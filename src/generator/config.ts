import { Document, isMap, isScalar, type Pair, type Scalar } from 'yaml';
import type { ConfigInput, ToolGroupConfig } from '../config/schema.js';
import type { OpenApiDocument } from '../sources/openapi/load.js';
import type { Operation } from '../sources/openapi/operations.js';
import { isObject } from '../sources/openapi/schema.js';

const DOCS = 'https://github.com/albert-canfield/apitame/blob/main/docs/configuration.md';

const AUDIT_COMMENT =
  'Add "file: ./apitame-audit.jsonl" to keep a JSON Lines record of every write attempt\n(blocked, dry run, confirmed, sent) and every refused query. include: all also records reads.';

/** Lowercase dash-separated name usable as config name, server name and skill name. */
export function slugify(input: string, fallback = 'api'): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || fallback;
}

/** Environment variable prefix derived from a name: "my-api" -> "MY_API". */
export function envPrefix(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'API'
  );
}

export interface AuthSuggestion {
  auth: ConfigInput['auth'];
  /** Env vars the user needs to set. */
  env: string[];
  note?: string;
}

/**
 * Pick an auth config from the spec's security schemes. Secrets always
 * become `${ENV_VAR}` references; nothing secret is written to disk.
 */
export function suggestAuth(doc: OpenApiDocument, name: string): AuthSuggestion {
  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const globalSecurity = Array.isArray(doc.security) ? doc.security : [];
  const preferred = globalSecurity.flatMap((req) => (isObject(req) ? Object.keys(req) : []));
  const ordered = [...new Set([...preferred, ...Object.keys(schemes)])];
  const prefix = envPrefix(name);

  for (const key of ordered) {
    const s = schemes[key];
    if (!isObject(s)) continue;
    if (s.type === 'http' && typeof s.scheme === 'string' && s.scheme.toLowerCase() === 'bearer') {
      return { auth: { type: 'bearer', token: `\${${prefix}_TOKEN}` }, env: [`${prefix}_TOKEN`] };
    }
    if (s.type === 'http' && typeof s.scheme === 'string' && s.scheme.toLowerCase() === 'basic') {
      return {
        auth: {
          type: 'basic',
          username: `\${${prefix}_USERNAME}`,
          password: `\${${prefix}_PASSWORD}`,
        },
        env: [`${prefix}_USERNAME`, `${prefix}_PASSWORD`],
      };
    }
    if (
      s.type === 'apiKey' &&
      typeof s.name === 'string' &&
      (s.in === 'header' || s.in === 'query' || s.in === 'cookie')
    ) {
      return {
        auth: { type: 'apiKey', in: s.in, name: s.name, value: `\${${prefix}_API_KEY}` },
        env: [`${prefix}_API_KEY`],
      };
    }
    if (s.type === 'oauth2' && isObject(s.flows) && isObject(s.flows.clientCredentials)) {
      const flow = s.flows.clientCredentials;
      return {
        auth: {
          type: 'oauth2',
          tokenUrl: String(flow.tokenUrl ?? ''),
          clientId: `\${${prefix}_CLIENT_ID}`,
          clientSecret: `\${${prefix}_CLIENT_SECRET}`,
          scopes: isObject(flow.scopes) ? Object.keys(flow.scopes) : [],
        },
        env: [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`],
      };
    }
  }
  if (ordered.length > 0) {
    return {
      auth: { type: 'none' },
      env: [],
      note: `The spec declares auth (${ordered.join(', ')}) that apitame cannot set up automatically. Configure "auth" by hand if requests fail with 401.`,
    };
  }
  return { auth: { type: 'none' }, env: [] };
}

function pairFor(doc: Document, key: string): Pair<Scalar, unknown> | undefined {
  if (!isMap(doc.contents)) return undefined;
  return doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key) as
    Pair<Scalar, unknown> | undefined;
}

function comment(doc: Document, key: string, text: string, spaceBefore = true): void {
  const pair = pairFor(doc, key);
  if (!pair || !isScalar(pair.key)) return;
  pair.key.commentBefore = text
    .split('\n')
    .map((l) => (l ? ` ${l}` : ''))
    .join('\n');
  pair.key.spaceBefore = spaceBefore;
}

export interface OpenApiConfigInput {
  name: string;
  description: string;
  spec: string;
  baseUrl?: string;
  groups: ToolGroupConfig[];
  ops: Operation[];
  auth: AuthSuggestion;
  maxTools: number;
  maxOperationsPerTool: number;
  generatedFrom: string;
}

/** Render apitame.config.yaml for an OpenAPI source, with explanatory comments. */
export function renderOpenApiConfig(input: OpenApiConfigInput): string {
  const writes = input.ops.filter((o) => o.access !== 'read');
  const readLike = writes.filter(
    (o) =>
      /^(search|query|find|list|lookup|count|preview|validate)/i.test(o.id) ||
      /\/(search|query|lookup)$/.test(o.path),
  );

  const obj: ConfigInput = {
    version: 1,
    name: input.name,
    description: input.description,
    source: {
      type: 'openapi',
      spec: input.spec,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    },
    mode: 'read-only',
    auth: input.auth.auth,
    limits: {
      maxTools: input.maxTools,
      maxOperationsPerTool: input.maxOperationsPerTool,
      timeoutMs: 15_000,
      maxResponseBytes: 50_000,
      maxCallsPerMinute: 120,
      maxWritesPerMinute: 20,
    },
    tools: input.groups,
    longTail: { enabled: true },
    writes: { allow: [], confirm: [], treatAsRead: [], destructive: [] },
    confirmation: { method: 'auto', ttlSeconds: 300 },
    audit: { include: 'writes' },
    skills: { dir: './skills' },
  };

  const doc = new Document(obj);
  doc.commentBefore = [
    ` apitame.config.yaml, generated by "apitame init" from ${input.generatedFrom}`,
    ' Edit it freely, then run "npx apitame inspect" to see the result.',
    ` Reference: ${DOCS}`,
  ].join('\n');

  comment(
    doc,
    'source',
    'Where operations come from. baseUrl overrides the first server in the spec.',
  );
  comment(
    doc,
    'mode',
    'read-only (default): every write operation is blocked, whatever the allowlist says.\nread-write: operations in writes.allow can run; destructive ones also need confirmation.',
  );
  comment(
    doc,
    'auth',
    input.auth.env.length > 0
      ? `Credentials come from environment variables (${input.auth.env.join(', ')}). Never put secrets in this file.${input.auth.note ? `\n${input.auth.note}` : ''}`
      : `Credentials always come from environment variables, for example: type: bearer, token: \${MY_API_TOKEN}${input.auth.note ? `\n${input.auth.note}` : ''}`,
  );
  comment(
    doc,
    'limits',
    'maxTools counts every tool, including search_operations and call_operation.',
  );
  comment(
    doc,
    'tools',
    'Task-level tools. Each one groups related operations. Rename, regroup or drop operations as you like.\nIn read-only mode, write operations listed here are simply not exposed.',
  );
  comment(
    doc,
    'longTail',
    'Operations that are not in a tool stay reachable through search_operations + call_operation.',
  );
  const writeLines = writes
    .slice(0, 30)
    .map((o) => `  ${o.id} (${o.access}): ${o.method.toUpperCase()} ${o.path}`);
  comment(
    doc,
    'writes',
    [
      'allow: operation ids that may write when mode is read-write. Wildcards work: "create*", "*".',
      'confirm: writes that must be confirmed by the user (destructive ones always are).',
      'treatAsRead: non-GET operations that only read, for example POST /search.',
      'destructive: writes to treat as destructive even if they do not look like it.',
      ...(writes.length > 0
        ? [`Write operations in this API (${writes.length}):`, ...writeLines]
        : []),
      ...(writes.length > 30
        ? [`  ... and ${writes.length - 30} more (see "apitame inspect --verbose")`]
        : []),
      ...(readLike.length > 0
        ? [
            `These look like reads; add them to treatAsRead if they are: ${readLike.map((o) => o.id).join(', ')}`,
          ]
        : []),
    ].join('\n'),
  );
  comment(
    doc,
    'confirmation',
    'auto: ask the human through the MCP client (elicitation) when it supports it, else return a one-time token.',
  );
  comment(doc, 'audit', AUDIT_COMMENT);
  comment(doc, 'skills', 'Generated agent skills. Regenerate with "apitame init --skills-only".');

  return doc.toString({ lineWidth: 0 });
}

export interface SqlConfigInput {
  name: string;
  description: string;
  type: 'postgres' | 'sqlite' | 'mysql';
  /** For postgres: a ${VAR} reference. For sqlite: a path relative to the config. */
  target: string;
  schemas?: string[];
  generatedFrom: string;
}

export function renderSqlConfig(input: SqlConfigInput): string {
  const obj: ConfigInput = {
    version: 1,
    name: input.name,
    description: input.description,
    source:
      input.type === 'postgres'
        ? { type: 'postgres', url: input.target, schemas: input.schemas ?? ['public'] }
        : input.type === 'mysql'
          ? { type: 'mysql', url: input.target }
          : { type: 'sqlite', path: input.target },
    mode: 'read-only',
    limits: {
      timeoutMs: 10_000,
      rowLimit: 200,
      maxResponseBytes: 50_000,
      maxCallsPerMinute: 120,
      maxWritesPerMinute: 20,
    },
    sql: { queries: [], tables: { allow: [], deny: [] } },
    writes: { allow: [], confirm: [] },
    confirmation: { method: 'auto', ttlSeconds: 300 },
    audit: { include: 'writes' },
    skills: { dir: './skills' },
  };
  const doc = new Document(obj);
  doc.commentBefore = [
    ` apitame.config.yaml, generated by "apitame init" from ${input.generatedFrom}`,
    ' Run "npx apitame inspect" to see the tools, and "npx apitame test" to check every table.',
    ` Reference: ${DOCS}`,
  ].join('\n');
  comment(
    doc,
    'source',
    input.type !== 'sqlite'
      ? 'The connection string comes from an environment variable (or .env next to this file).\nUse a read-only database role: see docs/sql.md for a two-line setup.'
      : 'Path to the database file, relative to this config. It is opened read-only.',
  );
  comment(
    doc,
    'mode',
    'read-only: the query tool only runs single SELECT statements, inside a read-only transaction.\nread-write only affects named queries marked "write: true" and listed in writes.allow.',
  );
  comment(
    doc,
    'limits',
    'rowLimit caps every result; timeoutMs cancels slow queries.\nmaxCallsPerMinute and maxWritesPerMinute stop runaway agent loops (0 means unlimited).',
  );
  comment(
    doc,
    'sql',
    [
      'queries: named, parameterized queries exposed as their own tools. Example:',
      '  - name: orders_by_customer',
      '    description: Recent orders for one customer',
      '    sql: SELECT id, total, created_at FROM orders WHERE customer_id = :customer_id ORDER BY created_at DESC LIMIT 20',
      '    params:',
      '      customer_id: { type: integer }',
      'tables.allow / tables.deny: limit which tables can be listed, described and queried.',
    ].join('\n'),
  );
  comment(
    doc,
    'writes',
    'Named write queries allowed when mode is read-write. DELETE, UPDATE without WHERE and DDL always need confirmation.',
  );
  comment(doc, 'audit', AUDIT_COMMENT);
  return doc.toString({ lineWidth: 0 });
}
