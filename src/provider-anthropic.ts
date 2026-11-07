// Messages API preserves every content block and groups tool results immediately after tool use.
import type { JsonValue, ModelCall, ModelProvider, ModelRequest, ModelReply } from './types';
import {
  arrayValue,
  modelUsage,
  objectValue,
  tokenCount,
  type JsonObject,
} from './model-validation';
import { apiCredential, type HttpProviderOptions } from './provider-http';
import { continuation, createWireProvider, storedState } from './provider-protocol';
import { textValue } from './values';

const FORMAT = 'anthropic-messages-2026-10-21';
export function anthropicMessages(options: HttpProviderOptions): ModelProvider {
  return createWireProvider(
    options,
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': apiCredential(options.apiKey, true), 'anthropic-version': '2026-10-21' },
    { format: FORMAT, encode, decode },
  );
}

function encode(request: ModelRequest): JsonValue {
  const messages: JsonValue[] = [];
  let toolResults: JsonValue[] = [];
  const flushResults = () => {
    if (toolResults.length) messages.push({ role: 'user', content: toolResults });
    toolResults = [];
  };
  for (const message of request.messages) {
    if (message.role === 'tool') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: message.callId,
        content: JSON.stringify(message.result),
        is_error: !message.result.success,
      });
    } else {
      flushResults();
      messages.push(
        message.role === 'user'
          ? { role: 'user', content: message.content }
          : { role: 'assistant', content: continuation(message.reply, FORMAT) },
      );
    }
  }
  flushResults();
  return {
    model: request.model,
    system: request.system,
    max_tokens: request.maxOutputTokens,
    stream: false,
    messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
  };
}

function decode(row: JsonObject, request: ModelRequest): ModelReply {
  const content = arrayValue(row.content),
    calls: ModelCall[] = [],
    text: string[] = [];
  for (const raw of content) {
    const part = objectValue(raw);
    if (part.type === 'text') text.push(textValue(part.text, 'model text', 131072));
    else if (part.type === 'tool_use')
      calls.push({
        id: textValue(part.id, 'call ID'),
        name: textValue(part.name, 'tool name'),
        arguments: objectValue(part.input),
      });
    else if (part.type !== 'thinking' && part.type !== 'redacted_thinking')
      throw new Error('Unsupported response content');
  }
  const usage = objectValue(row.usage ?? {}),
    details = objectValue(row.stop_details ?? {});
  const reason = row.stop_reason;
  let stop: ModelReply['stop'] = 'incomplete';
  if (details.type === 'refusal' || reason === 'refusal') stop = 'refused';
  else if (reason === 'tool_use') stop = 'tools';
  else if (reason === 'end_turn' || reason === 'stop_sequence') stop = 'complete';
  const input = tokenCount(usage.input_tokens),
    cacheRead = tokenCount(usage.cache_read_input_tokens),
    cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  // Anthropic reports uncached input separately from cached and cache-creation input.
  const totalInput = input === null ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    text: text.join('\n'),
    calls,
    stop,
    usage: modelUsage(totalInput, usage.output_tokens, cacheRead),
    model: textValue(row.model ?? request.model, 'response model', 256),
    providerState: storedState(FORMAT, content),
  };
}
