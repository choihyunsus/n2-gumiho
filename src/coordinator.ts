// A durable control-only conversation cannot finish until current artifacts and every worker are verified.
import type { TailExecutor } from './tail-executor';
import type { WorkspaceLease } from './workspace-lease';
import type { CoordinatorConfiguration } from './coordinator-config';
import { VerificationService, type VerificationReceipt } from './verification';
import { CoordinatorTools } from './coordinator-tools';
import { ToolCatalog } from './tool-catalog';
import { journalTools } from './journal-tools';
import type { JobInvocations } from './job-invocations';
import type { JsonValue, ModelMessage, ModelReply, ToolResult } from './types';
import { encode } from './run-store';
import { objectValue } from './model-validation';
import { receiptReference } from './work-references';

interface ControlRuntime {
  lease: WorkspaceLease;
  tools: CoordinatorTools;
  invocations: JobInvocations;
  signal: AbortSignal;
  task: string;
}
interface ControlDecision {
  action: 'finish' | 'continue';
  message: string;
  receiptId: string | null;
}
export class Coordinator {
  constructor(
    private readonly tails: TailExecutor,
    private readonly verification: VerificationService,
    private readonly configuration: CoordinatorConfiguration,
  ) {}

  async run(
    lease: WorkspaceLease,
    task: string,
    restoredReferences: JsonValue,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const completed = this.tails.store.receipt(lease.runId, 'coordinator-result');
    if (completed !== undefined) return completed as unknown as ToolResult;
    const combined = AbortSignal.any([signal, this.tails.signal, lease.controller.signal]);
    await this.verification.baseline(lease, combined);
    const context = { restoredReferences, targets: this.configuration.targets };
    this.tails.store.createJob(lease, {
      id: 'controller',
      tailId: this.configuration.controller.id,
      task,
      context,
    });
    this.tails.store.startJob(lease, 'controller');
    const tools = new CoordinatorTools(
      this.tails,
      this.verification,
      this.configuration,
      lease,
      task,
    );
    const catalog = new ToolCatalog([
      ...tools.definitions(),
      ...journalTools(this.tails.store, this.tails.journal),
    ]);
    const invocations = this.tails.createInvocations(catalog, {
      ...this.tails.limits,
      toolTimeoutMs: 3600000,
    });
    return await this.loop({ lease, tools, invocations, signal: combined, task }, [
      { role: 'user', content: encode({ task, context }, 131072) },
    ]);
  }

  private async loop(runtime: ControlRuntime, history: ModelMessage[]): Promise<ToolResult> {
    let candidate: string | null = null;
    for (let turn = 0; turn < this.configuration.maxTurns; turn++) {
      runtime.signal.throwIfAborted();
      const reply = await runtime.invocations.model(
        runtime.lease,
        'controller',
        turn,
        this.configuration.controller,
        history,
        runtime.signal,
      );
      history.push({ role: 'assistant', reply });
      if (reply.stop === 'tools') {
        candidate = await this.executeTools(runtime, turn, reply, history, candidate);
        continue;
      }
      if (reply.stop !== 'complete')
        return await this.finish(runtime, false, reply.text || `Controller ${reply.stop}`, null);
      const decision = await this.decide(runtime, turn, candidate);
      if (decision.action === 'finish')
        return await this.finish(runtime, true, reply.text, decision.receiptId);
      history.push({ role: 'user', content: decision.message });
    }
    return await this.finish(runtime, false, 'The coordinator reached its model-turn limit', null);
  }

  private async executeTools(
    runtime: ControlRuntime,
    turn: number,
    reply: ModelReply,
    history: ModelMessage[],
    candidate: string | null,
  ): Promise<string | null> {
    for (const [index, call] of reply.calls.entries()) {
      const result = await runtime.invocations.tool(
        runtime.lease,
        'controller',
        turn,
        index,
        this.configuration.controller,
        call,
        runtime.signal,
      );
      history.push({ role: 'tool', callId: call.id, name: call.name, result });
      if (call.name === 'gumiho_verify')
        candidate = result.success ? (objectValue(result.data).receiptId as string) : null;
    }
    return candidate;
  }

  private async decide(
    runtime: ControlRuntime,
    turn: number,
    candidate: string | null,
  ): Promise<ControlDecision> {
    const { lease } = runtime,
      id = `controller-decision-${turn}`;
    const existing = this.tails.store.receipt(lease.runId, id);
    if (existing !== undefined) return existing as unknown as ControlDecision;
    let reason = await this.blockingReason(runtime, candidate);
    if (reason === null) {
      const advice = await runtime.tools.advisor.consult(
        lease,
        'coordinator-final',
        {
          task: runtime.task,
          verification: receiptReference(this.tails.store, lease.runId, candidate!),
        },
        runtime.signal,
      );
      reason = advice.success
        ? await this.blockingReason(runtime, candidate)
        : 'The configured final advisor failed';
    }
    const decision: ControlDecision =
      reason === null
        ? { action: 'finish', message: 'Verified work is ready to finish', receiptId: candidate }
        : {
            action: 'continue',
            message: `Completion was blocked. ${reason}. Inspect the scoped job journal, resolve failures, and call gumiho_verify again.`,
            receiptId: null,
          };
    this.tails.store.putReceipt(lease, id, decision);
    return decision;
  }

  private async blockingReason(
    runtime: ControlRuntime,
    candidate: string | null,
  ): Promise<string | null> {
    const { lease } = runtime;
    const unresolved = this.tails.store
      .unresolved(lease.runId)
      .filter((job) => job.id !== 'controller');
    if (unresolved.length)
      return `Unresolved jobs remain (${unresolved
        .slice(0, 16)
        .map((job) => job.id)
        .join(', ')})`;
    if (!candidate) return 'No successful native-check and independent-review receipt is available';
    const proof = this.tails.store.receipt(lease.runId, candidate) as unknown as
      | VerificationReceipt
      | undefined;
    if (!proof?.success) return 'The verification receipt did not approve this work';
    const snapshot = await this.verification.scanner.scan(runtime.signal);
    return snapshot.hash === proof.snapshotHash &&
      this.verification.workHash(lease.runId) === proof.workHash
      ? null
      : 'Artifacts or worker results changed after verification';
  }

  private async finish(
    runtime: ControlRuntime,
    success: boolean,
    output: string,
    receiptId: string | null,
  ): Promise<ToolResult> {
    const { lease } = runtime,
      modifiedFiles = await this.verification.changes(lease, runtime.signal);
    const result: ToolResult = {
      success,
      output: [...output].slice(0, 8192).join(''),
      modifiedFiles,
      data: { controllerJobId: 'controller', approvalReceipt: success ? 'completion-proof' : null },
    };
    this.tails.store.mutate(lease, () => {
      this.tails.store.finishJob(lease, 'controller', { success, output, modifiedFiles });
      if (success) {
        const proof = this.tails.store.receipt(
          lease.runId,
          receiptId!,
        ) as unknown as VerificationReceipt;
        this.verification.approve(lease, proof);
      }
      this.tails.store.putReceipt(lease, 'coordinator-result', result);
    });
    return result;
  }
}
