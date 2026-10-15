import { createAuth, type AuthProvider } from '../auth/index.js';
import { envValues, resolveEnv } from '../config/env.js';
import type { Config, ToolGroupConfig } from '../config/schema.js';
import { Logger } from '../log.js';
import { ConfirmationStore, confirmOrChallenge } from '../safety/confirm.js';
import { Guardrails, type AuditEntry, type AuditOutcome } from '../safety/guardrails.js';
import {
  callerPermissions,
  checkPermissions,
  toolAllowed,
  type CallerPermissions,
  type Reach,
} from '../safety/permissions.js';
import { decide, matchesAny, type Decision } from '../safety/policy.js';
import { REDACTED, Redactor } from '../safety/redact.js';
import { WriteRules } from '../safety/rules.js';
import { loadSpec, resolveBaseUrl, type LoadedSpec } from '../sources/openapi/load.js';
import {
  extractOperations,
  operationTitle,
  signature,
  type Operation,
} from '../sources/openapi/operations.js';
import { truncate } from '../sources/openapi/schema.js';
import type {
  Access,
  CallContext,
  CallerContext,
  JsonSchema,
  Runtime,
  ToolAnnotations,
  ToolDefinition,
  ToolResult,
  ToolSummary,
} from '../types.js';
import type { Paging } from '../sources/openapi/pagination.js';
import {
  buildRequest,
  fitJson,
  RequestBuildError,
  sendRequest,
  type BuiltRequest,
  type HttpResult,
} from './http-client.js';
import { errorResult, jsonResult } from './results.js';
import { parseFields, projectFields } from './fields.js';
import { parseDryRun, parsePages } from './flags.js';
import {
  applyPosition,
  continuation,
  type Continuation,
  cutsInsidePages,
  jsonBytes,
  listAt,
  positionAfter,
  positionKeys,
  withList,
} from './pages.js';
import { ArgValidator } from './validate.js';

export interface OpenApiRuntimeOptions {
  config: Config;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  redactor?: Redactor;
  logger?: Logger;
  /** Point requests somewhere else (the `test` command uses this for the mock server). */
  baseUrlOverride?: string;
  /** Pre-loaded spec, to avoid parsing twice. */
  spec?: LoadedSpec;
  /** Rate limits and audit log. Built from the config when not given. */
  guardrails?: Guardrails;
}

interface BuiltTool {
  def: ToolDefinition;
  summary: ToolSummary;
  kind: 'group' | 'operation' | 'search' | 'call';
  ops: Operation[];
  /** Single-operation tools: API parameters exposed under another name (`api_confirm` -> `confirm`). */
  renamed?: Record<string, string>;
}

/** The tools one caller sees, by name too. */
interface ToolView {
  list: BuiltTool[];
  byName: Map<string, BuiltTool>;
  /**
   * The operations this caller can reach at all: those of the groups it sees, and, when it sees
   * call_operation, those in no group. Undefined without permissions: every operation.
   */
  surface?: Set<string>;
}

const viewOf = (list: BuiltTool[], surface?: Set<string>): ToolView => ({
  list,
  byName: new Map(list.map((t) => [t.def.name, t])),
  ...(surface ? { surface } : {}),
});

/** Tool lists kept for callers with different permissions. Each is rebuilt when evicted. */
const MAX_VIEWS = 32;

/** Arguments that steer apitame itself rather than the API. */
const CONTROL_ARGS = ['dryRun', 'confirm', 'fields', 'pages'] as const;

/**
 * Controls an API parameter of the same name takes over in single-operation tools: they only
 * shape the result, so the API's own meaning wins. dryRun and confirm never give way.
 */
const YIELDING = new Set<string>(['fields', 'pages']);

interface Flags {
  dryRun: boolean;
  confirm: string | undefined;
  fields: string[] | undefined;
  pages: number | undefined;
}

/** Read the control arguments. */
function parseFlags(args: {
  dryRun?: unknown;
  confirm?: unknown;
  fields?: unknown;
  pages?: unknown;
}): Flags {
  return {
    dryRun: parseDryRun(args.dryRun),
    confirm: typeof args.confirm === 'string' ? args.confirm : undefined,
    fields: parseFields(args.fields),
    pages: parsePages(args.pages),
  };
}

/** One page read by `pages`, kept until the result is fitted to the size limit. */
interface PageData {
  /** The arguments that read it. */
  args: Record<string, unknown>;
  /** The body after field selection and redaction, and its list. */
  envelope: unknown;
  shown: unknown[];
  /** The list as received, for ids. */
  items: unknown[];
  /** Size of the envelope with an empty list. */
  fixed: number;
  /** sums[c]: size of the first c items, measured only as far as the budget could hold. */
  sums: number[];
  /** Where the page after this one starts. */
  cont: Continuation;
}

const SEARCH = 'search_operations';
const CALL = 'call_operation';

function worstAccess(ops: Operation[]): Access {
  if (ops.some((o) => o.access === 'destructive')) return 'destructive';
  if (ops.some((o) => o.access === 'write')) return 'write';
  return 'read';
}

function tag(op: Operation, d: Decision): string {
  if (op.access === 'read') return '';
  if (d.allowed && d.needsConfirmation) return ` [${op.access}, asks for confirmation]`;
  return ` [${op.access}]`;
}

export class OpenApiRuntime implements Runtime {
  readonly sourceType = 'openapi' as const;
  readonly name: string;
  readonly mode: Config['mode'];
  readonly operations: Operation[];
  readonly byId: Map<string, Operation>;
  readonly baseUrl: string | undefined;
  readonly warnings: string[] = [];
  /** `writes.rules`, checked before any write is previewed, confirmed or sent. */
  readonly rules: WriteRules;

  private readonly groups: ToolGroupConfig[];
  /** The configured groups each operation belongs to. */
  private readonly groupsOf = new Map<string, string[]>();
  /** Groups the server config lists as a single-operation tool: they keep that shape per caller. */
  private readonly singleOps: Set<string>;
  private readonly tools: BuiltTool[];
  private readonly toolByName: Map<string, BuiltTool>;
  /** Tool lists for OAuth callers whose permissions narrow the server config, by permission set. */
  private readonly views = new Map<string, ToolView>();
  private readonly validator = new ArgValidator();
  private readonly confirmations: ConfirmationStore;
  private readonly guardrails: Guardrails;
  private readonly redactor: Redactor;
  private readonly logger: Logger;
  /** When each operation last logged a refused next link, so an API cannot flood the log. */
  private readonly linkWarnings = new Map<string, number>();
  private auth: AuthProvider | undefined;
  private authError: Error | undefined;
  private readonly staticHeaders: Record<string, string>;

  constructor(
    readonly config: Config,
    readonly spec: LoadedSpec,
    private readonly opts: Omit<OpenApiRuntimeOptions, 'config' | 'spec'>,
  ) {
    if (config.source.type !== 'openapi') throw new Error('OpenApiRuntime needs an openapi source');
    const env = opts.env ?? process.env;
    this.name = config.name;
    this.mode = config.mode;
    this.redactor = opts.redactor ?? new Redactor();
    this.logger = opts.logger ?? new Logger(this.redactor);
    this.confirmations = new ConfirmationStore(config.confirmation.ttlSeconds * 1_000);
    this.guardrails =
      opts.guardrails ?? Guardrails.fromConfig(config, opts.configDir, this.redactor, this.logger);

    const authHeaders =
      config.auth.type === 'apiKey' && config.auth.in === 'header' ? [config.auth.name] : [];
    this.operations = extractOperations(spec.doc, {
      treatAsRead: config.writes.treatAsRead,
      destructive: config.writes.destructive,
      authHeaders,
    });
    this.byId = new Map(this.operations.map((o) => [o.id, o]));
    this.rules = new WriteRules(
      config.writes.rules,
      this.operations.map((o) => ({ id: o.id, access: o.access, schema: o.inputSchema })),
      this.redactor,
    );
    this.warnings.push(...this.rules.warnings);

    // Values that come from environment variables are secrets wherever they are used:
    // a base URL can carry a token in its path (Telegram bots, webhooks), a static header
    // a tenant key. Only the variable parts are registered, so previews still show the host.
    const fromEnv = (template: string, field: string) => {
      const value = resolveEnv(template, field, env);
      for (const v of envValues(template, env)) this.redactor.addSecret(v);
      return value;
    };
    const override =
      opts.baseUrlOverride ??
      (config.source.baseUrl ? fromEnv(config.source.baseUrl, 'source.baseUrl') : undefined);
    this.baseUrl = resolveBaseUrl(spec.doc, spec.location, override);
    this.staticHeaders = Object.fromEntries(
      Object.entries(config.source.headers).map(([k, v]) => [k, fromEnv(v, `source.headers.${k}`)]),
    );

    // Resolve credentials now so a missing variable is reported early, but keep serving:
    // tool calls will explain the problem to the agent instead of the server failing to start.
    try {
      this.auth = createAuth(config.auth, this.redactor, env, opts.fetchImpl);
    } catch (err) {
      this.authError = err as Error;
      this.warnings.push((err as Error).message);
    }

    this.groups = this.resolveGroups();
    for (const g of this.groups)
      for (const id of g.operations)
        this.groupsOf.set(id, [...(this.groupsOf.get(id) ?? []), g.name]);
    this.tools = this.buildTools();
    this.toolByName = new Map(this.tools.map((t) => [t.def.name, t]));
    this.singleOps = new Set(
      this.tools.filter((t) => t.kind === 'operation').map((t) => t.def.name),
    );
    this.warnings.push(
      ...checkPermissions(config, {
        tools: [
          ...config.tools.map((g) => g.name),
          ...(config.longTail.enabled ? [SEARCH, CALL] : []),
        ],
        operations: this.operations.map((o) => ({ id: o.id, write: o.access !== 'read' })),
        noun: 'operation',
        reach: this.reach,
      }),
    );
  }

  /**
   * Whether tools matching these patterns reach an operation: a group that holds it, or
   * call_operation for an operation in no group. call_operation never reaches an operation of a
   * group, so hiding the group hides its operations.
   */
  private readonly reach: Reach = (tools, id) => {
    if (tools === undefined) return true;
    const groups = this.groupsOf.get(id);
    if (groups) return groups.some((g) => matchesAny(g, tools));
    return this.config.longTail.enabled && matchesAny(CALL, tools);
  };

  private permissionsOf(who: CallerContext | undefined): CallerPermissions | undefined {
    return callerPermissions(this.config, who, this.reach);
  }

  /** The server config, narrowed by an OAuth caller's permissions when there are any. */
  private policy(perm?: CallerPermissions) {
    return { mode: this.config.mode, writes: this.config.writes, caller: perm };
  }

  private decision(op: Operation, perm?: CallerPermissions): Decision {
    return decide(op.id, op.access, this.policy(perm));
  }

  private exposed(op: Operation, perm?: CallerPermissions): boolean {
    return !op.unsupported && this.decision(op, perm).allowed;
  }

  /** The argument rules of a write, as one line for its tool description. */
  private rulesLine(op: Operation): string {
    const text = this.rules.describe(op.id);
    return text ? `Rules: ${text}.` : '';
  }

  private writesEnabled(perm?: CallerPermissions): boolean {
    return this.operations.some((o) => o.access !== 'read' && this.exposed(o, perm));
  }

  /**
   * The tools a caller sees: the server's own list without permissions, else a list built for
   * the caller's permission set (only operations and tools it may use) and kept for reuse.
   */
  private toolsFor(perm: CallerPermissions | undefined): ToolView {
    if (!perm) return { list: this.tools, byName: this.toolByName };
    let view = this.views.get(perm.key);
    if (!view) {
      const surface = new Set<string>();
      for (const o of this.operations) if (this.reach(perm.tools, o.id)) surface.add(o.id);
      view = viewOf(
        this.buildTools(perm, surface).filter((t) => toolAllowed(t.def.name, perm)),
        surface,
      );
      if (this.views.size >= MAX_VIEWS) this.views.delete(this.views.keys().next().value ?? '');
      this.views.set(perm.key, view);
    }
    return view;
  }

  private safetyProps(ops: Operation[], perm?: CallerPermissions): Record<string, JsonSchema> {
    const props: Record<string, JsonSchema> = {};
    // Explained once in the server instructions, so no per-tool description.
    if (ops.some((o) => o.response)) props.fields = { type: 'array', items: { type: 'string' } };
    if (this.pagingOffered(ops)) {
      props.pages = { type: 'integer', minimum: 1, maximum: this.config.limits.maxPages };
    }
    if (ops.some((o) => o.access !== 'read')) {
      props.dryRun = {
        type: 'boolean',
        description: 'Return the exact request without sending it.',
      };
    }
    if (
      ops.some((o) => {
        const d = this.decision(o, perm);
        return d.allowed && d.needsConfirmation;
      })
    ) {
      props.confirm = {
        type: 'string',
        description: 'Confirmation token from a previous call, only after the user approved.',
      };
    }
    return props;
  }

  /** Whether a tool over these operations offers `pages`. */
  private pagingOffered(ops: Operation[]): boolean {
    return this.config.limits.maxPages > 1 && ops.some((o) => o.paging);
  }

  private annotations(title: string, ops: Operation[]): ToolAnnotations {
    const access = worstAccess(ops);
    return {
      title,
      readOnlyHint: access === 'read',
      destructiveHint: access === 'destructive',
      openWorldHint: true,
    };
  }

  private resolveGroups(): ToolGroupConfig[] {
    const groups: ToolGroupConfig[] = [];
    for (const g of this.config.tools) {
      const known = g.operations.filter((id) => this.byId.has(id));
      const unknown = g.operations.filter((id) => !this.byId.has(id));
      if (unknown.length > 0) {
        this.warnings.push(`Tool "${g.name}" references unknown operations: ${unknown.join(', ')}`);
      }
      if (known.length > 0) groups.push({ ...g, operations: known });
    }
    return groups;
  }

  private buildTools(perm?: CallerPermissions, surface?: Set<string>): BuiltTool[] {
    const tools: BuiltTool[] = [];
    for (const g of this.groups) {
      const ops = g.operations.map((id) => this.byId.get(id)!).filter((o) => this.exposed(o, perm));
      if (ops.length === 0) continue;
      const title = g.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

      // A caller sees a group in the shape the server config gives it, whatever it may use.
      if (perm ? this.singleOps.has(g.name) : ops.length === 1) {
        const op = ops[0]!;
        const description = [
          g.description,
          `${operationTitle(op)} (${op.method.toUpperCase()} ${op.path})${tag(op, this.decision(op, perm))}`,
          this.rulesLine(op),
        ]
          .filter(Boolean)
          .join('\n');
        // dryRun and confirm keep their meaning. An API parameter with the same name is
        // exposed as api_<name>, so an agent can never send a "dry run" to the API for real.
        // An API's own `fields` wins over field selection (the API trims server-side), and its
        // own `pages` over apitame's paging.
        const controls = this.safetyProps(ops, perm);
        const reserved = (k: string) => k in controls && !YIELDING.has(k);
        const renamed: Record<string, string> = {};
        const props: Record<string, JsonSchema> = {};
        for (const [k, v] of Object.entries(
          (op.inputSchema.properties ?? {}) as Record<string, JsonSchema>,
        )) {
          const name = reserved(k) ? `api_${k}` : k;
          if (name !== k) renamed[name] = k;
          props[name] = v;
        }
        const required = (op.inputSchema.required as string[] | undefined)?.map((r) =>
          reserved(r) ? `api_${r}` : r,
        );
        tools.push({
          kind: 'operation',
          ops,
          renamed,
          def: {
            name: g.name,
            description,
            inputSchema: {
              ...op.inputSchema,
              properties: { ...controls, ...props },
              ...(required ? { required } : {}),
            } as ToolDefinition['inputSchema'],
            annotations: this.annotations(title, ops),
          },
          summary: { name: g.name, kind: 'operation', access: op.access, operations: [op.id] },
        });
        continue;
      }

      const lines = ops.map((op) => {
        const rules = this.rulesLine(op);
        return `- ${signature(op)}${tag(op, this.decision(op, perm))}: ${operationTitle(op)}${rules ? `\n  ${rules}` : ''}`;
      });
      const description = [
        g.description,
        'Operations (pass the name as "operation" and its arguments in "params"):',
        ...lines,
      ]
        .filter(Boolean)
        .join('\n');
      tools.push({
        kind: 'group',
        ops,
        def: {
          name: g.name,
          description,
          inputSchema: {
            type: 'object',
            properties: {
              operation: { type: 'string', enum: ops.map((o) => o.id) },
              params: { type: 'object', description: 'Arguments for the chosen operation.' },
              ...this.safetyProps(ops, perm),
            },
            required: ['operation'],
            additionalProperties: false,
          },
          annotations: this.annotations(title, ops),
        },
        summary: {
          name: g.name,
          kind: 'group',
          access: worstAccess(ops),
          operations: ops.map((o) => o.id),
        },
      });
    }

    if (this.config.longTail.enabled) {
      tools.push({
        kind: 'search',
        ops: [],
        def: {
          name: SEARCH,
          description:
            `Search all ${surface?.size ?? this.operations.length} operations of the ${this.name} API, including ones not listed as tools. ` +
            `Returns ids, parameters and whether each can be called. Use with ${CALL}.`,
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Words to match, for example "list invoices by customer".',
              },
              limit: { type: 'integer', minimum: 1, maximum: 25, default: 8 },
            },
            required: ['query'],
            additionalProperties: false,
          },
          annotations: { title: 'Search operations', readOnlyHint: true, openWorldHint: false },
        },
        summary: { name: SEARCH, kind: 'search', access: 'read', operations: [] },
      });
      const callable = this.operations.filter(
        (o) => this.exposed(o, perm) && (!surface || surface.has(o.id)),
      );
      const writes = this.writesEnabled(perm);
      tools.push({
        kind: 'call',
        ops: callable,
        def: {
          name: CALL,
          description: `Call any ${this.name} operation by id (find ids with ${SEARCH}). ${
            writes
              ? 'Write operations follow the same allowlist and confirmation rules.'
              : 'Read-only mode: only read operations run.'
          }`,
          inputSchema: {
            type: 'object',
            properties: {
              operationId: { type: 'string' },
              params: { type: 'object', description: 'Arguments, as listed by search_operations.' },
              ...this.safetyProps(callable, perm),
            },
            required: ['operationId'],
            additionalProperties: false,
          },
          annotations: this.annotations('Call operation', callable),
        },
        summary: {
          name: CALL,
          kind: 'call',
          access: worstAccess(callable),
          operations: callable.map((o) => o.id),
        },
      });
    }
    return tools;
  }

  instructions(): string {
    const parts = [
      `${this.name}: ${truncate(this.spec.doc.info?.title ?? this.name, 80)} via apitame.`,
      this.mode === 'read-only'
        ? 'Read-only mode: write operations are blocked; if the user needs one, explain how to allow it instead of looking for workarounds.'
        : 'Read-write mode: only allowlisted writes run; destructive ones need explicit user approval. Use dryRun to preview writes.',
      'Grouped tools take {"operation": "<id>", "params": {...}}.',
      this.config.longTail.enabled
        ? `Use ${SEARCH} to find operations that are not listed, then ${CALL}.`
        : '',
      'Results are JSON: {"status": <http status>, "data": <body>}.',
      'Add "fields": ["id", "items.name"] (dot paths) to keep only the fields you need from large responses.',
      this.pagingOffered(this.operations)
        ? `"pages" (up to ${this.config.limits.maxPages}) reads the following pages of a list in one call; "pagination.next" in the result holds the arguments that continue.`
        : '',
    ];
    return parts.filter(Boolean).join(' ');
  }

  listTools(who?: CallerContext): ToolDefinition[] {
    return this.toolsFor(this.permissionsOf(who)).list.map((t) => t.def);
  }

  summarizeTools(): ToolSummary[] {
    return this.tools.map((t) => t.summary);
  }

  /** What a naive generator would expose: one tool per operation, writes included. */
  naiveTools(): ToolDefinition[] {
    return this.operations.map((op) => ({
      name: op.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
      description: [op.summary, op.description].filter(Boolean).join('\n'),
      inputSchema: op.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<ToolResult> {
    // A tool the caller may not use is unknown to it, exactly like one that does not exist.
    const tool = this.toolsFor(this.permissionsOf(ctx)).byName.get(name);
    if (!tool) return errorResult(`Unknown tool "${name}".`);
    const limited = this.guardrails.checkCall(ctx?.caller) ?? this.guardrails.checkTool(name);
    if (limited) return errorResult(limited);
    try {
      return await this.dispatch(tool, args ?? {}, ctx);
    } catch (err) {
      return errorResult(this.redactor.text((err as Error).message));
    }
  }

  private async dispatch(
    tool: BuiltTool,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<ToolResult> {
    const { dryRun, confirm, fields, pages, ...rest } = args;
    const control: Record<string, unknown> = { dryRun, confirm, fields, pages };

    switch (tool.kind) {
      case 'search':
        return this.search(String(args.query ?? ''), Number(args.limit ?? 8), ctx);
      case 'operation': {
        const op = tool.ops[0]!;
        const own = (op.inputSchema.properties ?? {}) as Record<string, unknown>;
        const renamed = tool.renamed ?? {};
        const params: Record<string, unknown> = { ...rest };
        for (const k of CONTROL_ARGS) {
          // A control this tool does not offer, where the API has a parameter of that name, is the API's.
          if (k in own && !(`api_${k}` in renamed) && control[k] !== undefined) {
            params[k] = control[k];
            control[k] = undefined;
          }
        }
        for (const [exposed, original] of Object.entries(renamed)) {
          if (exposed in params) {
            params[original] = params[exposed];
            delete params[exposed];
          }
        }
        return this.execute(op, params, parseFlags(control), ctx, tool.def.name);
      }
      case 'group': {
        const id = String(rest.operation ?? '');
        const op = tool.ops.find((o) => o.id === id);
        if (!op) {
          return errorResult(
            `Unknown operation "${id}" for tool "${tool.def.name}". Valid operations: ${tool.ops.map((o) => o.id).join(', ')}.`,
          );
        }
        return this.execute(op, asObject(rest.params), parseFlags(control), ctx, tool.def.name);
      }
      case 'call': {
        const id = String(rest.operationId ?? '');
        const op =
          this.byId.get(id) ?? this.operations.find((o) => o.id.toLowerCase() === id.toLowerCase());
        // An operation of a group the caller cannot see is unknown to it.
        const surface = this.toolsFor(this.permissionsOf(ctx)).surface;
        if (!op || (surface && !surface.has(op.id)))
          return errorResult(`Unknown operationId "${id}". Use ${SEARCH} to find valid ids.`);
        return this.execute(op, asObject(rest.params), parseFlags(control), ctx, tool.def.name);
      }
    }
  }

  private search(query: string, limit: number, ctx?: CallContext): ToolResult {
    const perm = this.permissionsOf(ctx);
    const { list: visible, surface } = this.toolsFor(perm);
    const words = query
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const groupOf = new Map<string, string>();
    for (const t of visible)
      if (t.kind === 'group' || t.kind === 'operation')
        for (const o of t.ops) groupOf.set(o.id, t.def.name);

    const scored = this.operations
      .filter((op) => !surface || surface.has(op.id))
      .map((op) => {
        const id = op.id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        const hay =
          `${id} ${op.summary} ${op.tags.join(' ')} ${op.path} ${op.method}`.toLowerCase();
        const desc = op.description.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (id.includes(w)) score += 4;
          if (hay.includes(w)) score += 2;
          else if (desc.includes(w)) score += 1;
          // Rough stemming: "invoices" should match "invoice".
          else if (w.length > 4 && hay.includes(w.replace(/(es|s)$/, ''))) score += 1;
        }
        if (op.access === 'read') score += 0.1;
        return { op, score };
      })
      .filter((s) => words.length === 0 || s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(1, limit || 8), 25));

    const results = scored.map(({ op }, i) => {
      const d = this.decision(op, perm);
      const rules = this.rules.describe(op.id);
      // Only operations the caller can reach are searched, so an allowed one is available.
      const status = op.unsupported
        ? `unsupported: ${op.unsupported}`
        : d.allowed
          ? 'available'
          : `blocked: ${d.reason}`;
      return {
        operationId: op.id,
        method: op.method.toUpperCase(),
        path: op.path,
        summary: operationTitle(op),
        access: op.access,
        status,
        ...(groupOf.has(op.id) ? { tool: groupOf.get(op.id) } : {}),
        params: signature(op),
        ...(rules ? { rules } : {}),
        // Full schemas only for the best matches, to keep results small.
        ...(i < 3 ? { inputSchema: op.inputSchema } : {}),
      };
    });
    return jsonResult({ query, results, total: this.operations.length });
  }

  private async execute(
    op: Operation,
    params: Record<string, unknown>,
    flags: Flags,
    ctx: CallContext | undefined,
    tool: string,
  ): Promise<ToolResult> {
    const perm = this.permissionsOf(ctx);
    const audit = (outcome: AuditOutcome, extra: Partial<AuditEntry> = {}) =>
      this.guardrails.record({
        tool,
        operation: op.id,
        access: op.access,
        outcome,
        args: params,
        caller: ctx?.caller,
        ...(perm ? { permissions: perm.applied } : {}),
        ...extra,
      });
    if (op.unsupported) return errorResult(`"${op.id}" cannot be called: ${op.unsupported}.`);

    const decision = this.decision(op, perm);
    if (!decision.allowed) {
      audit('blocked', { reason: decision.reason });
      return errorResult(`Blocked: ${decision.reason}\n${decision.hint}`);
    }
    // A write is sent once, whatever the agent asks: paging only ever repeats reads.
    if (op.access !== 'read' && (flags.pages ?? 1) > 1) {
      return errorResult(
        `"pages" only applies to read operations, and ${op.id} is a ${op.access} operation. Nothing was sent.`,
      );
    }

    const problems = this.validator.check(op.id, op.inputSchema, params);
    if (problems.length > 0) {
      return errorResult(
        `Invalid arguments for ${op.id}:\n${problems.map((p) => `- ${p}`).join('\n')}\nExpected: ${signature(op)}\nSchema: ${JSON.stringify(op.inputSchema)}`,
      );
    }

    // After validation (rules see coerced values), before any preview, approval or rate limit.
    const refused = this.rules.enforce(op.id, params);
    if (refused) {
      audit('blocked', { reason: refused.reason });
      return errorResult(refused.message);
    }
    const rulesPassed = this.rules.describe(op.id);

    if (!this.baseUrl) {
      return errorResult(
        'No base URL: the spec has no absolute server URL. Set source.baseUrl in apitame.config.yaml.',
      );
    }
    if (this.authError) return errorResult(this.authError.message);

    let req;
    try {
      req = buildRequest(op, params, this.baseUrl, this.staticHeaders, {
        maxUploadBytes: this.config.limits.maxUploadBytes,
      });
    } catch (err) {
      if (err instanceof RequestBuildError) return errorResult(err.message);
      throw err;
    }

    const preview = {
      operation: op.id,
      access: op.access,
      request: {
        method: req.method,
        url: this.redactor.text(req.url.toString()),
        headers: this.previewHeaders(req.headers),
        ...(req.body !== undefined ? { body: this.redactor.value(req.bodyPreview) } : {}),
        ...(this.config.auth.type !== 'none' && !op.noAuth
          ? { auth: `${this.config.auth.type} (added when sent)` }
          : {}),
      },
    };

    if (flags.dryRun) {
      audit('dry-run');
      return jsonResult({
        dryRun: true,
        note: 'Nothing was sent.',
        ...preview,
        ...(rulesPassed ? { rulesPassed } : {}),
      });
    }

    // Checked before asking: a call that would be rate-limited must not use up a human approval.
    const limitedBefore = op.access !== 'read' ? this.guardrails.peekWrite(ctx?.caller) : undefined;
    if (limitedBefore) {
      audit('rate-limited');
      return errorResult(limitedBefore);
    }

    if (decision.needsConfirmation) {
      const outcome = await confirmOrChallenge({
        id: op.id,
        preview: `${op.access.toUpperCase()}: ${operationTitle(op)}\n${JSON.stringify(preview.request, null, 2)}${rulesPassed ? `\nRules passed: ${rulesPassed}.` : ''}`,
        args: params,
        confirmToken: flags.confirm,
        method: this.config.confirmation.method,
        store: this.confirmations,
        ctx,
      });
      if (!outcome.proceed) {
        audit(outcome.audit, outcome.reason ? { reason: outcome.reason } : {});
        return outcome.result;
      }
    }

    if (op.access !== 'read') {
      const limited = this.guardrails.checkWrite(ctx?.caller);
      if (limited) {
        audit('rate-limited');
        return errorResult(limited);
      }
    }

    if (op.access !== 'read')
      this.logger.info(`${op.access} ${op.id}: ${req.method} ${req.url.pathname}`);

    // With limits.maxPages at 1, paging is off: no pages argument and no pagination in results.
    const paging = this.config.limits.maxPages > 1 ? op.paging : undefined;
    const send = (r: BuiltRequest, timeoutMs: number) =>
      sendRequest(r, op.noAuth ? undefined : this.auth, {
        timeoutMs,
        maxResponseBytes: this.config.limits.maxResponseBytes,
        fields: flags.fields,
        redactor: this.redactor,
        basePath: new URL(this.baseUrl!).pathname,
        ...(paging ? { keepBody: true } : {}),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
    const started = Date.now();
    let res: HttpResult;
    try {
      res = await send(req, this.config.limits.timeoutMs);
    } catch (err) {
      audit('error', { durationMs: Date.now() - started, reason: (err as Error).message });
      throw err;
    }
    audit(res.ok ? 'sent' : 'error', { status: res.status, durationMs: Date.now() - started });

    const max = this.config.limits.maxPages;
    const asked = flags.pages ?? 1;
    const capped = asked > max ? `"pages" is capped at ${max} (limits.maxPages).` : undefined;
    if (paging && res.body !== undefined) {
      return this.readPages({
        op,
        paging,
        params,
        first: res,
        req,
        want: Math.min(asked, max),
        ...(capped ? { capped } : {}),
        fields: flags.fields,
        send,
        deadline: started + this.config.limits.timeoutMs,
        ctx,
        tool,
        audit,
      });
    }
    const why = op.paging
      ? paging
        ? 'The response is not a JSON list apitame can page through, so it read one page.'
        : 'Paging is turned off on this server (limits.maxPages is 1), so apitame read one page.'
      : 'apitame does not know how this operation pages, so it read one page.';
    const payload = this.redactor.value({
      status: res.status,
      data: res.data,
      ...(res.note ? { note: res.note } : {}),
      ...(asked > 1 && res.ok ? { pagination: { pages: 1, note: why } } : {}),
    });
    return res.ok ? jsonResult(payload) : { ...jsonResult(payload), isError: true };
  }

  /**
   * Read the following pages of a list operation, one after the other, then fit as many items
   * as possible into `limits.maxResponseBytes`. Every following request is built from the same
   * operation and arguments, with only the position replaced and validated again, so it stays
   * on the same endpoint and is always a read. Fetching stops at `want` pages, at the end of the
   * data, once the budget is used up, at the call's deadline, at a rate limit, at a repeated
   * position or at a page that fails. The budget covers `data` and `pagination` together, is
   * counted after field selection and redaction, and never cuts inside an item.
   */
  private async readPages(o: {
    op: Operation;
    paging: Paging;
    params: Record<string, unknown>;
    first: HttpResult;
    req: BuiltRequest;
    want: number;
    capped?: string;
    fields: string[] | undefined;
    send: (req: BuiltRequest, timeoutMs: number) => Promise<HttpResult>;
    deadline: number;
    ctx: CallContext | undefined;
    tool: string;
    audit: (outcome: AuditOutcome, extra?: Partial<AuditEntry>) => void;
  }): Promise<ToolResult> {
    const { op, paging: p, params, want } = o;
    const budget = this.config.limits.maxResponseBytes;
    const budgetText = `limits.maxResponseBytes (${budget} bytes)`;
    const base = new URL(this.baseUrl!);
    const shape = (body: unknown) =>
      this.redactor.value(o.fields ? projectFields(body, o.fields) : body);
    // has_more is set to its final value at the end, so it is measured as "false", the longer.
    const sized = (env: unknown) =>
      p.kind === 'cursor' && env && typeof env === 'object' && !Array.isArray(env) && p.more in env
        ? { ...(env as Record<string, unknown>), [p.more]: false }
        : env;
    const positionOf = (args: Record<string, unknown>) =>
      JSON.stringify(positionKeys(p).map((k) => args[k] ?? null));

    // Phase 1: read pages. The outcome below holds if every page read fits in the budget.
    const pages: PageData[] = [];
    let more = false;
    let next: Record<string, unknown> | undefined;
    let note: string | undefined;
    let used = 0;
    let count = 0;
    let res = o.first;
    let req = o.req;
    let args = params;
    let position: Record<string, unknown> | undefined;
    const seen = new Set([positionOf(params)]);

    for (let n = 1; ; n++) {
      const items = listAt(res.body, p.items);
      const shaped = shape(res.body);
      const shown = listAt(shaped, p.items);
      if (!items || !shown || shown.length !== items.length) {
        const where = p.items ? `"${p.items}"` : 'the body';
        if (n === 1) {
          // Not a list after all (or fields left it out): one page, trimmed as usual.
          const fitted = fitJson(shaped, budget);
          return jsonResult({
            status: res.status,
            data: fitted.value,
            ...(fitted.note ? { note: fitted.note } : {}),
            ...(want > 1
              ? {
                  pagination: {
                    pages: 1,
                    note: `There is no list at ${where} in this response${o.fields ? ' (keep it in "fields")' : ''}, so apitame read one page.`,
                  },
                }
              : {}),
          });
        }
        [more, next, note] = [
          true,
          position,
          `Page ${n} has no list at ${where}, so it is not included.`,
        ];
        break;
      }
      const cont = continuation(
        p,
        { args, body: res.body, items, link: res.link, url: req.url },
        base,
      );
      // Item sizes, measured only as far as they can fit: a page of a million tiny items
      // costs no more than the budget.
      const sums = [0];
      for (let i = 0; i < shown.length && sums[i]! + i <= budget; i++) {
        sums.push(sums[i]! + jsonBytes(shown[i]));
      }
      const page: PageData = {
        args,
        envelope: shaped,
        shown,
        items,
        fixed: jsonBytes(withList(sized(shaped), p.items, [])),
        sums,
        cont,
      };
      pages.push(page);
      if (cont.refused) this.refusedLink(op, o.audit, args, cont.refused);
      const whole = sums.length === shown.length + 1;
      used += whole ? sums[shown.length]! : budget + 1;
      count += shown.length;
      // Once the items read so far exceed the budget, more pages cannot be shown.
      if (page.fixed + used + Math.max(0, count - 1) > budget) break;

      [more, next, note] = [cont.more, cont.position, cont.problem];
      if (!cont.more || cont.problem || !cont.position) break;
      if (cont.backwards) {
        if (want > 1 && p.kind === 'cursor' && p.before) {
          note = `apitame only reads following pages forward (${p.param.name}), so with ${p.before.name} it read one page.`;
        }
        break;
      }
      if (n >= want) break;

      // The next page: the same operation and arguments, with only the position replaced.
      const nextArgs = applyPosition(p, params, cont.position);
      if (seen.has(positionOf(nextArgs))) {
        [next, note] = [
          undefined,
          'The API pointed to a page it already returned, so apitame stopped.',
        ];
        break;
      }
      seen.add(positionOf(nextArgs));
      const problems = this.validator.check(op.id, op.inputSchema, nextArgs);
      if (problems.length > 0) {
        next = undefined;
        note = `The API's position for the next page is not valid: ${problems.join('; ')}.`;
        o.audit('refused', { args, reason: `next page position: ${problems.join('; ')}` });
        break;
      }
      let nextReq: BuiltRequest;
      try {
        nextReq = buildRequest(op, nextArgs, this.baseUrl!, this.staticHeaders, {
          maxUploadBytes: this.config.limits.maxUploadBytes,
        });
      } catch (err) {
        [next, note] = [undefined, (err as Error).message];
        break;
      }
      const ms = this.config.limits.timeoutMs;
      const remaining = o.deadline - Date.now();
      if (remaining <= 0) {
        note = `Stopped before page ${n + 1}: limits.timeoutMs (${ms} ms) covers every page of a call. Continue with "next".`;
        break;
      }
      // Every page counts against the per-minute limits, like a call of its own.
      const limited = this.guardrails.checkCall(o.ctx?.caller) ?? this.guardrails.checkTool(o.tool);
      if (limited) {
        note = `Stopped before page ${n + 1}. ${limited}`;
        o.audit('rate-limited', { args: nextArgs, reason: limited });
        break;
      }
      const started = Date.now();
      try {
        res = await o.send(nextReq, remaining);
      } catch (err) {
        const message = (err as Error).message;
        o.audit('error', { args: nextArgs, durationMs: Date.now() - started, reason: message });
        note =
          Date.now() >= o.deadline
            ? `Page ${n + 1} did not arrive within limits.timeoutMs (${ms} ms), which covers every page of a call, so it is not included. Continue with "next".`
            : `Page ${n + 1} failed (${message.slice(0, 200)}), so it is not included. Continue with "next" to retry.`;
        break;
      }
      o.audit(res.ok ? 'sent' : 'error', {
        args: nextArgs,
        status: res.status,
        durationMs: Date.now() - started,
      });
      if (!res.ok || res.body === undefined) {
        note = `Page ${n + 1} answered with status ${res.status}${res.ok ? ' and no JSON' : ''}, so it is not included. Continue with "next" to retry.`;
        break;
      }
      req = nextReq;
      args = nextArgs;
      position = cont.position;
    }

    // Phase 2: the most items that fit with their pagination, never cutting inside an item.
    // Each candidate keeps all items of the pages before page k and the first c of page k.
    const cutAnywhere = (k: number) => k === 0 || (cutsInsidePages(p) && !pages[k]!.cont.backwards);
    const choices = pages.map((pg, k) =>
      pg.shown.length === 0 ? 1 : cutAnywhere(k) ? pg.shown.length : 1,
    );
    const total = choices.reduce((a, b) => a + b, 0);
    const before: Array<{ bytes: number; items: number }> = [];
    for (let k = 0, bytes = 0, items = 0; k < pages.length; k++) {
      before.push({ bytes, items });
      bytes += pages[k]!.sums.at(-1)!;
      items += pages[k]!.shown.length;
    }
    const at = (index: number): { k: number; c: number } => {
      let k = 0;
      while (index >= choices[k]!) index -= choices[k++]!;
      const len = pages[k]!.shown.length;
      return { k, c: len === 0 ? 0 : cutAnywhere(k) ? index + 1 : len };
    };
    const outcome = (k: number, c: number) => {
      const pg = pages[k]!;
      const len = pg.shown.length;
      const lead = o.capped ? [o.capped] : [];
      if (k === pages.length - 1 && c === len) {
        return { pages: k + 1, more, next, notes: [...lead, ...(note ? [note] : [])] };
      }
      if (c === len) {
        return {
          pages: k + 1,
          more: true,
          next: pg.cont.position,
          notes: [
            ...lead,
            `Page ${k + 2} did not fit in ${budgetText}, so it is not included. Continue with "next", or select fewer fields to fit more.`,
          ],
        };
      }
      if (cutsInsidePages(p) && !pg.cont.backwards) {
        // The cursor or offset can point right after the last item kept.
        const after = positionAfter(p, pg.args, pg.items, c);
        return {
          pages: k + 1,
          more: true,
          next: after,
          notes: [
            ...lead,
            `Page ${k + 1} was cut to ${c} of ${len} items to fit ${budgetText}${after ? '; "next" continues right after the last item returned' : ', and the last item returned has no id apitame can continue from'}.`,
          ],
        };
      }
      // Only the first page of other styles is cut: their positions point at whole pages.
      const skip = pg.cont.position;
      return {
        pages: 1,
        more: true,
        next: skip,
        notes: [
          ...lead,
          `Page 1 was cut to ${c} of ${len} items to fit ${budgetText}${skip ? `, and "next" skips the ${len - c} that were cut` : ''}. Ask for fewer items per page, or select fewer fields.`,
          ...(pg.cont.problem ? [pg.cont.problem] : []),
        ],
      };
    };
    const paginationOf = (out: ReturnType<typeof outcome>) =>
      this.paginationBlock(out.pages, out.more, out.next, out.notes);
    const dataBytes = (k: number, c: number) => {
      const items = before[k]!.items + c;
      return pages[k]!.fixed + before[k]!.bytes + pages[k]!.sums[c]! + Math.max(0, items - 1);
    };
    const fitsAt = (index: number) => {
      const { k, c } = at(index);
      if (c >= pages[k]!.sums.length) return false;
      return dataBytes(k, c) + jsonBytes(paginationOf(outcome(k, c))) <= budget;
    };
    let best = -1;
    if (fitsAt(total - 1)) best = total - 1;
    else {
      let hi = total - 2;
      while (best < hi) {
        const mid = Math.floor((best + hi + 1) / 2);
        if (fitsAt(mid)) best = mid;
        else hi = mid - 1;
      }
    }

    if (best < 0) {
      // Not even one item fits: trimmed as before, and no position to continue from.
      const pagination = this.paginationBlock(1, true, undefined, [
        ...(o.capped ? [o.capped] : []),
        pages[0]!.shown.length === 0
          ? `The response does not fit in ${budgetText}. Select fewer fields.`
          : `Not even one item fits in ${budgetText}. Select fewer fields.`,
      ]);
      const fitted = fitJson(pages[0]!.envelope, Math.max(0, budget - jsonBytes(pagination)));
      return jsonResult({
        status: o.first.status,
        data: fitted.value,
        ...(fitted.note ? { note: fitted.note } : {}),
        pagination,
      });
    }
    const { k, c } = at(best);
    const out = outcome(k, c);
    let merged: unknown[] = [];
    for (let j = 0; j < k; j++) merged = merged.concat(pages[j]!.shown);
    merged = merged.concat(pages[k]!.shown.slice(0, c));
    let data = withList(pages[k]!.envelope, p.items, merged);
    if (p.kind === 'cursor' && data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (p.more in d) data = { ...d, [p.more]: out.more };
    }
    // data was redacted page by page; the pagination block is redacted on its own.
    return jsonResult({ status: o.first.status, data, pagination: paginationOf(out) });
  }

  /**
   * The `pagination` block. `next` is redacted by value only: its keys are the operation's own
   * parameter names, and one called `token` must not hide the cursor the agent passes back.
   */
  private paginationBlock(
    pages: number,
    more: boolean,
    next: Record<string, unknown> | undefined,
    notes: string[],
  ): Record<string, unknown> {
    const shown =
      more && next
        ? Object.fromEntries(
            Object.entries(next).map(([k, v]) => [
              this.redactor.text(k),
              typeof v === 'string' ? this.redactor.text(v) : v,
            ]),
          )
        : undefined;
    return {
      pages,
      more,
      ...(shown ? { next: shown } : {}),
      ...(notes.length > 0 ? { note: this.redactor.text(notes.join(' ')) } : {}),
    };
  }

  /** A next link outside the API: refused, audited, and logged at most once a minute per operation. */
  private refusedLink(
    op: Operation,
    audit: (outcome: AuditOutcome, extra?: Partial<AuditEntry>) => void,
    args: Record<string, unknown>,
    target: string,
  ): void {
    const base = new URL(this.baseUrl!);
    const reason = `next link to ${target} is outside ${base.origin}${base.pathname.replace(/\/+$/, '')}`;
    audit('refused', { args, reason });
    const now = Date.now();
    if (now - (this.linkWarnings.get(op.id) ?? -Infinity) >= 60_000) {
      this.linkWarnings.set(op.id, now);
      this.logger.warn(`${op.id}: refused a ${reason}.`);
    }
  }

  /** Request headers as shown in previews: sensitive ones and every static header from the config are hidden. */
  private previewHeaders(headers: Record<string, string>): Record<string, string> {
    const fixed = new Set(Object.keys(this.staticHeaders).map((k) => k.toLowerCase()));
    return Object.fromEntries(
      Object.entries(this.redactor.headers(headers)).map(([k, v]) => [
        k,
        fixed.has(k.toLowerCase()) ? REDACTED : v,
      ]),
    );
  }

  async close(): Promise<void> {}
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ...(v as Record<string, unknown>) };
  if (typeof v === 'string') {
    // Some agents send params as a JSON string.
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return {};
}

export async function createOpenApiRuntime(opts: OpenApiRuntimeOptions): Promise<OpenApiRuntime> {
  if (opts.config.source.type !== 'openapi') throw new Error('Not an OpenAPI config');
  const spec = opts.spec ?? (await loadSpec(opts.config.source.spec, opts.configDir));
  const { config, spec: _s, ...rest } = opts;
  return new OpenApiRuntime(config, spec, rest);
}
