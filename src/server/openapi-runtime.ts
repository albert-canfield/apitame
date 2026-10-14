import { createAuth, type AuthProvider } from '../auth/index.js';
import { envValues, resolveEnv } from '../config/env.js';
import type { Config, ToolGroupConfig } from '../config/schema.js';
import { Logger } from '../log.js';
import { ConfirmationStore, confirmOrChallenge } from '../safety/confirm.js';
import { Guardrails, type AuditEntry, type AuditOutcome } from '../safety/guardrails.js';
import { decide, type Decision } from '../safety/policy.js';
import { REDACTED, Redactor } from '../safety/redact.js';
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
  JsonSchema,
  Runtime,
  ToolAnnotations,
  ToolDefinition,
  ToolResult,
  ToolSummary,
} from '../types.js';
import { buildRequest, RequestBuildError, sendRequest } from './http-client.js';
import { errorResult, jsonResult } from './results.js';
import { parseFields } from './fields.js';
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

  private readonly tools: BuiltTool[];
  private readonly toolByName: Map<string, BuiltTool>;
  private readonly validator = new ArgValidator();
  private readonly confirmations: ConfirmationStore;
  private readonly guardrails: Guardrails;
  private readonly redactor: Redactor;
  private readonly logger: Logger;
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

    this.tools = this.buildTools();
    this.toolByName = new Map(this.tools.map((t) => [t.def.name, t]));
  }

  private policy() {
    return { mode: this.config.mode, writes: this.config.writes };
  }

  private decision(op: Operation): Decision {
    return decide(op.id, op.access, this.policy());
  }

  private exposed(op: Operation): boolean {
    return !op.unsupported && this.decision(op).allowed;
  }

  private writesEnabled(): boolean {
    return this.operations.some((o) => o.access !== 'read' && this.exposed(o));
  }

  private safetyProps(ops: Operation[]): Record<string, JsonSchema> {
    const props: Record<string, JsonSchema> = {};
    // Explained once in the server instructions, so no per-tool description.
    if (ops.some((o) => o.response)) props.fields = { type: 'array', items: { type: 'string' } };
    if (ops.some((o) => o.access !== 'read')) {
      props.dryRun = {
        type: 'boolean',
        description: 'Return the exact request without sending it.',
      };
    }
    if (
      ops.some((o) => {
        const d = this.decision(o);
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

  private buildTools(): BuiltTool[] {
    const tools: BuiltTool[] = [];
    for (const g of this.resolveGroups()) {
      const ops = g.operations.map((id) => this.byId.get(id)!).filter((o) => this.exposed(o));
      if (ops.length === 0) continue;
      const title = g.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

      if (ops.length === 1) {
        const op = ops[0]!;
        const description = [
          g.description,
          `${operationTitle(op)} (${op.method.toUpperCase()} ${op.path})${tag(op, this.decision(op))}`,
        ]
          .filter(Boolean)
          .join('\n');
        tools.push({
          kind: 'operation',
          ops,
          def: {
            name: g.name,
            description,
            inputSchema: {
              ...op.inputSchema,
              // The API's own parameters win if they share a name with fields, dryRun or confirm.
              properties: {
                ...this.safetyProps(ops),
                ...(op.inputSchema.properties as Record<string, JsonSchema>),
              },
            } as ToolDefinition['inputSchema'],
            annotations: this.annotations(title, ops),
          },
          summary: { name: g.name, kind: 'operation', access: op.access, operations: [op.id] },
        });
        continue;
      }

      const lines = ops.map(
        (op) => `- ${signature(op)}${tag(op, this.decision(op))}: ${operationTitle(op)}`,
      );
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
              ...this.safetyProps(ops),
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
            `Search all ${this.operations.length} operations of the ${this.name} API, including ones not listed as tools. ` +
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
      const callable = this.operations.filter((o) => this.exposed(o));
      const writes = this.writesEnabled();
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
              ...this.safetyProps(callable),
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
    ];
    return parts.filter(Boolean).join(' ');
  }

  listTools(): ToolDefinition[] {
    return this.tools.map((t) => t.def);
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
    const tool = this.toolByName.get(name);
    if (!tool) return errorResult(`Unknown tool "${name}".`);
    const limited = this.guardrails.checkCall() ?? this.guardrails.checkTool(name);
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
    const { dryRun, confirm, fields, ...rest } = args;
    const flags = {
      dryRun: dryRun === true,
      confirm: typeof confirm === 'string' ? confirm : undefined,
      fields: parseFields(fields),
    };

    switch (tool.kind) {
      case 'search':
        return this.search(String(args.query ?? ''), Number(args.limit ?? 8));
      case 'operation': {
        const op = tool.ops[0]!;
        // Give back any control argument that is really one of the operation's parameters.
        const own = (op.inputSchema.properties ?? {}) as Record<string, unknown>;
        const params = { ...rest };
        const control = { dryRun, confirm, fields };
        const ownFlags = { ...flags };
        for (const [k, v] of Object.entries(control)) {
          if (k in own && v !== undefined) {
            params[k] = v;
            if (k === 'fields') ownFlags.fields = undefined;
            if (k === 'dryRun') ownFlags.dryRun = false;
            if (k === 'confirm') ownFlags.confirm = undefined;
          }
        }
        return this.execute(op, params, ownFlags, ctx, tool.def.name);
      }
      case 'group': {
        const id = String(rest.operation ?? '');
        const op = tool.ops.find((o) => o.id === id);
        if (!op) {
          return errorResult(
            `Unknown operation "${id}" for tool "${tool.def.name}". Valid operations: ${tool.ops.map((o) => o.id).join(', ')}.`,
          );
        }
        return this.execute(op, asObject(rest.params), flags, ctx, tool.def.name);
      }
      case 'call': {
        const id = String(rest.operationId ?? '');
        const op =
          this.byId.get(id) ?? this.operations.find((o) => o.id.toLowerCase() === id.toLowerCase());
        if (!op)
          return errorResult(`Unknown operationId "${id}". Use ${SEARCH} to find valid ids.`);
        return this.execute(op, asObject(rest.params), flags, ctx, tool.def.name);
      }
    }
  }

  private search(query: string, limit: number): ToolResult {
    const words = query
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const groupOf = new Map<string, string>();
    for (const t of this.tools)
      if (t.kind === 'group' || t.kind === 'operation')
        for (const o of t.ops) groupOf.set(o.id, t.def.name);

    const scored = this.operations
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
      const d = this.decision(op);
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
        // Full schemas only for the best matches, to keep results small.
        ...(i < 3 ? { inputSchema: op.inputSchema } : {}),
      };
    });
    return jsonResult({ query, results, total: this.operations.length });
  }

  private async execute(
    op: Operation,
    params: Record<string, unknown>,
    flags: { dryRun: boolean; confirm: string | undefined; fields: string[] | undefined },
    ctx: CallContext | undefined,
    tool: string,
  ): Promise<ToolResult> {
    const audit = (outcome: AuditOutcome, extra: Partial<AuditEntry> = {}) =>
      this.guardrails.record({
        tool,
        operation: op.id,
        access: op.access,
        outcome,
        args: params,
        ...extra,
      });
    if (op.unsupported) return errorResult(`"${op.id}" cannot be called: ${op.unsupported}.`);

    const decision = this.decision(op);
    if (!decision.allowed) {
      audit('blocked', { reason: decision.reason });
      return errorResult(`Blocked: ${decision.reason}\n${decision.hint}`);
    }

    const problems = this.validator.check(op.id, op.inputSchema, params);
    if (problems.length > 0) {
      return errorResult(
        `Invalid arguments for ${op.id}:\n${problems.map((p) => `- ${p}`).join('\n')}\nExpected: ${signature(op)}\nSchema: ${JSON.stringify(op.inputSchema)}`,
      );
    }

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
      return jsonResult({ dryRun: true, note: 'Nothing was sent.', ...preview });
    }

    if (decision.needsConfirmation) {
      const outcome = await confirmOrChallenge({
        id: op.id,
        preview: `${op.access.toUpperCase()}: ${operationTitle(op)}\n${JSON.stringify(preview.request, null, 2)}`,
        args: params,
        confirmToken: flags.confirm,
        method: this.config.confirmation.method,
        store: this.confirmations,
        ctx,
      });
      if (!outcome.proceed) {
        audit(outcome.result.isError ? 'declined' : 'confirmation-requested');
        return outcome.result;
      }
    }

    if (op.access !== 'read') {
      const limited = this.guardrails.checkWrite();
      if (limited) {
        audit('rate-limited');
        return errorResult(limited);
      }
    }

    if (op.access !== 'read')
      this.logger.info(`${op.access} ${op.id}: ${req.method} ${req.url.pathname}`);

    const started = Date.now();
    let res: Awaited<ReturnType<typeof sendRequest>>;
    try {
      res = await sendRequest(req, op.noAuth ? undefined : this.auth, {
        timeoutMs: this.config.limits.timeoutMs,
        maxResponseBytes: this.config.limits.maxResponseBytes,
        fields: flags.fields,
        redactor: this.redactor,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      audit('error', { durationMs: Date.now() - started, reason: (err as Error).message });
      throw err;
    }
    audit(res.ok ? 'sent' : 'error', { status: res.status, durationMs: Date.now() - started });
    const payload = this.redactor.value({
      status: res.status,
      data: res.data,
      ...(res.note ? { note: res.note } : {}),
    });
    return res.ok ? jsonResult(payload) : { ...jsonResult(payload), isError: true };
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
