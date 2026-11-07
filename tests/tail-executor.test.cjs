const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, begin } = require('./store-fixture.cjs');
const { TailExecutor } = require('../dist/tail-executor');
const { configureTails } = require('../dist/tails');
const { executionLimits } = require('../dist/execution-limits');
const { ReconciliationRequired } = require('../dist/store-types');

const signal = () => new AbortController().signal;
function response(text = 'done', calls = [], stop = calls.length ? 'tools' : 'complete') {
  return {
    text,
    calls,
    stop,
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: null },
    model: 'fixture',
  };
}
function provider(generate, local = true) {
  return { id: 'fixture', version: '1', model: 'fixture', local, generate };
}
function tool(execute, readOnly = false) {
  return {
    name: 'work',
    version: '1',
    description: 'Fixture operation',
    readOnly,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    execute,
  };
}
function execution(f, p, tools = [], overrides = {}, tails) {
  return new TailExecutor(f.store, configureTails(p, [], tails), tools, executionLimits(overrides));
}
function input(id = 'job-1', tailId = 'build') {
  return {
    id,
    tailId,
    task: 'Perform the fixture task',
    context: { requirement: 'preserve evidence' },
  };
}
const modelCall = () => ({ id: 'wire-call', name: 'work', arguments: { value: 'verified' } });

test('model and tool identities are scope/run-specific and stable after an interrupted model request', async (t) => {
  const f = fixture(t),
    allIds = new Set();
  for (const [project, agent, runId] of [
    ['demo project', 'worker', 'run-1'],
    ['demo project', 'worker', 'run-2'],
    ['other project', 'worker', 'run-1'],
    ['demo project', 'other worker', 'run-1'],
  ]) {
    const current = { ...f, ...f.open(project, agent), input: { ...f.input, runId } };
    const lease = begin(current),
      modelIds = [],
      toolIds = [];
    let interrupted = false;
    const p = provider(async (request) => {
      modelIds.push(request.requestId);
      if (!interrupted) {
        interrupted = true;
        throw new Error('interrupted before the reply');
      }
      return request.messages.length === 1 ? response('work', [modelCall()]) : response('done');
    });
    const tools = [
      tool((_args, context) => {
        toolIds.push(context.callId);
        return { success: true, output: 'completed' };
      }),
    ];
    const first = execution(current, p, tools);
    await assert.rejects(first.run(lease, input(), signal()), /interrupted before/);
    await first.close();
    const resumed = execution(current, p, tools);
    assert.equal((await resumed.run(lease, input(), signal())).success, true);
    assert.equal(modelIds[0], modelIds[1]);
    assert.equal(modelIds.length, 3);
    assert.equal(toolIds.length, 1);
    for (const id of [modelIds[1], modelIds[2], toolIds[0]]) {
      assert.equal(allIds.has(id), false);
      allIds.add(id);
    }
    await resumed.close();
    lease.release();
  }
  assert.equal(allIds.size, 12);
});

test('a tail performs real file work, saves complete tool groups and replays a completed job without effects', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let models = 0,
    writes = 0;
  const p = provider(async (request) => {
    models++;
    if (request.messages.length === 1) return response('writing', [modelCall()]);
    assert.equal(request.messages.at(-1).role, 'tool');
    assert.equal(request.messages.at(-1).callId, 'wire-call');
    return response('verified file written');
  });
  const worker = execution(f, p, [
    tool((args, context) => {
      writes++;
      assert.equal(context.jobId, 'job-1');
      assert.equal(context.role, 'build');
      fs.writeFileSync(path.join(context.workspaceRoot, 'output.txt'), args.value);
      return {
        success: true,
        output: 'written',
        modifiedFiles: [path.join(context.workspaceRoot, 'output.txt')],
      };
    }),
  ]);
  const result = await worker.run(lease, input(), signal());
  assert.equal(result.success, true);
  assert.deepEqual(result.modifiedFiles, ['output.txt']);
  assert.equal(fs.readFileSync(path.join(f.directory, 'output.txt'), 'utf8'), 'verified');
  assert.equal(f.store.get('run-1').model_requests, 2);
  assert.equal(f.store.get('run-1').tool_calls, 1);
  assert.equal(worker.journal.list('run-1', 'job-1').length, 3);
  assert.deepEqual(await worker.run(lease, input(), signal()), result);
  assert.equal(models, 2);
  assert.equal(writes, 1);
  await worker.close();
  lease.release();
});

test('a side effect followed by a thrown handler requires evidence and resumes from cached model/tool receipts', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let effects = 0,
    models = 0;
  const p = provider(async (request) => {
    models++;
    return request.messages.length === 1 ? response('write', [modelCall()]) : response('complete');
  });
  const tools = [
    tool((_args, context) => {
      effects++;
      fs.writeFileSync(path.join(context.workspaceRoot, 'effect.txt'), 'once');
      throw new Error('interrupted after effect');
    }),
  ];
  const first = execution(f, p, tools);
  await assert.rejects(first.run(lease, input(), signal()), /interrupted after effect/);
  await first.close();
  const call = first.journal.list('run-1').find((row) => row.kind === 'tool');
  assert.equal(call.state, 'pending');
  const second = execution(f, p, tools);
  await assert.rejects(second.run(lease, input(), signal()), ReconciliationRequired);
  await second.close();
  assert.equal(effects, 1);
  assert.equal(models, 1);
  const resumed = execution(f, p, tools);
  await resumed.journal.completeTool(
    lease,
    call.id,
    { success: true, output: 'read back confirmed', modifiedFiles: ['effect.txt'] },
    'Read effect.txt and verified the expected bytes',
  );
  const result = await resumed.run(lease, input(), signal());
  assert.equal(result.success, true);
  assert.deepEqual(result.modifiedFiles, ['effect.txt']);
  assert.equal(effects, 1);
  assert.equal(models, 2);
  await resumed.close();
  lease.release();
});

test('read-only capabilities and JSON schemas reject model calls before host invocation and return corrective feedback', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let effects = 0;
  const p = provider(async (request) => {
    if (request.messages.length === 1) {
      assert.ok(!request.tools.some((tool) => tool.name === 'work'));
      return response('attempt', [modelCall()]);
    }
    assert.equal(request.messages.at(-1).result.success, false);
    assert.match(request.messages.at(-1).result.output, /capabilities/);
    return response('The requested write is outside this role');
  });
  const worker = execution(f, p, [
    tool(() => {
      effects++;
      return { success: true, output: 'unexpected' };
    }),
  ]);
  await worker.run(lease, input('reader', 'analyze'), signal());
  assert.equal(effects, 0);
  assert.equal(f.store.get('run-1').tool_calls, 0);
  await worker.close();
  lease.release();
});

test('parallel read-only jobs have isolated histories and obey a shared local-model concurrency cap', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let active = 0,
    maximum = 0;
  const p = provider(async (request) => {
    active++;
    maximum = Math.max(maximum, active);
    assert.equal(request.messages.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return response(JSON.parse(request.messages[0].content).task);
  });
  const worker = execution(f, p, [], { maxParallelReaders: 2, localConcurrency: 1 });
  const [first, second] = await Promise.all([
    worker.run(
      lease,
      { ...input('first', 'research'), tailId: 'analyze', task: 'First isolated task' },
      signal(),
    ),
    worker.run(lease, { ...input('second', 'plan'), task: 'Second isolated task' }, signal()),
  ]);
  assert.equal(maximum, 1);
  assert.equal(first.output, 'First isolated task');
  assert.equal(second.output, 'Second isolated task');
  assert.equal(worker.journal.list('run-1').length, 2);
  await worker.close();
  lease.release();
});

test('incomplete model output never dispatches its calls and exhausted turns produce a failed job', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let effects = 0;
  const tools = [
    tool(() => {
      effects++;
      return { success: true, output: 'read' };
    }, true),
  ];
  const incomplete = execution(
    f,
    provider(async () => response('partial', [modelCall()], 'incomplete')),
    tools,
  );
  assert.equal((await incomplete.run(lease, input('partial'), signal())).success, false);
  assert.equal(effects, 0);
  await incomplete.close();
  const looping = execution(
    f,
    provider(async () => response('loop', [modelCall()])),
    tools,
    { maxTurnsPerJob: 2 },
  );
  const result = await looping.run(lease, input('loop'), signal());
  assert.equal(result.failure, 'turn_limit');
  assert.equal(effects, 2);
  assert.equal(
    looping.journal.list('run-1', 'loop').some((row) => row.state === 'pending'),
    false,
  );
  await looping.close();
  lease.release();
});

test('model timeouts reject uncooperative providers, preserve pending evidence and cancel queued work', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let calls = 0;
  const worker = execution(
    f,
    provider(async () => {
      calls++;
      return await new Promise(() => {});
    }),
    [],
    { modelTimeoutMs: 30, jobTimeoutMs: 100 },
  );
  const pending = [
    worker.run(lease, input('first', 'analyze'), signal()),
    worker.run(lease, input('second', 'plan'), signal()),
  ];
  const results = await Promise.allSettled(pending);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.ok(worker.journal.list('run-1').some((row) => row.state === 'pending'));
  await worker.close();
  lease.release();
});

test('each provider retry is budgeted and model overrun cannot become a successful job', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  const worker = execution(
    f,
    provider(async (request) => {
      request.onAttempt();
      request.onAttempt();
      return response('complete');
    }),
  );
  assert.equal((await worker.run(lease, input('retry'), signal())).success, true);
  assert.equal(f.store.get('run-1').model_requests, 2);
  await worker.close();
  const excessive = execution(
    f,
    provider(async () => ({
      ...response('over budget'),
      usage: { inputTokens: 10, outputTokens: 3000, cachedInputTokens: null },
    })),
  );
  assert.equal((await excessive.run(lease, input('overrun'), signal())).success, false);
  await excessive.close();
  lease.release();
});

test('bounded history compacts complete groups while full results remain available through scoped journal tools', async (t) => {
  const f = fixture(t),
    lease = begin(f);
  let calls = 0,
    sawSummary = false;
  const worker = execution(
    f,
    provider(async (request) => {
      calls++;
      sawSummary ||= request.messages.some(
        (message) => message.role === 'user' && message.content.includes('historyNotice'),
      );
      return calls < 7 ? response('look up', [modelCall()]) : response('finished');
    }),
    [tool(() => ({ success: true, output: '한글😀'.repeat(500) }), true)],
    { maxHistoryBytes: 16000, maxTurnsPerJob: 8 },
  );
  const result = await worker.run(lease, input(), signal());
  assert.equal(result.success, true);
  assert.equal(sawSummary, true);
  const tail = worker.configuration.tails[0],
    context = {
      project: 'demo project',
      agent: 'worker',
      runId: 'run-1',
      callId: 'read',
      jobId: 'job-1',
      tailId: tail.id,
      role: tail.role,
      workspaceRoot: f.directory,
      phase: 'work',
      signal: signal(),
    };
  const page = await worker.catalog.invoke(
    'gumiho_read_job',
    { id: 'job-1', limit: 8192 },
    context,
    tail,
  );
  assert.equal(page.success, true);
  assert.match(page.output, /model-/);
  assert.match(page.output, /tool-/);
  const foreign = await worker.catalog.invoke('gumiho_read_job', { id: 'unknown' }, context, tail);
  assert.equal(foreign.success, false);
  await worker.close();
  lease.release();
});
