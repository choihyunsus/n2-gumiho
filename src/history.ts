// Compact only complete assistant/tool groups and retain deterministic references to durable calls.
import type { ModelMessage } from './types';
import { checkHistory } from './model-validation';
import { identity, positiveInteger, textValue } from './values';

export interface HistoryWindow {
  messages: ModelMessage[];
  omittedTurns: number;
}
export function historyWindow(
  history: readonly ModelMessage[],
  maximumBytes: number,
  jobId: string,
): HistoryWindow {
  positiveInteger(maximumBytes, 'history byte limit', 2097152);
  identity(jobId, 'history job ID');
  checkHistory(history, 2177);
  if (history[0]?.role !== 'user') throw new Error('Job history must begin with its task');
  if (history.length <= 512 && size(history) <= maximumBytes)
    return { messages: structuredClone(history) as ModelMessage[], omittedTurns: 0 };
  const boundaries = history.flatMap((message, index) =>
    message.role === 'assistant' ? [index] : [],
  );
  for (let omitted = 1; omitted < boundaries.length; omitted++) {
    const boundary = boundaries[omitted]!;
    const summary = summaryMessage(history.slice(1, boundary), jobId, omitted);
    const candidate = [history[0], summary, ...history.slice(boundary)];
    if (candidate.length <= 512 && size(candidate) <= maximumBytes)
      return { messages: structuredClone(candidate), omittedTurns: omitted };
  }
  throw new Error('Task and latest complete model/tool group exceed the history byte budget');
}

function summaryMessage(
  omitted: readonly ModelMessage[],
  jobId: string,
  turns: number,
): ModelMessage {
  const recent = omitted.filter((message) => message.role === 'assistant').slice(-4);
  const summary = recent.map((message) => ({
    text: [...message.reply.text].slice(0, 256).join(''),
    tools: message.reply.calls.map((call) => call.name),
  }));
  return {
    role: 'user',
    content: JSON.stringify({
      historyNotice:
        'Earlier complete turns are stored in the local job journal. Use gumiho_read_job or gumiho_read_call to inspect full receipts when needed.',
      jobId,
      omittedTurns: turns,
      recentSummaries: summary,
    }),
  };
}

export function textPage(
  value: string,
  offset: number,
  limit: number,
): { text: string; nextOffset: number | null; totalCharacters: number } {
  textValue(value, 'stored result text', 1048576);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid result offset');
  positiveInteger(limit, 'result page length', 8192);
  const characters = Array.from(value),
    end = Math.min(offset + limit, characters.length);
  if (offset > characters.length) throw new Error('Result offset exceeds its length');
  return {
    text: characters.slice(offset, end).join(''),
    nextOffset: end < characters.length ? end : null,
    totalCharacters: characters.length,
  };
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
