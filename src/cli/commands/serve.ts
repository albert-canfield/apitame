import { resolve } from 'node:path';
import { loadConfig } from '../../config/load.js';
import { Logger, type LogLevel } from '../../log.js';
import { Redactor } from '../../safety/redact.js';
import { createMcpServer } from '../../server/mcp.js';
import { createRuntime } from '../../server/runtime.js';
import { loadSkills } from '../../server/skills.js';
import { serveHttp, serveStdio } from '../../server/transport.js';

export interface ServeOptions {
  config?: string;
  transport?: string;
  port?: string;
  host?: string;
  logLevel?: string;
}

export async function serveCommand(opts: ServeOptions): Promise<void> {
  const redactor = new Redactor();
  const logger = new Logger(
    redactor,
    (opts.logLevel as LogLevel | undefined) ??
      (process.env.APITAME_LOG_LEVEL as LogLevel | undefined) ??
      'info',
  );
  const loaded = loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined);
  const runtime = await createRuntime(loaded, { redactor, logger });
  for (const w of runtime.warnings) logger.warn(w);

  const skills = loadSkills(resolve(loaded.dir, loaded.config.skills.dir));
  const tools = runtime.listTools().length;
  const transport = opts.transport ?? 'stdio';

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    await runtime.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  const summary = `${runtime.name}: ${tools} tools, ${runtime.mode}${skills.length > 0 ? `, ${skills.length} skill${skills.length === 1 ? '' : 's'}` : ''}`;

  if (transport === 'stdio') {
    await serveStdio(createMcpServer(runtime, { skills }));
    process.stdin.on('end', () => void shutdown(0));
    logger.info(`serving ${summary} over stdio`);
    if (process.stdin.isTTY) {
      logger.info(
        'waiting for an MCP client on stdin. Connect one with "npx apitame add-to claude-code" (or codex, cursor, vscode). Ctrl+C to stop.',
      );
    }
    return;
  }
  if (transport !== 'http') throw new Error(`Unknown transport "${transport}". Use stdio or http.`);

  const host = opts.host ?? '127.0.0.1';
  const port = Number(opts.port ?? 3333);
  const token = process.env.APITAME_HTTP_TOKEN;
  if (token) redactor.addSecret(token);
  await serveHttp(() => createMcpServer(runtime, { skills }), {
    host,
    port,
    logger,
    ...(token ? { token } : {}),
  });
  logger.info(
    `serving ${summary} at http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp${token ? ' (bearer token required)' : ''}`,
  );
}
