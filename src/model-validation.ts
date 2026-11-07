// Check provider contracts and complete tool-response groups before persisting or sending history.
import type { JsonValue, ModelMessage, ModelReply, ModelRequest, ModelUsage } from './types';
import { identity, plainJson, positiveInteger, textValue } from './values';

export const MAX_WIRE_BYTES = 2097152;
export const MAX_REPLY_BYTES = 524288;
const MAX_HISTORY_MESSAGES = 512;
const MAX_MODEL_BYTES = 256;
export type JsonObject = { [key: string]: JsonValue };

export function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as JsonObject;
}

export function arrayValue(value: unknown, maximum = 256): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('Invalid JSON array');
  return value as JsonValue[];
}

export function tokenCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid token usage');
  return value;
}

export function modelUsage(input: unknown, output: unknown, cached: unknown): ModelUsage {
  return {
    inputTokens: tokenCount(input),
    outputTokens: tokenCount(output),
    cachedInputTokens: tokenCount(cached),
  };
}

export function checkedReply(value: ModelReply): ModelReply {
  const row = objectValue(plainJson(value, MAX_REPLY_BYTES, 32768));
  const calls = arrayValue(row.calls, 16).map((raw) => {
    const call = objectValue(raw);
    return {
      id: identity(call.id, 'model call ID'),
      name: identity(call.name, 'model tool name'),
      arguments: plainJson(objectValue(call.arguments)),
      ...(call.metadata === undefined ? {} : { metadata: plainJson(call.metadata) }),
    };
  });
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw new Error('Duplicate model tool-call ID');
  const stop = row.stop as ModelReply['stop'];
  if (!['complete', 'tools', 'incomplete', 'refused'].includes(stop))
    throw new Error('Invalid model stop reason');
  if ((stop === 'tools' && !calls.length) || (stop === 'complete' && calls.length))
    throw new Error('Model stop reason conflicts with tool calls');
  const usage = objectValue(row.usage);
  return {
    text: textValue(row.text, 'model text', 131072),
    calls,
    stop,
    usage: modelUsage(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens),
    model: textValue(row.model, 'response model', MAX_MODEL_BYTES),
    ...(row.providerState === undefined ? {} : { providerState: row.providerState }),
  };
}

export function checkRequest(request: ModelRequest): void {
  identity(request.requestId, 'model request ID');
  if (!textValue(request.model, 'request model', MAX_MODEL_BYTES).trim())
    throw new Error('An explicit model name is required');
  textValue(request.system, 'model instructions', 65536);
  positiveInteger(request.maxOutputTokens, 'model output budget', 32768);
  if (!Array.isArray(request.tools) || request.tools.length > 512)
    throw new Error('Too many model tools');
  plainJson({ messages: request.messages, tools: request.tools }, MAX_WIRE_BYTES, 65536);
  checkHistory(request.messages);
  request.signal.throwIfAborted();
}

export function checkHistory(
  messages: readonly ModelMessage[],
  maximumMessages = MAX_HISTORY_MESSAGES,
): void {
  if (!Array.isArray(messages) || !messages.length || messages.length > maximumMessages)
    throw new Error('Invalid model history length');
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (pending.get(message.callId) !== message.name)
        throw new Error('Orphaned or mismatched tool result');
      pending.delete(message.callId);
    } else {
      if (pending.size) throw new Error('Tool responses must form a complete adjacent group');
      if (message.role === 'assistant') {
        const reply = checkedReply(message.reply);
        if (reply.stop === 'incomplete' || reply.stop === 'refused')
          throw new Error('An interrupted model reply cannot continue as a successful turn');
        for (const call of reply.calls) pending.set(call.id, call.name);
      } else if (message.role === 'user') {
        textValue(message.content, 'user message', 131072);
      } else throw new Error('Unknown model message role');
    }
  }
  if (pending.size) throw new Error('Tool responses are missing');
}
