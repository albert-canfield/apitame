import { resolve as resolvePath } from 'node:path';
import { resolveEnv } from '../config/env.js';
import type { Config, NamedQueryConfig } from '../config/schema.js';
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
import { decide, matchesAny } from '../safety/policy.js';
import { Redactor } from '../safety/redact.js';
import { WriteRules } from '../safety/rules.js';
import type { SqlDriver, TableInfo } from '../sources/sql/driver.js';
import { guardDuckdbSelect } from '../sources/sql/duckdb-guard.js';
import {
  analyzeWrite,
  bindNamedParams,
  guardSelect,
  type GuardOptions,
  type GuardResult,
} from '../sources/sql/guard.js';
import { tokenize } from '../sources/sql/lexer.js';
import type {
  Access,
  CallContext,
  CallerContext,
  JsonSchema,
  Runtime,
  ToolDefinition,
  ToolResult,
  ToolSummary,
} from '../types.js';
import { parseDryRun } from './flags.js';
import { fitJson } from './http-client.js';
import { errorResult, jsonResult } from './results.js';
import { ArgValidator } from './validate.js';

interface NamedTool {
  query: NamedQueryConfig;
  access: Access;
  sql: string;
  def: ToolDefinition;
  /** DuckDB: the result of DuckDB's parser check, made on the first call. */
  engineCheck?: Promise<GuardResult>;
}

const lower = (s: string) => s.toLowerCase();

const ENGINE = {
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  duckdb: 'DuckDB',
} as const;

/** The schema whose tables are listed without a prefix. */
const DEFAULT_SCHEMA: Partial<Record<keyof typeof ENGINE, string>> = {
  postgres: '',
  duckdb: 'main',
};

/** Tools every SQL source has, whatever the config. */
const BUILT_IN_TOOLS = ['list_tables', 'describe_table', 'query'];

/** Each SQL tool is its own named query (or a built-in read), so an entry reaches what it shows. */
const reach: Reach = (tools, id) => tools === undefined || matchesAny(id, tools);

/** The audit fields that say which permissions applied to an OAuth caller. */
const appliedTo = (perm: CallerPermissions | undefined) =>
  perm ? { permissions: perm.applied } : {};

export class SqlRuntime implements Runtime {
  readonly name: string;
  readonly mode: Config['mode'];
  readonly sourceType: 'postgres' | 'sqlite' | 'mysql' | 'duckdb';
  readonly warnings: string[] = [];
  /** `writes.rules` for named write queries, checked before a dry run, confirmation or the write. */
  readonly rules: WriteRules;
  private readonly named = new Map<string, NamedTool>();
  private readonly confirmations: ConfirmationStore;
  private readonly guardrails: Guardrails;
  private readonly validator = new ArgValidator();
  private readonly logger: Logger;

  constructor(
    readonly config: Config,
    readonly driver: SqlDriver,
    private readonly redactor: Redactor = new Redactor(),
    logger?: Logger,
    guardrails?: Guardrails,
  ) {
    if (config.source.type === 'openapi') throw new Error('SqlRuntime needs a SQL source');
    this.name = config.name;
    this.mode = config.mode;
    this.sourceType = config.source.type;
    this.logger = logger ?? new Logger(redactor);
    this.confirmations = new ConfirmationStore(config.confirmation.ttlSeconds * 1_000);
    this.guardrails =
      guardrails ?? Guardrails.fromConfig(config, process.cwd(), redactor, this.logger);
    // DuckDB sources cannot write (named write queries are refused), so no rule can apply.
    const readOnlySource = this.sourceType === 'duckdb';
    this.rules = new WriteRules(
      readOnlySource ? {} : config.writes.rules,
      config.sql.queries.map((q) => ({
        id: q.name,
        access: q.write ? 'write' : 'read',
        schema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(q.params).map(([name, p]) => [name, { type: p.type }]),
          ),
          additionalProperties: false,
        },
      })),
      redactor,
      'named query',
    );
    if (readOnlySource)
      for (const id of Object.keys(config.writes.rules))
        this.warnings.push(
          `writes.rules.${id}: DuckDB sources are read-only, so argument rules never apply.`,
        );
    this.warnings.push(...this.rules.warnings);
    for (const q of config.sql.queries) this.registerNamed(q);
    this.warnings.push(
      ...checkPermissions(config, {
        tools: [...BUILT_IN_TOOLS, ...config.sql.queries.map((q) => q.name)],
        operations: config.sql.queries.map((q) => ({ id: q.name, write: q.write })),
        noun: 'named query',
        reach,
      }),
    );
  }

  private get dialect() {
    return this.driver.dialect;
  }

  /**
   * The lexer and parser layers. PostgreSQL, MySQL and SQLite use the bundled parser;
   * DuckDB asks DuckDB's own parser, on a separate in-memory database (async).
   */
  private async checkSelect(
    sql: string,
    opts: Omit<GuardOptions, 'dialect'>,
  ): Promise<GuardResult> {
    if (this.dialect !== 'duckdb') return guardSelect(sql, { ...opts, dialect: this.dialect });
    const serialize = this.driver.serializeSelect?.bind(this.driver);
    if (!serialize) return { ok: false, reason: 'No DuckDB parser is available.' };
    return guardDuckdbSelect(sql, opts, serialize);
  }

  /** How a table is named in tool output: schema-qualified outside the default schema. */
  private displayName(t: { schema: string | null; name: string }): string {
    const home = DEFAULT_SCHEMA[this.sourceType];
    if (home === undefined || !t.schema) return t.name;
    return this.sourceType === 'postgres' || t.schema !== home ? `${t.schema}.${t.name}` : t.name;
  }

  private registerNamed(q: NamedQueryConfig): void {
    if (['list_tables', 'describe_table', 'query'].includes(q.name)) {
      this.warnings.push(`Named query "${q.name}" clashes with a built-in tool and was skipped.`);
      return;
    }
    let used: string[];
    try {
      used = tokenize(q.sql, this.dialect)
        .filter((t) => t.type === 'named')
        .map((t) => t.value);
    } catch (err) {
      this.warnings.push(`Named query "${q.name}" skipped: ${(err as Error).message}`);
      return;
    }
    const missing = [...new Set(used)].filter((p) => !(p in q.params));
    if (missing.length > 0) {
      this.warnings.push(
        `Named query "${q.name}" skipped: parameters ${missing.join(', ')} are used in the SQL but not declared.`,
      );
      return;
    }

    let access: Access = 'read';
    let sql: string;
    if (q.write && this.dialect === 'duckdb') {
      // Config validation refuses this too; the driver opens DuckDB files read-only.
      this.warnings.push(
        `Named query "${q.name}" skipped: named write queries are not supported for DuckDB.`,
      );
      return;
    }
    if (q.write) {
      const w = analyzeWrite(q.sql, this.dialect);
      if (!w.ok) {
        this.warnings.push(`Named query "${q.name}" skipped: ${w.reason}`);
        return;
      }
      access =
        w.destructive || matchesAny(q.name, this.config.writes.destructive)
          ? 'destructive'
          : 'write';
      sql = w.sql ?? q.sql;
    } else {
      // DuckDB's parser is asynchronous: the lexer runs now, the parser on the first call.
      let g = guardSelect(q.sql, {
        dialect: this.dialect,
        allowParams: true,
        denyTables: this.config.sql.tables.deny,
        ...(this.dialect === 'duckdb' ? { skipParser: true } : {}),
      });
      if (!g.ok && g.reason.startsWith('The query could not be parsed')) {
        g = guardSelect(q.sql, {
          dialect: this.dialect,
          allowParams: true,
          skipParser: true,
          denyTables: this.config.sql.tables.deny,
        });
        if (g.ok)
          this.warnings.push(
            `Named query "${q.name}": the SQL parser cannot read it; it still runs in a read-only transaction.`,
          );
      }
      if (!g.ok) {
        this.warnings.push(
          `Named query "${q.name}" skipped: ${g.reason} (set "write: true" for write queries).`,
        );
        return;
      }
      sql = g.sql;
    }

    const decision = decide(q.name, access, this.policy());
    if (!decision.allowed) return; // stays hidden; inspect reports it as blocked

    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [name, p] of Object.entries(q.params)) {
      properties[name] = { type: p.type, ...(p.description ? { description: p.description } : {}) };
      if (p.required) required.push(name);
    }
    if (access !== 'read') {
      properties.dryRun = {
        type: 'boolean',
        description:
          'Run inside a transaction that is rolled back, and report the affected row count.',
      };
      if (decision.needsConfirmation) {
        properties.confirm = {
          type: 'string',
          description: 'Confirmation token from a previous call, only after the user approved.',
        };
      }
    }
    const rules = this.rules.describe(q.name);
    const def: ToolDefinition = {
      name: q.name,
      description: `${q.description}${access === 'read' ? '' : ` [${access}${decision.needsConfirmation ? ', asks for confirmation' : ''}]`}${rules ? ` Rules: ${rules}.` : ''}`,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
      annotations: {
        title: q.name.replace(/_/g, ' '),
        readOnlyHint: access === 'read',
        destructiveHint: access === 'destructive',
        openWorldHint: false,
      },
    };
    this.named.set(q.name, { query: q, access, sql, def });
  }

  private permissionsOf(who: CallerContext | undefined): CallerPermissions | undefined {
    return callerPermissions(this.config, who, reach);
  }

  /** The server config, narrowed by an OAuth caller's permissions when there are any. */
  private policy(perm?: CallerPermissions) {
    return { mode: this.config.mode, writes: this.config.writes, caller: perm };
  }

  /** Whether a caller with these permissions sees the tool: allowed by `tools`, and its writes. */
  private visibleTo(name: string, perm: CallerPermissions): boolean {
    if (!toolAllowed(name, perm)) return false;
    const named = this.named.get(name);
    return !named || decide(name, named.access, this.policy(perm)).allowed;
  }

  /** Named queries that exist in config but are not exposed, with the reason. */
  blockedQueries(): Array<{ name: string; reason: string }> {
    const out: Array<{ name: string; reason: string }> = [];
    for (const q of this.config.sql.queries) {
      if (this.named.has(q.name) || !q.write) continue;
      const w = analyzeWrite(q.sql, this.dialect);
      const access: Access =
        (w.ok && w.destructive) || matchesAny(q.name, this.config.writes.destructive)
          ? 'destructive'
          : 'write';
      const d = decide(q.name, access, this.policy());
      if (!d.allowed) out.push({ name: q.name, reason: d.reason });
    }
    return out;
  }

  private tableVisible(t: { schema: string | null; name: string }): boolean {
    const { allow, deny } = this.config.sql.tables;
    const names = [lower(t.name), t.schema ? `${lower(t.schema)}.${lower(t.name)}` : ''];
    if (deny.some((d) => names.includes(lower(d)))) return false;
    if (allow.length > 0 && !allow.some((a) => names.includes(lower(a)))) return false;
    return true;
  }

  instructions(): string {
    const engine = ENGINE[this.sourceType];
    return [
      `${this.name}: ${engine} database via apitame.`,
      'Call list_tables and describe_table before writing SQL.',
      `"query" runs one read-only SELECT (max ${this.config.limits.rowLimit} rows, ${this.config.limits.timeoutMs} ms); writes are refused.`,
      this.named.size > 0
        ? 'Prefer the named query tools when they fit: they are reviewed and parameterized.'
        : '',
      'Results are JSON: {"columns": [...], "rows": [[...], ...]}.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  listTools(who?: CallerContext): ToolDefinition[] {
    const limit = this.config.limits.rowLimit;
    const engine = ENGINE[this.sourceType];
    const builtIn: ToolDefinition[] = [
      {
        name: 'list_tables',
        description: `List tables and views in the ${engine} database${this.sourceType === 'postgres' || this.sourceType === 'duckdb' ? ' with row estimates' : ''}.`,
        inputSchema: {
          type: 'object',
          properties:
            this.sourceType === 'postgres'
              ? { schema: { type: 'string', description: 'Only this schema.' } }
              : {},
          additionalProperties: false,
        },
        annotations: { title: 'List tables', readOnlyHint: true, openWorldHint: false },
      },
      {
        name: 'describe_table',
        description: 'Columns, types, primary key, foreign keys and indexes of one table.',
        inputSchema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              description:
                this.sourceType === 'postgres' || this.sourceType === 'duckdb'
                  ? 'Table name, optionally schema.table.'
                  : 'Table name.',
            },
          },
          required: ['table'],
          additionalProperties: false,
        },
        annotations: { title: 'Describe table', readOnlyHint: true, openWorldHint: false },
      },
      {
        name: 'query',
        description: `Run one read-only SELECT in ${engine} SQL. Returns at most ${limit} rows. Writes, multiple statements and side-effect functions are refused.`,
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'A single SELECT statement.' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: limit,
              description: `Max rows to return (default ${Math.min(50, limit)}).`,
            },
          },
          required: ['sql'],
          additionalProperties: false,
        },
        annotations: { title: 'Query', readOnlyHint: true, openWorldHint: false },
      },
    ];
    const all = [...builtIn, ...[...this.named.values()].map((n) => n.def)];
    const perm = this.permissionsOf(who);
    return perm ? all.filter((t) => this.visibleTo(t.name, perm)) : all;
  }

  summarizeTools(): ToolSummary[] {
    return [
      { name: 'list_tables', kind: 'sql', access: 'read', operations: [] },
      { name: 'describe_table', kind: 'sql', access: 'read', operations: [] },
      { name: 'query', kind: 'sql', access: 'read', operations: [] },
      ...[...this.named.values()].map((n) => ({
        name: n.query.name,
        kind: 'named-query' as const,
        access: n.access,
        operations: [n.query.name],
      })),
    ];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<ToolResult> {
    // An unknown name is refused before anything else looks at it, and a tool the caller may not
    // see answers exactly like one that does not exist.
    const perm = this.permissionsOf(ctx);
    if (
      !(BUILT_IN_TOOLS.includes(name) || this.named.has(name)) ||
      (perm && !this.visibleTo(name, perm))
    ) {
      return errorResult(`Unknown tool "${name}".`);
    }
    const limited = this.guardrails.checkCall(ctx?.caller) ?? this.guardrails.checkTool(name);
    if (limited) {
      ctx?.observe?.({ outcome: 'rate-limited' });
      return errorResult(limited);
    }
    try {
      switch (name) {
        case 'list_tables':
          return await this.listTables(typeof args.schema === 'string' ? args.schema : undefined);
        case 'describe_table':
          return await this.describe(String(args.table ?? ''));
        case 'query':
          return await this.query(String(args.sql ?? ''), args.limit, ctx);
        default: {
          const named = this.named.get(name);
          if (!named) return errorResult(`Unknown tool "${name}".`);
          return await this.runNamed(named, args ?? {}, ctx);
        }
      }
    } catch (err) {
      return errorResult(this.redactor.text((err as Error).message));
    }
  }

  async tables(): Promise<TableInfo[]> {
    return (await this.driver.listTables()).filter((t) => this.tableVisible(t));
  }

  private async listTables(schema?: string): Promise<ToolResult> {
    const tables = (await this.tables()).filter((t) => !schema || t.schema === schema);
    return this.fit({
      tables: tables.map((t) => ({
        name: this.displayName(t),
        type: t.type,
        ...(t.rowEstimate !== undefined && t.rowEstimate !== null ? { rows: t.rowEstimate } : {}),
        ...(t.comment ? { comment: t.comment } : {}),
      })),
    });
  }

  private async describe(table: string): Promise<ToolResult> {
    if (!table) return errorResult('Pass a table name.');
    const parts = table.replace(/"/g, '').split('.');
    const [schema, name] =
      parts.length > 1
        ? [parts[0] as string, parts.slice(1).join('.')]
        : [null, parts[0] as string];
    if (!this.tableVisible({ schema, name }))
      return errorResult(`Table "${table}" is not available.`);
    const detail = await this.driver.describeTable(schema, name);
    if (!detail || !this.tableVisible(detail))
      return errorResult(`Table "${table}" not found. Call list_tables to see what exists.`);
    return this.fit({
      table: this.displayName(detail),
      type: detail.type,
      ...(detail.comment ? { comment: detail.comment } : {}),
      columns: detail.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.nullable ? {} : { notNull: true }),
        ...(c.primaryKey ? { pk: true } : {}),
        ...(c.default ? { default: c.default } : {}),
        ...(c.comment ? { comment: c.comment } : {}),
      })),
      primaryKey: detail.primaryKey,
      foreignKeys: detail.foreignKeys,
      indexes: detail.indexes,
    });
  }

  private format(result: Awaited<ReturnType<SqlDriver['readQuery']>>, limit: number): ToolResult {
    const payload: Record<string, unknown> = {
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      ...(result.truncated
        ? {
            truncated: true,
            note: `Only the first ${Math.min(limit, result.rowCount)} rows are shown. Add filters, aggregation or ORDER BY ... LIMIT.`,
          }
        : {}),
      elapsedMs: result.elapsedMs,
    };
    return this.fit(payload);
  }

  /** Redact, then trim to maxResponseBytes (redacting after a cut could leave part of a secret). */
  private fit(payload: Record<string, unknown>): ToolResult {
    const fitted = fitJson(this.redactor.value(payload), this.config.limits.maxResponseBytes);
    const out = !fitted.note
      ? fitted.value
      : typeof fitted.value === 'string'
        ? { result: fitted.value, note: fitted.note }
        : { ...(fitted.value as object), note: fitted.note };
    return jsonResult(out);
  }

  private async query(sql: string, limitArg: unknown, ctx?: CallContext): Promise<ToolResult> {
    const perm = this.permissionsOf(ctx);
    const g = await this.checkSelect(sql, {
      allowTables: this.config.sql.tables.allow,
      denyTables: this.config.sql.tables.deny,
    });
    if (!g.ok) {
      this.guardrails.recordCall(ctx, {
        tool: 'query',
        access: 'read',
        outcome: 'refused',
        reason: g.reason,
        args: { sql },
        caller: ctx?.caller,
        ...appliedTo(perm),
      });
      return errorResult(`Refused: ${g.reason}`);
    }
    const max = this.config.limits.rowLimit;
    const limit = Math.min(
      max,
      Math.max(
        1,
        Number.isFinite(Number(limitArg)) && limitArg !== undefined
          ? Number(limitArg)
          : Math.min(50, max),
      ),
    );
    const started = Date.now();
    const res = await this.driver.readQuery(g.sql, [], {
      rowLimit: limit,
      timeoutMs: this.config.limits.timeoutMs,
      maxBytes: this.config.limits.maxResponseBytes,
    });
    this.guardrails.recordCall(ctx, {
      tool: 'query',
      access: 'read',
      outcome: 'sent',
      durationMs: Date.now() - started,
      args: { sql },
      caller: ctx?.caller,
      ...appliedTo(perm),
    });
    return this.format(res, limit);
  }

  private async runNamed(
    named: NamedTool,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<ToolResult> {
    let dryRun: boolean;
    try {
      dryRun = parseDryRun(args.dryRun);
    } catch (err) {
      return errorResult((err as Error).message);
    }
    // Validation coerces in place ("42" to 42), so parameters are read after it: binding the
    // raw values would compare 0 with a text column, which MySQL does numerically.
    const checked = { ...args };
    const problems = this.validator.check(
      `named:${named.query.name}`,
      { ...named.def.inputSchema },
      checked,
    );
    if (problems.length > 0) {
      return errorResult(
        `Invalid arguments for ${named.query.name}:\n${problems.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    const { dryRun: _dryRun, confirm, ...params } = checked;
    const bound = bindNamedParams(named.sql, this.dialect, params);
    const perm = this.permissionsOf(ctx);
    const audit = (outcome: AuditOutcome, extra: Partial<AuditEntry> = {}) =>
      this.guardrails.recordCall(ctx, {
        tool: named.query.name,
        access: named.access,
        outcome,
        args: params,
        caller: ctx?.caller,
        ...appliedTo(perm),
        ...extra,
      });

    if (named.access === 'read') {
      if (this.dialect === 'duckdb') {
        named.engineCheck ??= this.checkSelect(bound.sql, {
          allowParams: true,
          denyTables: this.config.sql.tables.deny,
        });
        const g = await named.engineCheck;
        if (!g.ok) {
          named.engineCheck = undefined; // only a pass is remembered
          audit('refused', { reason: g.reason });
          return errorResult(`Refused: named query "${named.query.name}": ${g.reason}`);
        }
      }
      const limit = this.config.limits.rowLimit;
      const res = await this.driver.readQuery(bound.sql, bound.params, {
        rowLimit: limit,
        timeoutMs: this.config.limits.timeoutMs,
        maxBytes: this.config.limits.maxResponseBytes,
      });
      audit('sent');
      return this.format(res, limit);
    }

    const decision = decide(named.query.name, named.access, this.policy(perm));
    if (!decision.allowed) {
      audit('blocked', { reason: decision.reason });
      return errorResult(`Blocked: ${decision.reason}\n${decision.hint}`);
    }

    const refused = this.rules.enforce(named.query.name, params);
    if (refused) {
      audit('blocked', { reason: refused.reason });
      return errorResult(refused.message);
    }
    const rulesPassed = this.rules.describe(named.query.name);

    const timeoutMs = this.config.limits.timeoutMs;
    if (dryRun) {
      const res = await this.driver.writeQuery(bound.sql, bound.params, {
        timeoutMs,
        dryRun: true,
      });
      audit('dry-run');
      return jsonResult({
        dryRun: true,
        note: 'Ran inside a transaction that was rolled back. Nothing changed.',
        query: named.query.name,
        params,
        wouldAffectRows: res.rowCount,
        ...(rulesPassed ? { rulesPassed } : {}),
      });
    }

    // Checked before asking: a call that would be rate-limited must not use up a human approval.
    const limitedBefore = this.guardrails.peekWrite(ctx?.caller);
    if (limitedBefore) {
      audit('rate-limited');
      return errorResult(limitedBefore);
    }

    if (decision.needsConfirmation) {
      let affected: number | string = 'unknown';
      try {
        affected = (
          await this.driver.writeQuery(bound.sql, bound.params, { timeoutMs, dryRun: true })
        ).rowCount;
      } catch {
        // The preview is best effort; the real run reports real errors.
      }
      const outcome = await confirmOrChallenge({
        id: named.query.name,
        preview: `${named.access.toUpperCase()}: ${named.query.description}\nSQL: ${named.sql}\nParameters: ${JSON.stringify(params)}\nRows that would be affected now: ${affected}${rulesPassed ? `\nRules passed: ${rulesPassed}.` : ''}`,
        args: params,
        confirmToken: typeof confirm === 'string' ? confirm : undefined,
        method: this.config.confirmation.method,
        store: this.confirmations,
        ctx,
      });
      if (!outcome.proceed) {
        audit(outcome.audit, outcome.reason ? { reason: outcome.reason } : {});
        return outcome.result;
      }
    }

    const limited = this.guardrails.checkWrite(ctx?.caller);
    if (limited) {
      audit('rate-limited');
      return errorResult(limited);
    }

    this.logger.info(`${named.access} ${named.query.name}`);
    const started = Date.now();
    let res: { rowCount: number };
    try {
      res = await this.driver.writeQuery(bound.sql, bound.params, { timeoutMs, dryRun: false });
    } catch (err) {
      audit('error', { durationMs: Date.now() - started, reason: (err as Error).message });
      throw err;
    }
    audit('sent', { durationMs: Date.now() - started });
    return jsonResult({ query: named.query.name, affectedRows: res.rowCount });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

/** Resolve the connection target for a SQL config and register any password as a secret. */
export function resolveSqlTarget(
  config: Config,
  configDir: string,
  redactor: Redactor,
  env: NodeJS.ProcessEnv = process.env,
):
  | { kind: 'postgres'; url: string; schemas: string[] }
  | { kind: 'mysql'; url: string }
  | { kind: 'sqlite'; file: string }
  | { kind: 'duckdb'; file: string } {
  const src = config.source;
  if (src.type === 'postgres') {
    const url = resolveEnv(src.url, 'source.url', env);
    try {
      const u = new URL(url);
      if (u.password) redactor.addSecret(decodeURIComponent(u.password));
    } catch {
      // Key/value connection strings: the URL-password pattern in the redactor still applies.
    }
    redactor.addSecret(url);
    return { kind: 'postgres', url, schemas: src.schemas };
  }
  if (src.type === 'mysql') {
    const url = resolveEnv(src.url, 'source.url', env);
    try {
      const u = new URL(url);
      if (u.password) redactor.addSecret(decodeURIComponent(u.password));
    } catch {
      // the URL-password pattern in the redactor still applies
    }
    redactor.addSecret(url);
    return { kind: 'mysql', url };
  }
  if (src.type === 'sqlite' || src.type === 'duckdb')
    return {
      kind: src.type,
      file: resolvePath(configDir, resolveEnv(src.path, 'source.path', env)),
    };
  throw new Error('Not a SQL source');
}
