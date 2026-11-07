// Responses API uses stateless replay, including opaque reasoning items and exact function call IDs.
import type { JsonValue, ModelCall, ModelProvider, ModelRequest } from './types';
import { arrayValue, modelUsage, objectValue, type JsonObject } from './model-validation';
import { apiCredential, type HttpProviderOptions } from './provider-http';
import { continuation, createWireProvider, jsonArguments, storedState } from './provider-protocol';
import { textValue } from './values';

const FORMAT = 'openai-responses';
export function openAIResponses(options: HttpProviderOptions): ModelProvider {
  const key = apiCredential(options.apiKey, true);
  return createWireProvider(
    options,
    'https://api.openai.com/v1/responses',
    { authorization: `Bearer ${key}` },
    { format: FORMAT, encode, decode },
  );
}

function encode(request: ModelRequest): JsonValue {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === 'user') input.push({ role: 'user', content: message.content });
    else if (message.role === 'assistant')
      input.push(...arrayValue(continuation(message.reply, FORMAT)));
    else
      input.push({
        type: 'function_call_output',
        call_id: message.callId,
        output: JSON.stringify(message.result),
      });
  }
  return {
    model: request.model,
    instructions: request.system,
    input,
    store: false,
    stream: false,
    max_output_tokens: request.maxOutputTokens,
    tools: request.tools.map((tool) => ({ type: 'function', ...tool, strict: false })),
  };
}

function decode(row: JsonObject, request: ModelRequest) {
  const output = arrayValue(row.output),
    calls: ModelCall[] = [],
    text: string[] = [];
  let refused = false;
  for (const raw of output) {
    const item = objectValue(raw);
    if (item.type === 'function_call') {
      calls.push({
        id: textValue(item.call_id, 'call ID'),
        name: textValue(item.name, 'tool name'),
        arguments: jsonArguments(item.arguments),
      });
    } else if (item.type === 'message') {
      for (const rawPart of arrayValue(item.content)) {
        const part = objectValue(rawPart);
        if (part.type === 'output_text') text.push(textValue(part.text, 'model text', 131072));
        else if (part.type === 'refusal') refused = true;
        else throw new Error('Unsupported response content');
      }
    } else if (item.type !== 'reasoning') throw new Error('Unsupported server-side tool response');
  }
  const usage = objectValue(row.usage ?? {}),
    details = objectValue(usage.input_tokens_details ?? {});
  const stop = refused
    ? 'refused'
    : row.status !== 'completed'
      ? 'incomplete'
      : calls.length
        ? 'tools'
        : 'complete';
  return {
    text: text.join('\n'),
    calls,
    stop: stop as 'refused' | 'incomplete' | 'tools' | 'complete',
    usage: modelUsage(usage.input_tokens, usage.output_tokens, details.cached_tokens),
    model: textValue(row.model ?? request.model, 'response model', 256),
    providerState: storedState(FORMAT, output),
  };
}
