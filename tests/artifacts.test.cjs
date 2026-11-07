const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  ArtifactScanner,
  artifactChanges,
  canonicalWorkspace,
  workspaceRelative,
} = require('../dist/artifacts');
const { commandVerifier } = require('../dist/command-verifier');
const { resolveCommand, runCheck } = require('../dist/check-command');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-gumiho-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const signal = () => new AbortController().signal;

test('snapshots bind exact bytes, newly created files and deletions across all source extensions', async (t) => {
  const root = await canonicalWorkspace(directory(t));
  for (const file of ['a.mts', 'b.cts', 'c.mjs', 'd.cjs', 'e.pyi', '한글, 파일.txt'])
    fs.writeFileSync(path.join(root, file), 'initial');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored'), 'dependency');
  fs.writeFileSync(path.join(root, 'mimir.db'), 'owned storage');
  const scanner = new ArtifactScanner(root, {
    excludePaths: ['mimir.db', 'mimir.db-wal', 'mimir.db-shm'],
  });
  const before = await scanner.scan(signal());
  assert.equal(before.files.length, 6);
  fs.writeFileSync(path.join(root, 'mimir.db'), 'new storage');
  fs.writeFileSync(path.join(root, 'mimir.db-wal'), 'wal');
  assert.equal((await scanner.scan(signal())).hash, before.hash);
  fs.writeFileSync(path.join(root, 'a.mts'), 'changed');
  fs.unlinkSync(path.join(root, 'b.cts'));
  fs.writeFileSync(path.join(root, 'fresh.rs'), 'new');
  const after = await scanner.scan(signal()),
    changes = artifactChanges(before, after);
  assert.notEqual(before.hash, after.hash);
  assert.deepEqual(
    changes.map((change) => change.path),
    ['a.mts', 'b.cts', 'fresh.rs'],
  );
  assert.equal(changes[1].after, null);
  assert.equal(changes[2].before, null);
  assert.equal((await scanner.scan(signal())).hash, after.hash);
  assert.equal(workspaceRelative(root, path.join(root, '한글, 파일.txt')), '한글, 파일.txt');
  assert.throws(() => workspaceRelative(root, '../outside'), /outside/);
  assert.throws(() => workspaceRelative(root, 'a.txt:stream'), /Invalid|outside/);
  assert.throws(() => workspaceRelative(root, root), /outside/);
});

test('snapshot limits, exclusions and cancellation fail explicitly with bounded reads', async (t) => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'a'), '12345');
  fs.writeFileSync(path.join(root, 'b'), '67890');
  await assert.rejects(new ArtifactScanner(root, { maxFiles: 1 }).scan(signal()), /file limit/);
  await assert.rejects(new ArtifactScanner(root, { maxFileBytes: 4 }).scan(signal()), /oversized/);
  await assert.rejects(
    new ArtifactScanner(root, { maxTotalBytes: 9 }).scan(signal()),
    /total byte/,
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled fixture'));
  await assert.rejects(new ArtifactScanner(root).scan(controller.signal), /cancelled fixture/);
  assert.throws(
    () => new ArtifactScanner(root, { excludeDirectories: ['../outside'] }),
    /directory names/,
  );
  assert.throws(() => new ArtifactScanner(root, { excludeDirectories: ['..'] }), /directory names/);
  assert.throws(() => new ArtifactScanner(root, { excludePaths: ['../outside'] }), /outside/);
  await assert.rejects(canonicalWorkspace(path.join(root, 'a')), /directory/);
});

test('symbolic links are hashed as links without following foreign directory contents', async (t) => {
  const root = directory(t),
    outside = directory(t);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside bytes');
  const link = path.join(root, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const scanner = new ArtifactScanner(root),
    before = await scanner.scan(signal());
  assert.equal(before.files.length, 1);
  assert.equal(before.files[0].kind, 'symlink');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'changed outside bytes');
  assert.equal((await scanner.scan(signal())).hash, before.hash);
});

test('a workspace directory alias is canonicalized before reading its artifact files', async (t) => {
  const root = directory(t),
    parent = directory(t),
    alias = path.join(parent, 'alias');
  fs.writeFileSync(path.join(root, 'file.txt'), 'contents');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await new ArtifactScanner(alias).scan(signal())).files[0].path, 'file.txt');
});

test(
  'special filesystem nodes fail before a blocking open',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = directory(t);
    execFileSync('mkfifo', [path.join(root, 'named-pipe')]);
    await assert.rejects(
      new ArtifactScanner(root).scan(signal()),
      /Unsupported artifact file type/,
    );
  },
);

test('native command checks execute actual file assertions and retain nonzero exits with the snapshot hash', async (t) => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'output.txt'), 'verified bytes');
  const scanner = new ArtifactScanner(root),
    snapshot = await scanner.scan(signal());
  const definitions = [
    {
      id: 'content',
      command: process.execPath,
      args: [
        '-e',
        "require('node:assert/strict').equal(require('node:fs').readFileSync('output.txt','utf8'),'verified bytes');console.log('content verified')",
      ],
    },
  ];
  const verifier = commandVerifier(definitions, 'fixture-1');
  definitions[0].args = [];
  const context = {
    workspaceRoot: root,
    runId: 'run-1',
    snapshot,
    modifiedFiles: ['output.txt'],
    signal: signal(),
  };
  const pass = await verifier.verify(context);
  assert.equal(pass.success, true);
  assert.equal(pass.evidence.snapshotHash, snapshot.hash);
  assert.match(pass.evidence.checks[0].stdout, /content verified/);
  assert.equal(pass.evidence.checks[0].exitCode, 0);
  fs.writeFileSync(path.join(root, 'output.txt'), 'wrong bytes');
  const fail = await verifier.verify(context);
  assert.equal(fail.success, false);
  assert.notEqual(fail.evidence.checks[0].exitCode, 0);
  assert.notEqual((await scanner.scan(signal())).hash, snapshot.hash);
  assert.throws(() => commandVerifier([], '1'), /1 through 16/);
  assert.throws(
    () =>
      commandVerifier(
        [
          { id: 'same', command: 'x' },
          { id: 'same', command: 'y' },
        ],
        '1',
      ),
    /Duplicate/,
  );
});

test('native command spawn errors, deadlines, cancellation and output limits produce failed receipts', async (t) => {
  const root = directory(t);
  const missing = await runCheck(
    resolveCommand({ id: 'missing', command: path.join(root, 'missing-executable') }),
    root,
    signal(),
  );
  assert.equal(missing.success, false);
  assert.equal(missing.failure, 'spawn_failed');
  const hanging = resolveCommand({
    id: 'hang',
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 100,
  });
  const start = Date.now(),
    timeout = await runCheck(hanging, root, signal());
  assert.equal(timeout.failure, 'timeout');
  assert.ok(Date.now() - start < 2500);
  const controller = new AbortController(),
    pending = runCheck({ ...hanging, timeoutMs: 5000 }, root, controller.signal);
  setTimeout(() => controller.abort(), 30);
  assert.equal((await pending).failure, 'cancelled');
  const output = await runCheck(
    resolveCommand({
      id: 'chatty',
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],
      maxOutputBytes: 128,
    }),
    root,
    signal(),
  );
  assert.equal(output.failure, 'output_limit');
  assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 128);
});
