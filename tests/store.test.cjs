const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { MimirDatabase } = require('n2-mimir/storage');
const { GumihoStore } = require('../dist/run-store');
const { ReconciliationRequired } = require('../dist/store-types');
const { fixture, begin, job, call, limits } = require('./store-fixture.cjs');

test('common storage scopes, input identity and immutable receipts survive reopening', (t) => {
  const f = fixture(t),
    lease = begin(f);
  job(f, lease);
  f.store.putReceipt(lease, 'snapshot', { files: [{ path: 'a.txt', hash: 'fixture' }] });
  f.store.putReceipt(lease, 'snapshot', { files: [{ path: 'a.txt', hash: 'fixture' }] });
  assert.throws(() => f.store.putReceipt(lease, 'snapshot', { files: [] }), /Immutable/);
  assert.throws(() => f.store.begin(lease, { ...f.input, task: 'different' }), /different/);
  assert.throws(
    () => f.store.createJob(lease, { id: 'job-1', tailId: 'build', task: 'changed', context: {} }),
    /changed/,
  );
  lease.release();
  f.memory.close();
  const reopened = f.open();
  assert.equal(reopened.store.get('run-1').session_id, 'session-1');
  assert.deepEqual(reopened.store.receipt('run-1', 'snapshot'), {
    files: [{ path: 'a.txt', hash: 'fixture' }],
  });
  const foreign = f.open('other project');
  assert.equal(foreign.store.get('run-1'), undefined);
  assert.deepEqual(foreign.store.jobs('run-1'), []);
  assert.deepEqual(reopened.store.connection.query('PRAGMA foreign_key_check'), []);
  assert.deepEqual(reopened.store.connection.query('PRAGMA integrity_check'), [
    { integrity_check: 'ok' },
  ]);
});

test('unknown non-idempotent effects require reconciliation and completed calls replay without rerunning', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  job(f, lease);
  assert.equal(f.journal.prepare(lease, call()).state, 'pending');
  assert.throws(() => f.journal.prepare(lease, call()), ReconciliationRequired);
  assert.throws(
    () => f.store.finishJob(lease, 'job-1', { success: true, output: 'done', modifiedFiles: [] }),
    /Pending/,
  );
  await assert.rejects(
    f.journal.completeTool(lease, 'call-1', { success: true, output: 'verified' }, ''),
    /evidence/,
  );
  await f.journal.completeTool(
    lease,
    'call-1',
    { success: true, output: 'verified', modifiedFiles: ['output.txt'] },
    'Read back output.txt and compared its expected bytes',
  );
  const completed = f.journal.prepare(lease, call());
  assert.equal(completed.state, 'completed');
  assert.match(completed.reconciliation, /Read back/);
  assert.throws(
    () => f.journal.prepare(lease, { ...call(), arguments: { path: 'other.txt' } }),
    /diverged/,
  );
  f.store.finishJob(lease, 'job-1', {
    success: true,
    output: 'done',
    modifiedFiles: ['output.txt'],
  });
  assert.equal(f.store.unresolved('run-1').length, 0);
  assert.throws(
    () => f.store.finishJob(lease, 'job-1', { success: true, output: 'again', modifiedFiles: [] }),
    /Only running/,
  );
  lease.release();
});

test('idempotent pending calls may retry while completion enforces readonly and bounded result semantics', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  job(f, lease);
  const input = { ...call('read', true), readOnly: true };
  f.journal.prepare(lease, input);
  assert.equal(f.journal.prepare(lease, input).state, 'pending');
  await assert.rejects(
    f.journal.completeTool(lease, 'read', { success: true, output: 'bad', modifiedFiles: ['a'] }),
    /read-only/,
  );
  await assert.rejects(
    f.journal.completeTool(lease, 'read', { success: true, output: '\uD800' }),
    /Invalid/,
  );
  assert.equal(f.journal.get('run-1', 'read').state, 'pending');
  await f.journal.completeTool(lease, 'read', { success: true, output: 'read' });
  assert.equal(f.journal.get('run-1', 'read').state, 'completed');
  assert.throws(
    () => f.store.finishJob(lease, 'job-1', { success: 'yes', output: 'done', modifiedFiles: [] }),
    /Invalid/,
  );
  lease.release();
});

test('previous failures remain unresolved across later rounds and retries retain their failed lineage', (t) => {
  const f = fixture(t),
    lease = begin(f),
    initial = job(f, lease);
  f.store.finishJob(lease, initial.id, {
    success: false,
    output: 'verification failed',
    modifiedFiles: [],
    failure: 'test failure',
  });
  job(f, lease, 'unrelated');
  f.store.finishJob(lease, 'unrelated', { success: true, output: 'done', modifiedFiles: [] });
  assert.deepEqual(
    f.store.unresolved('run-1').map((row) => row.id),
    ['job-1'],
  );
  assert.throws(
    () =>
      f.store.createJob(lease, {
        ...initial,
        id: 'bad-retry',
        task: 'unrelated goal',
        replacesId: initial.id,
      }),
    /same tail and task/,
  );
  f.store.createJob(lease, {
    ...initial,
    id: 'retry',
    context: { previousFailure: 'test failure' },
    replacesId: initial.id,
  });
  assert.equal(f.store.job('run-1', 'job-1').state, 'superseded');
  assert.deepEqual(
    f.store.unresolved('run-1').map((row) => row.id),
    ['retry'],
  );
  f.store.startJob(lease, 'retry');
  f.store.finishJob(lease, 'retry', { success: false, output: 'still failing', modifiedFiles: [] });
  f.store.createJob(lease, { ...initial, id: 'retry-2', replacesId: 'retry' });
  f.store.startJob(lease, 'retry-2');
  f.store.finishJob(lease, 'retry-2', { success: true, output: 'fixed', modifiedFiles: [] });
  assert.equal(f.store.unresolved('run-1').length, 0);
  assert.equal(JSON.parse(f.store.job('run-1', 'job-1').result_json).success, false);
  lease.release();
});

test('workspace leases exclude other owners and stale nonce holders cannot persist or release new ownership', (t) => {
  const f = fixture(t),
    lease = begin(f),
    other = f.open('other');
  assert.throws(() => other.store.acquire('run-2', f.directory), /active/);
  f.store.connection.execute('UPDATE gumiho_leases SET expires_at=0');
  const replacement = other.store.acquire('run-2', f.directory);
  assert.throws(() => f.store.putReceipt(lease, 'stale', {}), /lost/);
  assert.throws(() => other.store.mutate(lease, () => {}), /Foreign/);
  lease.release();
  replacement.assert();
  replacement.release();
});

test('budget exhaustion rolls back reservations and replacement jobs atomically', (t) => {
  const f = fixture(t, { maxJobs: 1, maxModelRequests: 1, maxToolCalls: 1, maxOutputTokens: 256 }),
    lease = begin(f),
    initial = job(f, lease);
  f.store.reserveAttempt(lease, 'model', 256);
  f.store.reserveAttempt(lease, 'tool');
  assert.throws(() => f.store.reserveAttempt(lease, 'model', 1), /budget exhausted/);
  assert.throws(() => f.store.reserveAttempt(lease, 'tool'), /budget exhausted/);
  assert.throws(() => f.store.reserveAttempt(lease, 'tool', -1), /Invalid/);
  const row = f.store.get('run-1');
  assert.equal(row.model_requests, 1);
  assert.equal(row.tool_calls, 1);
  assert.equal(row.output_reserved, 256);
  f.store.finishJob(lease, initial.id, { success: false, output: 'failed', modifiedFiles: [] });
  assert.throws(
    () => f.store.createJob(lease, { ...initial, id: 'retry', replacesId: initial.id }),
    /Job budget/,
  );
  assert.equal(f.store.job('run-1', 'job-1').state, 'failed');
  lease.release();
});

test('storage failure during completion leaves its pending receipt, budget and job state intact', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  job(f, lease);
  f.journal.prepare(lease, call());
  const before = f.store.get('run-1').trace_bytes;
  f.store.connection.execute(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON gumiho_events WHEN NEW.kind='invocation_completed' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
  );
  await assert.rejects(
    f.journal.completeTool(lease, 'call-1', { success: true, output: 'done' }),
    /fixture disk failure/,
  );
  assert.equal(f.journal.get('run-1', 'call-1').state, 'pending');
  assert.equal(f.store.get('run-1').trace_bytes, before);
  f.store.connection.execute('DROP TRIGGER fail_receipt');
  await f.journal.completeTool(
    lease,
    'call-1',
    { success: true, output: 'done' },
    'Confirmed previously executed fixture effect',
  );
  assert.ok(f.store.get('run-1').trace_bytes < before);
  lease.release();
});

test('unversioned and unsupported module schemas fail without altering common or foreign data', (t) => {
  const f = fixture(t),
    legacyFile = path.join(f.directory, 'legacy.db'),
    legacy = new MimirDatabase(legacyFile);
  try {
    const db = legacy.reasoning.connection;
    db.execute('CREATE TABLE gumiho_legacy(value TEXT)');
    db.execute("INSERT INTO gumiho_legacy VALUES('preserve')");
    assert.throws(() => new GumihoStore(legacy, 'demo', 'worker', limits), /explicit migration/);
    assert.deepEqual(db.query('SELECT * FROM gumiho_legacy'), [{ value: 'preserve' }]);
    assert.deepEqual(db.query("SELECT value FROM meta WHERE key='gumiho_schema_version'"), []);
    f.store.connection.execute("UPDATE meta SET value='999' WHERE key='gumiho_schema_version'");
    assert.throws(() => new GumihoStore(f.memory, 'demo', 'worker', limits), /Unsupported/);
  } finally {
    legacy.close();
  }
});

test('a killed process releases ownership by dead PID while uncertain side effects remain blocked', async (t) => {
  const f = fixture(t);
  f.memory.close();
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'store-crash-child.cjs'), f.dbPath, f.directory],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Child exited before its receipt ${code} ${stderr}`)),
    );
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(fs.readFileSync(path.join(f.directory, 'effect.txt'), 'utf8'), 'written once');
  const reopened = f.open(),
    lease = reopened.store.acquire('run-1', f.directory);
  reopened.store.begin(lease, f.input);
  assert.throws(() => reopened.journal.prepare(lease, call()), ReconciliationRequired);
  await reopened.journal.completeTool(
    lease,
    'call-1',
    { success: true, output: 'read back', modifiedFiles: ['effect.txt'] },
    'Verified the killed process wrote effect.txt exactly once',
  );
  assert.equal(reopened.journal.prepare(lease, call()).state, 'completed');
  lease.release();
});
