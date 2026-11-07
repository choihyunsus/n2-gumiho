// Control tools delegate through durable worker receipts and gate verification on unresolved work.
import type { TailExecutor } from './tail-executor';
import type { VerificationService, VerificationReceipt } from './verification';
import type { WorkspaceLease } from './workspace-lease';
import type { CoordinatorConfiguration } from './coordinator-config';
import { CoordinatorDispatch } from './coordinator-dispatch';
import { Advisor } from './advisor';
import type { GumihoTool, ToolResult } from './types';
import { receiptReference } from './work-references';
import { dispatchSchema, RETRY_SCHEMA } from './coordinator-schemas';

export class CoordinatorTools {
  readonly advisor: Advisor;
  private readonly dispatcher: CoordinatorDispatch;
  constructor(
    private readonly tails: TailExecutor,
    private readonly verification: VerificationService,
    private readonly config: CoordinatorConfiguration,
    private readonly lease: WorkspaceLease,
    private readonly task: string,
  ) {
    this.advisor = new Advisor(tails, config.advisorTail, config.advisorMaxCalls);
    this.dispatcher = new CoordinatorDispatch(
      tails,
      verification,
      config,
      this.advisor,
      lease,
      task,
    );
  }

  definitions(): GumihoTool[] {
    return [
      {
        name: 'gumiho_dispatch',
        version: '1',
        idempotent: true,
        description:
          'Dispatch up to four independent worker jobs and await their actual results. Use separate batches for dependencies.',
        inputSchema: dispatchSchema(this.config.targets),
        execute: (args, context) => this.dispatcher.dispatch(args, context.callId, context.signal),
      },
      {
        name: 'gumiho_retry_job',
        version: '1',
        idempotent: true,
        description:
          'Retry one failed worker or advisor job with the same goal and tail. Pending uncertain effects require host reconciliation.',
        inputSchema: RETRY_SCHEMA,
        execute: (args, context) => this.dispatcher.retry(args, context.callId, context.signal),
      },
      {
        name: 'gumiho_verify',
        version: '1',
        idempotent: true,
        description:
          'Run native checks and an independent read-only review of the original task. Finish only after a successful current receipt.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: (_args, context) => this.verify(context.callId, context.signal),
      },
    ];
  }

  private async verify(callId: string, signal: AbortSignal): Promise<ToolResult> {
    const { store } = this.tails,
      jobs = store.jobs(this.lease.runId);
    const unresolved = store
      .unresolved(this.lease.runId)
      .filter((job) => job.id !== 'controller' && !job.id.startsWith('review-'));
    if (unresolved.length)
      return {
        success: false,
        output: 'Resolve failed or pending jobs before verification',
        data: { jobs: unresolved.map((job) => job.id).slice(0, 32), total: unresolved.length },
      };
    if (!jobs.some((job) => job.parent_id === 'controller' && job.state === 'completed'))
      return {
        success: false,
        output: 'At least one completed worker job is required before verification',
      };
    const attempt = `c-${callId.slice(-16)}`,
      receiptId = `verification-${attempt}`;
    let receipt = store.receipt(this.lease.runId, receiptId) as unknown as
      | VerificationReceipt
      | undefined;
    if (!receipt) receipt = await this.review(attempt, signal);
    if (!receipt.success)
      await this.advisor.consult(
        this.lease,
        `coordinator-stalled-${callId.slice(-16)}`,
        { task: this.task, verification: receiptReference(store, this.lease.runId, receiptId) },
        signal,
      );
    return {
      success: receipt.success,
      output: receipt.success
        ? 'Native checks and independent review passed'
        : (receipt.failure ?? 'Verification failed'),
      data: {
        receiptId,
        snapshotHash: receipt.snapshotHash,
        workHash: receipt.workHash,
        reviewJobId: receipt.reviewJobId,
      },
    };
  }

  private async review(attempt: string, signal: AbortSignal): Promise<VerificationReceipt> {
    const previous = this.tails.store
      .jobs(this.lease.runId)
      .find((job) => job.id.startsWith('review-') && job.state === 'failed');
    const native = await this.verification.native(this.lease, attempt, signal);
    return await this.verification.review(
      this.lease,
      attempt,
      this.task,
      this.config.verifyTail,
      native,
      signal,
      previous?.id,
    );
  }
}
