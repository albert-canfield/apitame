import { z } from 'zod';

/** Matches a `${VAR}` or `${VAR:-default}` reference anywhere in a string. */
export const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/;

const envRef = (field: string) =>
  z
    .string()
    .min(1)
    .refine((v) => ENV_REF.test(v), {
      message: `${field} must come from an environment variable, for example "\${MY_SECRET}". Inline secrets are refused.`,
    });

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

export const SqliteSourceSchema = z.object({
  type: z.literal('sqlite'),
  /** Database file path, relative to the config file. */
  path: z.string().min(1),
});

export const SourceSchema = z.discriminatedUnion('type', [
  OpenApiSourceSchema,
  PostgresSourceSchema,
  SqliteSourceSchema,
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
    .default({}),
  /** A write query (INSERT, UPDATE, DELETE). Needs read-write mode and an allowlist entry. */
  write: z.boolean().default(false),
});

export const ConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes'),
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
      })
      .prefault({}),
    tools: z.array(ToolGroupSchema).default([]),
    longTail: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    writes: z
      .object({
        /** Operation ids (or named queries) allowed to write. `*` wildcards are supported. */
        allow: z.array(z.string()).default([]),
        /** Writes that always need confirmation, on top of destructive ones. */
        confirm: z.array(z.string()).default([]),
        /** Non-GET operations that are known to be safe reads (for example POST /search). */
        treatAsRead: z.array(z.string()).default([]),
        /** Writes that should be treated as destructive even if they do not look like it. */
        destructive: z.array(z.string()).default([]),
      })
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
      })
      .prefault({}),
    skills: z.object({ dir: z.string().default('./skills') }).prefault({}),
  })
  .superRefine((cfg, ctx) => {
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
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;
export type ToolGroupConfig = z.infer<typeof ToolGroupSchema>;
export type NamedQueryConfig = z.infer<typeof NamedQuerySchema>;
