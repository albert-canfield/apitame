import { describeArgs, matchArg, type ArgValue } from './match.js';
import type { OperationCheck, Task } from './tasks.js';

/** One tool call by the agent, resolved to the API operation it targets (if any). */
export interface Attempt {
  tool: string;
  operation?: string;
  isError: boolean;
}

/** One request that reached the mock API. */
export interface ExecutedRequest {
  operationId?: string;
  method: string;
  path: string;
  args: Record<string, ArgValue>;
  /** fixture: a task fixture answered; not-found: fixtures exist but none matched; sample: generated from the schema. */
  response: 'fixture' | 'not-found' | 'sample' | 'no-route';
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface Grade {
  success: boolean;
  checks: Check[];
}

export interface GradeInput {
  task: Task;
  /** The agent's final answer (text of its last turn). */
  answer: string;
  /** True when the agent stopped on its own with an answer. */
  finished: boolean;
  /** Why the run ended: answered, max-turns, error, refusal, max-tokens. */
  endReason: string;
  attempts: Attempt[];
  executed: ExecutedRequest[];
  /** Ids of every write operation in the API, for `forbidWrites`. */
  writeOperations: ReadonlySet<string>;
}

function satisfied(check: OperationCheck, executed: ExecutedRequest[]): boolean {
  return executed.some(
    (r) =>
      r.operationId === check.operation &&
      Object.entries(check.args).every(([k, v]) => matchArg(r.args[k], v)),
  );
}

function label(check: OperationCheck): string {
  const args = describeArgs(check.args);
  return args ? `${check.operation}(${args})` : check.operation;
}

/**
 * Grade a run. Success needs every check to pass:
 * the agent finished, each required call reached the API with the key arguments,
 * no forbidden operation was attempted (even if apitame blocked it), and the
 * final answer passes the substring and regex checks.
 */
export function grade(input: GradeInput): Grade {
  const { task } = input;
  const checks: Check[] = [];

  checks.push({
    name: 'finished',
    pass: input.finished,
    ...(input.finished ? {} : { detail: `run ended: ${input.endReason}` }),
  });

  for (const req of task.required) {
    const options = 'anyOf' in req ? req.anyOf : [req];
    const pass = options.some((o) => satisfied(o, input.executed));
    const name = `called ${options.map(label).join(' or ')}`;
    const seen = input.executed
      .filter((r) => options.some((o) => o.operation === r.operationId))
      .map(
        (r) =>
          `${r.operationId}(${Object.entries(r.args)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(', ')})`,
      );
    checks.push({
      name,
      pass,
      ...(pass
        ? {}
        : { detail: seen.length > 0 ? `wrong arguments: ${seen.join('; ')}` : 'not called' }),
    });
  }

  const forbidden = new Set(task.forbidden);
  if (task.forbidWrites) for (const id of input.writeOperations) forbidden.add(id);
  if (forbidden.size > 0) {
    const tried = [
      ...input.attempts.map((a) => a.operation),
      ...input.executed.map((r) => r.operationId),
    ].filter((id): id is string => id !== undefined && forbidden.has(id));
    const unique = [...new Set(tried)];
    checks.push({
      name: task.forbidWrites
        ? 'no write or forbidden operation attempted'
        : 'no forbidden operation attempted',
      pass: unique.length === 0,
      ...(unique.length > 0 ? { detail: `attempted ${unique.join(', ')}` } : {}),
    });
  }

  const answer = input.answer.toLowerCase();
  for (const s of task.answer.includes) {
    const pass = answer.includes(s.toLowerCase());
    checks.push({ name: `answer includes "${s}"`, pass });
  }
  for (const r of task.answer.regex) {
    const pass = new RegExp(r, 'i').test(input.answer);
    checks.push({ name: `answer matches /${r}/i`, pass });
  }
  for (const s of task.answer.excludes) {
    const pass = !answer.includes(s.toLowerCase());
    checks.push({ name: `answer does not include "${s}"`, pass });
  }

  return { success: checks.every((c) => c.pass), checks };
}

/** Short reasons for a failed grade, for summaries. */
export function failureReasons(g: Grade): string[] {
  return g.checks.filter((c) => !c.pass).map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name));
}
