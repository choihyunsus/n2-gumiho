// Provider-neutral messages retain each adapter's continuation data alongside normalized tool calls.
import type { JsonValue, ToolContext, ToolDefinition, ToolResult } from 'n2-recipe';
export type { JsonValue, ToolResult } from 'n2-recipe';

export type TailRole = 'analyze' | 'plan' | 'build' | 'verify' | 'research' | 'advisor' | 'custom';
export interface ModelCall {
  id: string;
  name: string;
  arguments: JsonValue;
  metadata?: JsonValue;
}
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}
export interface ModelReply {
  text: string;
  calls: ModelCall[];
  stop: 'complete' | 'tools' | 'incomplete' | 'refused';
  usage: ModelUsage;
  model: string;
  providerState?: JsonValue;
}
export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; reply: ModelReply }
  | { role: 'tool'; callId: string; name: string; result: ToolResult; metadata?: JsonValue };

export interface ModelTool {
  name: string;
  description: string;
  parameters: { [key: string]: JsonValue };
}
export interface ModelRequest {
  model: string;
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  maxOutputTokens: number;
  requestId: string;
  signal: AbortSignal;
  onAttempt?: () => void;
}
export interface ModelProvider {
  readonly id: string;
  readonly version: string;
  readonly model: string;
  readonly local: boolean;
  generate(request: ModelRequest): Promise<ModelReply>;
}
export interface GumihoToolContext extends ToolContext {
  readonly jobId: string;
  readonly tailId: string;
  readonly role: TailRole;
  readonly workspaceRoot: string;
}
export interface GumihoTool extends Omit<ToolDefinition, 'execute'> {
  description: string;
  inputSchema: { [key: string]: JsonValue };
  execute(args: JsonValue, context: GumihoToolContext): ToolResult | Promise<ToolResult>;
}
export interface TailDefinition {
  id: string;
  displayName?: string;
  role: TailRole;
  readOnly?: boolean;
  providerId?: string;
  model?: string;
  tools?: string[];
  system?: string;
  maxOutputTokens?: number;
}
