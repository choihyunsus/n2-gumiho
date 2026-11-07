const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { MimirDatabase } = require('n2-mimir/storage');
const { GumihoStore } = require('../dist/run-store');
const { CallJournal } = require('../dist/call-journal');
const { limits, call } = require('./store-fixture.cjs');
const [dbPath, directory] = process.argv.slice(2),
  memory = new MimirDatabase(dbPath);
const store = new GumihoStore(memory, 'demo project', 'worker', limits),
  journal = new CallJournal(store);
const lease = store.acquire('run-1', directory);
store.begin(lease, {
  runId: 'run-1',
  sessionId: 'session-1',
  task: 'Complete a fixture task',
  workspaceRoot: directory,
  configHash: 'configuration-1',
  mode: 'pipeline',
  modifiedFiles: [],
});
store.createJob(lease, { id: 'job-1', tailId: 'build', task: 'Write a fixture', context: {} });
store.startJob(lease, 'job-1');
journal.prepare(lease, call());
writeFileSync(path.join(directory, 'effect.txt'), 'written once');
process.stdout.write('effect complete\n');
setInterval(() => {}, 1000);
