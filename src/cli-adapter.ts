// Operator-selected local modules supply provider credentials, capabilities and actual native checks.
import { realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GumihoOptions } from './gumiho-options';
import type { ToolResult } from './types';
import { plainJson, textValue } from './values';
const MAX_RESULT_BYTES = 131072;

export type CliAdapter = Omit<GumihoOptions, 'dbPath' | 'project' | 'agent' | 'workspaceRoot'>;
export async function loadAdapter(filename: string): Promise<CliAdapter> {
  const resolved = await realpath(path.resolve(textValue(filename, 'adapter path', 4096)));
  if (!(await stat(resolved)).isFile() || !['.js', '.mjs', '.cjs'].includes(path.extname(resolved)))
    throw new Error('Adapter must be a local JavaScript module');
  const loaded = await import(pathToFileURL(resolved).href),
    adapter = loaded.default ?? loaded;
  if (
    !adapter ||
    typeof adapter !== 'object' ||
    !Array.isArray(adapter.tools) ||
    typeof adapter.provider?.generate !== 'function' ||
    typeof adapter.verifier?.verify !== 'function'
  )
    throw new Error('Adapter must export a provider, tools and a native verifier');
  return adapter as CliAdapter;
}

export async function loadResult(filename: string): Promise<ToolResult> {
  const resolved = await realpath(path.resolve(textValue(filename, 'result path', 4096))),
    info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_RESULT_BYTES)
    throw new Error('Result must be a JSON file within 128 KiB');
  const handle = await open(resolved, 'r'),
    buffer = Buffer.allocUnsafe(MAX_RESULT_BYTES + 1);
  let length = 0;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Result must remain a regular file');
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const raw = buffer.subarray(0, length);
  if (raw.length > MAX_RESULT_BYTES) throw new Error('Result file grew beyond its byte limit');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  return plainJson(JSON.parse(decoded), MAX_RESULT_BYTES) as unknown as ToolResult;
}
