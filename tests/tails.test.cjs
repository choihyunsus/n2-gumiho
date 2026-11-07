const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configureTails, resolveTailId } = require('../dist/tails');
const { plainJson, textValue, fingerprint } = require('../dist/values');
const primary = () => ({
  id: 'primary',
  version: '1',
  model: 'fixture-small',
  local: true,
  generate: async () => ({}),
});

test('one provider creates four independent role definitions and explicit capability defaults', () => {
  const config = configureTails(primary());
  assert.deepEqual(
    config.tails.map((t) => t.role),
    ['analyze', 'plan', 'build', 'verify'],
  );
  assert.equal(config.providers.size, 1);
  assert.equal(
    config.tails.every((t) => t.providerId === 'primary'),
    true,
  );
  assert.deepEqual(
    config.tails.map((t) => t.readOnly),
    [true, true, false, true],
  );
  assert.equal(
    config.tails.every((t) => t.maxOutputTokens === 2048),
    true,
  );
  assert.equal(config.bossId, 'analyze');
});

test('provider/model/tool overrides preserve empty allowlists and Unicode IDs without exposing credential fields', () => {
  const parent = { ...primary(), apiKey: 'fixture-sensitive-value' };
  const list = [
    { id: '분석', role: 'analyze', tools: [] },
    {
      id: 'builder',
      role: 'build',
      providerId: 'remote',
      model: 'override',
      maxOutputTokens: 1024,
    },
  ];
  const config = configureTails(parent, [{ ...primary(), id: 'remote', local: false }], list);
  assert.equal(config.tails[0].id, '분석');
  assert.deepEqual(config.tails[0].tools, []);
  assert.equal(config.tails[1].model, 'override');
  assert.equal(config.tails[1].providerId, 'remote');
  assert.equal(
    JSON.stringify([...config.providers.values()]).includes('fixture-sensitive-value'),
    false,
  );
  list[1].model = 'changed';
  assert.equal(config.tails[1].model, 'override');
  assert.throws(() => config.tails[0].tools.push('write'));
});

test('exact tail IDs precede ambiguous role aliases and configuration rejects invalid references and budgets', () => {
  const config = configureTails(
    primary(),
    [],
    [
      { id: 'build', role: 'verify' },
      { id: 'writer', role: 'build' },
      { id: 'second', role: 'verify' },
    ],
  );
  assert.equal(resolveTailId(config.tails, 'build').role, 'verify');
  assert.throws(() => resolveTailId(config.tails, 'verify'), /ambiguous/);
  assert.throws(() => configureTails(primary(), [primary()]), /Duplicate provider/);
  assert.throws(() => configureTails(primary(), [], []), /1 through 16/);
  assert.throws(
    () => configureTails(primary(), [], [{ id: 'x', role: 'build', providerId: 'missing' }]),
    /unregistered/,
  );
  for (const value of [0, -1, 1.5, 32769])
    assert.throws(
      () => configureTails(primary(), [], [{ id: 'x', role: 'build', maxOutputTokens: value }]),
      /budget/,
    );
  assert.throws(
    () => configureTails(primary(), [], [{ id: 'x', role: 'build', readOnly: 'false' }]),
    /boolean/,
  );
  assert.throws(() => configureTails(primary(), [], undefined, 'absent'), /configured tail/);
});

test('bounded JSON rejects malformed UTF-8, unsafe integers and excessive structure while retaining prototype-shaped data', () => {
  assert.throws(() => textValue('\uD800', 'text'), /Invalid/);
  assert.throws(() => plainJson({ value: '\uD800' }), /Invalid/);
  assert.throws(() => plainJson(Number.MAX_SAFE_INTEGER + 1), /precision/);
  assert.throws(() => plainJson(Array(4096).fill(0)), /element/);
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
  assert.deepEqual(plainJson(value), value);
  assert.equal({}.polluted, undefined);
  assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});
