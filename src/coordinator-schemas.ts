// Bounded control-plane schemas validate delegation before any worker can run.
import type { GumihoTool } from './types';
export function dispatchSchema(targets: string[]): GumihoTool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      jobs: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            tail: { type: 'string', enum: targets },
            task: { type: 'string', minLength: 1, maxLength: 8192 },
            context: { type: 'string', maxLength: 4096 },
          },
          required: ['tail', 'task'],
          additionalProperties: false,
        },
      },
    },
    required: ['jobs'],
    additionalProperties: false,
  };
}
export const RETRY_SCHEMA: GumihoTool['inputSchema'] = {
  type: 'object',
  properties: {
    jobId: { type: 'string', minLength: 1, maxLength: 128 },
    feedback: { type: 'string', maxLength: 4096 },
  },
  required: ['jobId'],
  additionalProperties: false,
};
