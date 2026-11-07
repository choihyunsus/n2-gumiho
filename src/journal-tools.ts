// Give tails paginated access to complete receipts within their current project/agent/run scope.
import type { GumihoStore } from './run-store';
import type { CallJournal } from './call-journal';
import type { GumihoTool, JsonValue } from './types';
import { objectValue } from './model-validation';
import { textPage } from './history';

const schema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 8192 },
  },
  required: ['id'],
  additionalProperties: false,
};

export function journalTools(store: GumihoStore, journal: CallJournal): GumihoTool[] {
  return [
    {
      name: 'gumiho_read_job',
      version: '1',
      readOnly: true,
      description:
        'Read a job and its invocation IDs from the current run. Results are paginated by Unicode characters.',
      inputSchema: schema,
      execute: (args, context) => {
        const id = objectValue(args).id as string,
          job = store.job(context.runId, id);
        if (!job) return { success: false, output: 'Job does not exist in this run' };
        const calls = journal
          .list(context.runId, id)
          .map((call) => ({ id: call.id, kind: call.kind, state: call.state }));
        return page({ job, calls }, args);
      },
    },
    {
      name: 'gumiho_read_call',
      version: '1',
      readOnly: true,
      description:
        'Read complete model or tool invocation evidence from the current run. Results are paginated by Unicode characters.',
      inputSchema: schema,
      execute: (args, context) => {
        const id = objectValue(args).id as string,
          call = journal.get(context.runId, id);
        return call
          ? page(call, args)
          : { success: false, output: 'Invocation does not exist in this run' };
      },
    },
    {
      name: 'gumiho_read_receipt',
      version: '1',
      readOnly: true,
      description:
        'Read complete workspace snapshots or native verification evidence from the current run, paginated by Unicode characters.',
      inputSchema: schema,
      execute: (args, context) => {
        const value = store.receipt(context.runId, objectValue(args).id as string);
        return value === undefined
          ? { success: false, output: 'Receipt does not exist in this run' }
          : page(value, args);
      },
    },
  ];
}

function page(value: unknown, args: JsonValue) {
  const parameters = objectValue(args),
    result = textPage(
      JSON.stringify(value),
      (parameters.offset as number) ?? 0,
      (parameters.limit as number) ?? 4096,
    );
  return {
    success: true,
    output: result.text,
    data: { nextOffset: result.nextOffset, totalCharacters: result.totalCharacters },
  };
}
