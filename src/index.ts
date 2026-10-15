/**
 * Library entry point. The CLI is the main interface; these exports let
 * you embed apitame in your own tooling or tests.
 */
export { loadConfig, parseConfig, ConfigError, type LoadedConfig } from './config/load.js';
export { ConfigSchema, type Config, type ConfigInput } from './config/schema.js';
export { createRuntime, type AnyRuntime, type RuntimeOptions } from './server/runtime.js';
export { createMcpServer } from './server/mcp.js';
export { LiveRuntime } from './server/live.js';
export {
  serveStdio,
  serveHttp,
  type HttpOptions,
  type HttpOAuth,
  type ServerFactory,
  type StdioOptions,
} from './server/transport.js';
export { JwtVerifier, type OAuthOptions } from './server/oauth.js';
export {
  AutoVerifier,
  createOAuthVerifiers,
  IntrospectionMisconfigured,
  IntrospectionVerifier,
  type IntrospectionSettings,
} from './server/introspection.js';
export { OpenApiRuntime, createOpenApiRuntime } from './server/openapi-runtime.js';
export { SqlRuntime } from './server/sql-runtime.js';
export {
  guardSelect,
  analyzeWrite,
  type GuardResult,
  type GuardOptions,
} from './sources/sql/guard.js';
export { guardDuckdbSelect, type DuckdbSerializer } from './sources/sql/duckdb-guard.js';
export { loadSpec } from './sources/openapi/load.js';
export { extractOperations, type Operation } from './sources/openapi/operations.js';
export { groupOperations } from './sources/openapi/grouping.js';
export { generateOpenApiSkill, generateSqlSkill } from './generator/skills.js';
export { decide, type Decision } from './safety/policy.js';
export { Redactor } from './safety/redact.js';
export {
  SecretReferenceError,
  SecretResolver,
  type SecretResolverOptions,
  type SecretScope,
} from './secrets/index.js';
export { estimateTokens, toolListCost } from './tokens/estimate.js';
export { startMockServer } from './mock/server.js';
export { VERSION } from './version.js';
export type * from './types.js';
