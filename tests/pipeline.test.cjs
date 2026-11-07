const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, begin } = require('./store-fixture.cjs');
const { TailExecutor } = require('../dist/tail-executor');
const { configureTails } = require('../dist/tails');
const { executionLimits } = require('../dist/execution-limits');
const { ArtifactScanner } = require('../dist/artifacts');
const { VerificationService } = require('../dist/verification');
const { Pipeline } = require('../dist/pipeline');
const { pipelineConfiguration } = require('../dist/pipeline-config');
const { commandVerifier } = require('../dist/command-verifier');
const { reviewDecision } = require('../dist/review-contract');

const signal = () => new AbortController().signal;
function reply(text, calls = [], stop = calls.length ? 'tools' : 'complete') {
  return {
    text,
    calls,
    stop,
    model: 'fixture',
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: null },
  };
}
function harness(t, settings = {}) {
  const f = fixture(t),
    lease = begin(f),
    counts = { models: 0, writes: 0, builds: 0, reviews: 0, advice: 0, checks: 0 };
  const provider = {
    id: 'fixture',
    version: '1',
    model: 'fixture',
    local: true,
    generate: async (request) => {
      counts.models++;
      if (request.system.startsWith('Inspect the relevant'))
        return reply(
          'Observed fixture requirements',
          [],
          settings.analysisFailure ? 'incomplete' : 'complete',
        );
      if (request.system.startsWith('Produce an actionable'))
        return reply('Write output.txt and verify exact bytes');
      if (request.system.startsWith('Implement the assigned')) {
        if (request.messages.length > 1) return reply('Reported file change');
        counts.builds++;
        if (settings.failedBuild && counts.builds === 1)
          return reply('Build interrupted', [], 'incomplete');
        const value = settings.repair && counts.builds === 1 ? 'broken' : 'correct';
        return reply('Write output', [{ id: 'write', name: 'write_output', arguments: { value } }]);
      }
      if (request.system.startsWith('Review the supplied')) {
        counts.advice++;
        return reply('Retain native evidence and inspect changes');
      }
      counts.reviews++;
      if (settings.failedReview && counts.reviews === 1)
        return reply('Review incomplete', [], 'incomplete');
      const context = JSON.parse(request.messages[0].content).context;
      if (settings.reviewMutation)
        fs.writeFileSync(path.join(f.directory, 'unexpected.txt'), 'mutation during review');
      const review = JSON.stringify({
        approved: true,
        snapshotHash: settings.staleReview ? 'wrong-hash' : context.snapshotHash,
        findings: settings.blockingFinding
          ? [{ severity: 'error', message: 'An unresolved defect remains' }]
          : [],
      });
      return reply(settings.fencedReview ? `\x60\x60\x60json\n${review}\n\x60\x60\x60` : review);
    },
  };
  const tools = [
    {
      name: 'write_output',
      version: '1',
      description: 'Write fixture output',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execute: (args, context) => {
        counts.writes++;
        fs.writeFileSync(path.join(context.workspaceRoot, 'output.txt'), args.value);
        return { success: true, output: 'written', modifiedFiles: ['output.txt'] };
      },
    },
  ];
  const definitions = settings.advisor
    ? ['analyze', 'plan', 'build', 'verify', 'advisor'].map((role) => ({ id: role, role }))
    : undefined;
  const config = configureTails(provider, [], definitions),
    limits = executionLimits();
  const scanner = new ArtifactScanner(f.directory, {
    excludePaths: ['mimir.db', 'mimir.db-wal', 'mimir.db-shm'],
  });
  const native = settings.command
    ? commandVerifier(
        [
          {
            id: 'exact-bytes',
            command: process.execPath,
            args: [
              '-e',
              "require('node:assert/strict').equal(require('node:fs').readFileSync('output.txt','utf8'),'correct')",
            ],
          },
        ],
        'fixture',
      )
    : {
        version: 'fixture-native',
        verify: () => {
          counts.checks++;
          const correct =
            fs.existsSync(path.join(f.directory, 'output.txt')) &&
            fs.readFileSync(path.join(f.directory, 'output.txt'), 'utf8') === 'correct';
          if (settings.nativeMutation)
            fs.writeFileSync(path.join(f.directory, 'native-change.txt'), String(counts.checks));
          return {
            success: correct && !settings.nativeFailure,
            summary: correct ? 'Expected file bytes observed' : 'File bytes are incorrect',
            evidence: { correct },
            privateConfiguration: 'must not persist',
          };
        },
      };
  const open = () => {
    const executor = new TailExecutor(f.store, config, tools, limits),
      verification = new VerificationService(f.store, scanner, native, executor, 5000);
    const pipeline = new Pipeline(
      executor,
      verification,
      pipelineConfiguration(config, {
        maxRepairs: settings.maxRepairs ?? 1,
        ...(settings.advisor
          ? { advisorTail: 'advisor', advisorMaxCalls: settings.advisorMaxCalls ?? 3 }
          : {}),
      }),
    );
    return { executor, verification, pipeline };
  };
  return { ...f, lease, counts, open, ...open() };
}

test('a single complete JSON code fence preserves typed review and exact snapshot validation', () => {
  const hash = 'a'.repeat(64),
    value = { approved: true, snapshotHash: hash, findings: [] };
  const raw = JSON.stringify(value),
    fence = (text) => `\x60\x60\x60json\n${text}\n\x60\x60\x60`;
  assert.deepEqual(reviewDecision(fence(raw), hash), value);
  assert.deepEqual(reviewDecision(`\x60\x60\x60\r\n${raw}\r\n\x60\x60\x60`, hash), value);
  for (const invalid of [
    'Approved.\n' + fence(raw),
    fence(raw) + '\nExtra explanation',
    fence(raw) + '\n' + fence(raw),
    fence('{invalid}'),
    fence(raw).slice(0, -1),
    fence(JSON.stringify({ ...value, approved: 'true' })),
    fence(JSON.stringify({ ...value, snapshotHash: 'b'.repeat(64) })),
    fence(JSON.stringify({ ...value, extra: true })),
  ])
    assert.throws(() => reviewDecision(invalid, hash));
  const rejected = reviewDecision(
    fence(JSON.stringify({ ...value, findings: [{ message: 'Defect', severity: 'error' }] })),
    hash,
  );
  assert.equal(rejected.approved, false);
});

test('a fenced model review completes the normal pipeline with fresh native verification', async (t) => {
  const f = harness(t, { fencedReview: true });
  assert.equal(
    (await f.pipeline.run(f.lease, 'Create correct output', [], signal())).success,
    true,
  );
  assert.equal((await f.verification.finalGate(f.lease, signal())).success, true);
  await f.executor.close();
  f.lease.release();
});

test('one provider completes analysis, plan, actual file work, independent review and native command checks', async (t) => {
  const f = harness(t, { command: true }),
    result = await f.pipeline.run(f.lease, 'Create correct output', [], signal());
  assert.equal(result.success, true);
  assert.deepEqual(result.modifiedFiles, ['output.txt']);
  assert.equal(f.counts.builds, 1);
  assert.equal((await f.verification.finalGate(f.lease, signal())).success, true);
  const proof = f.store.receipt('run-1', 'completion-proof');
  assert.equal(proof.success, true);
  const native = f.store.receipt('run-1', proof.nativeId);
  assert.equal(native.evidence.checks[0].exitCode, 0);
  const before = { ...f.counts };
  assert.deepEqual(await f.pipeline.run(f.lease, 'Create correct output', [], signal()), result);
  assert.deepEqual(f.counts, before);
  fs.writeFileSync(path.join(f.directory, 'output.txt'), 'changed after approval');
  assert.equal((await f.verification.finalGate(f.lease, signal())).success, false);
  await f.executor.close();
  f.lease.release();
});

test('a native failure blocks a model approval and a bounded repair is checked against new file bytes', async (t) => {
  const f = harness(t, { repair: true }),
    result = await f.pipeline.run(f.lease, 'Create correct output', [], signal());
  assert.equal(result.success, true);
  assert.equal(f.counts.writes, 2);
  assert.equal(f.counts.reviews, 2);
  const first = f.store.receipt('run-1', 'verification-pipeline-0'),
    second = f.store.receipt('run-1', 'verification-pipeline-1');
  assert.equal(first.success, false);
  assert.equal(second.success, true);
  assert.notEqual(first.snapshotHash, second.snapshotHash);
  assert.equal((await f.verification.finalGate(f.lease, signal())).success, true);
  assert.equal(f.store.receipt('run-1', second.nativeId).privateConfiguration, undefined);
  await f.executor.close();
  f.lease.release();
});

for (const setting of [
  'nativeFailure',
  'staleReview',
  'blockingFinding',
  'reviewMutation',
  'nativeMutation',
])
  test(`${setting} prevents completion even when a model declares approval`, async (t) => {
    const f = harness(t, { [setting]: true, maxRepairs: 0 }),
      result = await f.pipeline.run(f.lease, 'Create correct output', [], signal());
    assert.equal(result.success, false);
    assert.equal(f.store.receipt('run-1', 'completion-proof'), undefined);
    assert.equal((await f.verification.finalGate(f.lease, signal())).success, false);
    await f.executor.close();
    f.lease.release();
  });

test('analysis failure prevents downstream model work and is retained as unresolved failure', async (t) => {
  const f = harness(t, { analysisFailure: true }),
    result = await f.pipeline.run(f.lease, 'Create correct output', [], signal());
  assert.equal(result.success, false);
  assert.equal(f.counts.models, 1);
  assert.equal(f.counts.builds, 0);
  assert.equal(f.store.unresolved('run-1')[0].id, 'analysis');
  await f.executor.close();
  f.lease.release();
});

for (const setting of ['repair', 'failedBuild', 'failedReview'])
  test(`${setting} resumes after a failed final commit without replaying obsolete rounds or duplicating writes`, async (t) => {
    const f = harness(t, { [setting]: true }),
      original = f.store.putReceipt.bind(f.store);
    let fail = true;
    f.store.putReceipt = (lease, id, value) => {
      original(lease, id, value);
      if (id === 'completion-proof' && fail) {
        fail = false;
        throw new Error('fixture final commit failure');
      }
    };
    await assert.rejects(
      f.pipeline.run(f.lease, 'Create correct output', [], signal()),
      /final commit failure/,
    );
    assert.equal(f.store.receipt('run-1', 'completion-proof'), undefined);
    assert.equal(f.store.receipt('run-1', 'pipeline-result'), undefined);
    const counts = { ...f.counts };
    await f.executor.close();
    const resumed = f.open();
    const result = await resumed.pipeline.run(f.lease, 'Create correct output', [], signal());
    assert.equal(result.success, true);
    assert.deepEqual(f.counts, counts);
    assert.equal(f.store.unresolved('run-1').length, 0);
    assert.equal((await resumed.verification.finalGate(f.lease, signal())).success, true);
    await resumed.executor.close();
    f.lease.release();
  });

test('advisor checkpoints honor their configured call budget and persist skipped checkpoints', async (t) => {
  const f = harness(t, { advisor: true, advisorMaxCalls: 1, repair: true });
  assert.equal(
    (await f.pipeline.run(f.lease, 'Create correct output', [], signal())).success,
    true,
  );
  assert.equal(f.counts.advice, 1);
  assert.equal(f.store.receipt('run-1', 'advisor-skipped-final').reason, 'advisor_call_budget');
  assert.equal((await f.verification.finalGate(f.lease, signal())).success, true);
  await f.executor.close();
  f.lease.release();
});

test('final native checks refresh external evidence even when workspace files and worker results are unchanged', async (t) => {
  const f = harness(t),
    result = await f.pipeline.run(f.lease, 'Create correct output', [], signal());
  assert.equal(result.success, true);
  const first = await f.verification.finalGate(f.lease, signal()),
    count = f.counts.checks;
  const second = await f.verification.finalGate(f.lease, signal());
  assert.equal(second.success, true);
  assert.equal(f.counts.checks, count + 1);
  assert.notEqual(first.data.nativeReceipt, second.data.nativeReceipt);
  await f.executor.close();
  f.lease.release();
});
