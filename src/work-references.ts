// Compact stage inputs keep durable references to the full job and native evidence.
import type { GumihoStore } from './run-store';
import type { JobResult } from './store-types';
import type { JsonValue } from './types';

export function jobReference(id: string, result: JobResult): JsonValue {
  return {
    jobId: id,
    success: result.success,
    summary: [...result.output].slice(0, 2048).join(''),
    changedFileCount: result.modifiedFiles.length,
    readTool: 'gumiho_read_job',
  };
}
export function receiptReference(store: GumihoStore, runId: string, id: string): JsonValue {
  const value = store.receipt(runId, id);
  if (value === undefined) throw new Error('Missing workflow evidence receipt');
  return {
    receiptId: id,
    preview: [...JSON.stringify(value)].slice(0, 4096).join(''),
    readTool: 'gumiho_read_receipt',
  };
}
