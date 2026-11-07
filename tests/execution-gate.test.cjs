const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionGate } = require('../dist/execution-gate');
const { historyWindow, textPage } = require('../dist/history');
const { executionLimits } = require('../dist/execution-limits');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = () => new AbortController().signal;

test('readers run concurrently, queued writers are exclusive and later readers cannot starve a writer', async () => {
  const gate = new ExecutionGate(2),
    events = [];
  let readers = 0,
    writer = false,
    maximum = 0;
  const read = (id) =>
    gate.run(true, signal(), async () => {
      assert.equal(writer, false);
      readers++;
      maximum = Math.max(maximum, readers);
      events.push('start-' + id);
      await delay(10);
      readers--;
      events.push('end-' + id);
    });
  const first = read('a'),
    second = read('b');
  const write = gate.run(false, signal(), async () => {
    assert.equal(readers, 0);
    writer = true;
    events.push('write');
    await delay(10);
    writer = false;
  });
  const last = read('c');
  await Promise.all([first, second, write, last]);
  assert.equal(maximum, 2);
  assert.ok(events.indexOf('write') > events.indexOf('end-a'));
  assert.ok(events.indexOf('write') < events.indexOf('start-c'));
});

test('cancelled queued jobs never execute and rejected jobs release their scheduler slot', async () => {
  const gate = new ExecutionGate(1),
    controller = new AbortController();
  let release;
  const active = gate.run(false, signal(), () => new Promise((resolve) => (release = resolve)));
  const queued = gate.run(false, controller.signal, () => {
    throw new Error('must not execute');
  });
  controller.abort(new Error('cancelled'));
  await assert.rejects(queued, /cancelled/);
  release();
  await active;
  await assert.rejects(
    gate.run(false, signal(), () => {
      throw new Error('fixture failure');
    }),
    /fixture failure/,
  );
  assert.equal(await gate.run(true, signal(), () => 42), 42);
});

function reply(turn) {
  return {
    text: 'x'.repeat(1000),
    calls: [{ id: `call-${turn}`, name: 'lookup', arguments: { term: 'fixture' } }],
    stop: 'tools',
    usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: null },
    model: 'fixture',
    providerState: { format: 'fixture', value: { opaque: 'preserved-' + turn } },
  };
}
test('history compaction retains initial task, complete latest tool groups and durable job references', () => {
  const history = [{ role: 'user', content: 'Original task with essential requirements' }];
  for (let turn = 0; turn < 8; turn++)
    history.push(
      { role: 'assistant', reply: reply(turn) },
      {
        role: 'tool',
        callId: `call-${turn}`,
        name: 'lookup',
        result: { success: true, output: 'result-' + turn },
      },
    );
  const window = historyWindow(history, 5000, 'job-1');
  assert.ok(window.omittedTurns > 0);
  assert.deepEqual(window.messages[0], history[0]);
  assert.match(window.messages[1].content, /gumiho_read_call/);
  assert.match(window.messages[1].content, /job-1/);
  assert.deepEqual(window.messages.slice(-2), history.slice(-2));
  assert.ok(Buffer.byteLength(JSON.stringify(window.messages)) <= 5000);
  assert.throws(() => historyWindow(history, 100, 'job-1'), /exceed/);
  assert.throws(() => historyWindow(history.slice(0, -1), 5000, 'job-1'), /missing/);
  window.messages[0].content = 'mutated';
  assert.notEqual(history[0].content, 'mutated');
});

test('result pages preserve Unicode code points and budgets reject invalid overrides', () => {
  assert.deepEqual(textPage('가😀나다', 1, 2), { text: '😀나', nextOffset: 3, totalCharacters: 4 });
  assert.deepEqual(textPage('가😀나다', 4, 2), { text: '', nextOffset: null, totalCharacters: 4 });
  assert.throws(() => textPage('x', 2, 1), /exceeds/);
  assert.throws(() => textPage('x', -1, 1), /Invalid/);
  assert.equal(executionLimits().localConcurrency, 1);
  assert.throws(() => executionLimits({ localConcurrency: 3 }), /Invalid/);
  assert.throws(() => executionLimits({ maxTurnsPerJob: 0 }), /Invalid/);
});
