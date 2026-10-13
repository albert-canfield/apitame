import { resolve as resolvePath } from 'node:path';
import { resolveEnv } from '../config/env.js';
import type { Config, NamedQueryConfig } from '../config/schema.js';
import { Logger } from '../log.js';
import { ConfirmationStore, confirmOrChallenge } from '../safety/confirm.js';
import { decide } from '../safety/policy.js';
import { Redactor } from '../safety/redact.js';
import type { SqlDriver, TableInfo } from '../sources/sql/driver.js';
import { analyzeWrite, bindNamedParams, guardSelect } from '../sources/sql/guard.js';
import { tokenize } from '../sources/sql/lexer.js';
import type {
  Access,
  CallContext,
  JsonSchema,
  Runtime,
  ToolDefinition,
  ToolResult,
  ToolSummary,
} from '../types.js';
import { fitJson } from './http-client.js';
import { errorResult, jsonResult } from './results.js';
import { ArgValidator } from './validate.js';

interface NamedTool {
  query: NamedQueryConfig;
  access: Access;
  sql: string;
  def: ToolDefinition;
}

const lower = (s: string) => s.toLowerCase();

export class SqlRuntime implements Runtime {
  readonly name: string;
  readonly mode: Config['mode'];
  readonly sourceType: 'postgres' | 'sqlite';
  readonly warnings: string[] = [];
  private readonly named = new Map<string, NamedTool>();
  private readonly confirmations: ConfirmationStore;
  private readonly validator = new ArgValidator();
  private readonly logger: Logger;

  constructor(
    readonly config: Config,
    readonly driver: SqlDriver,
    private readonly redactor: Redactor = new Redactor(),
    logger?: Logger,
  ) {
    if (config.source.type === 'openapi') throw new Error('SqlRuntime needs a SQL source');
    this.name = config.name;
    this.mode = config.mode;
    this.sourceType = config.source.type;
    this.logger = logger ?? new Logger(redactor);
    this.confirmations = new ConfirmationStore(config.confirmation.ttlSeconds * 1_000);
    for (const q of config.sql.queries) this.registerNamed(q);
  }

  private get dialect() {
    return this.driver.dialect;
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
    if (q.write) {
      const w = analyzeWrite(q.sql, this.dialect);
      if (!w.ok) {
        this.warnings.push(`Named query "${q.name}" skipped: ${w.reason}`);
        return;
      }
      access =
        w.destructive || this.config.writes.destructive.includes(q.name) ? 'destructive' : 'write';
      sql = w.sql ?? q.sql;
    } else {
      let g = guardSelect(q.sql, {
        dialect: this.dialect,
        allowParams: true,
        denyTables: this.config.sql.tables.deny,
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
    const def: ToolDefinition = {
      name: q.name,
      description: `${q.description}${access === 'read' ? '' : ` [${access}${decision.needsConfirmation ? ', asks for confirmation' : ''}]`}`,
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

  private policy() {
    return { mode: this.config.mode, writes: this.config.writes };
  }

  /** Named queries that exist in config but are not exposed, with the reason. */
  blockedQueries(): Array<{ name: string; reason: string }> {
    const out: Array<{ name: string; reason: string }> = [];
    for (const q of this.config.sql.queries) {
      if (this.named.has(q.name) || !q.write) continue;
      const w = analyzeWrite(q.sql, this.dialect);
      const access: Access = w.ok && w.destructive ? 'destructive' : 'write';
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
    const engine = this.sourceType === 'postgres' ? 'PostgreSQL' : 'SQLite';
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

  listTools(): ToolDefinition[] {
    const limit = this.config.limits.rowLimit;
    const engine = this.sourceType === 'postgres' ? 'PostgreSQL' : 'SQLite';
    const builtIn: ToolDefinition[] = [
      {
        name: 'list_tables',
        description: `List tables and views in the ${engine} database${this.sourceType === 'postgres' ? ' with row estimates' : ''}.`,
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
                this.sourceType === 'postgres'
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
    return [...builtIn, ...[...this.named.values()].map((n) => n.def)];
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
    try {
      switch (name) {
        case 'list_tables':
          return await this.listTables(typeof args.schema === 'string' ? args.schema : undefined);
        case 'describe_table':
          return await this.describe(String(args.table ?? ''));
        case 'query':
          return await this.query(String(args.sql ?? ''), args.limit);
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
    return jsonResult({
      tables: tables.map((t) => ({
        name: t.schema && this.sourceType === 'postgres' ? `${t.schema}.${t.name}` : t.name,
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
    return jsonResult({
      table:
        detail.schema && this.sourceType === 'postgres'
          ? `${detail.schema}.${detail.name}`
          : detail.name,
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
            note: `Only the first ${limit} rows are shown. Add filters, aggregation or ORDER BY ... LIMIT.`,
          }
        : {}),
      elapsedMs: result.elapsedMs,
    };
    const fitted = fitJson(payload, this.config.limits.maxResponseBytes);
    const out = fitted.note ? { ...(fitted.value as object), note: fitted.note } : fitted.value;
    return jsonResult(this.redactor.value(out));
  }

  private async query(sql: string, limitArg: unknown): Promise<ToolResult> {
    const g = guardSelect(sql, {
      dialect: this.dialect,
      allowTables: this.config.sql.tables.allow,
      denyTables: this.config.sql.tables.deny,
    });
    if (!g.ok) return errorResult(`Refused: ${g.reason}`);
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
    const res = await this.driver.readQuery(g.sql, [], {
      rowLimit: limit,
      timeoutMs: this.config.limits.timeoutMs,
    });
    return this.format(res, limit);
  }

  private async runNamed(
    named: NamedTool,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<ToolResult> {
    const { dryRun, confirm, ...params } = args;
    const problems = this.validator.check(
      `named:${named.query.name}`,
      { ...named.def.inputSchema },
      args,
    );
    if (problems.length > 0) {
      return errorResult(
        `Invalid arguments for ${named.query.name}:\n${problems.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    const bound = bindNamedParams(named.sql, this.dialect, params);

    if (named.access === 'read') {
      const limit = this.config.limits.rowLimit;
      const res = await this.driver.readQuery(bound.sql, bound.params, {
        rowLimit: limit,
        timeoutMs: this.config.limits.timeoutMs,
      });
      return this.format(res, limit);
    }

    const decision = decide(named.query.name, named.access, this.policy());
    if (!decision.allowed) return errorResult(`Blocked: ${decision.reason}\n${decision.hint}`);

    const timeoutMs = this.config.limits.timeoutMs;
    if (dryRun === true) {
      const res = await this.driver.writeQuery(bound.sql, bound.params, {
        timeoutMs,
        dryRun: true,
      });
      return jsonResult({
        dryRun: true,
        note: 'Ran inside a transaction that was rolled back. Nothing changed.',
        query: named.query.name,
        params,
        wouldAffectRows: res.rowCount,
      });
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
        preview: `${named.access.toUpperCase()}: ${named.query.description}\nSQL: ${named.sql}\nParameters: ${JSON.stringify(params)}\nRows that would be affected now: ${affected}`,
        args: params,
        confirmToken: typeof confirm === 'string' ? confirm : undefined,
        method: this.config.confirmation.method,
        store: this.confirmations,
        ctx,
      });
      if (!outcome.proceed) return outcome.result;
    }

    this.logger.info(`${named.access} ${named.query.name}`);
    const res = await this.driver.writeQuery(bound.sql, bound.params, { timeoutMs, dryRun: false });
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
): { kind: 'postgres'; url: string; schemas: string[] } | { kind: 'sqlite'; file: string } {
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
  if (src.type === 'sqlite')
    return {
      kind: 'sqlite',
      file: resolvePath(configDir, resolveEnv(src.path, 'source.path', env)),
    };
  throw new Error('Not a SQL source');
}
