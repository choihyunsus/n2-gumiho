// Persist a batch plan before any child work so replay cannot redispatch it against a changed workspace.
import type { TailExecutor } from './tail-executor';
import type { VerificationService } from './verification';
import type { WorkspaceLease } from './workspace-lease';
import type { CoordinatorConfiguration } from './coordinator-config';
import type { Advisor } from './advisor';
import type { JobInput, JobResult } from './store-types';
import type { JsonValue, ToolResult } from './types';
import { arrayValue, objectValue } from './model-validation';
import { fingerprint, plainJson, textValue } from './values';
import { resolveTailId } from './tails';
import { encode } from './run-store';
import { ToolValidationError } from './tool-catalog';

interface DispatchPlan {
  jobs: JobInput[];
}
export class CoordinatorDispatch {
  constructor(
    private readonly tails: TailExecutor,
    private readonly verification: VerificationService,
    private readonly config: CoordinatorConfiguration,
    private readonly advisor: Advisor,
    private readonly lease: WorkspaceLease,
    private readonly originalTask: string,
  ) {}

  async dispatch(args: JsonValue, callId: string, signal: AbortSignal): Promise<ToolResult> {
    const receiptId = `dispatch-${callId}`;
    let plan = this.tails.store.receipt(this.lease.runId, receiptId) as unknown as
      | DispatchPlan
      | undefined;
    if (!plan) {
      try {
        plan = await this.plan(args, signal);
      } catch (error) {
        if (error instanceof ToolValidationError) return { success: false, output: error.message };
        throw error;
      }
      this.tails.store.putReceipt(this.lease, receiptId, plan);
    }
    const advice = await this.advisor.consult(
      this.lease,
      'coordinator-plan',
      { task: this.originalTask, dispatchPlan: { receiptId, readTool: 'gumiho_read_receipt' } },
      signal,
    );
    if (!advice.success) return { success: false, output: 'The configured plan advisor failed' };
    const jobs = plan.jobs.map((job) => this.currentRetry(job));
    const results = await Promise.all(jobs.map((job) => this.tails.run(this.lease, job, signal)));
    return batchResult(jobs, results);
  }

  async retry(args: JsonValue, callId: string, signal: AbortSignal): Promise<ToolResult> {
    const receiptId = `retry-${callId}`;
    let plan = this.tails.store.receipt(this.lease.runId, receiptId) as unknown as
      | DispatchPlan
      | undefined;
    if (!plan) {
      try {
        plan = this.retryPlan(args, callId);
      } catch (error) {
        if (error instanceof ToolValidationError) return { success: false, output: error.message };
        throw error;
      }
      this.tails.store.putReceipt(this.lease, receiptId, plan);
    }
    const job = this.currentRetry(plan.jobs[0]!);
    const result = await this.tails.run(this.lease, job, signal);
    return batchResult([job], [result]);
  }

  private retryPlan(args: JsonValue, callId: string): DispatchPlan {
    const input = objectValue(args),
      previous = this.tails.store.job(this.lease.runId, input.jobId as string);
    if (
      !previous ||
      previous.state !== 'failed' ||
      previous.id === 'controller' ||
      previous.id.startsWith('review-')
    )
      throw new ToolValidationError(
        'Retry requires a failed worker or advisor job; use gumiho_verify to retry review',
      );
    if (
      previous.id.startsWith('advisor-') &&
      this.tails.store.jobs(this.lease.runId).filter((job) => job.id.startsWith('advisor-'))
        .length >= this.config.advisorMaxCalls
    )
      throw new ToolValidationError('Advisor call budget exhausted');
    const original = JSON.parse(previous.input_json) as JobInput,
      prefix = previous.id.startsWith('advisor-') ? 'advisor-retry' : 'work-retry';
    const job = {
      ...original,
      id: `${prefix}-${callId.slice(-32)}`,
      replacesId: previous.id,
      context: {
        ...objectValue(original.context),
        previousJob: previous.id,
        retryFeedback: plainJson(input.feedback ?? null, 32768),
      },
    };
    validateJobInput(job);
    return { jobs: [job] };
  }

  private async plan(args: JsonValue, signal: AbortSignal): Promise<DispatchPlan> {
    const snapshot = await this.verification.scanner.scan(signal);
    const jobs = arrayValue(objectValue(args).jobs, 4).map((raw) => {
      const value = objectValue(raw),
        tail = resolveTailId(
          this.tails.configuration.tails,
          textValue(value.tail, 'delegation target', 128),
        );
      if (!this.config.targets.includes(tail.id))
        throw new Error('Delegation target is outside the configured capabilities');
      const task = textValue(value.task, 'delegated task', 32768);
      if (!task.trim()) throw new ToolValidationError('Delegated task must be nonempty');
      const context = {
        originalTask: this.originalTask,
        assignedContext: plainJson(value.context ?? {}, 32768),
        snapshotHash: snapshot.hash,
      };
      validateJobInput({ task, context });
      return {
        id: `work-${fingerprint({ tail: tail.id, task, context }, 262144).slice(0, 32)}`,
        tailId: tail.id,
        task,
        context,
        parentId: 'controller',
      };
    });
    if (!jobs.length) throw new Error('A dispatch batch requires at least one job');
    return { jobs };
  }

  private currentRetry(input: JobInput): JobInput {
    const row = this.tails.store.currentJob(this.lease.runId, input.id);
    return row ? (JSON.parse(row.input_json) as JobInput) : input;
  }
}

function validateJobInput(input: Pick<JobInput, 'task' | 'context'>): void {
  try {
    encode({ task: input.task, context: input.context }, 131072);
  } catch {
    throw new ToolValidationError('Delegated task and context exceed the job input limits');
  }
}

function batchResult(jobs: JobInput[], results: JobResult[]): ToolResult {
  return {
    success: results.every((result) => result.success),
    output: 'Worker results are stored in the scoped job journal',
    data: {
      jobs: jobs.map((job, index) => ({
        jobId: job.id,
        tailId: job.tailId,
        success: results[index]!.success,
        summary: [...results[index]!.output].slice(0, 256).join(''),
        readTool: 'gumiho_read_job',
      })),
    },
  };
}
