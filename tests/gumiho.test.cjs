const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Gumiho, ReconciliationRequired } = require('../dist/library');
const { MimirDatabase } = require('n2-mimir/storage');
const { resolveOptions } = require('../dist/gumiho-options');
const { ToolCatalog } = require('../dist/tool-catalog');
const { fingerprint } = require('../dist/values');

test('compatible patch releases retain the original workflow identity used by 1.0.0 records', async (t) => {
  const f = setup(t),
    options = await resolveOptions(f.options);
  const original = fingerprint({
    engineVersion: '1.0.0',
    tails: options.tails.hash,
    tools: new ToolCatalog(options.tools).hash,
    verifier: options.verifier.version,
    limits: options.limits,
    mode: options.mode,
    pipeline: options.pipeline,
    coordinator: options.coordinator,
    snapshot: options.scanner.policyHash,
    expertise: options.expertise,
  });
  assert.equal(options.hash, original);
});

function setup(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-gumiho-api-')),
    dbPath = path.join(root, 'mimir.db'),
    apps = [];
  const counts = { models: 0, writes: 0 },
    memory = new MimirDatabase(dbPath),
    connection = memory.reasoning.connection;
  connection.execute('CREATE TABLE foreign_sentinel(value TEXT)');
  connection.execute("INSERT INTO foreign_sentinel VALUES('preserve')");
  memory.insertExperience({
    project: 'other project',
    agent: 'other agent',
    type: 'success',
    category: 'fixture',
    severity: 'info',
    context: 'Unrelated private reference',
    action: 'fixture',
    outcome: 'preserve',
  });
  memory.close();
  t.after(async () => {
    for (const app of apps) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = (text, calls = []) => ({
    text,
    calls,
    stop: calls.length ? 'tools' : 'complete',
    model: 'fixture',
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: null },
  });
  const provider = {
    id: 'fixture',
    version: '1',
    model: 'fixture',
    local: true,
    privateApiKey: 'fixture-provider-secret',
    generate: async (request) => {
      counts.models++;
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /Unrelated private reference|fixture-provider-secret|fixture-tool-secret/,
      );
      if (settings.hang) return await new Promise(() => {});
      if (request.system.startsWith('Inspect the relevant'))
        return response('Analyze exact file requirements');
      if (request.system.startsWith('Produce an actionable'))
        return response('Write answer.txt, then assert bytes');
      if (request.system.startsWith('Implement the assigned'))
        return request.messages.length === 1
          ? response('write', [
              { id: 'write', name: 'write_answer', arguments: { value: 'correct' } },
            ])
          : response('Created answer.txt');
      const context = JSON.parse(request.messages[0].content).context;
      return response(
        JSON.stringify({ approved: true, snapshotHash: context.snapshotHash, findings: [] }),
      );
    },
  };
  const tools = [
    {
      name: 'write_answer',
      version: '1',
      description: 'Write the expected answer',
      privateApiKey: 'fixture-tool-secret',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execute(args, context) {
        counts.writes++;
        fs.writeFileSync(path.join(context.workspaceRoot, 'answer.txt'), args.value);
        if (settings.throwAfterWrite) throw new Error('fixture interruption after file write');
        return { success: true, output: 'written', modifiedFiles: ['answer.txt'] };
      },
    },
  ];
  const options = {
    dbPath,
    project: 'demo project',
    agent: 'worker',
    workspaceRoot: root,
    provider,
    tools,
    verifier: {
      version: '1',
      verify: () => ({
        success:
          !settings.rejectNative &&
          fs.readFileSync(path.join(root, 'answer.txt'), 'utf8') === 'correct',
        summary: 'Exact answer bytes checked',
        evidence: { filename: 'answer.txt' },
      }),
    },
    pipeline: { maxRepairs: 0 },
    limits: { modelTimeoutMs: 1000, jobTimeoutMs: 2000 },
  };
  const create = async (overrides = {}) => {
    const app = await Gumiho.create({ ...options, ...overrides });
    apps.push(app);
    return app;
  };
  return { root, dbPath, counts, options, create };
}

test('normal public API executes all N2R phases and records one scoped experience across restart and replay', async (t) => {
  const f = setup(t),
    app = await f.create();
  const result = await app.run({
    runId: 'task-1',
    sessionId: 'session-1',
    task: 'Create the correct answer',
  });
  assert.equal(result.success, true);
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.verification.success, true);
  assert.deepEqual(
    result.lifecycle.phases.map((phase) => phase.phase),
    ['boot', 'work_start', 'work_end', 'end'],
  );
  assert.equal(result.budget.modelRequests, 5);
  assert.equal(result.budget.toolCalls, 1);
  assert.equal(f.counts.writes, 1);
  assert.doesNotMatch(
    JSON.stringify(app.status('task-1')),
    /fixture-provider-secret|fixture-tool-secret/,
  );
  await app.close();
  const resumed = await f.create(),
    counts = { ...f.counts };
  assert.deepEqual(
    await resumed.run({
      runId: 'task-1',
      sessionId: 'session-1',
      task: 'Create the correct answer',
    }),
    result,
  );
  assert.deepEqual(f.counts, counts);
  await assert.rejects(
    resumed.run({ runId: 'task-1', sessionId: 'session-1', task: 'Different task' }),
    /different/,
  );
  const memory = new MimirDatabase(f.dbPath);
  try {
    const db = memory.reasoning.connection;
    assert.equal(
      db.query(
        "SELECT COUNT(*) AS count FROM experiences WHERE project='demo project' AND agent='worker' AND type='success'",
      )[0].count,
      1,
    );
    assert.equal(
      db.query(
        "SELECT COUNT(*) AS count FROM experiences WHERE project='other project' AND agent='other agent'",
      )[0].count,
      1,
    );
    assert.deepEqual(db.query('SELECT * FROM foreign_sentinel'), [{ value: 'preserve' }]);
    assert.deepEqual(db.query('PRAGMA foreign_key_check'), []);
    assert.deepEqual(db.query('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    memory.close();
  }
});

test('public recovery refuses uncertain side effects and resumes only after explicit reconciliation evidence', async (t) => {
  const f = setup(t, { throwAfterWrite: true }),
    app = await f.create();
  await assert.rejects(
    app.run({ runId: 'task-1', task: 'Create the correct answer' }),
    /fixture interruption/,
  );
  const call = app.status('task-1').calls.find((call) => call.kind === 'tool');
  assert.equal(call.state, 'pending');
  await app.close();
  const resumed = await f.create();
  await assert.rejects(
    resumed.run({ runId: 'task-1', task: 'Create the correct answer' }),
    ReconciliationRequired,
  );
  assert.equal(f.counts.writes, 1);
  await resumed.reconcileTool(
    'task-1',
    call.id,
    { success: true, output: 'Read back verified', modifiedFiles: ['answer.txt'] },
    'Confirmed answer.txt contains correct bytes',
  );
  const result = await resumed.run({ runId: 'task-1', task: 'Create the correct answer' });
  assert.equal(result.success, true);
  assert.equal(f.counts.writes, 1);
  await assert.rejects(
    resumed.reconcileTool(
      'task-1',
      call.id,
      { success: true, output: 'again' },
      'already completed',
    ),
    /unfinished/,
  );
});

test('native rejection records a failure through the normal lifecycle without a success experience', async (t) => {
  const f = setup(t, { rejectNative: true }),
    app = await f.create(),
    result = await app.run({ runId: 'failed', task: 'Create the correct answer' });
  assert.equal(result.success, false);
  assert.equal(result.verification, null);
  assert.equal(result.lifecycle.phases.find((phase) => phase.phase === 'work_end').success, false);
  const memory = new MimirDatabase(f.dbPath);
  try {
    assert.deepEqual(
      memory.reasoning.connection.query(
        "SELECT type,COUNT(*) AS count FROM experiences WHERE project='demo project' GROUP BY type",
      ),
      [{ type: 'failure', count: 1 }],
    );
  } finally {
    memory.close();
  }
});

test('public lifecycle rejects concurrent ownership and close interrupts uncooperative model work', async (t) => {
  const f = setup(t, { hang: true }),
    app = await f.create(),
    other = await f.create();
  const pending = app.run({ runId: 'active', task: 'Wait on the fixture' });
  const observed = pending.catch((error) => error);
  await assert.rejects(app.run({ runId: 'second', task: 'Another task' }), /active work/);
  await assert.rejects(other.run({ runId: 'second', task: 'Another task' }), /active Gumiho/);
  await app.close();
  assert.ok((await observed) instanceof Error);
  await assert.rejects(app.run({ runId: 'after-close', task: 'Task' }), /closed/);
});

test('configuration snapshots isolate later schema mutation and invalid public inputs fail before effects', async (t) => {
  const f = setup(t),
    app = await f.create();
  f.options.tools[0].inputSchema.properties.value.type = 'number';
  assert.equal(
    (await app.run({ runId: 'stable', task: 'Create the correct answer' })).success,
    true,
  );
  await assert.rejects(
    app.run({ runId: 'outside', task: 'Task', modifiedFiles: ['../outside.txt'] }),
    /outside/,
  );
  await assert.rejects(app.run({ runId: 'empty', task: ' ' }), /task is required/);
  await assert.rejects(f.create({ dbPath: ':memory:' }), /durable/);
  await assert.rejects(f.create({ verifier: null }), /verifier/);
});

test('declared and reported excluded file changes require an explicit matching snapshot policy', async (t) => {
  const f = setup(t),
    app = await f.create();
  await assert.rejects(
    app.run({
      runId: 'declared',
      task: 'Change an excluded file',
      modifiedFiles: ['dist/output.js'],
    }),
    /excluded/,
  );
  assert.equal(f.counts.models, 0);
  const original = f.options.tools[0];
  const tools = [
    {
      ...original,
      execute(args, context) {
        const result = original.execute(args, context);
        fs.mkdirSync(path.join(context.workspaceRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(context.workspaceRoot, 'dist', 'output.js'), 'generated');
        return { ...result, modifiedFiles: [...result.modifiedFiles, 'dist/output.js'] };
      },
    },
  ];
  const excluded = await f.create({ tools });
  await assert.rejects(
    excluded.run({ runId: 'reported', task: 'Create the correct answer' }),
    /excluded/,
  );
  const included = await f.create({
    tools,
    snapshot: { excludeDirectories: ['.git', 'node_modules'] },
  });
  assert.equal(
    (await included.run({ runId: 'included', task: 'Create the correct answer' })).success,
    true,
  );
});

test('a saved failed post-check can finish after an interrupted final commit without becoming a success', async (t) => {
  const f = setup(t);
  let checks = 0;
  const verifier = {
    version: 'post-failure',
    verify: () => ({
      success: ++checks === 1,
      summary: 'First check passes; final check fails',
      evidence: { checks },
    }),
  };
  const app = await f.create({ verifier }),
    memory = new MimirDatabase(f.dbPath),
    db = memory.reasoning.connection;
  try {
    db.execute(
      "CREATE TRIGGER fail_final_experience BEFORE INSERT ON experiences WHEN NEW.project='demo project' BEGIN SELECT RAISE(ABORT,'fixture finalization failure'); END",
    );
    await assert.rejects(
      app.run({ runId: 'post-failed', task: 'Create the correct answer' }),
      /finalization failure/,
    );
    const saved = app.status('post-failed');
    assert.equal(JSON.parse(saved.lifecycle.run.progress_json).work.success, true);
    assert.equal(
      JSON.parse(saved.lifecycle.run.progress_json).phases.find(
        (phase) => phase.phase === 'work_end',
      ).success,
      false,
    );
    db.execute('DROP TRIGGER fail_final_experience');
    await app.close();
    const resumed = await f.create({ verifier });
    const result = await resumed.run({ runId: 'post-failed', task: 'Create the correct answer' });
    assert.equal(result.success, false);
    assert.equal(checks, 2);
  } finally {
    memory.close();
  }
});
