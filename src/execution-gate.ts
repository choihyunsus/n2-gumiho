// FIFO admission permits bounded readers and gives queued writers exclusive workspace access.
import { positiveInteger } from './values';

interface WaitingTask {
  readOnly: boolean;
  signal: AbortSignal;
  execute(): Promise<void>;
  cancel(): void;
}
export class ExecutionGate {
  private readonly waiting: WaitingTask[] = [];
  private readers = 0;
  private writer = false;

  constructor(private readonly maximumReaders: number) {
    positiveInteger(maximumReaders, 'concurrency limit', 16);
  }

  run<T>(readOnly: boolean, signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.waiting.length >= 256) throw new Error('Execution queue limit exceeded');
    return new Promise((resolve, reject) => {
      const task: WaitingTask = {
        readOnly,
        signal,
        execute: async () => {
          try {
            signal.throwIfAborted();
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        },
        cancel: () => {
          const index = this.waiting.indexOf(task);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener('abort', task.cancel, { once: true });
      this.waiting.push(task);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length && !this.writer) {
      const next = this.waiting[0]!;
      if (next.readOnly ? this.readers >= this.maximumReaders : this.readers > 0) return;
      this.waiting.shift();
      next.signal.removeEventListener('abort', next.cancel);
      if (next.readOnly) this.readers++;
      else this.writer = true;
      void next.execute().finally(() => {
        if (next.readOnly) this.readers--;
        else this.writer = false;
        this.drain();
      });
    }
  }
}
