// Each tail owns a durable conversation, while workspace and provider concurrency stay bounded.
import type { TailConfiguration, ResolvedTail } from './tails';
import { resolveTailId } from './tails';
import { ToolCatalog } from './tool-catalog';
import { GumihoStore, encode } from './run-store';
import { CallJournal } from './call-journal';
import { ExecutionGate } from './execution-gate';
import type { ExecutionLimits } from './execution-limits';
import type { GumihoTool, ModelMessage } from './types';
import type { JobInput, JobResult } from './store-types';
import type { WorkspaceLease } from './workspace-lease';
import { JobInvocations } from './job-invocations';
import { journalTools } from './journal-tools';
import { workspaceRelative } from './artifacts';
import { withDeadline } from './deadline';

export class TailExecutor {
  readonly journal: CallJournal;
  readonly catalog: ToolCatalog;
  readonly workspace: ExecutionGate;
  private readonly invocations: JobInvocations;
  private readonly localModels: ExecutionGate;
  private readonly cloudModels: ExecutionGate;
  private readonly active = new Map<string, Promise<JobResult>>();
  private readonly abort = new AbortController();

  constructor(
    readonly store: GumihoStore,
    readonly configuration: TailConfiguration,
    tools: GumihoTool[],
    readonly limits: Readonly<ExecutionLimits>,
  ) {
    if (tools.some((tool) => tool.name.startsWith('gumiho_')))
      throw new Error('Gumiho internal tool names are reserved');
    this.journal = new CallJournal(store);
    this.catalog = new ToolCatalog([...tools, ...journalTools(store, this.journal)]);
    this.workspace = new ExecutionGate(limits.maxParallelReaders);
    this.localModels = new ExecutionGate(limits.localConcurrency);
    this.cloudModels = new ExecutionGate(limits.cloudConcurrency);
    this.invocations = this.createInvocations(this.catalog, limits);
  }

  createInvocations(
    catalog: ToolCatalog,
    limits: Readonly<ExecutionLimits> = this.limits,
  ): JobInvocations {
    return new JobInvocations({
      store: this.store,
      journal: this.journal,
      configuration: this.configuration,
      catalog,
      limits,
      localModels: this.localModels,
      cloudModels: this.cloudModels,
      interrupt: (error) => this.abort.abort(error),
    });
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  async run(lease: WorkspaceLease, input: JobInput, signal: AbortSignal): Promise<JobResult> {
    const combined = AbortSignal.any([signal, lease.controller.signal, this.abort.signal]);
    combined.throwIfAborted();
    const tail = resolveTailId(this.configuration.tails, input.tailId),
      resolved = JSON.parse(encode({ ...input, tailId: tail.id }, 262144)) as JobInput;
    encode({ task: resolved.task, context: resolved.context }, 131072);
    const row = this.store.createJob(lease, resolved);
    if (row.state === 'superseded') throw new Error('A superseded job cannot run again');
    if (row.result_json) return JSON.parse(row.result_json) as JobResult;
    const key = `${lease.runId}\0${row.id}`,
      pending = this.active.get(key);
    if (pending) return await pending;
    const work = this.workspace.run(tail.readOnly, combined, async () => {
      try {
        return await withDeadline(combined, this.limits.jobTimeoutMs, (signal) =>
          this.execute(lease, resolved, tail, signal),
        );
      } catch (error) {
        this.abort.abort(error);
        throw error;
      }
    });
    this.active.set(key, work);
    try {
      return await work;
    } catch (error) {
      this.abort.abort(error);
      throw error;
    } finally {
      this.active.delete(key);
    }
  }

  async close(): Promise<void> {
    this.abort.abort(new Error('Tail execution closed'));
    await Promise.allSettled(this.active.values());
  }

  private async execute(
    lease: WorkspaceLease,
    input: JobInput,
    tail: Readonly<ResolvedTail>,
    signal: AbortSignal,
  ): Promise<JobResult> {
    this.store.startJob(lease, input.id);
    const history: ModelMessage[] = [
      { role: 'user', content: encode({ task: input.task, context: input.context }, 131072) },
    ];
    const changed = new Set<string>();
    for (let turn = 0; turn < this.limits.maxTurnsPerJob; turn++) {
      signal.throwIfAborted();
      const reply = await this.invocations.model(lease, input.id, turn, tail, history, signal);
      history.push({ role: 'assistant', reply });
      if (reply.stop !== 'tools') {
        const result: JobResult = {
          success: reply.stop === 'complete',
          output: reply.text,
          modifiedFiles: [...changed],
          ...(reply.stop === 'complete' ? {} : { failure: `model_${reply.stop}` }),
        };
        this.store.finishJob(lease, input.id, result);
        return result;
      }
      for (const [index, call] of reply.calls.entries()) {
        const result = await this.invocations.tool(
          lease,
          input.id,
          turn,
          index,
          tail,
          call,
          signal,
        );
        for (const file of result.modifiedFiles ?? [])
          changed.add(workspaceRelative(lease.workspaceRoot, file));
        history.push({ role: 'tool', callId: call.id, name: call.name, result });
      }
    }
    const result: JobResult = {
      success: false,
      output: 'The job reached its model-turn limit',
      modifiedFiles: [...changed],
      failure: 'turn_limit',
    };
    this.store.finishJob(lease, input.id, result);
    return result;
  }
}
