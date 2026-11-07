// Read one consistent SQLite snapshot without creating tables, migrating data or loading an adapter.
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RunReceipt } from 'n2-recipe';
import type { StoredJob, StoredCall } from './store-types';
import type { VerificationReceipt } from './verification';
import { identity, textValue } from './values';
import { recipeRunId } from './gumiho';

export interface InspectionOptions {
  dbPath: string;
  project: string;
  agent: string;
  runId: string;
}
export interface GumihoInspection {
  run: {
    id: string;
    session_id: string;
    mode: string;
    task: string;
    model_requests: number;
    tool_calls: number;
    output_reserved: number;
    trace_bytes: number;
    created_at: string;
  };
  jobs: Array<Pick<StoredJob, 'id' | 'tail_id' | 'state' | 'parent_id' | 'replaces_id'>>;
  calls: Array<
    Pick<StoredCall, 'id' | 'job_id' | 'kind' | 'state' | 'idempotent' | 'read_only'> & {
      name: string;
    }
  >;
  lifecycle: RunReceipt | null;
  verification: VerificationReceipt | null;
}

export function inspectGumiho(options: InspectionOptions): GumihoInspection | undefined {
  const filename = textValue(options.dbPath, 'database path', 4096),
    project = textValue(options.project, 'project', 512),
    agent = textValue(options.agent, 'agent', 512);
  const runId = identity(options.runId, 'run ID');
  if (!filename.trim() || !project.trim() || !agent.trim())
    throw new Error('Database path, project and agent are required');
  const db = new Database(path.resolve(filename), {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    return db.transaction(() => inspectSnapshot(db, project, agent, runId))();
  } finally {
    db.close();
  }
}

function inspectSnapshot(
  db: Database.Database,
  project: string,
  agent: string,
  runId: string,
): GumihoInspection | undefined {
  requireSchema(db, 'gumiho');
  const run = db
    .prepare(
      `SELECT id,session_id,json_extract(input_json,'$.mode') AS mode,json_extract(input_json,'$.task') AS task,
    model_requests,tool_calls,output_reserved,trace_bytes,created_at FROM gumiho_runs WHERE project=? AND agent=? AND id=?`,
    )
    .get(project, agent, runId) as GumihoInspection['run'] | undefined;
  if (!run) return undefined;
  requireSchema(db, 'n2r');
  const jobs = db
    .prepare(
      'SELECT id,tail_id,state,parent_id,replaces_id FROM gumiho_jobs WHERE project=? AND agent=? AND run_id=? ORDER BY created_at,id LIMIT 257',
    )
    .all(project, agent, runId) as GumihoInspection['jobs'];
  const calls = db
    .prepare(
      `SELECT id,job_id,kind,state,idempotent,read_only,json_extract(input_json,'$.name') AS name
    FROM gumiho_calls WHERE project=? AND agent=? AND run_id=? ORDER BY started_at,id LIMIT 6001`,
    )
    .all(project, agent, runId) as GumihoInspection['calls'];
  if (jobs.length > 256 || calls.length > 6000)
    throw new Error('Stored execution exceeds inspection bounds');
  const lifecycle = db
    .prepare('SELECT result_json FROM n2r_runs WHERE project=? AND agent=? AND id=?')
    .get(project, agent, recipeRunId(runId)) as { result_json: string | null } | undefined;
  const verification = db
    .prepare(
      "SELECT data_json FROM gumiho_receipts WHERE project=? AND agent=? AND run_id=? AND id='completion-proof'",
    )
    .get(project, agent, runId) as { data_json: string } | undefined;
  return {
    run,
    jobs,
    calls,
    lifecycle: lifecycle?.result_json ? (JSON.parse(lifecycle.result_json) as RunReceipt) : null,
    verification: verification ? (JSON.parse(verification.data_json) as VerificationReceipt) : null,
  };
}

function requireSchema(db: Database.Database, name: 'gumiho' | 'n2r'): void {
  const version = db.prepare('SELECT value FROM meta WHERE key=?').get(`${name}_schema_version`) as
    | { value: string }
    | undefined;
  if (version?.value !== '1')
    throw new Error(`An initialized ${name} schema version 1 is required`);
}
