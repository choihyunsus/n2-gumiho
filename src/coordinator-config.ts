// The controller inherits a model route while its delegation targets are configured separately.
import { resolveTailId, type ResolvedTail, type TailConfiguration } from './tails';
import { positiveInteger } from './values';
const INSTRUCTIONS = [
  'Gumiho coordinator. Coordinate the original task with the declared worker tails.',
  'Dispatch independent jobs in a batch. Await results before dispatching dependent work. Retry failed jobs explicitly.',
  'Use gumiho_verify after work is complete. It runs native checks and independent review. Finish only after it succeeds and all failed or pending jobs are resolved.',
  'You have orchestration and journal tools. Delegate workspace operations to the allowed workers.',
].join('\n\n');

export interface CoordinatorOptions {
  sourceTail?: string;
  verifyTail?: string;
  targets?: string[];
  maxTurns?: number;
  advisorTail?: string;
  advisorMaxCalls?: number;
}
export interface CoordinatorConfiguration {
  controller: Readonly<ResolvedTail>;
  verifyTail: string;
  targets: string[];
  maxTurns: number;
  advisorTail: string | null;
  advisorMaxCalls: number;
}
export function coordinatorConfiguration(
  configuration: TailConfiguration,
  options: CoordinatorOptions = {},
): CoordinatorConfiguration {
  const source = resolveTailId(configuration.tails, options.sourceTail ?? configuration.bossId);
  const verify = resolveTailId(configuration.tails, options.verifyTail ?? 'verify');
  if (!verify.readOnly) throw new Error('Coordinator review requires a read-only tail');
  if (configuration.tails.some((tail) => tail.id === 'gumiho-controller'))
    throw new Error('gumiho-controller is a reserved tail ID');
  const targetNames =
    options.targets ??
    configuration.tails.filter((tail) => tail.role !== 'advisor').map((tail) => tail.id);
  if (!Array.isArray(targetNames) || !targetNames.length || targetNames.length > 16)
    throw new Error('Expected 1 through 16 delegation targets');
  const targets = targetNames.map((name) => resolveTailId(configuration.tails, name).id);
  if (new Set(targets).size !== targets.length) throw new Error('Duplicate delegation target');
  const advisor =
    options.advisorTail === undefined
      ? null
      : resolveTailId(configuration.tails, options.advisorTail);
  if (advisor && !advisor.readOnly) throw new Error('Advisor must have read-only capabilities');
  const descriptions = targets.map((id) => {
    const tail = resolveTailId(configuration.tails, id);
    return { id, role: tail.role, readOnly: tail.readOnly };
  });
  const system = [INSTRUCTIONS, JSON.stringify({ targets: descriptions }), source.system]
    .filter(Boolean)
    .join('\n\n');
  return {
    controller: Object.freeze({
      ...source,
      id: 'gumiho-controller',
      displayName: 'Coordinator',
      role: 'custom',
      readOnly: false,
      tools: null,
      system,
    }),
    verifyTail: verify.id,
    targets,
    maxTurns: positiveInteger(options.maxTurns ?? 16, 'coordinator turn limit', 64),
    advisorTail: advisor?.id ?? null,
    advisorMaxCalls: positiveInteger(options.advisorMaxCalls ?? 3, 'advisor call budget', 8),
  };
}
