// Record effects before invocation and require explicit evidence for uncertain non-idempotent calls.
import { ToolRegistry } from 'n2-recipe';
import type { GumihoStore } from './run-store';
import { encode, now } from './run-store';
import type { WorkspaceLease } from './workspace-lease';
import { ReconciliationRequired, type CallInput, type StoredCall } from './store-types';
import { fingerprint, identity, textValue } from './values';
import { checkedReply, MAX_REPLY_BYTES } from './model-validation';
import type { JsonValue, ModelReply, ToolResult } from './types';

const MAX_TOOL_RESULT = 131072;
export class CallJournal {
  constructor(private readonly store: GumihoStore) {}

  get(runId: string, id: string): StoredCall | undefined {
    return this.store.connection.query<StoredCall>(
      'SELECT * FROM gumiho_calls WHERE project=? AND agent=? AND run_id=? AND id=?',
      [...this.store.scope, runId, id],
    )[0];
  }

  list(runId: string, jobId?: string): StoredCall[] {
    const condition = jobId === undefined ? '' : ' AND job_id=?';
    return this.store.connection.query<StoredCall>(
      `SELECT * FROM gumiho_calls WHERE project=? AND agent=? AND run_id=?${condition} ORDER BY started_at,id`,
      [...this.store.scope, runId, ...(jobId === undefined ? [] : [jobId])],
    );
  }

  prepare(lease: WorkspaceLease, input: CallInput): StoredCall {
    identity(input.id, 'invocation ID');
    identity(input.jobId, 'job ID');
    identity(input.name, 'invocation name');
    identity(input.version, 'invocation version');
    if (
      !['model', 'tool'].includes(input.kind) ||
      typeof input.idempotent !== 'boolean' ||
      typeof input.readOnly !== 'boolean'
    )
      throw new Error('Invalid invocation semantics');
    const json = encode(input, MAX_TOOL_RESULT),
      hash = fingerprint(input, MAX_TOOL_RESULT);
    return this.store.mutate(lease, () => {
      const existing = this.get(lease.runId, input.id);
      if (existing) {
        if (existing.input_hash !== hash)
          throw new Error('Invocation replay diverged from its receipt');
        if (existing.state === 'pending' && !existing.idempotent)
          throw new ReconciliationRequired(lease.runId, input.id);
        return existing;
      }
      const job = this.store.job(lease.runId, input.jobId);
      if (job?.state !== 'running') throw new Error('Invocations require a running job');
      this.store.reserve(
        lease,
        Buffer.byteLength(json) + (input.kind === 'model' ? MAX_REPLY_BYTES : MAX_TOOL_RESULT),
      );
      this.store.connection.execute(
        `INSERT INTO gumiho_calls(project,agent,run_id,id,job_id,kind,input_json,input_hash,idempotent,read_only,state,started_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`,
        [
          ...this.store.scope,
          lease.runId,
          input.id,
          input.jobId,
          input.kind,
          json,
          hash,
          Number(input.idempotent),
          Number(input.readOnly),
          now(),
        ],
      );
      return this.get(lease.runId, input.id)!;
    });
  }

  completeModel(lease: WorkspaceLease, id: string, result: ModelReply): void {
    this.complete(lease, id, 'model', checkedReply(result));
  }

  async completeTool(
    lease: WorkspaceLease,
    id: string,
    result: ToolResult,
    reconciliation?: string,
  ): Promise<void> {
    const row = this.get(lease.runId, id);
    if (!row || row.kind !== 'tool') throw new Error('Unknown tool invocation');
    const registry = new ToolRegistry([
      { name: 'result', version: '1', readOnly: !!row.read_only, execute: () => result },
    ]);
    const checked = await registry.invoke(
      'result',
      {},
      {
        project: this.store.scope[0]!,
        agent: this.store.scope[1]!,
        runId: lease.runId,
        callId: id,
        phase: 'work',
        signal: lease.controller.signal,
      },
    );
    this.complete(lease, id, 'tool', checked, reconciliation);
  }

  private complete(
    lease: WorkspaceLease,
    id: string,
    kind: 'model' | 'tool',
    value: unknown,
    reconciliation?: string,
  ): void {
    const json = encode(value, kind === 'model' ? MAX_REPLY_BYTES : MAX_TOOL_RESULT);
    if (
      reconciliation !== undefined &&
      !textValue(reconciliation, 'reconciliation evidence', 8192).trim()
    )
      throw new Error('Reconciliation requires an evidence note');
    this.store.mutate(lease, () => {
      const changed = this.store.connection.execute(
        "UPDATE gumiho_calls SET state='completed',result_json=?,reconciliation=?,completed_at=? WHERE project=? AND agent=? AND run_id=? AND id=? AND kind=? AND state='pending'",
        [json, reconciliation ?? null, now(), ...this.store.scope, lease.runId, id, kind],
      );
      if (changed !== 1) throw new Error('Only a pending invocation can complete');
      this.store.refund(
        lease,
        (kind === 'model' ? MAX_REPLY_BYTES : MAX_TOOL_RESULT) - Buffer.byteLength(json),
      );
      this.store.event(lease, 'invocation_completed', {
        id,
        kind,
        reconciled: reconciliation !== undefined,
      });
    });
  }
}

export function callResult(row: StoredCall): JsonValue | undefined {
  return row.result_json === null ? undefined : (JSON.parse(row.result_json) as JsonValue);
}
