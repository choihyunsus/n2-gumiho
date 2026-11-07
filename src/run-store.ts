// Persist jobs, budgets and verification receipts without overwriting completed or foreign work.
import type { MimirDatabase } from 'n2-mimir/storage';
import { fingerprint, identity, plainJson, positiveInteger, textValue } from './values';
import { initializeStore } from './store-schema';
import { WorkspaceLease } from './workspace-lease';
import type {
  JobInput,
  JobResult,
  RunInput,
  SqlConnection,
  StorageLimits,
  StoredJob,
  StoredRun,
} from './store-types';
import type { JsonValue } from './types';

const MAX_JOB_BYTES = 262144;
const MAX_RECEIPT_BYTES = 524288;
const RESULT_RESERVE = MAX_JOB_BYTES;
const MAX_JOB_TASK_BYTES = 32768;
const MAX_REQUEST_OUTPUT_TOKENS = 32768;
export class GumihoStore {
  readonly connection: SqlConnection;
  readonly scope: readonly string[];
  readonly limits: Readonly<StorageLimits>;

  constructor(memory: MimirDatabase, project: string, agent: string, limits: StorageLimits) {
    this.scope = Object.freeze([scopeName(project), scopeName(agent)]);
    this.limits = Object.freeze({
      maxJobs: positiveInteger(limits.maxJobs, 'job limit', 256),
      maxModelRequests: positiveInteger(limits.maxModelRequests, 'model request limit', 1024),
      maxToolCalls: positiveInteger(limits.maxToolCalls, 'tool call limit', 4096),
      maxOutputTokens: positiveInteger(limits.maxOutputTokens, 'total output budget', 2097152),
      maxTraceBytes: positiveInteger(limits.maxTraceBytes, 'trace byte budget', 134217728),
    });
    this.connection = memory.reasoning.connection;
    initializeStore(this.connection);
  }

  acquire(runId: string, workspaceRoot: string): WorkspaceLease {
    return new WorkspaceLease(
      this.connection,
      this.scope,
      identity(runId, 'run ID'),
      workspaceRoot,
    );
  }

  mutate<T>(lease: WorkspaceLease, work: () => T): T {
    return this.connection.transaction(() => {
      if (lease.scope[0] !== this.scope[0] || lease.scope[1] !== this.scope[1])
        throw new Error('Foreign Gumiho lease');
      lease.assert();
      return work();
    });
  }

  get(runId: string): StoredRun | undefined {
    return this.connection.query<StoredRun>(
      'SELECT * FROM gumiho_runs WHERE project=? AND agent=? AND id=?',
      [...this.scope, runId],
    )[0];
  }

  begin(lease: WorkspaceLease, input: RunInput): StoredRun {
    identity(input.runId, 'run ID');
    identity(input.sessionId, 'session ID');
    textValue(input.task, 'run task', MAX_JOB_TASK_BYTES);
    if (!input.task.trim() || !['pipeline', 'coordinator'].includes(input.mode))
      throw new Error('Invalid run task or mode');
    const json = encode(input, MAX_JOB_BYTES),
      hash = fingerprint({ input, limits: this.limits }, MAX_JOB_BYTES);
    if (input.runId !== lease.runId || input.workspaceRoot !== lease.workspaceRoot)
      throw new Error('Run input differs from its lease');
    return this.mutate(lease, () => {
      const existing = this.get(input.runId);
      if (existing && existing.request_hash !== hash)
        throw new Error('Run ID belongs to different input, configuration or budgets');
      if (!existing) {
        this.connection.execute(
          `INSERT INTO gumiho_runs(project,agent,id,session_id,request_hash,input_json,limits_json,created_at)
          VALUES(?,?,?,?,?,?,?,?)`,
          [...this.scope, input.runId, input.sessionId, hash, json, encode(this.limits), now()],
        );
        this.reserve(lease, Buffer.byteLength(json));
        this.event(lease, 'run_created', { mode: input.mode });
      }
      return this.get(input.runId)!;
    });
  }

  jobs(runId: string): StoredJob[] {
    return this.connection.query<StoredJob>(
      'SELECT * FROM gumiho_jobs WHERE project=? AND agent=? AND run_id=? ORDER BY created_at,id',
      [...this.scope, runId],
    );
  }

  job(runId: string, id: string): StoredJob | undefined {
    return this.connection.query<StoredJob>(
      'SELECT * FROM gumiho_jobs WHERE project=? AND agent=? AND run_id=? AND id=?',
      [...this.scope, runId, id],
    )[0];
  }

  currentJob(runId: string, id: string): StoredJob | undefined {
    const jobs = this.jobs(runId),
      visited = new Set<string>();
    let row = jobs.find((job) => job.id === id);
    while (row?.state === 'superseded') {
      if (visited.has(row.id)) throw new Error('Cyclic replacement history');
      visited.add(row.id);
      const next = jobs.find((job) => job.replaces_id === row!.id);
      if (!next) throw new Error('Superseded job has no replacement receipt');
      row = next;
    }
    return row;
  }

  createJob(lease: WorkspaceLease, input: JobInput): StoredJob {
    identity(input.id, 'job ID');
    identity(input.tailId, 'tail ID');
    if (!textValue(input.task, 'job task', MAX_JOB_TASK_BYTES).trim())
      throw new Error('A job task is required');
    const json = encode(input, MAX_JOB_BYTES),
      hash = fingerprint(input, MAX_JOB_BYTES);
    return this.mutate(lease, () => {
      const existing = this.job(lease.runId, input.id);
      if (existing) {
        if (existing.input_hash !== hash) throw new Error('Job replay input changed');
        return existing;
      }
      const jobs = this.jobs(lease.runId);
      if (jobs.length >= this.limits.maxJobs) throw new Error('Job budget exhausted');
      if (input.parentId && !jobs.some((job) => job.id === input.parentId))
        throw new Error('Unknown parent job');
      this.replaceFailedJob(lease, input);
      this.reserve(lease, Buffer.byteLength(json) + RESULT_RESERVE);
      this.connection.execute(
        `INSERT INTO gumiho_jobs(project,agent,run_id,id,tail_id,task,input_json,input_hash,parent_id,replaces_id,state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`,
        [
          ...this.scope,
          lease.runId,
          input.id,
          input.tailId,
          input.task,
          json,
          hash,
          input.parentId ?? null,
          input.replacesId ?? null,
          now(),
        ],
      );
      this.event(lease, 'job_created', {
        id: input.id,
        tailId: input.tailId,
        replacesId: input.replacesId ?? null,
      });
      return this.job(lease.runId, input.id)!;
    });
  }

  startJob(lease: WorkspaceLease, id: string): void {
    this.mutate(lease, () => {
      const changed = this.connection.execute(
        "UPDATE gumiho_jobs SET state='running' WHERE project=? AND agent=? AND run_id=? AND id=? AND state IN ('pending','running')",
        [...this.scope, lease.runId, id],
      );
      if (changed !== 1) throw new Error('Only unfinished jobs can start');
    });
  }

  finishJob(lease: WorkspaceLease, id: string, result: JobResult): void {
    validateJobResult(result);
    const json = encode(result, MAX_JOB_BYTES);
    this.mutate(lease, () => {
      const pending = this.connection.query<{ id: string }>(
        "SELECT id FROM gumiho_calls WHERE project=? AND agent=? AND run_id=? AND job_id=? AND state='pending' LIMIT 1",
        [...this.scope, lease.runId, id],
      );
      if (pending.length)
        throw new Error('Pending invocations must be resolved before completing a job');
      const changed = this.connection.execute(
        "UPDATE gumiho_jobs SET state=?,result_json=?,completed_at=? WHERE project=? AND agent=? AND run_id=? AND id=? AND state='running'",
        [result.success ? 'completed' : 'failed', json, now(), ...this.scope, lease.runId, id],
      );
      if (changed !== 1) throw new Error('Only running jobs can finish');
      this.refund(lease, RESULT_RESERVE - Buffer.byteLength(json));
      this.event(lease, 'job_finished', { id, success: result.success });
    });
  }

  unresolved(runId: string): StoredJob[] {
    return this.jobs(runId).filter((job) => !['completed', 'superseded'].includes(job.state));
  }

  reserveAttempt(lease: WorkspaceLease, kind: 'model' | 'tool', outputTokens = 0): void {
    if (kind === 'model')
      positiveInteger(outputTokens, 'request output budget', MAX_REQUEST_OUTPUT_TOKENS);
    else if (kind !== 'tool' || outputTokens !== 0)
      throw new Error('Invalid invocation budget reservation');
    this.mutate(lease, () => {
      const row = this.get(lease.runId);
      if (!row) throw new Error('Unknown run');
      const models = row.model_requests + Number(kind === 'model'),
        tools = row.tool_calls + Number(kind === 'tool'),
        output = row.output_reserved + outputTokens;
      if (
        models > this.limits.maxModelRequests ||
        tools > this.limits.maxToolCalls ||
        output > this.limits.maxOutputTokens
      )
        throw new Error('Gumiho execution budget exhausted');
      this.connection.execute(
        'UPDATE gumiho_runs SET model_requests=?,tool_calls=?,output_reserved=? WHERE project=? AND agent=? AND id=?',
        [models, tools, output, ...this.scope, lease.runId],
      );
      this.event(lease, 'attempt_reserved', { kind, outputTokens });
    });
  }

  receipt(runId: string, id: string): JsonValue | undefined {
    const row = this.connection.query<{ data_json: string }>(
      'SELECT data_json FROM gumiho_receipts WHERE project=? AND agent=? AND run_id=? AND id=?',
      [...this.scope, runId, id],
    )[0];
    return row ? (JSON.parse(row.data_json) as JsonValue) : undefined;
  }

  putReceipt(lease: WorkspaceLease, id: string, value: unknown): void {
    identity(id, 'receipt ID');
    const json = encode(value, MAX_RECEIPT_BYTES),
      hash = fingerprint(value, MAX_RECEIPT_BYTES);
    this.mutate(lease, () => {
      const existing = this.receipt(lease.runId, id);
      if (existing !== undefined) {
        if (fingerprint(existing, MAX_RECEIPT_BYTES) !== hash)
          throw new Error('Immutable receipt content changed');
        return;
      }
      this.reserve(lease, Buffer.byteLength(json));
      this.connection.execute('INSERT INTO gumiho_receipts VALUES(?,?,?,?,?,?,?)', [
        ...this.scope,
        lease.runId,
        id,
        hash,
        json,
        now(),
      ]);
    });
  }

  event(lease: WorkspaceLease, kind: string, data: JsonValue): void {
    const json = encode(data, 8192);
    this.mutate(lease, () => {
      this.reserve(lease, Buffer.byteLength(json) + 128);
      this.connection.execute(
        'INSERT INTO gumiho_events(project,agent,run_id,kind,data_json,created_at) VALUES(?,?,?,?,?,?)',
        [...this.scope, lease.runId, identity(kind, 'event kind'), json, now()],
      );
    });
  }

  reserve(lease: WorkspaceLease, bytes: number): void {
    positiveInteger(bytes, 'trace reservation', this.limits.maxTraceBytes);
    const changed = this.connection.execute(
      'UPDATE gumiho_runs SET trace_bytes=trace_bytes+? WHERE project=? AND agent=? AND id=? AND trace_bytes+?<=?',
      [bytes, ...this.scope, lease.runId, bytes, this.limits.maxTraceBytes],
    );
    if (changed !== 1) throw new Error('Durable trace budget exhausted');
  }

  refund(lease: WorkspaceLease, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RECEIPT_BYTES)
      throw new Error('Invalid trace refund');
    this.connection.execute(
      'UPDATE gumiho_runs SET trace_bytes=trace_bytes-? WHERE project=? AND agent=? AND id=?',
      [bytes, ...this.scope, lease.runId],
    );
  }

  private replaceFailedJob(lease: WorkspaceLease, input: JobInput): void {
    if (!input.replacesId) return;
    const previous = this.job(lease.runId, input.replacesId);
    if (
      !previous ||
      previous.state !== 'failed' ||
      previous.tail_id !== input.tailId ||
      previous.task !== input.task
    )
      throw new Error('A retry must replace a failed job with the same tail and task');
    this.connection.execute(
      "UPDATE gumiho_jobs SET state='superseded' WHERE project=? AND agent=? AND run_id=? AND id=?",
      [...this.scope, lease.runId, input.replacesId],
    );
  }
}

export function encode(value: unknown, maximum = 65536): string {
  return JSON.stringify(plainJson(value, maximum, 32768));
}
function scopeName(value: string): string {
  if (!textValue(value, 'scope name', 512).trim())
    throw new Error('Project and agent must be explicit');
  return value;
}
function validateJobResult(value: JobResult): void {
  if (
    !value ||
    typeof value.success !== 'boolean' ||
    !Array.isArray(value.modifiedFiles) ||
    value.modifiedFiles.length > 1024
  )
    throw new Error('Invalid job result');
  textValue(value.output, 'job output', 131072);
  for (const filename of value.modifiedFiles) textValue(filename, 'modified file', 4096);
  if (value.failure !== undefined) textValue(value.failure, 'job failure', 8192);
}
export function now(): string {
  return new Date().toISOString();
}
