// Scoped invocation IDs remain stable on replay and distinct across projects, agents and runs.
import type { GumihoStore } from './run-store';
import type { CallJournal } from './call-journal';
import type { WorkspaceLease } from './workspace-lease';
import type { ExecutionLimits } from './execution-limits';
import type { ExecutionGate } from './execution-gate';
import type { ResolvedTail, TailConfiguration } from './tails';
import { ToolCatalog, ToolValidationError } from './tool-catalog';
import type {
  ModelCall,
  ModelMessage,
  ModelReply,
  ModelRequest,
  ModelProvider,
  GumihoToolContext,
  ToolResult,
} from './types';
import { checkedReply } from './model-validation';
import { fingerprint } from './values';
import { historyWindow } from './history';
import { withDeadline } from './deadline';
import { jobInstructions } from './job-prompts';

export interface InvocationDependencies {
  store: GumihoStore;
  journal: CallJournal;
  configuration: TailConfiguration;
  catalog: ToolCatalog;
  limits: Readonly<ExecutionLimits>;
  localModels: ExecutionGate;
  cloudModels: ExecutionGate;
  interrupt(error: unknown): void;
}
export class JobInvocations {
  constructor(private readonly dependencies: InvocationDependencies) {}

  async model(
    lease: WorkspaceLease,
    jobId: string,
    turn: number,
    tail: Readonly<ResolvedTail>,
    history: readonly ModelMessage[],
    signal: AbortSignal,
  ): Promise<ModelReply> {
    const { journal, configuration, catalog, limits } = this.dependencies;
    const provider = configuration.providers.get(tail.providerId)!;
    const requestId = this.invocationId(lease, 'model', jobId, turn, 0),
      system = jobInstructions(tail),
      tools = catalog.list(tail);
    const window = historyWindow(history, limits.maxHistoryBytes, jobId);
    const input = {
      model: tail.model,
      system,
      messages: window.messages,
      tools,
      maxOutputTokens: tail.maxOutputTokens,
    };
    const row = journal.prepare(lease, {
      id: requestId,
      jobId,
      kind: 'model',
      name: provider.id,
      version: provider.version,
      arguments: {
        requestHash: fingerprint(input, 2097152),
        model: tail.model,
        turn,
        omittedTurns: window.omittedTurns,
      },
      idempotent: true,
      readOnly: true,
    });
    if (row.result_json) return checkedReply(JSON.parse(row.result_json) as ModelReply);
    const gate = provider.local ? this.dependencies.localModels : this.dependencies.cloudModels;
    return await gate.run(true, signal, async () => {
      try {
        return await this.executeModel(lease, provider, { ...input, requestId, signal });
      } catch (error) {
        this.dependencies.interrupt(error);
        throw error;
      }
    });
  }

  async tool(
    lease: WorkspaceLease,
    jobId: string,
    turn: number,
    index: number,
    tail: Readonly<ResolvedTail>,
    call: ModelCall,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const { catalog, store, journal, limits } = this.dependencies;
    let checked;
    try {
      checked = catalog.check(call.name, call.arguments, tail);
    } catch (error) {
      if (error instanceof ToolValidationError) return { success: false, output: error.message };
      throw error;
    }
    const callId = this.invocationId(lease, 'tool', jobId, turn, index);
    const row = store.mutate(lease, () => {
      const prepared = journal.prepare(lease, {
        id: callId,
        jobId,
        kind: 'tool',
        name: checked.name,
        version: checked.version,
        arguments: checked.args,
        idempotent: checked.idempotent,
        readOnly: checked.readOnly,
      });
      if (!prepared.result_json) store.reserveAttempt(lease, 'tool');
      return prepared;
    });
    if (row.result_json) return JSON.parse(row.result_json) as ToolResult;
    const result = await withDeadline(signal, limits.toolTimeoutMs, (signal) =>
      catalog.invoke(
        call.name,
        checked.args,
        this.toolContext(lease, jobId, tail, callId, signal),
        tail,
      ),
    );
    signal.throwIfAborted();
    await journal.completeTool(lease, callId, result);
    return result;
  }

  private async executeModel(
    lease: WorkspaceLease,
    provider: Readonly<ModelProvider>,
    request: ModelRequest,
  ): Promise<ModelReply> {
    const { store, journal, limits } = this.dependencies;
    lease.assert();
    store.reserveAttempt(lease, 'model', request.maxOutputTokens);
    let announced = false;
    const result = await withDeadline(request.signal, limits.modelTimeoutMs, async (signal) =>
      checkedReply(
        await provider.generate({
          ...request,
          signal,
          onAttempt: () => {
            lease.assert();
            if (announced) store.reserveAttempt(lease, 'model', request.maxOutputTokens);
            announced = true;
          },
        }),
      ),
    );
    if (result.usage.outputTokens !== null && result.usage.outputTokens > request.maxOutputTokens)
      result.stop = 'incomplete';
    request.signal.throwIfAborted();
    journal.completeModel(lease, request.requestId, result);
    return result;
  }

  private toolContext(
    lease: WorkspaceLease,
    jobId: string,
    tail: Readonly<ResolvedTail>,
    callId: string,
    signal: AbortSignal,
  ): GumihoToolContext {
    const { scope } = this.dependencies.store;
    return {
      project: scope[0]!,
      agent: scope[1]!,
      runId: lease.runId,
      callId,
      jobId,
      tailId: tail.id,
      role: tail.role,
      workspaceRoot: lease.workspaceRoot,
      phase: 'work',
      signal,
    };
  }

  private invocationId(
    lease: WorkspaceLease,
    kind: 'model' | 'tool',
    jobId: string,
    turn: number,
    index: number,
  ): string {
    const [project, agent] = this.dependencies.store.scope;
    return `${kind}-${fingerprint({ project, agent, runId: lease.runId, jobId, turn, index }).slice(0, 32)}`;
  }
}
