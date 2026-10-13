import type { Redactor } from './safety/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Logs always go to stderr (stdout belongs to the MCP stdio transport)
 * and always pass through the redactor.
 */
export class Logger {
  constructor(
    private readonly redactor: Redactor,
    private level: LogLevel = (process.env.APITAME_LOG_LEVEL as LogLevel | undefined) ?? 'info',
    private readonly write: (line: string) => void = (l) => process.stderr.write(l),
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(msg: string): void {
    this.log('debug', msg);
  }
  info(msg: string): void {
    this.log('info', msg);
  }
  warn(msg: string): void {
    this.log('warn', msg);
  }
  error(msg: string): void {
    this.log('error', msg);
  }

  private log(level: LogLevel, msg: string): void {
    if (ORDER[level] < ORDER[this.level]) return;
    this.write(`[apitame] ${level === 'info' ? '' : `${level}: `}${this.redactor.text(msg)}\n`);
  }
}
