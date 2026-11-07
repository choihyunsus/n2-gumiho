const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tools = require('../examples/workspace-tools.cjs');
const read = tools.find((tool) => tool.name === 'read_text'),
  write = tools.find((tool) => tool.name === 'write_text');
function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-gumiho-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspaceRoot: root, signal: new AbortController().signal };
}

test('the shipped demonstration verifier records missing or unreadable output as failed evidence', (t) => {
  const ctx = context(t),
    adapter = require('../examples/file-task.cjs');
  const missing = adapter.verifier.verify(ctx);
  assert.equal(missing.success, false);
  assert.equal(missing.evidence.sha256, null);
  fs.writeFileSync(path.join(ctx.workspaceRoot, 'gumiho-demo.txt'), Buffer.from([255]));
  assert.equal(adapter.verifier.verify(ctx).success, false);
});

test('writes through an internal directory alias report the canonical covered file', (t) => {
  const ctx = context(t),
    directory = path.join(ctx.workspaceRoot, 'real');
  fs.mkdirSync(directory);
  fs.symlinkSync(
    directory,
    path.join(ctx.workspaceRoot, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = write.execute(
    { path: 'alias/file.txt', content: 'canonical', expectedSha256: 'new' },
    ctx,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.modifiedFiles, ['real/file.txt']);
  assert.equal(read.execute({ path: 'alias/file.txt' }, ctx).output, 'canonical');
});

test('shipped workspace tools create/read/update exact UTF-8 bytes and detect changed content before replacement', (t) => {
  const ctx = context(t),
    input = { path: '한글, sample.txt', content: 'first 😀', expectedSha256: 'new' };
  assert.equal(write.execute(input, ctx).success, true);
  const original = read.execute({ path: input.path }, ctx);
  assert.equal(original.output, input.content);
  assert.match(original.data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    write.execute({ ...input, content: 'second', expectedSha256: 'wrong' }, ctx).success,
    false,
  );
  assert.equal(read.execute({ path: input.path }, ctx).output, input.content);
  assert.equal(
    write.execute({ ...input, content: 'second', expectedSha256: original.data.sha256 }, ctx)
      .success,
    true,
  );
  assert.equal(
    write.execute({ ...input, content: 'second', expectedSha256: original.data.sha256 }, ctx)
      .success,
    true,
  );
  assert.equal(read.execute({ path: input.path }, ctx).output, 'second');
  assert.equal(
    fs.readdirSync(ctx.workspaceRoot).some((name) => name.endsWith('.tmp')),
    false,
  );
});

test('shipped workspace tools reject escapes, symbolic links, oversized files and invalid UTF-8', (t) => {
  const ctx = context(t),
    outside = context(t);
  fs.writeFileSync(path.join(outside.workspaceRoot, 'private.txt'), 'outside');
  fs.symlinkSync(
    outside.workspaceRoot,
    path.join(ctx.workspaceRoot, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal(read.execute({ path: '../outside' }, ctx).success, false);
  assert.match(read.execute({ path: 'link/private.txt' }, ctx).output, /inside/);
  assert.equal(
    write.execute({ path: 'link/private.txt', content: 'changed', expectedSha256: 'new' }, ctx)
      .success,
    false,
  );
  fs.writeFileSync(path.join(ctx.workspaceRoot, 'large'), Buffer.alloc(32769));
  assert.match(read.execute({ path: 'large' }, ctx).output, /32 KiB/);
  fs.writeFileSync(path.join(ctx.workspaceRoot, 'invalid'), Buffer.from([255]));
  assert.equal(read.execute({ path: 'invalid' }, ctx).success, false);
  assert.match(read.execute({ path: 'missing' }, ctx).output, /ENOENT/);
  assert.equal(fs.readFileSync(path.join(outside.workspaceRoot, 'private.txt'), 'utf8'), 'outside');
});
