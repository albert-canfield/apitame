import { InMemoryServerEventBus, type Server } from '@modelcontextprotocol/server';
import { DEFAULT_CONFIG_FILE } from '../../config/load.js';
import { Logger, type LogLevel } from '../../log.js';
import { asksForConfirmation, type ConfirmationMethod } from '../../safety/confirm.js';
import { Redactor } from '../../safety/redact.js';
import { LiveRuntime } from '../../server/live.js';
import { createMcpServer } from '../../server/mcp.js';
import { createOAuthVerifiers, IntrospectionMisconfigured } from '../../server/introspection.js';
import { oauthChange, oauthReloadRefusal, oauthWarnings } from '../../server/oauth.js';
import { serveHttp, serveStdio } from '../../server/transport.js';
import type { ToolDefinition } from '../../types.js';

export interface ServeOptions {
  config?: string;
  transport?: string;
  port?: string;
  host?: string;
  logLevel?: string;
  watch?: boolean;
  sessions?: boolean;
}

/**
 * Keep `server` in `servers` while it is open, so a reload can tell its client that the lists
 * changed. It leaves when it closes: an ended session, or a stdio probe the SDK threw away
 * because the client fell back to `initialize`.
 */
export function trackOpen(servers: Set<Server>, server: Server): Server {
  servers.add(server);
  server.onclose = () => servers.delete(server);
  return server;
}

/**
 * Over HTTP with OAuth, the transport checks tokens with the `http.oauth` it started with, while
 * a `--watch` reload rebuilds the runtime (and its per-user permissions) from the file. A reload
 * that removes or changes `http.oauth` is therefore refused: OAuth callers would otherwise be
 * served without the permissions meant for them. `permissions` alone may change.
 */
export function guardOAuthReloads(live: LiveRuntime, started: unknown): void {
  if (started === undefined) return;
  live.refuseReloadIf((next) => oauthReloadRefusal(started, next.config.http.oauth));
}

/**
 * Over HTTP without a token or OAuth, any local process that can reach the port (an agent's
 * shell, for one) can call the tools and answer approval prompts itself. Returns the startup
 * warning when some operation asks for a human decision.
 */
export function unauthenticatedHttpWarning(
  tools: ToolDefinition[],
  method: ConfirmationMethod,
  url: string,
): string | undefined {
  if (!asksForConfirmation(tools)) return undefined;
  return [
    `HTTP without authentication: any local process that can reach ${url} can call the tools and approve destructive operations itself, so an approval does not prove that a human agreed.`,
    'Set APITAME_HTTP_TOKEN or http.oauth and give the credentials only to the MCP client, or serve over stdio.',
    method === 'elicitation'
      ? 'Under confirmation.method: elicitation, approvals are refused until then.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function serveCommand(opts: ServeOptions): Promise<void> {
  const redactor = new Redactor();
  const logger = new Logger(
    redactor,
    (opts.logLevel as LogLevel | undefined) ??
      (process.env.APITAME_LOG_LEVEL as LogLevel | undefined) ??
      'info',
  );
  const live = await LiveRuntime.start(
    opts.config ?? process.env.APITAME_CONFIG ?? DEFAULT_CONFIG_FILE,
    { redactor, logger },
  );
  for (const w of live.runtime.warnings) logger.warn(w);

  const watching = opts.watch === true;
  const buildServer = () =>
    createMcpServer(() => live.runtime, { skills: () => live.skills, listChanged: watching });
  // Open servers, so a reload can tell every connected client that the tool list changed.
  const servers = new Set<Server>();
  const makeServer = () => trackOpen(servers, buildServer());
  // Over HTTP, protocol 2026-07-28 clients get list changes on their subscriptions/listen
  // streams, which the SDK handler serves from this bus. Over stdio the connection's own server
  // delivers them on those streams.
  const events = new InMemoryServerEventBus((err) => logger.debug(`--watch: ${err.message}`));

  if (watching) {
    live.onReload(({ toolsChanged, skillsChanged }) => {
      for (const s of servers) {
        if (toolsChanged) void s.sendToolListChanged().catch(() => {});
        if (skillsChanged) void s.sendResourceListChanged().catch(() => {});
      }
      if (toolsChanged) events.publish({ kind: 'tools_list_changed' });
      if (skillsChanged) events.publish({ kind: 'resources_list_changed' });
    });
    live.watch();
  }

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    await live.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  const rt = live.runtime;
  const skills = live.skills.length;
  const summary = `${rt.name}: ${rt.listTools().length} tools, ${rt.mode}${skills > 0 ? `, ${skills} skill${skills === 1 ? '' : 's'}` : ''}${watching ? ', watching for changes' : ''}`;
  const transport = opts.transport ?? 'stdio';

  if (transport === 'stdio') {
    // Both protocol eras: the client's first message decides, and one server serves the connection.
    await serveStdio(makeServer, { logger });
    process.stdin.on('end', () => void shutdown(0));
    logger.info(`serving ${summary} over stdio`);
    if (process.stdin.isTTY) {
      logger.info(
        'waiting for an MCP client on stdin. Connect one with "npx apitame add-to claude-code" (or codex, cursor, vscode, gemini, claude-desktop). Ctrl+C to stop.',
      );
    }
    return;
  }
  if (transport !== 'http') throw new Error(`Unknown transport "${transport}". Use stdio or http.`);

  const host = opts.host ?? '127.0.0.1';
  const port = Number(opts.port ?? 3333);
  const token = process.env.APITAME_HTTP_TOKEN;
  if (token) redactor.addSecret(token);
  const sessions = opts.sessions === true;
  // Read once: the verifier and the metadata document are built at startup, so changes to
  // http.oauth need a restart (a --watch reload says so).
  const oauthConfig = live.loaded.config.http.oauth;
  // Introspection credentials are resolved (and registered with the redactor) here, once.
  const oauth =
    oauthConfig &&
    createOAuthVerifiers(oauthConfig, { redactor, warn: (message) => logger.warn(message) });
  guardOAuthReloads(live, oauthConfig);
  if (oauthConfig) for (const w of oauthWarnings(oauthConfig)) logger.warn(w);
  const unauthenticatedHttp = !token && !oauthConfig;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`;
  let warnedUnauthenticated = false;
  const warnUnauthenticated = () => {
    if (!unauthenticatedHttp || warnedUnauthenticated) return;
    const warning = unauthenticatedHttpWarning(
      live.runtime.listTools(),
      live.loaded.config.confirmation.method,
      url,
    );
    if (!warning) return;
    warnedUnauthenticated = true;
    logger.warn(warning);
  };
  warnUnauthenticated();
  if (watching) {
    live.onReload(() => {
      const change = oauthChange(oauthConfig, live.loaded.config.http.oauth);
      if (change) logger.warn(change);
      warnUnauthenticated();
    });
  }
  // Before listening: an endpoint that calls a made-up token active would accept anything, and
  // that must stop apitame. Any other failure is logged and apitame serves anyway: every new
  // token is introspected, so it works once the endpoint does.
  const introspectionUrl = oauthConfig?.introspection?.url;
  if (oauth?.introspection && introspectionUrl) {
    try {
      await oauth.introspection.warmUp();
      logger.info(
        `OAuth: token introspection at ${introspectionUrl} accepts apitame's credentials`,
      );
    } catch (err) {
      if (err instanceof IntrospectionMisconfigured) throw err;
      logger.error(
        `OAuth: token introspection does not work yet: ${(err as Error).message} Tokens that need introspection are refused until it does.`,
      );
    }
  }
  // Every server reads the runtime through `live`, so stateless requests and sessions alike see reloads.
  // A 2026-07-28 request gets a server of its own that lives for that request only, so it is not
  // kept in `servers`: list changes reach those clients through `events`.
  await serveHttp(({ era }) => (era === 'modern' ? buildServer() : makeServer()), {
    host,
    port,
    logger,
    sessions,
    events,
    onServerClosed: (s) => servers.delete(s),
    ...(token ? { token } : {}),
    ...(oauthConfig && oauth
      ? { oauth: { verifier: oauth.verifier, options: oauthConfig, name: rt.name } }
      : {}),
  });
  if (oauthConfig && oauth?.jwt) {
    try {
      const keys = await oauth.jwt.warmUp();
      logger.info(`OAuth: ${keys} signing key${keys === 1 ? '' : 's'} from ${oauthConfig.issuer}`);
    } catch (err) {
      // Keep serving: the keys are fetched again when tokens arrive (at most every few seconds).
      logger.error(
        `OAuth: could not load the signing keys of ${oauthConfig.issuer}: ${(err as Error).message} ${oauth.introspection ? 'JWT access tokens' : 'Tokens'} are refused until the keys load; apitame tries again when requests arrive.`,
      );
    }
  }
  const notes = [
    sessions ? 'sessions' : '',
    token ? 'bearer token required' : '',
    oauthConfig ? `OAuth from ${oauthConfig.issuer}` : '',
    oauth && oauth.mode !== 'jwt' ? `verify: ${oauth.mode}` : '',
  ].filter(Boolean);
  logger.info(`serving ${summary} at ${url}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
}
