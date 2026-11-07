// Coordinate workflows sharing this database and canonical workspace, with nonce-fenced writes.
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from './store-types';

const LEASE_MS = 30000;
interface LeaseRow {
  project: string;
  agent: string;
  nonce: string;
  process_id: number;
  expires_at: number;
}

export class WorkspaceLease {
  readonly nonce = randomUUID();
  readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: SqlConnection,
    readonly scope: readonly string[],
    readonly runId: string,
    readonly workspaceRoot: string,
  ) {
    db.transaction(() => {
      const existing = db.query<LeaseRow>(
        'SELECT * FROM gumiho_leases WHERE (project=? AND agent=?) OR workspace_root=?',
        [...scope, workspaceRoot],
      );
      for (const row of existing) {
        if (row.expires_at > Date.now() && processAlive(row.process_id))
          throw new Error('This scope or workspace already has an active Gumiho workflow');
        db.execute('DELETE FROM gumiho_leases WHERE project=? AND agent=? AND nonce=?', [
          row.project,
          row.agent,
          row.nonce,
        ]);
      }
      db.execute('INSERT INTO gumiho_leases VALUES(?,?,?,?,?,?,?)', [
        ...scope,
        runId,
        workspaceRoot,
        this.nonce,
        process.pid,
        Date.now() + LEASE_MS,
      ]);
    });
    this.timer = setInterval(() => this.renew(), LEASE_MS / 3);
    this.timer.unref();
  }

  assert(): void {
    this.controller.signal.throwIfAborted();
    const row = this.db.query<LeaseRow>(
      'SELECT * FROM gumiho_leases WHERE project=? AND agent=?',
      this.scope,
    )[0];
    if (!row || row.nonce !== this.nonce || row.expires_at <= Date.now())
      throw new Error('Gumiho workspace lease was lost or expired');
  }

  release(): void {
    clearInterval(this.timer);
    this.controller.abort(new Error('Gumiho operation ended'));
    this.db.execute('DELETE FROM gumiho_leases WHERE project=? AND agent=? AND nonce=?', [
      ...this.scope,
      this.nonce,
    ]);
  }

  private renew(): void {
    try {
      this.db.transaction(() => {
        this.assert();
        this.db.execute(
          'UPDATE gumiho_leases SET expires_at=? WHERE project=? AND agent=? AND nonce=?',
          [Date.now() + LEASE_MS, ...this.scope, this.nonce],
        );
      });
    } catch (error) {
      clearInterval(this.timer);
      this.controller.abort(error);
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
