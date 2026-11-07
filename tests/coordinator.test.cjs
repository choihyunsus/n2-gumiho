const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Gumiho, ReconciliationRequired } = require('../dist/library');
const { MimirDatabase } = require('n2-mimir/storage');
const { fixture, begin } = require('./store-fixture.cjs');
const { TailExecutor } = require('../dist/tail-executor');
const { configureTails } = require('../dist/tails');
const { executionLimits } = require('../dist/execution-limits');
const { ArtifactScanner } = require('../dist/artifacts');
const { CoordinatorDispatch } = require('../dist/coordinator-dispatch');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function response(text, calls = [], stop = calls.length ? 'tools' : 'complete') {
  return {
    text,
    calls,
    stop,
    model: 'fixture',
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: null },
  };
}
function invoke(name, args = {}) {
  return response('coordinate', [{ id: 'control-call', name, arguments: args }]);
}
function dispatch(jobs) {
  return invoke('gumiho_dispatch', { jobs });
}
const build = { tail: 'build', task: 'Write the correct answer' };
function previousResult(request) {
  return request.messages.filter((message) => message.role === 'tool').at(-1)?.result;
}
function setup(t, scenario, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-gumiho-control-')),
    dbPath = path.join(root, 'mimir.db'),
    apps = [];
  const counts = {
    models: 0,
    writes: 0,
    reviews: 0,
    checks: 0,
    activeReaders: 0,
    maximumReaders: 0,
  };
  if (settings.preseed) fs.writeFileSync(path.join(root, 'answer.txt'), 'correct');
  t.after(async () => {
    for (const app of apps) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const provider = {
    id: 'fixture',
    version: '1',
    model: 'fixture',
    local: settings.local ?? true,
    generate: async (request) => {
      counts.models++;
      const prompt = JSON.parse(request.messages[0].content);
      if (request.system.includes('Gumiho coordinator.')) {
        assert.ok(request.tools.some((tool) => tool.name === 'gumiho_dispatch'));
        assert.ok(!request.tools.some((tool) => tool.name === 'write_answer'));
        const turn = request.messages.filter((message) => message.role === 'assistant').length;
        return scenario(turn, request);
      }
      assert.ok(!request.tools.some((tool) => tool.name === 'gumiho_dispatch'));
      if (request.system.startsWith('Implement the assigned')) {
        if (request.messages.length > 1) return response('File written');
        return response('write', [
          {
            id: 'write',
            name: 'write_answer',
            arguments: { value: prompt.task.includes('first value') ? 'first' : 'correct' },
          },
        ]);
      }
      if (request.system.startsWith('Independently inspect')) {
        counts.reviews++;
        return response(
          JSON.stringify({
            approved: true,
            snapshotHash: prompt.context.snapshotHash,
            findings: [],
          }),
        );
      }
      if (
        settings.failedPlan &&
        request.system.startsWith('Produce an actionable') &&
        !prompt.context.retryFeedback
      )
        return response('failed planning fixture', [], 'incomplete');
      counts.activeReaders++;
      counts.maximumReaders = Math.max(counts.maximumReaders, counts.activeReaders);
      if (settings.delayReaders) await wait(30);
      counts.activeReaders--;
      return response('Read-only worker completed');
    },
  };
  const options = {
    dbPath,
    project: 'demo',
    agent: 'worker',
    workspaceRoot: root,
    provider,
    mode: 'coordinator',
    coordinator: { maxTurns: settings.maxTurns ?? 8 },
    limits: { modelTimeoutMs: 2000, jobTimeoutMs: 5000 },
    tools: [
      {
        name: 'write_answer',
        version: '1',
        description: 'Write the answer',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        execute: (args, context) => {
          counts.writes++;
          fs.writeFileSync(path.join(context.workspaceRoot, 'answer.txt'), args.value);
          if (settings.throwAfterWrite) throw new Error('effect interrupted');
          return { success: true, output: 'written', modifiedFiles: ['answer.txt'] };
        },
      },
    ],
    verifier: {
      version: '1',
      verify: () => {
        counts.checks++;
        const correct =
          fs.existsSync(path.join(root, 'answer.txt')) &&
          fs.readFileSync(path.join(root, 'answer.txt'), 'utf8') === 'correct';
        return { success: correct, summary: 'Exact answer bytes checked', evidence: { correct } };
      },
    },
  };
  const create = async () => {
    const app = await Gumiho.create(options);
    apps.push(app);
    return app;
  };
  return { root, dbPath, counts, options, create };
}
const happy = (turn) =>
  turn === 0 ? dispatch([build]) : turn === 1 ? invoke('gumiho_verify') : response('DONE');

test('the entire delegation batch is validated before any worker effect or dispatch receipt', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let modelCalls = 0;
  const provider = {
    id: 'fixture',
    version: '1',
    model: 'fixture',
    local: true,
    generate: async () => {
      modelCalls++;
      return response('done');
    },
  };
  const tails = new TailExecutor(f.store, configureTails(provider), [], executionLimits());
  const scanner = new ArtifactScanner(f.directory, {
    excludePaths: ['mimir.db', 'mimir.db-wal', 'mimir.db-shm'],
  });
  const dispatcher = new CoordinatorDispatch(
    tails,
    { scanner },
    { targets: ['build'] },
    { consult: async () => ({ success: true }) },
    lease,
    '\u0001'.repeat(18000),
  );
  for (const [callId, task] of [
    ['oversized', '\u0001'.repeat(8192)],
    ['blank', '   '],
  ]) {
    const result = await dispatcher.dispatch(
      { jobs: [build, { tail: 'build', task }] },
      callId,
      new AbortController().signal,
    );
    assert.equal(result.success, false);
    assert.equal(f.store.receipt('run-1', `dispatch-${callId}`), undefined);
    assert.equal(f.store.jobs('run-1').length, 0);
  }
  assert.equal(modelCalls, 0);
  await tails.close();
  lease.release();
});

test('coordinator delegates a writer without holding a reader lock and finishes only with native and review evidence', async (t) => {
  const f = setup(t, happy),
    app = await f.create();
  const result = await app.run({ runId: 'run', task: 'Create a correct answer' });
  assert.equal(result.success, true);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.reviews, 1);
  assert.equal(result.budget.modelRequests, 6);
  assert.equal(app.status('run').jobs.find((job) => job.id === 'controller').state, 'completed');
  const counts = { ...f.counts };
  assert.deepEqual(await app.run({ runId: 'run', task: 'Create a correct answer' }), result);
  assert.deepEqual(f.counts, counts);
});

test('a model DONE response cannot bypass missing verification', async (t) => {
  const f = setup(t, (turn) => (turn === 0 ? dispatch([build]) : response('DONE')), {
      maxTurns: 3,
    }),
    app = await f.create();
  const result = await app.run({ runId: 'run', task: 'Create a correct answer' });
  assert.equal(result.success, false);
  assert.equal(result.verification, null);
  assert.equal(f.counts.checks, 0);
  assert.equal(app.status('run').jobs.find((job) => job.id === 'controller').state, 'failed');
});

test('an earlier failed worker stays unresolved after a later successful round and blocks DONE', async (t) => {
  const f = setup(
      t,
      (turn) => {
        if (turn === 0) return dispatch([{ tail: 'plan', task: 'Plan the task' }]);
        if (turn === 1) return dispatch([build]);
        if (turn === 2) return invoke('gumiho_verify');
        return response('DONE');
      },
      { failedPlan: true, maxTurns: 5 },
    ),
    app = await f.create();
  const result = await app.run({ runId: 'run', task: 'Create a correct answer' });
  assert.equal(result.success, false);
  const jobs = app.status('run').jobs;
  assert.ok(jobs.some((job) => job.tail_id === 'plan' && job.state === 'failed'));
  assert.ok(jobs.some((job) => job.tail_id === 'build' && job.state === 'completed'));
  assert.equal(f.counts.checks, 0);
});

test('explicit retries preserve the failed lineage and allow completion after the replacement succeeds', async (t) => {
  const f = setup(
      t,
      (turn, request) => {
        if (turn === 0) return dispatch([{ tail: 'plan', task: 'Plan the task' }]);
        if (turn === 1)
          return invoke('gumiho_retry_job', {
            jobId: previousResult(request).data.jobs[0].jobId,
            feedback: 'Recheck the evidence and complete planning',
          });
        if (turn === 2) return dispatch([build]);
        if (turn === 3) return invoke('gumiho_verify');
        return response('DONE');
      },
      { failedPlan: true },
    ),
    app = await f.create();
  assert.equal((await app.run({ runId: 'run', task: 'Create a correct answer' })).success, true);
  const jobs = app.status('run').jobs;
  assert.ok(jobs.some((job) => job.tail_id === 'plan' && job.state === 'superseded'));
  assert.ok(
    jobs.some((job) => job.tail_id === 'plan' && job.state === 'completed' && job.replaces_id),
  );
});

test('parallel read batches obey cloud concurrency while matching text on different tails remains distinct', async (t) => {
  const f = setup(
      t,
      (turn) =>
        turn === 0
          ? dispatch([
              { tail: 'analyze', task: 'Inspect the same topic' },
              { tail: 'plan', task: 'Inspect the same topic' },
            ])
          : turn === 1
            ? invoke('gumiho_verify')
            : response('DONE'),
      { preseed: true, local: false, delayReaders: true },
    ),
    app = await f.create();
  assert.equal(
    (await app.run({ runId: 'run', task: 'Verify the existing correct answer' })).success,
    true,
  );
  assert.equal(f.counts.maximumReaders, 2);
  assert.equal(app.status('run').jobs.filter((job) => job.parent_id === 'controller').length, 2);
});

test('exact duplicate dispatch jobs share one execution and serialize write-capable work', async (t) => {
  const f = setup(t, (turn) =>
      turn === 0
        ? dispatch([build, build])
        : turn === 1
          ? invoke('gumiho_verify')
          : response('DONE'),
    ),
    app = await f.create();
  assert.equal((await app.run({ runId: 'run', task: 'Create a correct answer' })).success, true);
  assert.equal(f.counts.writes, 1);
  assert.equal(app.status('run').jobs.filter((job) => job.parent_id === 'controller').length, 1);
});

test('new worker results invalidate an earlier approval even when file bytes remain identical', async (t) => {
  const f = setup(t, (turn) => {
      if (turn === 0) return dispatch([build]);
      if (turn === 1 || turn === 4) return invoke('gumiho_verify');
      if (turn === 2) return dispatch([{ tail: 'analyze', task: 'Inspect additional evidence' }]);
      return response('DONE');
    }),
    app = await f.create();
  const result = await app.run({ runId: 'run', task: 'Create a correct answer' });
  assert.equal(result.success, true);
  assert.equal(f.counts.reviews, 2);
  const calls = app
    .status('run')
    .calls.filter((call) => call.kind === 'model' && call.job_id === 'controller');
  assert.equal(calls.length, 6);
  const memory = new MimirDatabase(f.dbPath);
  try {
    const decisions = memory.reasoning.connection.query(
      "SELECT data_json FROM gumiho_receipts WHERE id='controller-decision-3'",
    );
    assert.match(decisions[0].data_json, /worker results changed/);
  } finally {
    memory.close();
  }
});

test('a pending composite dispatch reuses its original job plan after a child effect changes the workspace', async (t) => {
  const f = setup(t, happy, { throwAfterWrite: true }),
    app = await f.create();
  await assert.rejects(
    app.run({ runId: 'run', task: 'Create a correct answer' }),
    /effect interrupted/,
  );
  const pending = app
    .status('run')
    .calls.find(
      (call) => call.kind === 'tool' && JSON.parse(call.input_json).name === 'write_answer',
    );
  const parent = app
    .status('run')
    .calls.find(
      (call) => call.kind === 'tool' && JSON.parse(call.input_json).name === 'gumiho_dispatch',
    );
  await assert.rejects(
    app.reconcileTool(
      'run',
      parent.id,
      { success: true, output: 'skip children' },
      'parent shortcut',
    ),
    /child receipts/,
  );
  await app.close();
  const resumed = await f.create();
  await assert.rejects(
    resumed.run({ runId: 'run', task: 'Create a correct answer' }),
    ReconciliationRequired,
  );
  assert.equal(
    resumed.status('run').jobs.filter((job) => job.parent_id === 'controller').length,
    1,
  );
  await resumed.reconcileTool(
    'run',
    pending.id,
    { success: true, output: 'Verified file bytes', modifiedFiles: ['answer.txt'] },
    'Read answer.txt and confirmed correct bytes',
  );
  assert.equal(
    (await resumed.run({ runId: 'run', task: 'Create a correct answer' })).success,
    true,
  );
  assert.equal(f.counts.writes, 1);
  assert.equal(
    resumed.status('run').jobs.filter((job) => job.parent_id === 'controller').length,
    1,
  );
});

test('failed final persistence rolls back controller completion and approval together, then replays without new effects', async (t) => {
  const f = setup(t, happy),
    app = await f.create(),
    memory = new MimirDatabase(f.dbPath),
    db = memory.reasoning.connection;
  try {
    db.execute(
      "CREATE TRIGGER fail_controller_commit BEFORE INSERT ON gumiho_receipts WHEN NEW.id='coordinator-result' BEGIN SELECT RAISE(ABORT,'fixture final commit failure'); END",
    );
    await assert.rejects(
      app.run({ runId: 'run', task: 'Create a correct answer' }),
      /final commit failure/,
    );
    assert.equal(app.status('run').verification, undefined);
    assert.equal(app.status('run').jobs.find((job) => job.id === 'controller').state, 'running');
    db.execute('DROP TRIGGER fail_controller_commit');
    const counts = { models: f.counts.models, writes: f.counts.writes };
    await app.close();
    const resumed = await f.create();
    assert.equal(
      (await resumed.run({ runId: 'run', task: 'Create a correct answer' })).success,
      true,
    );
    assert.deepEqual({ models: f.counts.models, writes: f.counts.writes }, counts);
  } finally {
    memory.close();
  }
});
