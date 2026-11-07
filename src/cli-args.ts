// Require explicit database/workspace scope and reject unknown or repeated command-line flags.
export interface CliArguments {
  command: 'run' | 'status' | 'reconcile' | 'help' | 'version';
  values: Record<string, string>;
}
const COMMON = ['db', 'project', 'agent', 'run-id'];
const ADAPTER = ['adapter', 'workspace', 'mode'];
const FLAGS = {
  run: [...COMMON, ...ADAPTER, 'task', 'session-id'],
  status: COMMON,
  reconcile: [...COMMON, ...ADAPTER, 'call-id', 'result', 'evidence'],
};

export function parseArguments(args: string[]): CliArguments {
  if (!args.length || args[0] === '--help') return { command: 'help', values: {} };
  if (args.length === 1 && args[0] === '--version') return { command: 'version', values: {} };
  const command = args[0] as 'run' | 'status' | 'reconcile';
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Expected run, status or reconcile');
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!,
      name = flag.slice(2),
      value = args[index + 1];
    if (!flag.startsWith('--') || !FLAGS[command].includes(name) || Object.hasOwn(values, name))
      throw new Error('Unknown or duplicate CLI flag');
    if (value === undefined || !value.trim()) throw new Error('Each CLI flag requires a value');
    values[name] = value;
  }
  const required =
    command === 'status'
      ? COMMON
      : command === 'run'
        ? [...COMMON, 'adapter', 'workspace', 'task']
        : [...COMMON, 'adapter', 'workspace', 'call-id', 'result', 'evidence'];
  for (const name of required) if (!values[name]) throw new Error(`Missing --${name}`);
  if (values.mode && !['pipeline', 'coordinator'].includes(values.mode))
    throw new Error('Unknown execution mode');
  return { command, values };
}
