// Deterministic stage dependencies and bounded repairs share the same native/review completion gate.
import type { TailExecutor } from './tail-executor';
import type { WorkspaceLease } from './workspace-lease';
import type { PipelineConfiguration } from './pipeline-config';
import type { JobResult } from './store-types';
import type { JsonValue, ToolResult } from './types';
import {
  VerificationService,
  nativeReference,
  type NativeReceipt,
  type VerificationReceipt,
} from './verification';
import { jobReference, receiptReference } from './work-references';
import { Advisor } from './advisor';
const ANALYSIS_TASK =
  'Analyze the implementation task in context.originalTask. Identify requirements, relevant evidence and constraints. Return the analysis for the planning stage.';
const PLANNING_TASK =
  'Plan the implementation task in context.originalTask using the supplied analysis. Return an actionable sequence of changes and checks for the build stage.';

export class Pipeline {
  private readonly advisor: Advisor;
  constructor(
    private readonly tails: TailExecutor,
    private readonly verification: VerificationService,
    private readonly configuration: PipelineConfiguration,
  ) {
    this.advisor = new Advisor(tails, configuration.advisorTail, configuration.advisorMaxCalls);
  }

  async run(
    lease: WorkspaceLease,
    task: string,
    restoredReferences: JsonValue,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const completed = this.tails.store.receipt(lease.runId, 'pipeline-result');
    if (completed !== undefined) return completed as unknown as ToolResult;
    await this.verification.baseline(lease, signal);
    const analyze = await this.tails.run(
      lease,
      {
        id: 'analysis',
        tailId: this.configuration.analyzeTail,
        task: ANALYSIS_TASK,
        context: { originalTask: task, restoredReferences },
      },
      signal,
    );
    if (!analyze.success) return await this.failure(lease, 'Analysis failed', 'analysis', signal);
    const analysis = jobReference('analysis', analyze);
    const plan = await this.tails.run(
      lease,
      {
        id: 'plan',
        tailId: this.configuration.planTail,
        task: PLANNING_TASK,
        context: { originalTask: task, analysis },
      },
      signal,
    );
    if (!plan.success) return await this.failure(lease, 'Planning failed', 'plan', signal);
    const planning = jobReference('plan', plan),
      advice = await this.advisor.consult(lease, 'plan', { task, analysis, planning }, signal);
    if (!advice.success)
      return await this.failure(lease, 'Plan advisor failed', 'advisor-plan', signal);
    return await this.buildAndVerify(
      lease,
      task,
      { analysis, planning, advice: advice.reference },
      signal,
    );
  }

  private async buildAndVerify(
    lease: WorkspaceLease,
    task: string,
    context: { [key: string]: JsonValue },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    let previousBuild: string | undefined,
      previousReview: string | undefined,
      feedback: JsonValue = null;
    for (let round = 0; round <= this.configuration.maxRepairs; round++) {
      const attempt = `pipeline-${round}`,
        id = `build-${round}`;
      const build = await this.buildJob(
        lease,
        task,
        id,
        previousBuild,
        { ...context, feedback },
        signal,
      );
      previousBuild = id;
      if (!build.success) {
        feedback = jobReference(id, build);
        continue;
      }
      const { native, review } = await this.reviewBuild(
        lease,
        attempt,
        task,
        previousReview,
        signal,
      );
      previousReview = review.reviewJobId;
      if (review.success)
        return await this.finishVerifiedRound(lease, task, { id, build, native, review }, signal);
      feedback = receiptReference(this.tails.store, lease.runId, `verification-${attempt}`);
      if (round < this.configuration.maxRepairs) {
        feedback = await this.repairFeedback(
          lease,
          round,
          { task, feedback, native: nativeReference(native) },
          signal,
        );
        const advisorId = `advisor-stalled-${round}`;
        if (feedback === null)
          return await this.failure(lease, 'Repair advisor failed', advisorId, signal);
      }
    }
    return await this.failure(lease, 'Repair budget exhausted', previousBuild ?? 'build', signal);
  }

  private async repairFeedback(
    lease: WorkspaceLease,
    round: number,
    context: { [key: string]: JsonValue },
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const advice = await this.advisor.consult(lease, `stalled-${round}`, context, signal);
    return advice.success ? { verification: context.feedback!, advice: advice.reference } : null;
  }

  private async buildJob(
    lease: WorkspaceLease,
    task: string,
    id: string,
    previous: string | undefined,
    context: JsonValue,
    signal: AbortSignal,
  ): Promise<JobResult> {
    const replacesId = this.failedPredecessor(lease, previous);
    const input = {
      id,
      tailId: this.configuration.buildTail,
      task,
      context,
      ...(replacesId ? { replacesId } : {}),
    };
    const existing = this.tails.store.createJob(lease, input);
    if (existing.state === 'superseded') return JSON.parse(existing.result_json!) as JobResult;
    return await this.tails.run(lease, input, signal);
  }

  private async reviewBuild(
    lease: WorkspaceLease,
    attempt: string,
    task: string,
    previous: string | undefined,
    signal: AbortSignal,
  ) {
    const completed = this.tails.store.receipt(
      lease.runId,
      `verification-${attempt}`,
    ) as unknown as VerificationReceipt | undefined;
    if (completed)
      return {
        review: completed,
        native: this.tails.store.receipt(
          lease.runId,
          completed.nativeId,
        ) as unknown as NativeReceipt,
      };
    const native = await this.verification.native(lease, attempt, signal);
    const review = await this.verification.review(
      lease,
      attempt,
      task,
      this.configuration.verifyTail,
      native,
      signal,
      this.failedPredecessor(lease, previous),
    );
    return { native, review };
  }

  private async finishVerifiedRound(
    lease: WorkspaceLease,
    task: string,
    evidence: { id: string; build: JobResult; native: NativeReceipt; review: VerificationReceipt },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const { id, build, native, review } = evidence;
    const advice = await this.advisor.consult(
      lease,
      'final',
      { task, build: jobReference(id, build), native: nativeReference(native) },
      signal,
    );
    if (!advice.success)
      return await this.failure(lease, 'Final advisor failed', 'advisor-final', signal);
    const result = await this.success(lease, id, build, native.id, signal);
    this.tails.store.mutate(lease, () => {
      this.verification.approve(lease, review);
      this.tails.store.putReceipt(lease, 'pipeline-result', result);
    });
    return result;
  }

  private failedPredecessor(lease: WorkspaceLease, id: string | undefined): string | undefined {
    const state = id ? this.tails.store.job(lease.runId, id)?.state : undefined;
    return state === 'failed' || state === 'superseded' ? id : undefined;
  }

  private async failure(
    lease: WorkspaceLease,
    output: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const result = {
      success: false,
      output,
      data: { jobId },
      modifiedFiles: await this.verification.changes(lease, signal),
    };
    this.tails.store.putReceipt(lease, 'pipeline-result', result);
    return result;
  }

  private async success(
    lease: WorkspaceLease,
    jobId: string,
    result: JobResult,
    nativeId: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    return {
      success: true,
      output: [...result.output].slice(0, 8192).join(''),
      data: { jobId, nativeReceipt: nativeId, approvalReceipt: 'completion-proof' },
      modifiedFiles: await this.verification.changes(lease, signal),
    };
  }
}
