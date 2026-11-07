// Interactions API stores no server conversation and replays its complete chronological steps.
import type { JsonValue, ModelCall, ModelProvider, ModelReply, ModelRequest } from './types';
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

const FORMAT = 'gemini-interactions';
export function geminiInteractions(options: HttpProviderOptions): ModelProvider {
  return createWireProvider(
    options,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    { 'x-goog-api-key': apiCredential(options.apiKey, true) },
    { format: FORMAT, encode, decode },
  );
}

function encode(request: ModelRequest): JsonValue {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === 'user')
      input.push({ type: 'user_input', content: [{ type: 'text', text: message.content }] });
    else if (message.role === 'assistant')
      input.push(...arrayValue(continuation(message.reply, FORMAT)));
    else
      input.push({
        type: 'function_result',
        call_id: message.callId,
        name: message.name,
        is_error: !message.result.success,
        result: [{ type: 'text', text: JSON.stringify(message.result) }],
      });
  }
  return {
    model: request.model,
    system_instruction: request.system,
    input,
    store: false,
    stream: false,
    generation_config: { max_output_tokens: request.maxOutputTokens },
    tools: request.tools.map((tool) => ({ type: 'function', ...tool })),
  };
}

function decode(row: JsonObject, request: ModelRequest): ModelReply {
  const steps = arrayValue(row.steps),
    calls: ModelCall[] = [],
    text: string[] = [];
  let hasError = false;
  for (const raw of steps) {
    const step = objectValue(raw);
    if (step.type === 'function_call')
      calls.push({
        id: textValue(step.id, 'call ID'),
        name: textValue(step.name, 'tool name'),
        arguments: objectValue(step.arguments),
      });
    else if (step.type === 'model_output') {
      hasError ||= step.error !== undefined;
      for (const rawPart of arrayValue(step.content ?? [])) {
        const part = objectValue(rawPart);
        if (part.type !== 'text') throw new Error('Unsupported non-text output');
        text.push(textValue(part.text, 'model text', 131072));
      }
    } else if (step.type !== 'thought') throw new Error('Unsupported server-side step');
  }
  const usage = objectValue(row.usage ?? {}),
    output = tokenCount(usage.total_output_tokens),
    thoughts = tokenCount(usage.total_thought_tokens);
  const ready = !hasError && ['requires_action', 'completed'].includes(String(row.status));
  const stop =
    ready && calls.length
      ? 'tools'
      : ready && row.status === 'completed'
        ? 'complete'
        : 'incomplete';
  return {
    text: text.join('\n'),
    calls,
    stop,
    usage: modelUsage(
      usage.total_input_tokens,
      output === null ? null : output + (thoughts ?? 0),
      usage.total_cached_tokens,
    ),
    model: textValue(row.model ?? request.model, 'response model', 256),
    providerState: storedState(FORMAT, steps),
  };
}
