import {
  Gumiho,
  inspectGumiho,
  openAIResponses,
  ollamaChat,
  commandVerifier,
  type GumihoOptions,
  type GumihoResult,
  type ModelProvider,
  type CliAdapter,
} from 'n2-gumiho';

const provider: ModelProvider = {
  id: 'fixture',
  version: '1',
  model: 'fixture',
  local: true,
  generate: async (request) => ({
    text: request.model,
    calls: [],
    stop: 'complete',
    model: request.model,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null },
  }),
};
const adapter: CliAdapter = {
  provider,
  tools: [],
  verifier: commandVerifier(
    [{ id: 'fixture', command: process.execPath, args: ['--version'] }],
    '1',
  ),
};
const options: GumihoOptions = {
  ...adapter,
  dbPath: 'memory.db',
  project: 'demo',
  agent: 'worker',
  workspaceRoot: '.',
  mode: 'coordinator',
  coordinator: { maxTurns: 4 },
};
async function typedExample(): Promise<GumihoResult> {
  const app = await Gumiho.create(options);
  try {
    return await app.run({ runId: 'fixture', task: 'Type checking fixture' });
  } finally {
    await app.close();
  }
}
void typedExample;
void inspectGumiho;
void openAIResponses;
void ollamaChat;
