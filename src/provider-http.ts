// Bounded stateless requests keep credentials in closures and redact provider/network diagnostics.
import { setTimeout as delay } from 'node:timers/promises';
import type { JsonValue, ModelRequest } from './types';
import { plainJson, positiveInteger, textValue } from './values';
import { MAX_WIRE_BYTES, objectValue, type JsonObject } from './model-validation';

export interface HttpProviderOptions {
  id: string;
  model: string;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  retries?: number;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Model provider ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'ProviderError';
  }
}

class AttemptRejected extends Error {
  constructor(readonly reason: unknown) {
    super('Provider attempt was rejected by its budget');
  }
}

export function providerEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid provider endpoint');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Provider endpoint requires HTTPS or loopback HTTP, without URL credentials');
  return url.href;
}

export function apiCredential(value: string | undefined, required: boolean): string {
  const credential = textValue(value ?? '', 'API credential', 8192);
  if (/[\r\n]/.test(credential) || (required && !credential.trim()))
    throw new Error('A valid provider API credential is required');
  return credential;
}

export function jsonTransport(
  endpoint: string,
  headers: Record<string, string>,
  options: HttpProviderOptions,
): (body: JsonValue, request: ModelRequest) => Promise<JsonObject> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 120000, 'provider timeout', 3600000);
  const retries = options.retries ?? 1;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2)
    throw new Error('Provider retries must be between zero and two');
  const requestHeaders = Object.freeze({ ...headers, 'content-type': 'application/json' });
  // Each factory owns its endpoint/credential circuit. Independent accounts cannot block each other.
  let failures = 0,
    retryAfter = 0;
  return async (body, request) => {
    request.signal.throwIfAborted();
    if (retryAfter > Date.now()) throw new ProviderError('circuit_open');
    const encoded = JSON.stringify(plainJson(body, MAX_WIRE_BYTES, 65536));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ProviderError('timeout')), timeoutMs);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      const result = await sendAttempts(
        endpoint,
        requestHeaders,
        encoded,
        retries,
        request,
        signal,
      );
      failures = 0;
      retryAfter = 0;
      return result;
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof AttemptRejected) throw error.reason;
      if (++failures >= 3) retryAfter = Date.now() + 30000;
      if (controller.signal.aborted) throw new ProviderError('timeout');
      if (error instanceof ProviderError) throw error;
      // No raw server body, endpoint, request headers or fetch cause is included in diagnostics.
      throw new ProviderError('transport_failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

async function sendAttempts(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  retries: number,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<JsonObject> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      request.onAttempt?.();
    } catch (error) {
      throw new AttemptRejected(error);
    }
    const response = await raceAbort(
      fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
      }),
      signal,
    );
    if ((response.status === 429 || response.status === 503) && attempt < retries) {
      void response.body?.cancel().catch(() => undefined);
      await delay(retryDelay(response.headers.get('retry-after'), attempt), undefined, { signal });
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProviderError('request_failed', response.status);
    }
    return await readJson(response, signal);
  }
}

function retryDelay(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      // Respect a longer server delay by surfacing it, rather than retrying before that deadline.
      if (milliseconds > 30000) throw new ProviderError('retry_later', 429);
      return milliseconds;
    }
  }
  return 250 * (attempt + 1);
}

async function readJson(response: Response, signal: AbortSignal): Promise<JsonObject> {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > MAX_WIRE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderError('response_too_large_or_empty');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await raceAbort(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_WIRE_BYTES) throw new ProviderError('response_too_large');
      chunks.push(part.value);
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return objectValue(plainJson(JSON.parse(decoded), MAX_WIRE_BYTES, 65536));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('invalid_response');
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => undefined);
  signal.throwIfAborted();
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', rejectAbort);
  }
}
