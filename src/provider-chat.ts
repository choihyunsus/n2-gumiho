// Explicit compatibility adapter for hosts that expose Chat Completions function calling.
import type { JsonValue, ModelCall, ModelProvider, ModelReply, ModelRequest } from './types';
import { arrayValue, modelUsage, objectValue, type JsonObject } from './model-validation';
import { apiCredential, type HttpProviderOptions } from './provider-http';
import { continuation, createWireProvider, jsonArguments, storedState } from './provider-protocol';
import { textValue } from './values';

export interface ChatCompatibleOptions extends HttpProviderOptions {
  endpoint: string;
  local?: boolean;
  outputTokenField?: 'max_completion_tokens' | 'max_tokens';
}

export function openAICompatible(options: ChatCompatibleOptions): ModelProvider {
  const field = options.outputTokenField ?? 'max_completion_tokens',
    local = options.local ?? false;
  if (!['max_completion_tokens', 'max_tokens'].includes(field) || typeof local !== 'boolean')
    throw new Error('Invalid chat compatibility options');
  const format = `chat-${field}`,
    key = apiCredential(options.apiKey, false);
  return createWireProvider(
    options,
    options.endpoint,
    key ? { authorization: `Bearer ${key}` } : {},
    {
      format,
      encode: (request) => encode(request, format, field),
      decode: (response, request) => decode(response, request, format),
    },
    local,
  );
}

function encode(request: ModelRequest, format: string, field: string): JsonValue {
  const messages: JsonValue[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: message.content });
    else if (message.role === 'assistant') messages.push(continuation(message.reply, format));
    else
      messages.push({
        role: 'tool',
        tool_call_id: message.callId,
        content: JSON.stringify(message.result),
      });
  }
  return {
    model: request.model,
    messages,
    stream: false,
    [field]: request.maxOutputTokens,
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: { ...tool, strict: false },
    })),
  };
}

function decode(row: JsonObject, request: ModelRequest, format: string): ModelReply {
  const choices = arrayValue(row.choices);
  if (choices.length !== 1) throw new Error('Expected one model choice');
  const choice = objectValue(choices[0]),
    message = objectValue(choice.message);
  if (message.role !== 'assistant') throw new Error('Expected an assistant message');
  const calls: ModelCall[] = arrayValue(message.tool_calls ?? [], 16).map((raw) => {
    const call = objectValue(raw),
      fn = objectValue(call.function);
    if (call.type !== 'function') throw new Error('Unsupported tool call');
    return {
      id: textValue(call.id, 'call ID'),
      name: textValue(fn.name, 'tool name'),
      arguments: jsonArguments(fn.arguments),
    };
  });
  const reason = choice.finish_reason;
  let stop: ModelReply['stop'] = 'incomplete';
  if (message.refusal || reason === 'content_filter') stop = 'refused';
  else if (reason === 'tool_calls') stop = 'tools';
  else if (reason === 'stop') stop = 'complete';
  const usage = objectValue(row.usage ?? {}),
    details = objectValue(usage.prompt_tokens_details ?? {});
  return {
    text: textValue(message.content ?? '', 'model text', 131072),
    calls,
    stop,
    usage: modelUsage(usage.prompt_tokens, usage.completion_tokens, details.cached_tokens),
    model: textValue(row.model ?? request.model, 'response model', 256),
    providerState: storedState(format, message),
  };
}
