const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { cases } = require('./provider-fixtures.cjs');
const { ollamaChat } = require('../dist/provider-ollama');
const { openAIResponses } = require('../dist/provider-openai');
const { geminiInteractions } = require('../dist/provider-gemini');
const { checkedReply } = require('../dist/model-validation');
const { raceAbort } = require('../dist/provider-http');

async function server(t, handler) {
  const requests = [],
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ body, headers: req.headers });
      handler(res, requests.length, body);
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/model`, requests };
}
function request(overrides = {}) {
  return {
    model: 'fixture',
    system: 'Follow the host tool contract.',
    requestId: 'request-1',
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    messages: [{ role: 'user', content: 'Find alpha and beta' }],
    tools: [
      {
        name: 'lookup',
        description: 'Look up a term',
        parameters: {
          type: 'object',
          properties: { term: { type: 'string' } },
          required: ['term'],
          additionalProperties: false,
        },
      },
    ],
    ...overrides,
  };
}
function send(res, value) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}
function plainResponse() {
  return {
    model: 'fixture',
    status: 'completed',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
  };
}

test('Gemini function steps remain actionable in completed turns and usage includes separately reported thoughts', async (t) => {
  const response = structuredClone(
    cases.find((fixture) => fixture.name === 'Gemini Interactions').response,
  );
  response.status = 'completed';
  const host = await server(t, (res) => send(res, response));
  const provider = geminiInteractions({
    id: 'gemini',
    model: 'fixture',
    endpoint: host.endpoint,
    apiKey: 'fixture-key',
  });
  const result = await provider.generate(request());
  assert.equal(result.stop, 'tools');
  assert.equal(result.calls.length, 2);
  assert.equal(
    result.usage.outputTokens,
    response.usage.total_output_tokens + response.usage.total_thought_tokens,
  );
});

for (const fixture of cases)
  test(`${fixture.name} preserves multiple calls, continuation, output budgets and token usage over HTTP`, async (t) => {
    const host = await server(t, (res) => send(res, fixture.response));
    const options = {
      id: 'primary',
      model: 'fixture',
      endpoint: host.endpoint,
      apiKey: 'fixture-key',
    };
    const provider = fixture.factory(options);
    options.apiKey = 'mutated';
    assert.doesNotMatch(JSON.stringify(provider), /fixture-key|mutated|Bearer/);
    const first = await provider.generate(request());
    assert.equal(first.stop, 'tools');
    assert.equal(first.text, 'first text\nsecond text');
    assert.deepEqual(
      first.calls.map((call) => call.arguments),
      [{ term: 'alpha' }, { term: 'beta' }],
    );
    assert.deepEqual(first.usage, { inputTokens: 15, outputTokens: 7, cachedInputTokens: 5 });
    const history = [
      ...request().messages,
      { role: 'assistant', reply: first },
      ...first.calls.map((call) => ({
        role: 'tool',
        callId: call.id,
        name: call.name,
        result: { success: true, output: 'found' },
      })),
    ];
    await provider.generate(request({ requestId: 'request-2', messages: history }));
    fixture.inspect(assert, host.requests[1].body, host.requests[1].headers);
    await assert.rejects(provider.generate(request({ messages: history.slice(0, -1) })), /missing/);
    await assert.rejects(
      provider.generate(request({ messages: [history[0], history[2]] })),
      /Orphaned/,
    );
    assert.equal(host.requests.length, 2);
  });

test('local JSON tool mode is explicit, strictly parsed and never auto-runs tool-shaped native text', async (t) => {
  let content = JSON.stringify({
    text: 'lookup',
    calls: [{ name: 'lookup', arguments: { term: 'alpha' } }],
  });
  const host = await server(t, (res) =>
    send(res, {
      model: 'fixture',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content },
    }),
  );
  const provider = ollamaChat({
    id: 'local',
    model: 'small-fixture',
    endpoint: host.endpoint,
    toolMode: 'json',
  });
  const first = await provider.generate(request());
  assert.equal(first.stop, 'tools');
  assert.equal(host.requests[0].body.format.additionalProperties, false);
  const reply = { role: 'assistant', reply: first },
    result = {
      role: 'tool',
      callId: first.calls[0].id,
      name: 'lookup',
      result: { success: true, output: 'found' },
    };
  content = JSON.stringify({ text: 'finished', calls: [] });
  const final = await provider.generate(
    request({ messages: [...request().messages, reply, result] }),
  );
  assert.equal(final.stop, 'complete');
  assert.equal(final.usage.inputTokens, null);
  assert.equal(host.requests[1].body.messages.at(-1).role, 'user');
  content = '```json\n{"text":"bad","calls":[]}\n```';
  await assert.rejects(provider.generate(request()), /invalid_model_response/);
  const native = ollamaChat({ id: 'native', model: 'fixture', endpoint: host.endpoint });
  const nativeReply = await native.generate(request());
  assert.equal(nativeReply.calls.length, 0);
  assert.equal(nativeReply.text, content);
  assert.throws(
    () => ollamaChat({ id: 'cloud', model: 'fixture', local: false, toolMode: 'json' }),
    /local/,
  );
});

test('Ollama context length is explicit, bounded and included in provider replay identity', async (t) => {
  const host = await server(t, (res) =>
    send(res, {
      model: 'fixture',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: 'done' },
    }),
  );
  const options = { id: 'local', model: 'fixture', endpoint: host.endpoint };
  const provider = ollamaChat({ ...options, contextLength: 8192,think:false });
  await provider.generate(request());
  assert.equal(host.requests[0].body.options.num_ctx, 8192);
  assert.equal(host.requests[0].body.think,false);
  assert.throws(()=>ollamaChat({...options,think:123}),/think/);
  assert.notEqual(provider.version, ollamaChat({ ...options, contextLength: 4096 }).version);
  assert.throws(() => ollamaChat({ ...options, contextLength: 0 }), /context length/);
});

test('partial, refused, malformed, duplicated and unsafe-number replies cannot become successful tool dispatches', async (t) => {
  let response = plainResponse();
  const host = await server(t, (res) => send(res, response));
  const provider = openAIResponses({
    id: 'primary',
    model: 'fixture',
    endpoint: host.endpoint,
    apiKey: 'fixture-key',
  });
  response.status = 'incomplete';
  assert.equal((await provider.generate(request())).stop, 'incomplete');
  response = {
    ...plainResponse(),
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] }],
  };
  assert.equal((await provider.generate(request())).stop, 'refused');
  response = {
    ...plainResponse(),
    output: [{ type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{malformed' }],
  };
  await assert.rejects(provider.generate(request()), /invalid_model_response/);
  response.output[0].arguments = '{"value":9007199254740992}';
  await assert.rejects(provider.generate(request()), /invalid_model_response/);
  response.output[0].arguments = '{}';
  response.output.push({ ...response.output[0] });
  await assert.rejects(provider.generate(request()), /invalid_model_response/);
  const valid = {
    text: '',
    calls: [],
    stop: 'complete',
    model: 'fixture',
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
  };
  assert.throws(() => checkedReply({ ...valid, text: '\uD800' }), /Invalid/);
  assert.throws(
    () => checkedReply({ ...valid, calls: [{ id: 'x', name: 'lookup', arguments: {} }] }),
    /conflicts/,
  );
});

test('HTTP retries count each attempt, respect Retry-After and preserve host budget failures', async (t) => {
  const host = await server(t, (res, count) => {
    if (count === 1) {
      res.statusCode = 429;
      res.setHeader('retry-after', '0');
      send(res, { error: 'fixture-key' });
    } else send(res, plainResponse());
  });
  const provider = openAIResponses({
    id: 'primary',
    model: 'fixture',
    endpoint: host.endpoint,
    apiKey: 'fixture-key',
  });
  let attempts = 0;
  await provider.generate(request({ onAttempt: () => attempts++ }));
  assert.equal(attempts, 2);
  assert.equal(host.requests.length, 2);
  const budgetFailure = new Error('Model request budget exhausted');
  for (let index = 0; index < 4; index++)
    await assert.rejects(
      provider.generate(
        request({
          onAttempt: () => {
            throw budgetFailure;
          },
        }),
      ),
      (error) => error === budgetFailure,
    );
  assert.equal((await provider.generate(request())).stop, 'complete');
  const deferred = await server(t, (res) => {
    res.statusCode = 429;
    res.setHeader('retry-after', '120');
    send(res, {});
  });
  const later = openAIResponses({
    id: 'later',
    model: 'fixture',
    endpoint: deferred.endpoint,
    apiKey: 'fixture-key',
  });
  await assert.rejects(later.generate(request()), /retry_later/);
  assert.equal(deferred.requests.length, 1);
});

test('circuits are isolated and provider errors never include request credentials or response bodies', async (t) => {
  const host = await server(t, (res) => {
    res.statusCode = 503;
    send(res, { secret: 'fixture-key', detail: 'private-server-diagnostic' });
  });
  const make = () =>
    openAIResponses({
      id: 'primary',
      model: 'fixture',
      endpoint: host.endpoint,
      apiKey: 'fixture-key',
      retries: 0,
    });
  const provider = make();
  for (let index = 0; index < 3; index++)
    await assert.rejects(provider.generate(request()), (error) => {
      assert.doesNotMatch(error.stack, /fixture-key|private-server|127\.0\.0\.1/);
      return error.status === 503;
    });
  await assert.rejects(provider.generate(request()), /circuit_open/);
  assert.equal(host.requests.length, 3);
  await assert.rejects(make().generate(request()), /503/);
  assert.equal(host.requests.length, 4);
});

test('body deadlines, cancellation, bounded input/output and redirect rejection apply to real HTTP requests', async (t) => {
  const stalled = await server(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"output":');
  });
  const provider = openAIResponses({
    id: 'primary',
    model: 'fixture',
    endpoint: stalled.endpoint,
    apiKey: 'fixture-key',
    timeoutMs: 100,
  });
  const start = Date.now();
  await assert.rejects(provider.generate(request()), /timeout/);
  assert.ok(Date.now() - start < 2500);
  const controller = new AbortController(),
    cancelled = provider.generate(request({ signal: controller.signal }));
  controller.abort(new Error('host cancelled'));
  await assert.rejects(cancelled, /host cancelled/);
  const large = await server(t, (res) => {
    res.setHeader('content-length', 2097153);
    res.end('x');
  });
  const bounded = openAIResponses({
    id: 'bounded',
    model: 'fixture',
    endpoint: large.endpoint,
    apiKey: 'fixture-key',
  });
  await assert.rejects(bounded.generate(request()), /too_large/);
  await assert.rejects(bounded.generate(request({ system: 'x'.repeat(65537) })), /Invalid/);
  assert.equal(large.requests.length, 1);
  const redirect = await server(t, (res) => {
    res.statusCode = 302;
    res.setHeader('location', large.endpoint);
    res.end();
  });
  const redirected = openAIResponses({
    id: 'redirect',
    model: 'fixture',
    endpoint: redirect.endpoint,
    apiKey: 'fixture-key',
  });
  await assert.rejects(redirected.generate(request()), /transport_failed/);
  assert.equal(large.requests.length, 1);
  const aborted = new AbortController();
  aborted.abort(new Error('early'));
  await assert.rejects(raceAbort(Promise.reject(new Error('ignored')), aborted.signal), /early/);
  for (const endpoint of [
    'http://example.com/model',
    'https://user:pass@example.com/model',
    'https://example.com/model?key=secret',
  ])
    assert.throws(
      () => openAIResponses({ id: 'bad', model: 'fixture', endpoint, apiKey: 'fixture-key' }),
      /endpoint/,
    );
});
