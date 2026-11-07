// The normal entry point always wraps the durable harness in N2R preparation, verification and memory.
import { MimirDatabase } from 'n2-mimir/storage';
import { RecipeRunner, type RunReceipt, type ToolResult, type WorkContext } from 'n2-recipe';
import { GumihoStore } from './run-store';
import { TailExecutor } from './tail-executor';
import { VerificationService, type VerificationReceipt } from './verification';
import { Pipeline } from './pipeline';
import { Coordinator } from './coordinator';
import { CallJournal } from './call-journal';
import type { WorkspaceLease } from './workspace-lease';
import { resolveOptions, type GumihoOptions, type ResolvedOptions } from './gumiho-options';
import { fingerprint, identity, plainJson, textValue } from './values';
import { workspaceRelative } from './artifacts';
import type { RunInput } from './store-types';

export interface GumihoRequest {
  runId: string;
  sessionId?: string;
  task: string;
  modifiedFiles?: string[];
}
export interface GumihoResult {
  runId: string;
  sessionId: string;
  success: boolean;
  lifecycle: RunReceipt;
  verification: VerificationReceipt | null;
  budget: { modelRequests: number; toolCalls: number; outputTokensReserved: number };
}
interface Runtime {
  lease: WorkspaceLease;
  tails: TailExecutor;
  verification: VerificationService;
  workflow: Pipeline | Coordinator;
}

export class Gumiho {
  private readonly memory: MimirDatabase;
  private readonly store: GumihoStore;
  private readonly recipes: RecipeRunner;
  private runtime?: Runtime;
  private active?: Promise<GumihoResult>;
  private abort?: AbortController;
  private closed = false;

  static async create(options: GumihoOptions): Promise<Gumiho> {
    return new Gumiho(await resolveOptions(options));
  }

  private constructor(private readonly options: ResolvedOptions) {
    this.memory = new MimirDatabase(options.dbPath);
    try {
      this.store = new GumihoStore(this.memory, options.project, options.agent, options.limits);
      this.recipes = new RecipeRunner({
        dbPath: options.dbPath,
        project: options.project,
        agent: options.agent,
        expertise: options.expertise ? undefined : false,
        deadlines: { toolMs: options.limits.jobTimeoutMs, phaseMs: 3600000, workMs: 3600000 },
        tools: [
          {
            name: 'prepare',
            version: options.hash,
            idempotent: true,
            execute: async (_args, context) => {
              const current = this.current(),
                baseline = await current.verification.baseline(current.lease, context.signal);
              return {
                success: true,
                output: 'Workspace and durable execution context prepared',
                data: { snapshotHash: baseline.hash },
              };
            },
          },
          {
            name: 'verify',
            version: options.hash,
            idempotent: true,
            execute: async (_args, context) => {
              const current = this.current();
              return await current.verification.finalGate(current.lease, context.signal);
            },
          },
        ],
      });
    } catch (error) {
      this.memory.close();
      throw error;
    }
  }

  async run(request: GumihoRequest, signal?: AbortSignal): Promise<GumihoResult> {
    this.assertOpen();
    if (this.active) throw new Error('This Gumiho instance already has active work');
    const input = checkedRequest(request, this.options);
    this.abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const pending = this.execute(input, combined);
    this.active = pending;
    try {
      return await pending;
    } finally {
      this.active = undefined;
      this.abort = undefined;
    }
  }

  status(runId: string) {
    this.assertOpen();
    identity(runId, 'run ID');
    const run = this.store.get(runId);
    if (!run) return undefined;
    return {
      run,
      jobs: this.store.jobs(runId),
      calls: new CallJournal(this.store).list(runId),
      lifecycle: this.recipes.status(recipeRunId(runId)),
      verification: this.store.receipt(runId, 'completion-proof'),
    };
  }

  async reconcileTool(
    runId: string,
    callId: string,
    result: ToolResult,
    evidence: string,
  ): Promise<void> {
    this.assertOpen();
    if (this.active) throw new Error('Reconcile only while this instance is idle');
    identity(runId, 'run ID');
    identity(callId, 'invocation ID');
    if (!textValue(evidence, 'reconciliation evidence', 8192).trim())
      throw new Error('Reconciliation evidence is required');
    const status = this.status(runId);
    if (!status || status.lifecycle?.run.state === 'completed')
      throw new Error('Only unfinished Gumiho runs can be reconciled');
    const call = status.calls.find((call) => call.id === callId);
    if (call && String(JSON.parse(call.input_json).name).startsWith('gumiho_'))
      throw new Error(
        'Resume composite control calls through their child receipts; reconcile the individual host tool',
      );
    const lease = this.store.acquire(runId, this.options.workspaceRoot);
    try {
      await new CallJournal(this.store).completeTool(lease, callId, result, evidence);
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort(new Error('Gumiho is closing'));
    try {
      await this.active;
    } catch {
      /* The caller retains the interrupted run and durable receipts. */
    }
    await this.recipes.close();
    if (!this.memory.isClosed) this.memory.close();
  }

  private async execute(input: RunInput, signal: AbortSignal): Promise<GumihoResult> {
    signal.throwIfAborted();
    const lease = this.store.acquire(input.runId, this.options.workspaceRoot);
    let runtime: Runtime | undefined;
    try {
      this.store.begin(lease, input);
      runtime = this.createRuntime(lease);
      this.runtime = runtime;
      const combined = AbortSignal.any([signal, lease.controller.signal]);
      await this.checkResume(input.runId, runtime, combined);
      const lifecycle = await this.recipes.run(
        {
          runId: recipeRunId(input.runId),
          sessionId: input.sessionId,
          task: input.task,
          modifiedFiles: input.modifiedFiles,
        },
        {
          version: this.options.hash,
          idempotent: true,
          execute: (context) => this.work(input, runtime!, context),
        },
        combined,
      );
      const budget = this.store.get(input.runId)!;
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        success: lifecycle.success,
        lifecycle,
        verification:
          (this.store.receipt(input.runId, 'completion-proof') as unknown as VerificationReceipt) ??
          null,
        budget: {
          modelRequests: budget.model_requests,
          toolCalls: budget.tool_calls,
          outputTokensReserved: budget.output_reserved,
        },
      };
    } finally {
      try {
        await runtime?.tails.close();
      } finally {
        this.runtime = undefined;
        lease.release();
      }
    }
  }

  private createRuntime(lease: WorkspaceLease): Runtime {
    const { options } = this,
      tails = new TailExecutor(this.store, options.tails, options.tools, options.limits);
    const verification = new VerificationService(
      this.store,
      options.scanner,
      options.verifier,
      tails,
      options.limits.jobTimeoutMs,
    );
    return {
      lease,
      tails,
      verification,
      workflow:
        options.mode === 'pipeline'
          ? new Pipeline(tails, verification, options.pipeline!)
          : new Coordinator(tails, verification, options.coordinator!),
    };
  }

  private async work(input: RunInput, runtime: Runtime, context: WorkContext): Promise<ToolResult> {
    const references = plainJson(context.context.systemAdditions, 32768);
    return await runtime.workflow.run(runtime.lease, input.task, references, context.signal);
  }

  private async checkResume(runId: string, runtime: Runtime, signal: AbortSignal): Promise<void> {
    const status = this.recipes.status(recipeRunId(runId));
    if (!status || status.run.state === 'completed') return;
    const progress = JSON.parse(status.run.progress_json) as {
      work?: { success?: boolean };
      phases?: Array<{ success: boolean }>;
    };
    if (progress.phases?.some((phase) => !phase.success)) return;
    if (
      progress.work?.success &&
      !(await runtime.verification.finalGate(runtime.lease, signal)).success
    )
      throw new Error(
        'Saved successful work no longer matches its evidence. Inspect the changes and start a new run ID',
      );
  }

  private current(): Runtime {
    if (!this.runtime) throw new Error('Gumiho lifecycle has no active runtime');
    return this.runtime;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Gumiho is closed');
  }
}

function checkedRequest(request: GumihoRequest, options: ResolvedOptions): RunInput {
  const task = textValue(request.task, 'task', 32768);
  if (!task.trim()) throw new Error('A task is required');
  if (!Array.isArray(request.modifiedFiles ?? []) || (request.modifiedFiles?.length ?? 0) > 1024)
    throw new Error('Too many declared file changes');
  const modifiedFiles = [
    ...new Set(
      (request.modifiedFiles ?? []).map((file) => workspaceRelative(options.workspaceRoot, file)),
    ),
  ];
  options.scanner.assertCovered(modifiedFiles);
  return {
    runId: identity(request.runId, 'run ID'),
    sessionId: identity(request.sessionId ?? request.runId, 'session ID'),
    task,
    workspaceRoot: options.workspaceRoot,
    configHash: options.hash,
    mode: options.mode,
    modifiedFiles,
  };
}
export function recipeRunId(runId: string): string {
  return `gumiho-${fingerprint(runId)}`;
}
