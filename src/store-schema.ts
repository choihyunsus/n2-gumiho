// Add only namespaced tables and refuse ambiguous ownership or unsupported on-disk revisions.
import type { SqlConnection } from './store-types';

export function initializeStore(connection: SqlConnection): void {
  connection.transaction(() => {
    const version = connection.query<{ value: string }>(
      "SELECT value FROM meta WHERE key='gumiho_schema_version'",
    )[0];
    const existing = connection.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'gumiho_*'",
    );
    if (version && version.value !== '1') throw new Error('Unsupported Gumiho schema version');
    if (!version && existing.length)
      throw new Error('Unversioned Gumiho tables require explicit migration');
    for (const table of existing) {
      const columns = connection.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [
        table.name,
      ]);
      if (!['project', 'agent'].every((name) => columns.some((column) => column.name === name)))
        throw new Error('Unscoped Gumiho tables require explicit migration');
    }
    for (const statement of STATEMENTS) connection.execute(statement);
    connection.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('gumiho_schema_version','1')");
  });
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS gumiho_runs (
    project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, input_json TEXT NOT NULL, limits_json TEXT NOT NULL,
    model_requests INTEGER NOT NULL DEFAULT 0 CHECK(model_requests>=0),
    tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls>=0),
    output_reserved INTEGER NOT NULL DEFAULT 0 CHECK(output_reserved>=0),
    trace_bytes INTEGER NOT NULL DEFAULT 0 CHECK(trace_bytes>=0),
    created_at TEXT NOT NULL, PRIMARY KEY(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS gumiho_jobs (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
    tail_id TEXT NOT NULL, task TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
    parent_id TEXT, replaces_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','superseded')),
    result_json TEXT, created_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY(project,agent,run_id,id), UNIQUE(project,agent,run_id,replaces_id),
    FOREIGN KEY(project,agent,run_id) REFERENCES gumiho_runs(project,agent,id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS gumiho_calls (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
    job_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
    input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
    idempotent INTEGER NOT NULL CHECK(idempotent IN (0,1)), read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
    state TEXT NOT NULL CHECK(state IN ('pending','completed')), result_json TEXT, reconciliation TEXT,
    started_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(project,agent,run_id,id),
    FOREIGN KEY(project,agent,run_id,job_id) REFERENCES gumiho_jobs(project,agent,run_id,id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS gumiho_leases (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, workspace_root TEXT NOT NULL UNIQUE,
    nonce TEXT NOT NULL, process_id INTEGER NOT NULL CHECK(process_id>0), expires_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent))`,
  `CREATE TABLE IF NOT EXISTS gumiho_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, agent TEXT NOT NULL,
    run_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(project,agent,run_id) REFERENCES gumiho_runs(project,agent,id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS gumiho_receipts (
    project TEXT NOT NULL, agent TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
    content_hash TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project,agent,run_id,id),
    FOREIGN KEY(project,agent,run_id) REFERENCES gumiho_runs(project,agent,id) ON DELETE CASCADE)`,
  'CREATE INDEX IF NOT EXISTS idx_gumiho_events_scope ON gumiho_events(project,agent,run_id,id)',
];
