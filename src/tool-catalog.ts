// Reuse N2R's handler/result contract and validate host JSON schemas before any tool side effect.
import { createHash } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { ToolRegistry } from 'n2-recipe';
import type { GumihoTool, GumihoToolContext, JsonValue, ModelTool, ToolResult } from './types';
import type { ResolvedTail } from './tails';
import { plainJson, textValue, fingerprint } from './values';
const MAX_CATALOG_BYTES = 1048576;
const MAX_RESULT_BYTES = 131072;

interface CatalogEntry {
  definition: GumihoTool;
  schema: ModelTool;
  validate: ValidateFunction;
}
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

export class ToolCatalog {
  private readonly registry: ToolRegistry;
  private readonly entries = new Map<string, CatalogEntry>();
  readonly hash: string;

  constructor(definitions: GumihoTool[]) {
    if (!Array.isArray(definitions) || definitions.length > 512)
      throw new Error('Expected at most 512 work tools');
    definitions = definitions.map((definition) => ({ ...definition }));
    this.registry = new ToolRegistry(
      definitions.map((definition) => ({
        name: definition.name,
        version: definition.version,
        readOnly: definition.readOnly,
        idempotent: definition.idempotent,
        execute: (args, context) => definition.execute(args, context as GumihoToolContext),
      })),
    );
    const ajv = new Ajv({ strict: true, allowUnionTypes: true, ownProperties: true });
    addFormats(ajv);
    for (const definition of definitions) {
      const parameters = plainJson(definition.inputSchema, 32768);
      if (
        !parameters ||
        typeof parameters !== 'object' ||
        Array.isArray(parameters) ||
        parameters.type !== 'object' ||
        parameters.$async
      )
        throw new Error('Tool input schemas must be synchronous JSON object schemas');
      const name = wireName(definition.name);
      if (this.entries.has(name)) throw new Error('Model-facing tool name collision');
      const validate = ajv.compile(parameters);
      const schema = {
        name,
        description: textValue(definition.description, 'tool description', 2048),
        parameters,
      };
      this.entries.set(name, { definition: { ...definition }, schema, validate });
    }
    this.hash = fingerprint(
      [...this.entries.values()].map(({ definition, schema }) => ({
        name: definition.name,
        version: definition.version,
        readOnly: definition.readOnly ?? false,
        idempotent: definition.idempotent ?? definition.readOnly ?? false,
        schema,
      })),
      MAX_CATALOG_BYTES,
    );
  }

  list(tail: Readonly<ResolvedTail>): ModelTool[] {
    return [...this.entries.values()]
      .filter((entry) => allowed(tail, entry.definition))
      .map((entry) => structuredClone(entry.schema));
  }

  check(
    name: string,
    args: JsonValue,
    tail: Readonly<ResolvedTail>,
  ): { name: string; version: string; args: JsonValue; idempotent: boolean; readOnly: boolean } {
    const entry = this.entries.get(name);
    if (!entry || !allowed(tail, entry.definition))
      throw new ToolValidationError("Tool is outside this tail's registered capabilities");
    const checked = plainJson(args);
    if (!entry.validate(checked))
      throw new ToolValidationError('Tool arguments do not match the registered JSON schema');
    return {
      name: entry.definition.name,
      version: entry.definition.version,
      args: checked,
      readOnly: entry.definition.readOnly ?? false,
      idempotent: entry.definition.idempotent ?? entry.definition.readOnly ?? false,
    };
  }

  async invoke(
    name: string,
    args: JsonValue,
    context: GumihoToolContext,
    tail: Readonly<ResolvedTail>,
  ): Promise<ToolResult> {
    const checked = this.check(name, args, tail);
    const result = await this.registry.invoke(checked.name, checked.args, context);
    plainJson(result, MAX_RESULT_BYTES);
    return result;
  }
}

function allowed(tail: Readonly<ResolvedTail>, tool: GumihoTool): boolean {
  if (tail.readOnly && !tool.readOnly) return false;
  return tail.tools === null || tail.tools.includes(tool.name);
}

function wireName(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  return 'tool_' + createHash('sha256').update(name).digest('hex').slice(0, 32);
}
