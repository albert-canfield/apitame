import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Operation } from '../../src/sources/openapi/operations.js';

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * How a required argument is checked against the request the mock server received.
 * A scalar must be equal (strings ignore case), a list must all be present,
 * `contains` and `regex` look inside the value (case-insensitive).
 */
const ArgMatcher = z.union([
  Scalar,
  z.array(Scalar),
  z.object({ contains: z.string() }).strict(),
  z.object({ regex: z.string() }).strict(),
]);
export type ArgMatcher = z.infer<typeof ArgMatcher>;

const OperationCheck = z
  .object({
    operation: z.string().min(1),
    args: z.record(z.string(), ArgMatcher).default({}),
  })
  .strict();
export type OperationCheck = z.infer<typeof OperationCheck>;

/** A required call: one operation, or any one of several routes to the same data. */
const Required = z.union([
  OperationCheck,
  z.object({ anyOf: z.array(OperationCheck).min(2) }).strict(),
]);
export type Required = z.infer<typeof Required>;

/** A canned response. The first fixture whose `match` fits the request wins. */
const Fixture = z
  .object({
    operation: z.string().min(1),
    /** Path, query or body parameters, checked like the arguments of a required call. */
    match: z.record(z.string(), ArgMatcher).default({}),
    status: z.number().int().min(100).max(599).default(200),
    body: z.unknown(),
  })
  .strict();
export type Fixture = z.infer<typeof Fixture>;

const FakeStep = z
  .object({
    operation: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type FakeStep = z.infer<typeof FakeStep>;

export const TASK_KINDS = ['lookup', 'chain', 'long-tail', 'blocked-write'] as const;

const TaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.enum(TASK_KINDS),
    prompt: z.string().min(1),
    /** Fixtures for this task only. They are tried before the file's shared fixtures. */
    fixtures: z.array(Fixture).default([]),
    required: z.array(Required).default([]),
    /** Operations the agent must not even try (a call that apitame blocks still counts). */
    forbidden: z.array(z.string()).default([]),
    /** Also forbid every write operation of the API. On by default: the eval runs read-only. */
    forbidWrites: z.boolean().default(true),
    answer: z
      .object({
        /** Substrings that must all appear in the final answer (case-insensitive). */
        includes: z.array(z.string()).default([]),
        /** Regular expressions that must all match the final answer (case-insensitive). */
        regex: z.array(z.string()).default([]),
        /** Substrings that must not appear (case-insensitive). */
        excludes: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    /** What the scripted fake model does: these calls in order, then this answer. */
    fake: z
      .object({
        steps: z.array(FakeStep).default([]),
        answer: z.string().min(1),
      })
      .strict(),
    notes: z.string().optional(),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

const TaskFileSchema = z
  .object({
    api: z.string().min(1),
    /** The data every task sees: one small, consistent world. */
    fixtures: z.array(Fixture).default([]),
    tasks: z.array(TaskSchema).min(1),
  })
  .strict();

/**
 * Read and validate a task file. Each task gets its own fixtures followed by the
 * shared ones. Operation ids are checked later, against the spec.
 */
export function loadTaskFile(path: string): { api: string; tasks: Task[] } {
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  const parsed = TaskFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid task file ${path}:\n${issues}`);
  }
  const ids = new Set<string>();
  for (const t of parsed.data.tasks) {
    if (ids.has(t.id)) throw new Error(`Duplicate task id "${t.id}" in ${path}`);
    ids.add(t.id);
  }
  const { api, fixtures: shared, tasks } = parsed.data;
  return { api, tasks: tasks.map((t) => ({ ...t, fixtures: [...t.fixtures, ...shared] })) };
}

/** Every operation id a task mentions must exist in the spec. Returns the problems found. */
export function checkTaskOperations(tasks: Task[], operations: Operation[]): string[] {
  const known = new Set(operations.map((o) => o.id));
  const problems: string[] = [];
  for (const t of tasks) {
    const refs = [
      ...t.fixtures.map((f) => f.operation),
      ...t.required.flatMap((r) => ('anyOf' in r ? r.anyOf : [r]).map((c) => c.operation)),
      ...t.forbidden,
      ...t.fake.steps.map((s) => s.operation),
    ];
    for (const id of refs) {
      if (!known.has(id)) problems.push(`${t.id}: unknown operation "${id}"`);
    }
    if (t.kind === 'blocked-write' && t.forbidden.length === 0) {
      problems.push(`${t.id}: a blocked-write task must list the write in "forbidden"`);
    }
  }
  return problems;
}
