// Offline deterministic fixture demonstrating real file work and native verification in both modes.
const tools = require('./workspace-tools.cjs');
const readText = tools.find((tool) => tool.name === 'read_text');
const writeText = tools.find((tool) => tool.name === 'write_text');
const filename = 'gumiho-demo.txt';
const content = 'hello from gumiho\n';

function reply(text, calls = []) {
  return {
    text,
    calls,
    stop: calls.length ? 'tools' : 'complete',
    model: 'offline-fixture',
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
  };
}
function fixtureReply(request) {
  const input = JSON.parse(request.messages[0].content);
  if (request.system.includes('Gumiho coordinator.')) {
    const turn = request.messages.filter((message) => message.role === 'assistant').length;
    if (turn === 0)
      return reply('Delegate the demonstration', [
        {
          id: 'dispatch',
          name: 'gumiho_dispatch',
          arguments: {
            jobs: [
              { tail: 'build', task: 'Create gumiho-demo.txt with the demonstration content' },
            ],
          },
        },
      ]);
    if (turn === 1)
      return reply('Verify the demonstration', [
        { id: 'verify', name: 'gumiho_verify', arguments: {} },
      ]);
    return reply('The demonstration completed');
  }
  if (request.system.startsWith('Implement the assigned') && request.messages.length === 1)
    return reply('Create the demonstration file', [
      { id: 'write', name: 'write_demo', arguments: {} },
    ]);
  if (request.system.startsWith('Independently inspect'))
    return reply(
      JSON.stringify({ approved: true, snapshotHash: input.context.snapshotHash, findings: [] }),
    );
  return reply('The deterministic demonstration stage completed');
}

module.exports = {
  provider: {
    id: 'offline',
    version: '1',
    model: 'offline-fixture',
    local: true,
    generate: async (request) => fixtureReply(request),
  },
  tools: [
    {
      name: 'write_demo',
      version: '1',
      idempotent: true,
      description:
        'Create the demonstration file while preserving an existing file with different content',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute(_args, context) {
        return writeText.execute({ path: filename, content, expectedSha256: 'new' }, context);
      },
    },
  ],
  verifier: {
    version: 'demo-1',
    verify(context) {
      const actual = readText.execute({ path: filename }, context);
      return {
        success: actual.success && actual.output === content,
        summary: 'Compared the actual demonstration file bytes',
        evidence: { filename, sha256: actual.data?.sha256 ?? null },
      };
    },
  },
};
