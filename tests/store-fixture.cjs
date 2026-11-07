const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MimirDatabase } = require('n2-mimir/storage');
const { GumihoStore } = require('../dist/run-store');
const { CallJournal } = require('../dist/call-journal');
const limits = {
  maxJobs: 16,
  maxModelRequests: 16,
  maxToolCalls: 32,
  maxOutputTokens: 32768,
  maxTraceBytes: 8388608,
};
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'n2-gumiho-'));
  const dbPath = path.join(directory, 'mimir.db');
  const databases = [];
  const open = (project = 'demo project', agent = 'worker') => {
    const memory = new MimirDatabase(dbPath);
    databases.push(memory);
    const store = new GumihoStore(memory, project, agent, { ...limits, ...overrides });
    return { memory, store, journal: new CallJournal(store) };
  };
  const current = open();
  t.after(() => {
    for (const memory of databases) if (!memory.isClosed) memory.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input = {
    runId: 'run-1',
    sessionId: 'session-1',
    task: 'Complete a fixture task',
    workspaceRoot: directory,
    configHash: 'configuration-1',
    mode: 'pipeline',
    modifiedFiles: [],
  };
  return { ...current, open, directory, dbPath, input };
}
function begin(f) {
  const lease = f.store.acquire(f.input.runId, f.directory);
  f.store.begin(lease, f.input);
  return lease;
}
function job(f, lease, id = 'job-1') {
  const input = { id, tailId: 'build', task: 'Write a fixture', context: {} };
  f.store.createJob(lease, input);
  f.store.startJob(lease, id);
  return input;
}
function call(id = 'call-1', idempotent = false) {
  return {
    id,
    jobId: 'job-1',
    kind: 'tool',
    name: 'write',
    version: '1',
    arguments: { path: 'output.txt' },
    idempotent,
    readOnly: false,
  };
}
exports.fixture = fixture;
exports.begin = begin;
exports.job = job;
exports.call = call;
exports.limits = limits;
