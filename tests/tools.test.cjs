const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolCatalog, ToolValidationError } = require('../dist/tool-catalog');
const { configureTails } = require('../dist/tails');
const provider = {
  id: 'primary',
  version: '1',
  model: 'fixture',
  local: true,
  generate: async () => ({}),
};
const context = {
  project: 'demo',
  agent: 'worker',
  runId: 'run',
  callId: 'call',
  jobId: 'job',
  tailId: 'build',
  role: 'build',
  workspaceRoot: '/fixture',
  phase: 'work',
  signal: new AbortController().signal,
};

test('schemas, capabilities and aliases are enforced at dispatch with stable host context', async () => {
  let calls = 0;
  const definitions = [
    {
      name: 'files.edit:local',
      version: '1',
      description: 'Edit a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: (args, ctx) => {
        calls++;
        assert.equal(ctx.jobId, 'job');
        assert.equal(Object.isFrozen(ctx), true);
        return { success: true, output: args.path, modifiedFiles: [args.path] };
      },
    },
  ];
  const catalog = new ToolCatalog(definitions),
    configuration = configureTails(provider);
  const build = configuration.tails[2],
    verify = configuration.tails[3];
  assert.equal(catalog.list(verify).length, 0);
  const name = catalog.list(build)[0].name;
  assert.match(name, /^tool_[a-f0-9]{32}$/);
  await assert.rejects(catalog.invoke(name, { path: 1 }, context, build), ToolValidationError);
  await assert.rejects(
    catalog.invoke(name, { path: 'a', extra: true }, context, build),
    ToolValidationError,
  );
  await assert.rejects(catalog.invoke(name, { path: 'a' }, context, verify), ToolValidationError);
  assert.equal(calls, 0);
  assert.equal((await catalog.invoke(name, { path: 'a' }, context, build)).output, 'a');
  assert.equal(calls, 1);
  const copy = catalog.list(build);
  copy[0].parameters.required = [];
  assert.throws(() => catalog.check(name, {}, build), ToolValidationError);
});

test('formats validate without coercion and explicit empty tool permissions remain empty', () => {
  const tool = {
    name: 'lookup',
    version: '1',
    readOnly: true,
    description: 'Look up contact metadata',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
      additionalProperties: false,
    },
    execute: () => ({ success: true, output: 'ok' }),
  };
  const catalog = new ToolCatalog([tool]);
  const tail = configureTails(provider, [], [{ id: 'reader', role: 'research' }]).tails[0];
  assert.equal(catalog.check('lookup', { email: 'user@example.com' }, tail).idempotent, true);
  assert.throws(() => catalog.check('lookup', { email: 'invalid' }, tail), ToolValidationError);
  assert.equal(catalog.list({ ...tail, tools: [] }).length, 0);
  assert.throws(
    () => new ToolCatalog([{ ...tool, inputSchema: { $async: true, type: 'object' } }]),
    /synchronous/,
  );
});

test('read-only mutation reports and malformed Unicode results fail explicitly', async () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const tools = [
    {
      name: 'readonly',
      version: '1',
      readOnly: true,
      description: 'fixture',
      inputSchema: schema,
      execute: () => ({ success: true, output: 'ok', modifiedFiles: ['changed'] }),
    },
    {
      name: 'unicode',
      version: '1',
      readOnly: true,
      description: 'fixture',
      inputSchema: schema,
      execute: () => ({ success: true, output: '\uD800' }),
    },
  ];
  const catalog = new ToolCatalog(tools),
    tail = configureTails(provider).tails[0];
  await assert.rejects(catalog.invoke('readonly', {}, context, tail), /read-only/);
  await assert.rejects(catalog.invoke('unicode', {}, context, tail), /Invalid/);
});
