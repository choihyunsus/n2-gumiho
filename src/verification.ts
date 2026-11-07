// Native checks and independent model review must agree on the current immutable artifact snapshot.
import { randomUUID } from 'node:crypto';
import {
  ArtifactScanner,
  artifactChanges,
  workspaceRelative,
  type ArtifactSnapshot,
} from './artifacts';
import type { GumihoStore } from './run-store';
import type { WorkspaceLease } from './workspace-lease';
import type { TailExecutor } from './tail-executor';
import type { NativeVerifier, NativeVerification } from './native-verifier';
import type { JobInput } from './store-types';
import { fingerprint, identity, plainJson, textValue } from './values';
import { withDeadline } from './deadline';
import { REVIEW_TASK, reviewDecision, type ReviewDecision } from './review-contract';
import { receiptReference } from './work-references';
import type { JsonValue, ToolResult } from './types';

export interface NativeReceipt extends NativeVerification {
  id: string;
  snapshotHash: string;
  workHash: string;
  verifierVersion: string;
  stable: boolean;
}
export interface VerificationReceipt {
  success: boolean;
  snapshotHash: string;
  workHash: string;
  nativeId: string;
  reviewJobId: string;
  review: ReviewDecision | null;
  failure: string | null;
}
export class VerificationService {
  constructor(
    private readonly store: GumihoStore,
    readonly scanner: ArtifactScanner,
    private readonly verifier: NativeVerifier,
    private readonly tails: TailExecutor,
    private readonly timeoutMs: number,
  ) {
    identity(verifier.version, 'native verifier version');
    if (typeof verifier.verify !== 'function')
      throw new Error('A host native verifier is required');
  }

  async baseline(lease: WorkspaceLease, signal: AbortSignal): Promise<ArtifactSnapshot> {
    const existing = this.store.receipt(lease.runId, 'baseline');
    if (existing !== undefined) return existing as unknown as ArtifactSnapshot;
    const snapshot = await this.scanner.scan(signal);
    this.store.putReceipt(lease, 'baseline', snapshot);
    return snapshot;
  }

  async native(
    lease: WorkspaceLease,
    attempt: string,
    signal: AbortSignal,
    fresh = false,
  ): Promise<NativeReceipt> {
    identity(attempt, 'verification attempt');
    const before = await this.scanner.scan(signal),
      workHash = this.workHash(lease.runId),
      id = `native-${attempt}-${fingerprint({ artifact: before.hash, work: workHash }).slice(0, 16)}${fresh ? `-${randomUUID()}` : ''}`;
    this.checkReportedFiles(lease, before);
    const existing = this.store.receipt(lease.runId, id);
    if (existing !== undefined) return existing as unknown as NativeReceipt;
    const baseline = await this.baseline(lease, signal),
      modifiedFiles = artifactChanges(baseline, before).map((change) => change.path);
    const checked = await withDeadline(signal, this.timeoutMs, (signal) =>
      this.verifier.verify({
        workspaceRoot: lease.workspaceRoot,
        runId: lease.runId,
        snapshot: structuredClone(before),
        modifiedFiles,
        signal,
      }),
    );
    if (!checked || typeof checked.success !== 'boolean')
      throw new Error('Native verifier returned invalid evidence');
    textValue(checked.summary, 'native verification summary', 8192);
    plainJson(checked.evidence, 262144, 32768);
    const after = await this.scanner.scan(signal),
      stable = before.hash === after.hash;
    const receipt: NativeReceipt = {
      summary: checked.summary,
      evidence: checked.evidence,
      id,
      snapshotHash: before.hash,
      workHash,
      verifierVersion: this.verifier.version,
      stable,
      success: checked.success && stable && this.workHash(lease.runId) === workHash,
    };
    this.store.putReceipt(lease, `snapshot-${before.hash}`, before);
    this.store.putReceipt(lease, id, receipt);
    return receipt;
  }

  async review(
    lease: WorkspaceLease,
    attempt: string,
    task: string,
    reviewerId: string,
    native: NativeReceipt,
    signal: AbortSignal,
    replacesId?: string,
  ): Promise<VerificationReceipt> {
    const tail = this.tails.configuration.tails.find((tail) => tail.id === reviewerId);
    if (!tail?.readOnly) throw new Error('Independent review requires a read-only tail');
    const id = `review-${attempt}`,
      input: JobInput = {
        id,
        tailId: reviewerId,
        task: REVIEW_TASK,
        context: reviewContext(this.store, lease.runId, task, native),
        ...(replacesId ? { replacesId } : {}),
      };
    const result = await this.tails.run(lease, input, signal);
    let decision: ReviewDecision | null = null,
      failure: string | null = null;
    try {
      if (result.success) decision = reviewDecision(result.output, native.snapshotHash);
    } catch {
      failure = 'The reviewer returned an invalid or stale approval';
    }
    const current = await this.scanner.scan(signal);
    const success =
      native.success &&
      decision?.approved === true &&
      current.hash === native.snapshotHash &&
      this.workHash(lease.runId) === native.workHash;
    if (!success && !failure)
      failure =
        current.hash !== native.snapshotHash
          ? 'Artifacts changed after verification'
          : 'Native checks or independent review rejected the work';
    const receipt: VerificationReceipt = {
      success,
      snapshotHash: native.snapshotHash,
      workHash: native.workHash,
      nativeId: native.id,
      reviewJobId: id,
      review: decision,
      failure,
    };
    this.store.putReceipt(lease, `verification-${attempt}`, receipt);
    return receipt;
  }

  async finalGate(lease: WorkspaceLease, signal: AbortSignal): Promise<ToolResult> {
    const proof = this.store.receipt(lease.runId, 'completion-proof') as unknown as
      | VerificationReceipt
      | undefined;
    if (!proof?.success || this.store.unresolved(lease.runId).length)
      return {
        success: false,
        output: 'Successful native checks, independent review and resolved jobs are required',
      };
    const snapshot = await this.scanner.scan(signal);
    if (snapshot.hash !== proof.snapshotHash || this.workHash(lease.runId) !== proof.workHash)
      return { success: false, output: 'Current artifacts differ from the approved snapshot' };
    const native = await this.native(lease, 'final', signal, true);
    const success = native.success && native.snapshotHash === proof.snapshotHash;
    return {
      success,
      output: success
        ? 'Native checks and independent review match the current artifacts'
        : 'Final native checks rejected the work',
      data: {
        nativeReceipt: native.id,
        snapshotHash: native.snapshotHash,
        workHash: native.workHash,
        approvalReceipt: 'completion-proof',
      },
    };
  }

  approve(lease: WorkspaceLease, receipt: VerificationReceipt): void {
    if (!receipt.success) throw new Error('A failed verification cannot approve completion');
    this.store.putReceipt(lease, 'completion-proof', receipt);
  }

  workHash(runId: string): string {
    const jobs = this.store
      .jobs(runId)
      .filter(
        (job) =>
          job.id !== 'controller' &&
          !job.id.startsWith('review-') &&
          !job.id.startsWith('advisor-'),
      );
    return fingerprint(
      jobs
        .map((job) => ({
          id: job.id,
          state: job.state,
          inputHash: job.input_hash,
          resultHash: job.result_json === null ? null : fingerprint(job.result_json, 524288),
        }))
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
  }

  private checkReportedFiles(lease: WorkspaceLease, snapshot: ArtifactSnapshot): void {
    const input = JSON.parse(this.store.get(lease.runId)!.input_json) as {
      modifiedFiles: string[];
    };
    const reported = [
      ...input.modifiedFiles,
      ...this.store
        .jobs(lease.runId)
        .flatMap((job) =>
          job.result_json
            ? (JSON.parse(job.result_json) as { modifiedFiles: string[] }).modifiedFiles
            : [],
        ),
    ];
    this.scanner.assertCovered(reported);
    const pathKey = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const links = snapshot.files
      .filter((file) => file.kind === 'symlink')
      .map((file) => pathKey(file.path));
    for (const filename of reported) {
      const relative = pathKey(workspaceRelative(lease.workspaceRoot, filename));
      if (links.some((link) => relative === link || relative.startsWith(`${link}/`)))
        throw new Error('Report canonical file changes instead of writes through symbolic links');
    }
  }

  async changes(lease: WorkspaceLease, signal: AbortSignal): Promise<string[]> {
    const baseline = await this.baseline(lease, signal),
      current = await this.scanner.scan(signal);
    return artifactChanges(baseline, current).map((change) => change.path);
  }
}

function reviewContext(
  store: GumihoStore,
  runId: string,
  task: string,
  native: NativeReceipt,
): JsonValue {
  return {
    originalTask: task,
    snapshotHash: native.snapshotHash,
    native: receiptReference(store, runId, native.id),
    snapshot: { receiptId: `snapshot-${native.snapshotHash}`, readTool: 'gumiho_read_receipt' },
  };
}

export function nativeReference(receipt: NativeReceipt): JsonValue {
  return {
    receiptId: receipt.id,
    snapshotHash: receipt.snapshotHash,
    success: receipt.success,
    summary: receipt.summary,
    readTool: 'gumiho_read_receipt',
  };
}
