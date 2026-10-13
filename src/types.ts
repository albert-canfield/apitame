/** A JSON Schema object, kept loose on purpose: specs in the wild are messy. */
export type JsonSchema = Record<string, unknown>;

/** How risky an operation is. Drives what the safety layer allows. */
export type Access = 'read' | 'write' | 'destructive';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool exactly as it is sent to MCP clients in `tools/list`. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: 'object' };
  annotations?: ToolAnnotations;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

/** Answer from a human confirmation prompt (MCP elicitation). */
export type ElicitOutcome = 'accept' | 'decline' | 'cancel' | 'unsupported';

/** Per-call context handed to a runtime by the MCP layer. */
export interface CallContext {
  /** Ask the human to approve something. Resolves to 'unsupported' when the client cannot. */
  elicit?: (message: string) => Promise<ElicitOutcome>;
  signal?: AbortSignal;
}

/** Summary row used by `inspect` and the generators. */
export interface ToolSummary {
  name: string;
  kind: 'group' | 'operation' | 'search' | 'call' | 'sql' | 'named-query';
  access: Access;
  operations: string[];
}

/** A source-specific runtime: the thing an MCP server serves. */
export interface Runtime {
  readonly name: string;
  readonly sourceType: 'openapi' | 'postgres' | 'sqlite';
  readonly mode: 'read-only' | 'read-write';
  /** Server instructions sent during the MCP handshake. */
  instructions(): string;
  listTools(): ToolDefinition[];
  summarizeTools(): ToolSummary[];
  callTool(name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult>;
  close(): Promise<void>;
}
