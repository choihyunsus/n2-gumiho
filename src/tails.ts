// One provider supplies independent role contexts, with explicit optional model/provider overrides.
import type { ModelProvider, TailDefinition, TailRole } from './types';
import { identity, positiveInteger, textValue, fingerprint } from './values';

const ROLES: TailRole[] = ['analyze', 'plan', 'build', 'verify', 'research', 'advisor', 'custom'];
export interface ResolvedTail {
  id: string;
  displayName: string;
  role: TailRole;
  readOnly: boolean;
  providerId: string;
  model: string;
  tools: string[] | null;
  system: string;
  maxOutputTokens: number;
}
export interface TailConfiguration {
  providers: ReadonlyMap<string, Readonly<ModelProvider>>;
  tails: readonly Readonly<ResolvedTail>[];
  bossId: string;
  hash: string;
}

export function configureTails(
  primary: ModelProvider,
  additional: ModelProvider[] = [],
  definitions?: TailDefinition[],
  bossId?: string,
): TailConfiguration {
  if (!Array.isArray(additional) || additional.length > 15)
    throw new Error('At most 16 providers can be registered');
  const providers = new Map<string, Readonly<ModelProvider>>();
  for (const definition of [primary, ...additional]) {
    const provider = checkedProvider(definition);
    if (providers.has(provider.id)) throw new Error('Duplicate provider ID');
    providers.set(provider.id, provider);
  }
  const configured =
    definitions ??
    (['analyze', 'plan', 'build', 'verify'] as const).map((role) => ({ id: role, role }));
  if (!Array.isArray(configured) || configured.length < 1 || configured.length > 16)
    throw new Error('Expected 1 through 16 tails');
  const tails = configured.map((definition) => resolveTail(definition, primary.id, providers));
  Object.freeze(tails);
  if (new Set(tails.map((tail) => tail.id)).size !== tails.length)
    throw new Error('Duplicate tail ID');
  const boss = identity(bossId ?? tails[0]!.id, 'boss ID');
  if (!tails.some((tail) => tail.id === boss))
    throw new Error('Boss must identify a configured tail');
  const metadata = [...providers.values()].map(({ id, version, model, local }) => ({
    id,
    version,
    model,
    local,
  }));
  return {
    providers,
    tails,
    bossId: boss,
    hash: fingerprint({ providers: metadata, tails, boss }, 1024 * 1024),
  };
}

function checkedProvider(value: ModelProvider): Readonly<ModelProvider> {
  if (!value || typeof value.generate !== 'function' || typeof value.local !== 'boolean')
    throw new Error('Invalid provider handler or locality');
  const id = identity(value.id, 'provider ID'),
    version = identity(value.version, 'provider version');
  const model = textValue(value.model, 'model name', 256);
  if (!model.trim()) throw new Error('An explicit model name is required');
  return Object.freeze({
    id,
    version,
    model,
    local: value.local,
    generate: value.generate.bind(value),
  });
}

function resolveTail(
  value: TailDefinition,
  primaryId: string,
  providers: ReadonlyMap<string, Readonly<ModelProvider>>,
): Readonly<ResolvedTail> {
  const id = identity(value.id, 'tail ID');
  if (!ROLES.includes(value.role)) throw new Error('Unknown tail role');
  const providerId = identity(value.providerId ?? primaryId, 'tail provider ID'),
    provider = providers.get(providerId);
  if (!provider) throw new Error('Tail refers to an unregistered provider');
  const model = textValue(value.model ?? provider.model, 'tail model', 256);
  if (!model.trim()) throw new Error('Tail model must be nonempty');
  if (value.readOnly !== undefined && typeof value.readOnly !== 'boolean')
    throw new Error('Tail readOnly must be a boolean');
  const tools = value.tools === undefined ? null : toolNames(value.tools);
  if (tools) Object.freeze(tools);
  return Object.freeze({
    id,
    displayName: textValue(value.displayName ?? id, 'tail display name', 512),
    role: value.role,
    readOnly: value.readOnly ?? value.role !== 'build',
    providerId,
    model,
    tools,
    system: textValue(value.system ?? '', 'tail system instructions', 32768),
    maxOutputTokens: positiveInteger(value.maxOutputTokens ?? 2048, 'tail output budget', 32768),
  });
}

function toolNames(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > 512)
    throw new Error('Expected at most 512 allowed tool names');
  const names = value.map((name) => identity(name, 'allowed tool name'));
  if (new Set(names).size !== names.length) throw new Error('Duplicate allowed tool name');
  return names;
}

export function resolveTailId(
  tails: readonly Readonly<ResolvedTail>[],
  address: string,
): Readonly<ResolvedTail> {
  const exact = tails.find((tail) => tail.id === address);
  if (exact) return exact;
  const roles = tails.filter((tail) => tail.role === address);
  if (roles.length !== 1) throw new Error('Unknown or ambiguous tail address; use its exact ID');
  return roles[0]!;
}
