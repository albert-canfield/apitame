import { z } from 'zod';
import { MAX_PATTERN_LENGTH } from '../safety/pattern.js';
import { parseRulePath, RULE_PATH_HELP, ruleProblems } from '../safety/rules.js';

/** Matches a `${VAR}` or `${VAR:-default}` reference anywhere in a string. */
export const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/;

const envRef = (field: string) =>
  z
    .string()
    .min(1)
    .refine((v) => ENV_REF.test(v), {
      message: `${field} must come from an environment variable, for example "\${MY_SECRET}". Inline secrets are refused.`,
    });

/**
 * Unknown keys are an error, so a typo (`scope:` for `scopes:`) or a block at the wrong level
 * cannot silently turn a setting off. `hints` suggests where a misplaced key belongs.
 */
const unknownKeys =
  (hints: Record<string, string> = {}, otherwise?: string) =>
  (issue: { code?: string; keys?: string[] }) => {
    if (issue.code !== 'unrecognized_keys' || !issue.keys) return undefined;
    return issue.keys
      .map((k) => {
        const hint = Object.hasOwn(hints, k) ? hints[k] : otherwise;
        return `Unknown key "${k}"${hint ? ` (${hint})` : ''}`;
      })
      .join('; ');
  };

/** Why `http.oauth.audiences` needs `scopes` or `clients` next to it. */
export const AUDIENCES_NEED_A_FILTER =
  'audiences accepts tokens that do not name this server, and such an audience is often shared by every app on the authorization server (for example api://default on Okta). Also set scopes or clients, so that only tokens meant for apitame are accepted.';

/**
 * What one entry of `http.oauth.permissions` lets a caller do. Every field narrows the server
 * config; a field that is not set does not narrow it.
 */
export const PermissionSchema = z
  .strictObject(
    {
      /** `read-only`: no writes for this caller, whatever the server allows. */
      mode: z.enum(['read-only', 'read-write']).optional(),
      /** Writes this caller may run, as ids or `*` patterns. Also needs `writes.allow`. */
      writes: z.array(z.string().min(1)).optional(),
      /** Tools this caller sees, as names or `*` patterns. */
      tools: z.array(z.string().min(1)).optional(),
    },
    { error: unknownKeys({ allow: 'did you mean writes?', operations: 'did you mean writes?' }) },
  )
  .refine((p) => !(p.mode === 'read-only' && p.writes && p.writes.length > 0), {
    message: 'writes has no effect with mode: read-only. Remove one of them.',
  });

/** Per-caller permissions for OAuth callers, by token scope and by client id. */
export const PermissionsSchema = z.strictObject(
  {
    byScope: z.record(z.string().min(1), PermissionSchema).default({}),
    byClient: z.record(z.string().min(1), PermissionSchema).default({}),
    /** For callers that no entry matches. Unset: read-only. */
    default: PermissionSchema.optional(),
  },
  {
    error: unknownKeys(
      { scopes: 'did you mean byScope?', clients: 'did you mean byClient?' },
      'put scopes under byScope and client ids under byClient',
    ),
  },
);

const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, 'Tool names use lowercase letters, digits and underscores');

export const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: envRef('auth.token') }),
  z.object({
    type: z.literal('apiKey'),
    in: z.enum(['header', 'query', 'cookie']).default('header'),
    name: z.string().min(1),
    value: envRef('auth.value'),
  }),
  z.object({
    type: z.literal('basic'),
    username: z.string().min(1),
    password: envRef('auth.password'),
  }),
  z.object({
    type: z.literal('oauth2'),
    flow: z.literal('client_credentials').default('client_credentials'),
    tokenUrl: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: envRef('auth.clientSecret'),
    scopes: z.array(z.string()).default([]),
    audience: z.string().optional(),
    clientAuthMethod: z
      .enum(['client_secret_basic', 'client_secret_post'])
      .default('client_secret_basic'),
  }),
]);

export const OpenApiSourceSchema = z.object({
  type: z.literal('openapi'),
  /** File path (relative to the config file) or http(s) URL. */
  spec: z.string().min(1),
  /** Overrides `servers[0].url` from the spec. */
  baseUrl: z.string().optional(),
  /** Extra static headers sent with every request. Values may use ${VAR}. */
  headers: z.record(z.string(), z.string()).default({}),
});

export const PostgresSourceSchema = z.object({
  type: z.literal('postgres'),
  url: z.string().min(1).default('${DATABASE_URL}'),
  schemas: z.array(z.string()).min(1).default(['public']),
});

export const MysqlSourceSchema = z.object({
  type: z.literal('mysql'),
  /** mysql:// (or mariadb://) connection string, normally from an environment variable. */
  url: z.string().min(1).default('${DATABASE_URL}'),
});

export const SqliteSourceSchema = z.object({
  type: z.literal('sqlite'),
  /** Database file path, relative to the config file. */
  path: z.string().min(1),
});

export const DuckdbSourceSchema = z.object({
  type: z.literal('duckdb'),
  /** Database file path, relative to the config file. Opened read-only. */
  path: z.string().min(1),
});

export const SourceSchema = z.discriminatedUnion('type', [
  OpenApiSourceSchema,
  PostgresSourceSchema,
  MysqlSourceSchema,
  SqliteSourceSchema,
  DuckdbSourceSchema,
]);

export const ToolGroupSchema = z.object({
  name: toolName,
  description: z.string().default(''),
  operations: z.array(z.string().min(1)).min(1),
});

export const NamedQuerySchema = z.object({
  name: toolName,
  description: z.string().min(1),
  sql: z.string().min(1),
  /** Named parameters used as `:name` in the SQL. Values are always bound, never interpolated. */
  params: z
    .record(
      z.string(),
      z.object({
        type: z.enum(['string', 'number', 'integer', 'boolean']).default('string'),
        description: z.string().optional(),
        required: z.boolean().default(true),
      }),
    )
    .refine((p) => !('dryRun' in p) && !('confirm' in p), {
      message: 'dryRun and confirm are reserved for apitame; rename the parameter',
    })
    .default({}),
  /** A write query (INSERT, UPDATE, DELETE). Needs read-write mode and an allowlist entry. */
  write: z.boolean().default(false),
});

const ruleValue = z.union([z.string(), z.number(), z.boolean(), z.null()], {
  error: 'values must be text, numbers, true, false or null',
});
const ruleNumber = (op: string) => z.number({ error: `${op} must be a number` }).optional();
const ruleLength = (op: string) =>
  z
    .number({ error: `${op} must be a whole number of characters or items` })
    .int()
    .min(0)
    .optional();
const ruleFlag = (op: string) =>
  z.literal(true, { error: `${op} can only be true (leave it out otherwise)` }).optional();

/** One argument rule (`writes.rules.<id>.<path>`). See src/safety/rules.ts. */
export const ArgumentRuleSchema = z
  .strictObject(
    {
      in: z.array(ruleValue, { error: 'in must be a list' }).min(1).optional(),
      notIn: z.array(ruleValue, { error: 'notIn must be a list' }).min(1).optional(),
      equals: ruleValue.optional(),
      pattern: z
        .string({ error: 'pattern must be text' })
        .min(1)
        .max(MAX_PATTERN_LENGTH, `patterns are limited to ${MAX_PATTERN_LENGTH} characters`)
        .optional(),
      min: ruleNumber('min'),
      max: ruleNumber('max'),
      minLength: ruleLength('minLength'),
      maxLength: ruleLength('maxLength'),
      required: ruleFlag('required'),
      forbidden: ruleFlag('forbidden'),
      optional: ruleFlag('optional'),
    },
    {
      error: unknownKeys({
        enum: 'did you mean in?',
        oneOf: 'did you mean in?',
        not_in: 'did you mean notIn?',
        notin: 'did you mean notIn?',
        const: 'did you mean equals?',
        equal: 'did you mean equals?',
        regex: 'did you mean pattern?',
        minimum: 'did you mean min?',
        maximum: 'did you mean max?',
        minlength: 'did you mean minLength?',
        maxlength: 'did you mean maxLength?',
        nullable: 'did you mean optional?',
      }),
    },
  )
  .superRefine((rule, ctx) => {
    for (const message of ruleProblems(rule)) ctx.addIssue({ code: 'custom', message });
  });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `writes.rules`: exact operation ids (or named queries), then argument paths, then a rule. */
const WriteRulesSchema = z
  .record(z.string(), z.record(z.string(), ArgumentRuleSchema))
  .superRefine(
    (rules, ctx) => {
      for (const [id, paths] of Object.entries(rules)) {
        if (id.includes('*'))
          ctx.addIssue({
            code: 'custom',
            path: [id],
            message:
              'rules take an exact operation id or named query, not a pattern, so a rule cannot miss an operation by accident',
          });
        if (!isRecord(paths)) continue;
        if (Object.keys(paths).length === 0)
          ctx.addIssue({ code: 'custom', path: [id], message: 'no rules listed' });
        for (const path of Object.keys(paths))
          if (!parseRulePath(path))
            ctx.addIssue({
              code: 'custom',
              path: [id, path],
              message: `not a valid rule path. ${RULE_PATH_HELP}`,
            });
      }
    },
    // Also when a rule has other errors, so every mistake is reported at once.
    { when: (payload) => isRecord(payload.value) },
  )
  .default({});

export const ConfigSchema = z
  .strictObject(
    {
      version: z.literal(1).default(1),
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes'),
      description: z.string().default(''),
      source: SourceSchema,
      mode: z.enum(['read-only', 'read-write']).default('read-only'),
      auth: AuthSchema.prefault({ type: 'none' }),
      limits: z
        .object({
          maxTools: z.number().int().min(1).max(128).default(12),
          maxOperationsPerTool: z.number().int().min(1).max(100).default(15),
          timeoutMs: z.number().int().min(100).max(600_000).default(15_000),
          maxResponseBytes: z.number().int().min(1_000).max(10_000_000).default(50_000),
          rowLimit: z.number().int().min(1).max(10_000).default(200),
          /** Total size of files an agent may upload in one call. */
          maxUploadBytes: z.number().int().min(1_000).max(100_000_000).default(10_000_000),
          /** Tool calls per minute across all tools. 0 means unlimited. */
          maxCallsPerMinute: z.number().int().min(0).max(100_000).default(120),
          /** Writes per minute (HTTP writes and named write queries). 0 means unlimited. */
          maxWritesPerMinute: z.number().int().min(0).max(100_000).default(20),
          /** Calls per minute for individual tools, on top of the server-wide limits. */
          perTool: z.record(z.string(), z.number().int().min(1).max(100_000)).default({}),
          /** Limits for each OAuth caller (client and subject), on top of the server-wide ones. */
          perCaller: z
            .strictObject(
              {
                /** Tool calls per minute for one caller. 0 means no per-caller limit. */
                maxCallsPerMinute: z.number().int().min(0).max(100_000).default(0),
                /** Writes per minute for one caller. 0 means no per-caller limit. */
                maxWritesPerMinute: z.number().int().min(0).max(100_000).default(0),
              },
              { error: unknownKeys() },
            )
            .prefault({}),
        })
        .prefault({}),
      audit: z
        .object({
          /** JSON Lines file, relative to the config file. Unset means no audit file. */
          file: z.string().min(1).optional(),
          /** `writes`: write attempts and refused queries. `all`: every call. */
          include: z.enum(['writes', 'all']).default('writes'),
        })
        .prefault({}),
      tools: z.array(ToolGroupSchema).default([]),
      longTail: z.object({ enabled: z.boolean().default(true) }).prefault({}),
      writes: z
        .strictObject(
          {
            /** Operation ids (or named queries) allowed to write. `*` wildcards are supported. */
            allow: z.array(z.string()).default([]),
            /** Writes that always need confirmation, on top of destructive ones. */
            confirm: z.array(z.string()).default([]),
            /** Non-GET operations that are known to be safe reads (for example POST /search). */
            treatAsRead: z.array(z.string()).default([]),
            /** Writes that should be treated as destructive even if they do not look like it. */
            destructive: z.array(z.string()).default([]),
            /** Limits on the arguments of allowed writes, checked before anything is sent. */
            rules: WriteRulesSchema,
          },
          {
            error: unknownKeys({
              rule: 'did you mean rules?',
              allowed: 'did you mean allow?',
              allowlist: 'did you mean allow?',
              confirmation: 'did you mean confirm?',
            }),
          },
        )
        .prefault({}),
      confirmation: z
        .object({
          method: z.enum(['auto', 'elicitation', 'token']).default('auto'),
          ttlSeconds: z.number().int().min(10).max(3_600).default(300),
        })
        .prefault({}),
      sql: z
        .object({
          queries: z.array(NamedQuerySchema).default([]),
          tables: z
            .object({
              /** If set, only these tables can be listed, described or queried. */
              allow: z.array(z.string()).default([]),
              /** Tables that are never exposed. */
              deny: z.array(z.string()).default([]),
            })
            .prefault({}),
          /** Resource limits for DuckDB sources (each call opens the file with these). */
          duckdb: z
            .strictObject({
              /** DuckDB memory_limit, for example 512MB or 2GB. Results never spill to disk. */
              memoryLimit: z
                .string()
                .regex(
                  /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i,
                  'Use a size such as 512MB or 2GB',
                )
                .default('1GB'),
              /** DuckDB worker threads per call. */
              threads: z.number().int().min(1).max(64).default(2),
            })
            .optional(),
        })
        .prefault({}),
      skills: z.object({ dir: z.string().default('./skills') }).prefault({}),
      /** `serve --transport http` settings. */
      http: z
        .strictObject(
          {
            /** Accept OAuth 2.1 access tokens from an external authorization server. */
            oauth: z
              .strictObject(
                {
                  issuer: z.string().url(),
                  resource: z.string().url(),
                  scopes: z.array(z.string().min(1)).default([]),
                  audiences: z.array(z.string().min(1)).default([]),
                  /** Accept only tokens issued to these clients (client_id, azp, cid or appid). */
                  clients: z.array(z.string().min(1)).default([]),
                  /** Require the RFC 9068 token type (`typ: at+jwt`) in the token header. */
                  requireAccessTokenType: z.boolean().default(false),
                  jwksUri: z.string().url().optional(),
                  /** What each caller may do, by token scope or client. Only narrows the config. */
                  permissions: PermissionsSchema.optional(),
                },
                {
                  error: unknownKeys({
                    scope: 'did you mean scopes?',
                    audience: 'did you mean audiences?',
                    client: 'did you mean clients?',
                    jwks_uri: 'did you mean jwksUri?',
                    permission: 'did you mean permissions?',
                  }),
                },
              )
              .optional(),
          },
          {
            error: unknownKeys({
              issuer: 'it belongs under http.oauth',
              resource: 'it belongs under http.oauth',
              scopes: 'it belongs under http.oauth',
            }),
          },
        )
        .prefault({}),
    },
    { error: unknownKeys({ oauth: 'it belongs under http.oauth' }) },
  )
  .superRefine((cfg, ctx) => {
    const oauth = cfg.http.oauth;
    if (
      oauth &&
      oauth.audiences.length > 0 &&
      oauth.scopes.length === 0 &&
      oauth.clients.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['http', 'oauth', 'audiences'],
        message: AUDIENCES_NEED_A_FILTER,
      });
    }
    const seen = new Set<string>();
    for (const t of cfg.tools) {
      if (seen.has(t.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools'],
          message: `Duplicate tool name "${t.name}"`,
        });
      }
      seen.add(t.name);
    }
    if (cfg.source.type !== 'openapi' && cfg.tools.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'Tool groups only apply to OpenAPI sources. Use sql.queries for SQL sources.',
      });
    }
    if (cfg.sql.duckdb && cfg.source.type !== 'duckdb') {
      ctx.addIssue({
        code: 'custom',
        path: ['sql', 'duckdb'],
        message: 'sql.duckdb only applies to DuckDB sources.',
      });
    }
    if (cfg.source.type === 'duckdb') {
      cfg.sql.queries.forEach((q, i) => {
        if (!q.write) return;
        ctx.addIssue({
          code: 'custom',
          path: ['sql', 'queries', i, 'write'],
          message: `Named write queries are not supported for DuckDB sources: apitame opens DuckDB files read-only. Remove "write: true" from "${q.name}" (read queries work).`,
        });
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;
export type ToolGroupConfig = z.infer<typeof ToolGroupSchema>;
export type NamedQueryConfig = z.infer<typeof NamedQuerySchema>;
export type PermissionConfig = z.infer<typeof PermissionSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsSchema>;
