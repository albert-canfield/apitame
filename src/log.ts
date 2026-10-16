import { REDACTED, type Redactor } from './safety/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Logs always go to stderr (stdout belongs to the MCP stdio transport)
 * and always pass through the redactor.
 */
export class Logger {
  /** Values hidden in log lines only (see {@link addSecret}), longest first. */
  private logOnly: string[] = [];

  constructor(
    private readonly redactor: Redactor,
    private level: LogLevel = (process.env.APITAME_LOG_LEVEL as LogLevel | undefined) ?? 'info',
    private readonly write: (line: string) => void = (l) => process.stderr.write(l),
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Hide a value in log lines, and only there. For secrets that never reach tool results, such
   * as the headers apitame sends to an OpenTelemetry collector: in the shared redactor, a header
   * value that is an ordinary word (`x-team=items`) would be cut out of every API response.
   */
  addSecret(value: string): void {
    if (value.length < 4 || this.logOnly.includes(value)) return;
    this.logOnly = [...this.logOnly, value].sort((a, b) => b.length - a.length);
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
    let text = this.redactor.text(msg);
    for (const value of this.logOnly) text = text.split(value).join(REDACTED);
    this.write(`[apitame] ${level === 'info' ? '' : `${level}: `}${text}\n`);
  }
}
