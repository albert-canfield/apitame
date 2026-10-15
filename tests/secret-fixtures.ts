import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fake secret manager CLIs (`op`, `aws`, `gcloud`) for tests: a shell script that runs a Node
 * script, so the CLI is found on PATH and started like the real one. Every call is recorded in
 * `<name>.calls.jsonl` (arguments, environment and PID) before `body` runs. POSIX only: Windows
 * cannot run a script without a shell, and apitame never uses one.
 */
export function fakeCli(dir: string, name: string, body: string): { calls: () => FakeCall[] } {
  const calls = join(dir, `${name}.calls.jsonl`);
  const script = join(dir, `${name}.cjs`);
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid }) + '\\n');`,
      body,
      '',
    ].join('\n'),
  );
  const launcher = join(dir, name);
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(launcher, 0o755);
  return {
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as FakeCall)
        : [],
  };
}

export interface FakeCall {
  argv: string[];
  env: Record<string, string>;
  pid: number;
}

/** A body that prints `text` on stdout and exits with code 0. */
export const prints = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;

/** A body that prints `stderr`, maybe `stdout`, and exits with `code`. */
export const fails = (code: number, stderr: string, stdout = '') =>
  `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};`;

/**
 * A body that starts a child of its own, writes both PIDs to `pidFile`, and never exits: a CLI
 * stuck waiting for a sign-in, or a wrapper script and the program it started.
 */
export const hangs = (pidFile: string) =>
  [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');

/** Whether a process exists (a zombie counts: it still has its PID). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Wait until none of `pids` exists, or `ms` passes. Returns the ones still there. */
export async function gone(pids: number[], ms = 5_000): Promise<number[]> {
  const until = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter(alive);
  }
  return left;
}
