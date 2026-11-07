// Optional advisor checkpoints are invoked by host control flow with an explicit per-run call cap.
import type { TailExecutor } from './tail-executor';
import type { WorkspaceLease } from './workspace-lease';
import type { JsonValue } from './types';
import { jobReference } from './work-references';
import type { JobInput } from './store-types';

export class Advisor {
  constructor(
    private readonly tails: TailExecutor,
    private readonly tailId: string | null,
    private readonly maximumCalls: number,
  ) {}

  async consult(
    lease: WorkspaceLease,
    checkpoint: string,
    context: JsonValue,
    signal: AbortSignal,
  ): Promise<{ success: boolean; reference: JsonValue }> {
    if (!this.tailId) return { success: true, reference: null };
    const id = `advisor-${checkpoint}`,
      existing = this.tails.store.currentJob(lease.runId, id);
    const count = this.tails.store
      .jobs(lease.runId)
      .filter((job) => job.id.startsWith('advisor-')).length;
    if (!existing && count >= this.maximumCalls) {
      this.tails.store.putReceipt(lease, `advisor-skipped-${checkpoint}`, {
        reason: 'advisor_call_budget',
        maximum: this.maximumCalls,
      });
      return { success: true, reference: { skipped: true, reason: 'advisor_call_budget' } };
    }
    const input: JobInput = existing
      ? (JSON.parse(existing.input_json) as JobInput)
      : {
          id,
          tailId: this.tailId,
          task: 'Independently advise on the supplied workflow checkpoint. Identify concrete defects, tradeoffs and verification gaps.',
          context,
        };
    const result = await this.tails.run(lease, input, signal);
    return { success: result.success, reference: jobReference(input.id, result) };
  }
}
