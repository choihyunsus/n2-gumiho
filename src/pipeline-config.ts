// Pipeline stage assignments remain independent of provider count and keep review read-only.
import { resolveTailId, type TailConfiguration } from './tails';
import { positiveInteger } from './values';

export interface PipelineOptions {
  analyzeTail?: string;
  planTail?: string;
  buildTail?: string;
  verifyTail?: string;
  maxRepairs?: number;
  advisorTail?: string;
  advisorMaxCalls?: number;
}
export interface PipelineConfiguration {
  analyzeTail: string;
  planTail: string;
  buildTail: string;
  verifyTail: string;
  maxRepairs: number;
  advisorTail: string | null;
  advisorMaxCalls: number;
}
export function pipelineConfiguration(
  tails: TailConfiguration,
  options: PipelineOptions = {},
): PipelineConfiguration {
  const analyze = resolveTailId(tails.tails, options.analyzeTail ?? 'analyze'),
    plan = resolveTailId(tails.tails, options.planTail ?? 'plan'),
    build = resolveTailId(tails.tails, options.buildTail ?? 'build'),
    verify = resolveTailId(tails.tails, options.verifyTail ?? 'verify');
  if (!analyze.readOnly || !plan.readOnly || !verify.readOnly || build.readOnly)
    throw new Error(
      'Pipeline requires read-only analysis, planning and review, plus a write-capable build tail',
    );
  const repairs = options.maxRepairs ?? 1;
  if (!Number.isInteger(repairs) || repairs < 0 || repairs > 3)
    throw new Error('Repair rounds must be between zero and three');
  const advisor =
    options.advisorTail === undefined ? null : resolveTailId(tails.tails, options.advisorTail);
  if (advisor && !advisor.readOnly) throw new Error('Advisor must have read-only capabilities');
  return {
    analyzeTail: analyze.id,
    planTail: plan.id,
    buildTail: build.id,
    verifyTail: verify.id,
    maxRepairs: repairs,
    advisorTail: advisor?.id ?? null,
    advisorMaxCalls: positiveInteger(options.advisorMaxCalls ?? 3, 'advisor call budget', 8),
  };
}
