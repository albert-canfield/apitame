import type { Server } from '@modelcontextprotocol/server';
import { DEFAULT_CONFIG_FILE } from '../../config/load.js';
import { Logger, type LogLevel } from '../../log.js';
import { Redactor } from '../../safety/redact.js';
import { LiveRuntime } from '../../server/live.js';
import { createMcpServer } from '../../server/mcp.js';
import { serveHttp, serveStdio } from '../../server/transport.js';

export interface ServeOptions {
  config?: string;
  transport?: string;
  port?: string;
  host?: string;
  logLevel?: string;
  watch?: boolean;
  sessions?: boolean;
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
  // Live servers, so a reload can tell every connected client that the tool list changed.
  const servers = new Set<Server>();
  const makeServer = () => {
    const server = createMcpServer(() => live.runtime, {
      skills: () => live.skills,
      listChanged: watching,
    });
    servers.add(server);
    return server;
  };

  if (watching) {
    live.onReload(({ toolsChanged, skillsChanged }) => {
      for (const s of servers) {
        if (toolsChanged) void s.sendToolListChanged().catch(() => {});
        if (skillsChanged) void s.sendResourceListChanged().catch(() => {});
      }
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
    const server = makeServer();
    servers.add(server);
    await serveStdio(server);
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
  // Every server reads the runtime through `live`, so stateless requests and sessions alike see reloads.
  await serveHttp(makeServer, {
    host,
    port,
    logger,
    sessions,
    onServerClosed: (s) => servers.delete(s),
    ...(token ? { token } : {}),
  });
  const notes = [sessions ? 'sessions' : '', token ? 'bearer token required' : ''].filter(Boolean);
  logger.info(
    `serving ${summary} at http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
  );
}
