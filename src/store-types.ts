// Public receipts use the same project, agent and session identifiers as Soul and N2R.
import type { MimirDatabase } from 'n2-mimir/storage';
import type { JsonValue } from './types';
export type SqlConnection = MimirDatabase['reasoning']['connection'];
export interface StorageLimits {
  maxJobs: number;
  maxModelRequests: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxTraceBytes: number;
}
export interface RunInput {
  runId: string;
  sessionId: string;
  task: string;
  workspaceRoot: string;
  configHash: string;
  mode: 'pipeline' | 'coordinator';
  modifiedFiles: string[];
}
export interface StoredRun {
  id: string;
  session_id: string;
  request_hash: string;
  input_json: string;
  model_requests: number;
  tool_calls: number;
  output_reserved: number;
  trace_bytes: number;
}
export interface JobInput {
  id: string;
  tailId: string;
  task: string;
  context: JsonValue;
  parentId?: string;
  replacesId?: string;
}
export interface JobResult {
  success: boolean;
  output: string;
  modifiedFiles: string[];
  failure?: string;
}
export interface StoredJob {
  id: string;
  tail_id: string;
  task: string;
  input_json: string;
  input_hash: string;
  parent_id: string | null;
  replaces_id: string | null;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'superseded';
  result_json: string | null;
}
export interface CallInput {
  id: string;
  jobId: string;
  kind: 'model' | 'tool';
  name: string;
  version: string;
  arguments: JsonValue;
  idempotent: boolean;
  readOnly: boolean;
}
export interface StoredCall {
  id: string;
  job_id: string;
  kind: 'model' | 'tool';
  input_hash: string;
  input_json: string;
  idempotent: number;
  read_only: number;
  state: 'pending' | 'completed';
  result_json: string | null;
  reconciliation: string | null;
}
export class ReconciliationRequired extends Error {
  constructor(
    readonly runId: string,
    readonly callId: string,
  ) {
    super(
      `Invocation ${callId} has an uncertain outcome. Reconcile it before resuming run ${runId}`,
    );
    this.name = 'ReconciliationRequired';
  }
}
