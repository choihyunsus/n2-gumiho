// Configure an already installed local model and real project checks through the environment.
const { ollamaChat, commandVerifier } = require('../dist/library.js');
const tools = require('./workspace-tools.cjs');
const model = process.env.N2_GUMIHO_MODEL;
const checkArguments = process.env.N2_GUMIHO_CHECK_ARGS;
if (!model || !checkArguments)
  throw new Error('Set N2_GUMIHO_MODEL and N2_GUMIHO_CHECK_ARGS before loading this adapter');
const toolMode = process.env.N2_GUMIHO_TOOL_MODE ?? 'native';
if (!['native', 'json'].includes(toolMode))
  throw new Error('N2_GUMIHO_TOOL_MODE must be native or json');

module.exports = {
  provider: ollamaChat({
    id: 'local',
    model,
    toolMode,
    endpoint: process.env.N2_GUMIHO_OLLAMA_ENDPOINT,
    contextLength: process.env.N2_GUMIHO_CONTEXT_LENGTH
      ? Number(process.env.N2_GUMIHO_CONTEXT_LENGTH)
      : undefined,
    think:
      process.env.N2_GUMIHO_THINK === undefined
        ? undefined
        : JSON.parse(process.env.N2_GUMIHO_THINK),
  }),
  tools,
  verifier: commandVerifier(
    [
      {
        id: 'project-checks',
        command: process.env.N2_GUMIHO_CHECK_COMMAND ?? process.execPath,
        args: JSON.parse(checkArguments),
        timeoutMs: Number(process.env.N2_GUMIHO_CHECK_TIMEOUT_MS ?? 120000),
      },
    ],
    'project-checks-1',
  ),
};
