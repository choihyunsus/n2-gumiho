// Execute only explicitly configured host commands with bounded output, cancellation and deadlines.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { identity, positiveInteger, textValue } from './values';

export interface CheckCommand {
  id: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface CheckReceipt {
  id: string;
  command: string;
  args: string[];
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  failure: string | null;
}
export interface ResolvedCommand {
  id: string;
  command: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export function resolveCommand(value: CheckCommand): ResolvedCommand {
  const id = identity(value.id, 'check ID'),
    command = textValue(value.command, 'check command', 4096);
  if (!command.trim() || !Array.isArray(value.args ?? []) || (value.args?.length ?? 0) > 128)
    throw new Error('Invalid check command');
  return {
    id,
    command,
    args: (value.args ?? []).map((arg) => textValue(arg, 'check argument', 4096)),
    timeoutMs: positiveInteger(value.timeoutMs ?? 120000, 'check timeout', 3600000),
    maxOutputBytes: positiveInteger(value.maxOutputBytes ?? 65536, 'check output limit', 262144),
  };
}

export async function runCheck(
  command: ResolvedCommand,
  workspace: string,
  signal: AbortSignal,
): Promise<CheckReceipt> {
  signal.throwIfAborted();
  const child = spawn(command.command, command.args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  return await new CheckProcess(child, command, signal).run();
}

class CheckProcess {
  private readonly started = Date.now();
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private bytes = 0;
  private failure: string | null = null;
  private settled = false;
  private timer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private resolve!: (receipt: CheckReceipt) => void;
  private readonly onAbort = () => this.stop('cancelled');

  constructor(
    private readonly child: ChildProcess,
    private readonly command: ResolvedCommand,
    private readonly signal: AbortSignal,
  ) {}

  run(): Promise<CheckReceipt> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => this.stop('timeout'), this.command.timeoutMs);
      this.signal.addEventListener('abort', this.onAbort, { once: true });
      this.child.stdout!.on('data', (data: Buffer) => this.collect(this.stdout, data));
      this.child.stderr!.on('data', (data: Buffer) => this.collect(this.stderr, data));
      this.child.once('error', () => {
        this.failure = 'spawn_failed';
        this.finish(null, null);
      });
      this.child.once('close', (code, exitSignal) => this.finish(code, exitSignal));
      if (this.signal.aborted) this.onAbort();
    });
  }

  private finish(code: number | null, exitSignal: string | null): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    clearTimeout(this.killTimer);
    this.signal.removeEventListener('abort', this.onAbort);
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
    this.resolve({
      id: this.command.id,
      command: this.command.command,
      args: [...this.command.args],
      success: code === 0 && !this.failure,
      exitCode: code,
      signal: exitSignal,
      durationMs: Date.now() - this.started,
      stdout: Buffer.concat(this.stdout).toString('utf8'),
      stderr: Buffer.concat(this.stderr).toString('utf8'),
      failure: this.failure,
    });
  }

  private stop(reason: string): void {
    if (this.failure || this.settled) return;
    this.failure = reason;
    killTree(this.child);
    this.killTimer = setTimeout(() => this.finish(null, null), 1000);
  }

  private collect(target: Buffer[], data: Buffer): void {
    if (this.failure || this.settled) return;
    const remaining = this.command.maxOutputBytes - this.bytes;
    target.push(data.subarray(0, remaining));
    this.bytes += data.length;
    if (this.bytes > this.command.maxOutputBytes) this.stop('output_limit');
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const executable = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    );
    const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    killer.once('error', () => {
      child.kill();
    });
    killer.unref();
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
