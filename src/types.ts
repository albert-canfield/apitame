import type { AuditOutcome } from './safety/guardrails.js';

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
  /**
   * Set when the server is served over HTTP without authentication: any local process that can
   * reach it could answer an approval prompt, so the answer is not known to come from the client
   * the human uses. `confirmation.method: elicitation` then refuses, in both protocol eras.
   */
  anyoneCanAnswer?: boolean;
  signal?: AbortSignal;
  /** Who made the call, when the HTTP transport checked an OAuth access token. Audited. */
  caller?: { client?: string; subject?: string };
  /**
   * The scopes of that access token. With `caller`, they select the caller's permissions
   * (`http.oauth.permissions`). Not audited: the audit log names the entries that applied.
   */
  scopes?: string[];
  /**
   * Told what happens to the call as the runtime decides it: every audit entry it writes
   * (whether or not the audit file records it), and a call refused by a per-minute call limit.
   * Set by the MCP layer when OpenTelemetry export is on.
   */
  observe?: (event: CallEvent) => void;
}

/**
 * What a runtime reports about a tool call: the fields of an audit entry that are safe to export,
 * never arguments, reasons or the caller.
 */
export interface CallEvent {
  outcome: AuditOutcome;
  operation?: string;
  access?: Access;
  /** HTTP status of the API's response, when one arrived. */
  status?: number;
}

/** Who is asking, for the tools a caller may see. Without `caller`, the server config applies. */
export type CallerContext = Pick<CallContext, 'caller' | 'scopes'>;

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
  readonly sourceType: 'openapi' | 'postgres' | 'sqlite' | 'mysql' | 'duckdb';
  readonly mode: 'read-only' | 'read-write';
  /** Server instructions sent during the MCP handshake. */
  instructions(): string;
  /** The tools to list. With an OAuth caller, only the ones that caller may use. */
  listTools(who?: CallerContext): ToolDefinition[];
  summarizeTools(): ToolSummary[];
  callTool(name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult>;
  close(): Promise<void>;
}
