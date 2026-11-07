// Resource ceilings are explicit and form part of each durable run's configuration identity.
import { positiveInteger } from './values';
import type { StorageLimits } from './store-types';
const MAX_TIMEOUT_MS = 3600000;

export interface ExecutionLimits extends StorageLimits {
  maxTurnsPerJob: number;
  maxHistoryBytes: number;
  maxParallelReaders: number;
  localConcurrency: number;
  cloudConcurrency: number;
  modelTimeoutMs: number;
  toolTimeoutMs: number;
  jobTimeoutMs: number;
}
export function executionLimits(value: Partial<ExecutionLimits> = {}): Readonly<ExecutionLimits> {
  return Object.freeze({
    maxJobs: positiveInteger(value.maxJobs ?? 64, 'job limit', 256),
    maxModelRequests: positiveInteger(value.maxModelRequests ?? 64, 'model request limit', 1024),
    maxToolCalls: positiveInteger(value.maxToolCalls ?? 128, 'tool call limit', 4096),
    maxOutputTokens: positiveInteger(
      value.maxOutputTokens ?? 131072,
      'total output budget',
      2097152,
    ),
    maxTraceBytes: positiveInteger(value.maxTraceBytes ?? 33554432, 'trace byte budget', 134217728),
    maxTurnsPerJob: positiveInteger(value.maxTurnsPerJob ?? 16, 'turn limit', 128),
    maxHistoryBytes: positiveInteger(
      value.maxHistoryBytes ?? 262144,
      'history byte budget',
      2097152,
    ),
    maxParallelReaders: positiveInteger(value.maxParallelReaders ?? 2, 'reader concurrency', 8),
    localConcurrency: positiveInteger(value.localConcurrency ?? 1, 'local model concurrency', 2),
    cloudConcurrency: positiveInteger(value.cloudConcurrency ?? 2, 'cloud model concurrency', 8),
    modelTimeoutMs: positiveInteger(
      value.modelTimeoutMs ?? 120000,
      'model timeout',
      MAX_TIMEOUT_MS,
    ),
    toolTimeoutMs: positiveInteger(value.toolTimeoutMs ?? 120000, 'tool timeout', MAX_TIMEOUT_MS),
    jobTimeoutMs: positiveInteger(value.jobTimeoutMs ?? 600000, 'job timeout', MAX_TIMEOUT_MS),
  });
}
