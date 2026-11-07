#!/usr/bin/env node
// CLI operations use the same verified lifecycle and recovery entry points as library callers.
import { Gumiho } from './gumiho';
import { inspectGumiho } from './inspect';
import { parseArguments, type CliArguments } from './cli-args';
import { loadAdapter, loadResult } from './cli-adapter';
import { VERSION } from './version';

const HELP = `n2-gumiho ${VERSION}

run --adapter FILE --db FILE --workspace DIR --project NAME --agent NAME --run-id ID --task TEXT
    [--session-id ID] [--mode pipeline|coordinator]
status --db FILE --project NAME --agent NAME --run-id ID
reconcile --adapter FILE --db FILE --workspace DIR --project NAME --agent NAME --run-id ID
          --call-id ID --result JSON_FILE --evidence TEXT [--mode pipeline|coordinator]

Adapters are explicit local JavaScript modules. Configure provider credentials through the host environment.
Exit codes are 0 for success, 1 for errors/interruption, 2 for completed failed work, and 3 for a missing status record.
`;

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2)),
    values = args.values;
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command === 'status') {
    const status = inspectGumiho({
      dbPath: values.db!,
      project: values.project!,
      agent: values.agent!,
      runId: values['run-id']!,
    });
    process.stdout.write(JSON.stringify(status ?? null) + '\n');
    return status ? 0 : 3;
  }
  return await operate(args);
}

async function operate(args: CliArguments): Promise<number> {
  const values = args.values,
    adapter = await loadAdapter(values.adapter!);
  const app = await Gumiho.create({
    ...adapter,
    dbPath: values.db!,
    workspaceRoot: values.workspace!,
    project: values.project!,
    agent: values.agent!,
    ...(values.mode ? { mode: values.mode as 'pipeline' | 'coordinator' } : {}),
  });
  const controller = new AbortController(),
    cancel = () => controller.abort(new Error('CLI execution interrupted'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (args.command === 'reconcile') {
      await app.reconcileTool(
        values['run-id']!,
        values['call-id']!,
        await loadResult(values.result!),
        values.evidence!,
      );
      process.stdout.write(
        JSON.stringify({ reconciled: true, runId: values['run-id'], callId: values['call-id'] }) +
          '\n',
      );
      return 0;
    }
    const result = await app.run(
      { runId: values['run-id']!, sessionId: values['session-id'], task: values.task! },
      controller.signal,
    );
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.success ? 0 : 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await app.close();
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Gumiho CLI failed';
    process.stderr.write(message.slice(0, 4096) + '\n');
    process.exitCode = 1;
  },
);
