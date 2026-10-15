import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fromDotEnv } from '../config/env.js';
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
 * Where a CLI is: an absolute path, or the first executable file of that name in a PATH folder.
 * PATH entries that are not absolute (`.`, `bin`) are skipped, so a program in the folder apitame
 * happens to run in is never picked up, and a PATH that `.env` set is not used at all. On Windows
 * only `.exe` and `.com` files are found: batch files cannot run without a shell.
 */
export function findExecutable(cli: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(cli)) return isExecutable(cli) ? cli : undefined;
  const names = WINDOWS && !/\.(exe|com)$/i.test(cli) ? [`${cli}.exe`, `${cli}.com`] : [cli];
  const path = fromDotEnv(env, 'PATH') ? '' : (envGet(env, 'PATH') ?? '');
  for (const entry of path.split(delimiter)) {
    const dir = WINDOWS ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  return undefined;
}

/**
 * The program to run for a CLI. Its location comes from the environment that starts apitame,
 * never from the config or `.env`, which travel with a project: `variable` (`APITAME_OP_CLI` and
 * the like) when it is set, an absolute path, otherwise `name` on PATH.
 */
export function locateCli(
  name: string,
  variable: string,
  env: NodeJS.ProcessEnv,
): { file: string } | { problem: string } {
  const configured = envGet(env, variable);
  if (configured === undefined || configured === '') {
    const file = findExecutable(name, env);
    return file ? { file } : { problem: `${name} was not found on PATH` };
  }
  if (fromDotEnv(env, variable)) {
    return {
      problem: `${variable} is set in .env, which cannot choose a program. Set it in the environment that starts apitame (the shell or the MCP client config)`,
    };
  }
  if (!isAbsolute(configured)) {
    return { problem: `${variable} must be an absolute path, such as /usr/local/bin/${name}` };
  }
  return isExecutable(configured)
    ? { file: configured }
    : { problem: `${variable} (${configured}) is not an executable file` };
}

/** CLIs that are still running, so they can be stopped if apitame stops first. */
const running = new Set<ChildProcess>();
let exitHook = false;

/**
 * Stop a CLI and everything it started. On POSIX systems each CLI leads a process group of its
 * own (`detached`), so a wrapper script and the program it runs (gcloud is a shell script that
 * starts Python) are stopped together. A program that leaves the group (`setsid`) escapes, and
 * what a CLI leaves running after a successful read is its own business.
 */
function stop(child: ChildProcess): void {
  try {
    if (!WINDOWS && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * In a process group of its own, a CLI does not get the Ctrl+C (or the SIGTERM of a container
 * stop) meant for apitame. While CLIs run, these signals stop them first; then, when nothing else
 * in the process handles the signal (`serve` does once it is up, and shuts down), it is raised
 * again so apitame ends as it would have without this handler.
 */
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const onSignal = new Map(
  SIGNALS.map((signal) => [
    signal,
    () => {
      for (const c of running) stop(c);
      running.clear();
      unhookSignals();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    },
  ]),
);
let signalsHooked = false;

function hookSignals(): void {
  if (signalsHooked) return;
  signalsHooked = true;
  for (const [signal, handler] of onSignal) process.on(signal, handler);
}

function unhookSignals(): void {
  if (!signalsHooked) return;
  signalsHooked = false;
  for (const [signal, handler] of onSignal) process.removeListener(signal, handler);
}

function track(child: ChildProcess): void {
  running.add(child);
  hookSignals();
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const c of running) stop(c);
    });
  }
}

function untrack(child: ChildProcess): void {
  running.delete(child);
  if (running.size === 0) unhookSignals();
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
          untrack(child);
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
