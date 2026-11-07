// Resolve explicit host capabilities and shared-database scope before opening any workflow.
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { GumihoTool, ModelProvider, TailDefinition } from './types';
import type { NativeVerifier } from './native-verifier';
import {
  ArtifactScanner,
  canonicalWorkspace,
  type SnapshotOptions,
  workspaceRelative,
} from './artifacts';
import { configureTails, type TailConfiguration } from './tails';
import { executionLimits, type ExecutionLimits } from './execution-limits';
import {
  pipelineConfiguration,
  type PipelineConfiguration,
  type PipelineOptions,
} from './pipeline-config';
import { ToolCatalog } from './tool-catalog';
import { fingerprint, identity, plainJson, textValue } from './values';
import { objectValue } from './model-validation';
import { REPLAY_VERSION } from './version';
import {
  coordinatorConfiguration,
  type CoordinatorConfiguration,
  type CoordinatorOptions,
} from './coordinator-config';

export interface GumihoOptions {
  dbPath: string;
  project: string;
  agent: string;
  workspaceRoot: string;
  provider: ModelProvider;
  providers?: ModelProvider[];
  tails?: TailDefinition[];
  tools: GumihoTool[];
  verifier: NativeVerifier;
  limits?: Partial<ExecutionLimits>;
  pipeline?: PipelineOptions;
  snapshot?: SnapshotOptions;
  expertise?: boolean;
  mode?: 'pipeline' | 'coordinator';
  coordinator?: CoordinatorOptions;
}
export interface ResolvedOptions {
  dbPath: string;
  project: string;
  agent: string;
  workspaceRoot: string;
  tails: TailConfiguration;
  tools: GumihoTool[];
  verifier: Readonly<NativeVerifier>;
  limits: Readonly<ExecutionLimits>;
  pipeline: PipelineConfiguration | null;
  coordinator: CoordinatorConfiguration | null;
  mode: 'pipeline' | 'coordinator';
  scanner: ArtifactScanner;
  expertise: boolean;
  hash: string;
}

export async function resolveOptions(options: GumihoOptions): Promise<ResolvedOptions> {
  const workspaceRoot = await canonicalWorkspace(options.workspaceRoot),
    dbPath = await databasePath(options.dbPath);
  const project = scopeName(options.project),
    agent = scopeName(options.agent);
  const tails = configureTails(options.provider, options.providers, options.tails),
    limits = executionLimits(options.limits);
  const tools = checkedTools(options.tools),
    catalog = new ToolCatalog(tools);
  const verifier = checkedVerifier(options.verifier),
    workflow = resolveWorkflow(tails, options);
  const scanner = new ArtifactScanner(workspaceRoot, {
    ...options.snapshot,
    excludePaths: [
      ...(options.snapshot?.excludePaths ?? []),
      ...storageExclusions(workspaceRoot, dbPath),
    ],
  });
  const expertise = options.expertise ?? true;
  if (typeof expertise !== 'boolean') throw new Error('Expertise must be a boolean');
  const hash = fingerprint({
    engineVersion: REPLAY_VERSION,
    tails: tails.hash,
    tools: catalog.hash,
    verifier: verifier.version,
    limits,
    ...workflow,
    snapshot: scanner.policyHash,
    expertise,
  });
  return {
    dbPath,
    project,
    agent,
    workspaceRoot,
    tails,
    tools,
    verifier,
    limits,
    ...workflow,
    scanner,
    expertise,
    hash,
  };
}

function resolveWorkflow(
  tails: TailConfiguration,
  options: GumihoOptions,
): Pick<ResolvedOptions, 'mode' | 'pipeline' | 'coordinator'> {
  const mode = options.mode ?? 'pipeline';
  if (mode !== 'pipeline' && mode !== 'coordinator')
    throw new Error('Unknown Gumiho execution mode');
  return {
    mode,
    pipeline: mode === 'pipeline' ? pipelineConfiguration(tails, options.pipeline) : null,
    coordinator:
      mode === 'coordinator' ? coordinatorConfiguration(tails, options.coordinator) : null,
  };
}

async function databasePath(value: string): Promise<string> {
  const filename = textValue(value, 'database path', 4096);
  if (!filename.trim() || filename === ':memory:')
    throw new Error('Gumiho requires an explicit durable database file');
  const absolute = path.resolve(filename);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parent = await realpath(path.dirname(absolute)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return path.dirname(absolute);
  });
  return path.join(parent, path.basename(absolute));
}

function checkedVerifier(value: NativeVerifier): Readonly<NativeVerifier> {
  if (!value || typeof value.verify !== 'function')
    throw new Error('A host native verifier is required');
  return Object.freeze({
    version: identity(value.version, 'native verifier version'),
    verify: value.verify.bind(value),
  });
}

function checkedTools(values: GumihoTool[]): GumihoTool[] {
  if (!Array.isArray(values) || values.length > 509)
    throw new Error('Expected at most 509 host tools');
  return values.map((tool) => {
    if (typeof tool.execute !== 'function' || tool.name.startsWith('gumiho_'))
      throw new Error('Invalid or reserved host tool');
    return {
      name: tool.name,
      version: tool.version,
      description: tool.description,
      readOnly: tool.readOnly,
      idempotent: tool.idempotent,
      inputSchema: objectValue(plainJson(tool.inputSchema, 32768)),
      execute: tool.execute.bind(tool),
    };
  });
}
function scopeName(value: string): string {
  if (!textValue(value, 'scope name', 512).trim())
    throw new Error('Project and agent must be explicit');
  return value;
}
function storageExclusions(root: string, dbPath: string): string[] {
  const relative = path.relative(root, dbPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return [];
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((filename) =>
    workspaceRelative(root, filename),
  );
}
