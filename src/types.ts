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
  /**
   * Set instead of a final result when the human must approve first on a 2026-07-28 request:
   * the MCP layer answers with an input-required result that carries this prompt, and the
   * client calls again with the answer and `requestState` (a one-time approval id).
   */
  inputRequired?: { message: string; requestState: string };
}

/** Answer from a human confirmation prompt (MCP elicitation). */
export type ElicitOutcome = 'accept' | 'decline' | 'cancel' | 'unsupported';

/**
 * Approval state of a request on protocol 2026-07-28, where the human is asked in two rounds
 * (multi round-trip input) instead of in the middle of the call.
 */
export interface ApprovalRound {
  /** Whether this request's client can show a form to the human (elicitation capability). */
  canAsk: boolean;
  /** The approval id the client sent back as `requestState`, on the second round. */
  state?: string;
  /** The human's answer on the second round. `accept` only when the form came back approved. */
  answer?: 'accept' | 'decline' | 'cancel';
}

/** Per-call context handed to a runtime by the MCP layer. */
export interface CallContext {
  /** Ask the human to approve something. Resolves to 'unsupported' when the client cannot. */
  elicit?: (message: string) => Promise<ElicitOutcome>;
  /** Set on 2026-07-28 requests instead of `elicit`. */
  approval?: ApprovalRound;
  signal?: AbortSignal;
  /** Who made the call, when the HTTP transport checked an OAuth access token. Audited. */
  caller?: { client?: string; subject?: string };
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
  readonly sourceType: 'openapi' | 'postgres' | 'sqlite' | 'mysql';
  readonly mode: 'read-only' | 'read-write';
  /** Server instructions sent during the MCP handshake. */
  instructions(): string;
  listTools(): ToolDefinition[];
  summarizeTools(): ToolSummary[];
  callTool(name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult>;
  close(): Promise<void>;
}
