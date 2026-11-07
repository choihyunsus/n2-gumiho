// Provider adapters share bounded HTTP handling while retaining their native continuation records.
import type { JsonValue, ModelProvider, ModelReply, ModelRequest } from './types';
import { identity, fingerprint, textValue } from './values';
import { checkRequest, checkedReply, objectValue, type JsonObject } from './model-validation';
import {
  jsonTransport,
  providerEndpoint,
  ProviderError,
  type HttpProviderOptions,
} from './provider-http';

export interface WireProtocol {
  format: string;
  configuration?: JsonValue;
  encode(request: ModelRequest): JsonValue;
  decode(response: JsonObject, request: ModelRequest): ModelReply;
}

export function createWireProvider(
  options: HttpProviderOptions,
  defaultEndpoint: string,
  headers: Record<string, string>,
  protocol: WireProtocol,
  local = false,
): ModelProvider {
  const id = identity(options.id, 'provider ID'),
    model = textValue(options.model, 'provider model', 256);
  if (!model.trim()) throw new Error('An explicit model is required');
  const endpoint = providerEndpoint(options.endpoint ?? defaultEndpoint);
  const transport = jsonTransport(endpoint, headers, options);
  const version = `${protocol.format}-1-${fingerprint({ endpoint, model, configuration: protocol.configuration ?? null }).slice(0, 16)}`;
  return Object.freeze({
    id,
    version,
    model,
    local,
    async generate(request: ModelRequest): Promise<ModelReply> {
      checkRequest(request);
      const response = await transport(protocol.encode(request), request);
      try {
        return checkedReply(protocol.decode(response, request));
      } catch {
        throw new ProviderError('invalid_model_response');
      }
    },
  });
}

export function continuation(reply: ModelReply, format: string): JsonValue {
  const state = objectValue(reply.providerState);
  if (state.format !== format || state.value === undefined)
    throw new Error('Missing or incompatible provider continuation state');
  return state.value;
}

export function storedState(format: string, value: JsonValue): JsonObject {
  return { format, value };
}

export function jsonArguments(value: unknown): JsonValue {
  return objectValue(JSON.parse(textValue(value, 'function arguments')));
}
