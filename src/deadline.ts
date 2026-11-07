// Async deadlines reject promptly while propagating cancellation to cooperative host operations.
import { raceAbort } from './provider-http';
import { positiveInteger } from './values';

export async function withDeadline<T>(
  signal: AbortSignal,
  milliseconds: number,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  positiveInteger(milliseconds, 'operation timeout', 3600000);
  signal.throwIfAborted();
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error('Gumiho operation deadline exceeded')),
    milliseconds,
  );
  try {
    return await raceAbort(
      Promise.resolve().then(() => operation(combined)),
      combined,
    );
  } finally {
    clearTimeout(timer);
    controller.abort(new Error('Gumiho invocation ended'));
  }
}
