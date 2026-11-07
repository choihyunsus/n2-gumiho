const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { inspectGumiho, Gumiho } = require('../dist/library');
const { parseArguments } = require('../dist/cli-args');
const { loadResult } = require('../dist/cli-adapter');
const executable = path.resolve(__dirname, '../dist/index.js');
const adapter = path.resolve(__dirname, '../examples/file-task.cjs');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-gumiho-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function cli(args) {
  return spawnSync(process.execPath, [executable, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 2097152,
  });
}
function scope(root, id = 'demo') {
  return [
    '--db',
    path.join(root, 'mimir.db'),
    '--project',
    'demo',
    '--agent',
    'worker',
    '--run-id',
    id,
  ];
}
function runArguments(root, mode = 'pipeline', module = adapter) {
  return [
    'run',
    ...scope(root),
    '--workspace',
    root,
    '--adapter',
    module,
    '--task',
    'Create the demonstration file',
    '--mode',
    mode,
  ];
}
function fileHash(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

for (const mode of ['pipeline', 'coordinator'])
  test(`CLI ${mode} runs its shipped offline adapter, reports status and replays across separate processes`, (t) => {
    const root = directory(t),
      first = cli(runArguments(root, mode));
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.success, true);
    assert.equal(result.lifecycle.phases.length, 4);
    assert.equal(
      fs.readFileSync(path.join(root, 'gumiho-demo.txt'), 'utf8'),
      'hello from gumiho\n',
    );
    const second = cli(runArguments(root, mode));
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), result);
    const before = fileHash(path.join(root, 'mimir.db')),
      status = cli(['status', ...scope(root)]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).lifecycle.success, true);
    assert.equal(fileHash(path.join(root, 'mimir.db')), before);
    assert.equal(cli(['status', ...scope(root, 'absent')]).status, 3);
    const inspected = inspectGumiho({
      dbPath: path.join(root, 'mimir.db'),
      project: 'demo',
      agent: 'worker',
      runId: 'demo',
    });
    assert.equal(inspected.run.mode, mode);
    assert.ok(inspected.calls.some((call) => call.name === 'write_demo'));
    assert.equal(
      inspectGumiho({
        dbPath: path.join(root, 'mimir.db'),
        project: 'foreign',
        agent: 'worker',
        runId: 'demo',
      }),
      undefined,
    );
  });

test('CLI imports an operator-selected ESM adapter and preserves an existing different file on failure', (t) => {
  const root = directory(t),
    esm = path.join(root, 'adapter.mjs');
  fs.writeFileSync(
    esm,
    `import adapter from ${JSON.stringify(pathToFileURL(adapter).href)};\nexport default adapter;\n`,
  );
  fs.writeFileSync(path.join(root, 'gumiho-demo.txt'), 'existing user content');
  const failed = cli(runArguments(root, 'pipeline', esm));
  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).success, false);
  assert.equal(
    fs.readFileSync(path.join(root, 'gumiho-demo.txt'), 'utf8'),
    'existing user content',
  );
});

test('CLI argument and result-file validation rejects unsupported input before workflow effects', async (t) => {
  const root = directory(t),
    missing = path.join(root, 'missing.db');
  assert.equal(cli(['--version']).stdout.trim(), '1.0.1');
  assert.match(cli(['--help']).stdout, /reconcile/);
  assert.equal(
    cli(['status', '--db', missing, '--project', 'demo', '--agent', 'worker', '--run-id', 'x'])
      .status,
    1,
  );
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => parseArguments(['run', '--db', 'a', '--db', 'b']), /duplicate/);
  assert.throws(() => parseArguments(['status', '--unknown', 'value']), /Unknown/);
  assert.throws(() => parseArguments(['run']), /Missing/);
  const malformed = path.join(root, 'result.json');
  fs.writeFileSync(malformed, '{invalid');
  await assert.rejects(loadResult(malformed));
  fs.writeFileSync(malformed, Buffer.alloc(131073));
  await assert.rejects(loadResult(malformed), /128 KiB/);
  fs.writeFileSync(malformed, Buffer.from([255]));
  await assert.rejects(loadResult(malformed));
});

test('CLI reconciliation resumes a pending host effect using its saved child invocation', async (t) => {
  const root = directory(t),
    file = path.join(root, 'adapter.cjs');
  fs.writeFileSync(
    file,
    `const base=require(${JSON.stringify(adapter)});\nmodule.exports={...base,tools:base.tools.map(tool=>({...tool,idempotent:false,execute(args,context){tool.execute(args,context);throw new Error('effect interrupted');}}))};\n`,
  );
  const first = cli(runArguments(root, 'pipeline', file));
  assert.equal(first.status, 1);
  assert.match(first.stderr, /effect interrupted/);
  const status = JSON.parse(cli(['status', ...scope(root)]).stdout),
    call = status.calls.find((call) => call.kind === 'tool' && call.name === 'write_demo');
  assert.equal(call.state, 'pending');
  const resultFile = path.join(root, 'reconciled.json');
  fs.writeFileSync(
    resultFile,
    JSON.stringify({
      success: true,
      output: 'Verified demonstration bytes',
      modifiedFiles: ['gumiho-demo.txt'],
    }),
  );
  const reconcile = cli([
    'reconcile',
    ...scope(root),
    '--workspace',
    root,
    '--adapter',
    file,
    '--call-id',
    call.id,
    '--result',
    resultFile,
    '--evidence',
    'Read back the exact demonstration file bytes',
  ]);
  assert.equal(reconcile.status, 0, reconcile.stderr);
  const resumed = cli(runArguments(root, 'pipeline', file));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).success, true);
  const loaded = require(file),
    app = await Gumiho.create({
      ...loaded,
      dbPath: path.join(root, 'mimir.db'),
      workspaceRoot: root,
      project: 'demo',
      agent: 'worker',
    });
  try {
    assert.equal(
      app.status('demo').calls.find((row) => row.id === call.id).reconciliation,
      'Read back the exact demonstration file bytes',
    );
  } finally {
    await app.close();
  }
});
