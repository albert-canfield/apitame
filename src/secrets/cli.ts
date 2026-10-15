import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { withDeadline } from '../util/deadline.js';

const WINDOWS = process.platform === 'win32';

/** What a secret manager CLI printed and how it ended. */
export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  /** The start of what it printed on stderr, used only to pick a message, never shown. */
  stderr: string;
}

export interface CliOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Most bytes read from stdout; past it the program is stopped. */
  maxOutputBytes: number;
}

/** Runs a CLI: an absolute path and its arguments, never through a shell. */
export type CliRunner = (file: string, args: string[], opts: CliOptions) => Promise<CliResult>;

export class CliTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${timeoutMs / 1000} seconds`);
    this.name = 'CliTimeoutError';
  }
}

export class CliOutputTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`printed more than ${maxBytes} bytes`);
    this.name = 'CliOutputTooLargeError';
  }
}

/** Most bytes of stderr kept, to pick a message from. */
const MAX_STDERR_BYTES = 8_192;

/** A variable of `env`, by name, ignoring case on Windows as Windows does. */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined || !WINDOWS) return env[name];
  return Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!WINDOWS) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a CLI is: the configured absolute path, or the first executable file of that name in a
 * PATH folder. PATH entries that are not absolute (`.`, `bin`) are skipped, so a program in the
 * folder apitame happens to run in is never picked up. On Windows only `.exe` and `.com` files
 * are found: batch files cannot run without a shell.
 */
export function findExecutable(cli: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(cli)) return isExecutable(cli) ? cli : undefined;
  const names = WINDOWS && !/\.(exe|com)$/i.test(cli) ? [`${cli}.exe`, `${cli}.com`] : [cli];
  for (const entry of (envGet(env, 'PATH') ?? '').split(delimiter)) {
    const dir = WINDOWS ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutable(path)) return path;
    }
  }
  return undefined;
}

/** CLIs that are still running, so they can be stopped if apitame exits first. */
const running = new Set<ChildProcess>();
let exitHook = false;

/**
 * Stop a CLI and everything it started. On POSIX systems each CLI leads a process group of its
 * own (`detached`), so a wrapper script and the program it runs (gcloud is a shell script that
 * starts Python) are stopped together.
 */
function stop(child: ChildProcess): void {
  try {
    if (!WINDOWS && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function track(child: ChildProcess): void {
  running.add(child);
  if (!exitHook) {
    exitHook = true;
    // In its own process group, a CLI would not get the Ctrl+C that stops apitame.
    process.on('exit', () => {
      for (const c of running) stop(c);
    });
  }
}

/**
 * Run a CLI with an argument array, never through a shell, with no input, the given environment
 * only, and a deadline held by a timer (see withDeadline) that covers its whole output. At the
 * deadline, or when stdout grows past `maxOutputBytes`, the CLI and its process group are killed.
 */
export const runCli: CliRunner = (file, args, opts) =>
  withDeadline(
    opts.timeoutMs,
    () => new CliTimeoutError(opts.timeoutMs),
    (signal) =>
      new Promise<CliResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = spawn(file, args, {
            env: opts.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            detached: !WINDOWS,
            windowsHide: true,
          });
        } catch (err) {
          reject(err as Error);
          return;
        }
        track(child);
        let done = false;
        const finish = () => {
          done = true;
          running.delete(child);
          signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          if (!done) stop(child);
        };
        signal.addEventListener('abort', onAbort, { once: true });

        const out: Buffer[] = [];
        let outBytes = 0;
        let err = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          outBytes += chunk.length;
          if (outBytes > opts.maxOutputBytes) {
            if (!done) stop(child);
            finish();
            reject(new CliOutputTooLargeError(opts.maxOutputBytes));
            return;
          }
          out.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (err.length < MAX_STDERR_BYTES) err += chunk.toString('utf8');
        });
        child.on('error', (e) => {
          if (done) return;
          finish();
          reject(e);
        });
        child.on('close', (code, sig) => {
          if (done) return;
          finish();
          resolve({
            code,
            signal: sig,
            stdout: Buffer.concat(out),
            stderr: err.slice(0, MAX_STDERR_BYTES),
          });
        });
      }),
  );
