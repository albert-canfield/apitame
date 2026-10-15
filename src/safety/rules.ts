/**
 * Argument rules for writes (`writes.rules`): limits on how an allowed write may be called,
 * checked after argument validation and before dry runs, confirmation, rate limits and sending.
 * Rules only ever refuse calls; they never allow anything `writes.allow` does not.
 */
import type { Access, JsonSchema } from '../types.js';
import { compilePattern, PatternError, type SafePattern } from './pattern.js';
import type { Redactor } from './redact.js';

type Scalar = string | number | boolean | null;

/** One rule, as validated by the config schema (`writes.rules.<id>.<path>`). */
export interface ArgumentRule {
  in?: Scalar[];
  notIn?: Scalar[];
  equals?: Scalar;
  pattern?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  required?: true;
  forbidden?: true;
}

/** `writes.rules`: operation id (or named query), then argument path, then the rule. */
export type RulesConfig = Record<string, Record<string, ArgumentRule>>;

export const RULE_OPERATORS = [
  'in',
  'notIn',
  'equals',
  'pattern',
  'min',
  'max',
  'minLength',
  'maxLength',
  'required',
  'forbidden',
] as const;

/** One step of a rule path: a field name, then `[]` once per list level (`items[]`). */
interface Segment {
  name: string;
  lists: number;
}

// `*` is refused rather than read as a field name: `items.*.price` would silently match nothing.
const SEGMENT = /^([^.[\]*]+)((?:\[\])*)$/;

/** Split `body.items[].price` into segments, or undefined when the syntax is wrong. */
export function parseRulePath(path: string): Segment[] | undefined {
  const segments: Segment[] = [];
  for (const part of path.split('.')) {
    const m = SEGMENT.exec(part);
    if (!m) return undefined;
    segments.push({ name: m[1]!, lists: m[2]!.length / 2 });
  }
  return segments;
}

export const RULE_PATH_HELP =
  'Rule paths are argument names, with dots for nested fields and [] for every item of a list (not * or an index), for example amount, body.state or body.items[].price.';

/** Problems with one rule, for config validation. Empty when the rule is fine. */
export function ruleProblems(rule: ArgumentRule): string[] {
  const used = RULE_OPERATORS.filter((op) => rule[op] !== undefined);
  const out: string[] = [];
  if (used.length === 0) out.push(`a rule needs at least one of ${RULE_OPERATORS.join(', ')}`);
  if (rule.forbidden && used.length > 1)
    out.push(
      'forbidden means the argument must be left out, so it cannot be combined with other operators',
    );
  if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max)
    out.push(`min (${rule.min}) is greater than max (${rule.max})`);
  if (
    rule.minLength !== undefined &&
    rule.maxLength !== undefined &&
    rule.minLength > rule.maxLength
  )
    out.push(`minLength (${rule.minLength}) is greater than maxLength (${rule.maxLength})`);
  if (rule.pattern !== undefined) {
    try {
      compilePattern(rule.pattern);
    } catch (err) {
      if (!(err instanceof PatternError)) throw err;
      out.push(`pattern: ${err.message}`);
    }
  }
  return out;
}

/** An operation (or named query) that rules can refer to. */
export interface RuleTarget {
  id: string;
  access: Access;
  /** The tool input schema, used to report rules for fields that do not exist. */
  schema?: JsonSchema;
}

interface Compiled {
  path: string;
  segments: Segment[];
  rule: ArgumentRule;
  pattern?: SafePattern;
  /** What minLength and maxLength count, from the schema. */
  unit: string;
}

/** A broken rule. `at` is the concrete path (`items[2].price`), `path` the configured one. */
export interface Violation {
  at: string;
  path: string;
  rule: string;
  problem: string;
  /** False when there is no value to show (a missing argument). */
  hasValue: boolean;
  value?: unknown;
}

export interface RuleListing {
  operation: string;
  path: string;
  rule: ArgumentRule;
  text: string;
}

/** The rules of one server, compiled and checked against the operations it serves. */
export class WriteRules {
  /** Rules for ids that do not exist, for reads, or for fields that do not exist. */
  readonly warnings: string[] = [];
  private readonly byId = new Map<string, Compiled[]>();

  constructor(
    config: RulesConfig,
    targets: RuleTarget[],
    private readonly redactor: Redactor,
    noun = 'operation',
  ) {
    const targetById = new Map(targets.map((t) => [t.id, t]));
    for (const [id, paths] of Object.entries(config)) {
      const target = targetById.get(id);
      if (!target) {
        this.warnings.push(
          `writes.rules.${id}: no ${noun} has this id (typo?). Rules take exact ids.`,
        );
        continue;
      }
      if (target.access === 'read') {
        this.warnings.push(
          `writes.rules.${id}: "${id}" is a read ${noun}; rules only apply to writes, so these are ignored.`,
        );
        continue;
      }
      const compiled: Compiled[] = [];
      for (const [path, rule] of Object.entries(paths)) {
        const segments = parseRulePath(path);
        if (!segments) throw new Error(`writes.rules.${id}: "${path}" is not a valid path`);
        const found = target.schema ? schemaAt(target.schema, segments) : UNKNOWN;
        if (found.kind === 'problem')
          this.warnings.push(`writes.rules.${id}.${path}: ${found.message}`);
        const kinds = found.kind === 'found' ? kindsOf(found.schemas) : undefined;
        if (kinds)
          for (const w of typeWarnings(rule, kinds))
            this.warnings.push(`writes.rules.${id}.${path}: ${w}`);
        compiled.push({
          path,
          segments,
          rule,
          ...(rule.pattern !== undefined ? { pattern: compilePattern(rule.pattern) } : {}),
          unit:
            kinds?.has('string') && !kinds.has('array')
              ? 'characters'
              : kinds?.has('array') && !kinds.has('string')
                ? 'items'
                : 'characters or items',
        });
      }
      this.byId.set(id, compiled);
    }
  }

  /** True when the operation has rules that are enforced. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Every broken rule for these (validated) arguments. Empty when the call may go on. */
  check(id: string, args: Record<string, unknown>): Violation[] {
    const out: Violation[] = [];
    for (const r of this.byId.get(id) ?? [])
      for (const leaf of valuesAt(args, r.segments)) out.push(...checkLeaf(r, leaf));
    return out;
  }

  /**
   * Check the arguments and, when a rule is broken, build the refusal for the agent and the
   * reason for the audit log. Values are shown through the redactor.
   */
  enforce(
    id: string,
    args: Record<string, unknown>,
  ): { message: string; reason: string } | undefined {
    const broken = this.check(id, args);
    if (broken.length === 0) return undefined;
    const got = (v: Violation) => (v.hasValue ? `, got ${this.display(v)}` : '');
    const lines = broken
      .slice(0, 10)
      .map((v) => `- ${v.at}: ${v.problem}${got(v)} [rule ${v.path} ${v.rule}]`);
    if (broken.length > 10) lines.push(`- and ${broken.length - 10} more`);
    const message = [
      `Refused by writes.rules for "${id}". Nothing was sent.`,
      ...lines,
      'These rules are set in apitame.config.yaml by whoever runs this server. Tell the user what was refused instead of looking for a way around it.',
    ].join('\n');
    const reason = broken
      .slice(0, 5)
      .map((v) => `writes.rules.${id}.${v.path} (${v.rule}): ${v.at} ${v.problem}${got(v)}`)
      .join('; ');
    return { message: this.redactor.text(message), reason: this.redactor.text(reason) };
  }

  /**
   * The rules of one operation in plain language, or undefined when it has none. In markdown,
   * paths and patterns are code spans, so `\.` or `*` in a pattern reads as written.
   */
  describe(id: string, markdown = false): string | undefined {
    const rules = this.byId.get(id);
    if (!rules) return undefined;
    return rules
      .map((r) => `${markdown ? code(r.path) : r.path}: ${phrases(r, markdown).join(', ')}`)
      .join('; ');
  }

  /** Every enforced rule, for `inspect` and the skill reference. */
  list(markdown = false): RuleListing[] {
    return [...this.byId].flatMap(([operation, rules]) =>
      rules.map((r) => ({
        operation,
        path: r.path,
        rule: r.rule,
        text: phrases(r, markdown).join(', '),
      })),
    );
  }

  /**
   * Example arguments (for generated skills) changed to follow the simple rules: the first
   * allowed value, numbers within min and max, required values added when the rule names one,
   * forbidden ones removed. Paths through lists and patterns are left alone.
   */
  example(id: string, args: Record<string, unknown>): Record<string, unknown> {
    const out = structuredClone(args);
    for (const { segments, rule } of this.byId.get(id) ?? []) {
      if (segments.some((s) => s.lists > 0)) continue;
      const names = segments.map((s) => s.name);
      const key = names.pop()!;
      const ranged = rule.min !== undefined || rule.max !== undefined;
      const supplied: { v: Scalar } | undefined = rule.in
        ? { v: rule.in[0]! }
        : rule.equals !== undefined
          ? { v: rule.equals }
          : ranged
            ? { v: rule.min ?? rule.max! }
            : undefined;
      // Walk to the parent object, creating it only for a required value the rule can supply.
      let parent: Record<string, unknown> | undefined = out;
      for (const name of names) {
        if (!isRecord(parent[name])) {
          if (!rule.required || !supplied) {
            parent = undefined;
            break;
          }
          parent[name] = {};
        }
        parent = parent[name] as Record<string, unknown>;
      }
      if (!parent) continue;
      const value = parent[key];
      if (rule.forbidden) delete parent[key];
      else if (value === undefined) {
        if (rule.required && supplied) parent[key] = supplied.v;
      } else if (rule.in && !(isScalar(value) && rule.in.some((o) => sameValue(value, o))))
        parent[key] = rule.in[0];
      else if (rule.equals !== undefined && !(isScalar(value) && sameValue(value, rule.equals)))
        parent[key] = rule.equals;
      else if (ranged) {
        const n = typeof value === 'number' ? value : (rule.min ?? rule.max!);
        parent[key] = Math.min(rule.max ?? Infinity, Math.max(rule.min ?? -Infinity, n));
      }
    }
    return out;
  }

  /** A value as shown in a refusal: redacted (by its key too), JSON, and short. */
  private display(v: Violation): string {
    const key = v.path.split('.').pop()!.replace(/\[\]/g, '');
    const redacted = Object.values(this.redactor.value({ [key]: v.value }))[0];
    const text = JSON.stringify(redacted) ?? String(redacted);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
}

// ---------------------------------------------------------------------------
// Checking values

interface Leaf {
  at: string;
  present: boolean;
  value?: unknown;
  /** Set when the path cannot be followed: the value there is not an object or not a list. */
  shape?: 'object' | 'list';
}

/** The values a path points to. A list segment (`items[]`) yields one leaf per element. */
function valuesAt(args: Record<string, unknown>, segments: Segment[]): Leaf[] {
  let nodes: Leaf[] = [{ at: '', present: true, value: args }];
  for (const seg of segments) {
    const next: Leaf[] = [];
    for (const node of nodes) {
      if (node.shape) {
        next.push(node);
        continue;
      }
      const at = node.at ? `${node.at}.${seg.name}` : seg.name;
      // Below a missing value, everything is missing; the path keeps the rule's shape (items[].sku).
      if (!node.present || node.value === null || node.value === undefined) {
        next.push({ at: at + '[]'.repeat(seg.lists), present: false });
        continue;
      }
      if (typeof node.value !== 'object' || Array.isArray(node.value)) {
        next.push({ ...node, shape: 'object' });
        continue;
      }
      const obj = node.value as Record<string, unknown>;
      const has = Object.hasOwn(obj, seg.name) && obj[seg.name] !== undefined;
      let current: Leaf[] = [{ at, present: has, ...(has ? { value: obj[seg.name] } : {}) }];
      for (let i = 0; i < seg.lists; i++) {
        const expanded: Leaf[] = [];
        for (const c of current) {
          if (c.shape) expanded.push(c);
          else if (!c.present || c.value === null)
            expanded.push({ at: `${c.at}[]`, present: false });
          else if (!Array.isArray(c.value)) expanded.push({ ...c, shape: 'list' });
          else
            c.value.forEach((v: unknown, idx) =>
              expanded.push({ at: `${c.at}[${idx}]`, present: v !== undefined, value: v }),
            );
        }
        current = expanded;
      }
      next.push(...current);
    }
    nodes = next;
  }
  return nodes;
}

const json = (v: unknown) => JSON.stringify(v);

function checkLeaf(r: Compiled, leaf: Leaf): Violation[] {
  const { rule } = r;
  const fail = (problem: string, ruleText: string, hasValue = true): Violation => ({
    at: leaf.at,
    path: r.path,
    rule: ruleText,
    problem,
    hasValue,
    ...(hasValue ? { value: leaf.value } : {}),
  });

  if (leaf.shape)
    return [fail(leaf.shape === 'list' ? 'must be a list' : 'must be an object', `path ${r.path}`)];
  if (rule.forbidden) return leaf.present ? [fail('must not be set', 'forbidden: true')] : [];
  if (!leaf.present) return rule.required ? [fail('is required', 'required: true', false)] : [];
  const value = leaf.value;
  if (value === null && rule.required) return [fail('is required', 'required: true')];

  const out: Violation[] = [];
  const scalar = isScalar(value);
  if (rule.in && !(scalar && rule.in.some((o) => sameValue(value, o))))
    out.push(fail(`must be ${oneOf(rule.in)}`, `in: ${json(rule.in)}`));
  if (rule.notIn && (!scalar || rule.notIn.some((o) => looksLike(value, o))))
    out.push(
      fail(
        scalar ? `must not be ${rule.notIn.map(show).join(' or ')}` : 'must be a single value',
        `notIn: ${json(rule.notIn)}`,
      ),
    );
  if (rule.equals !== undefined && !(scalar && sameValue(value, rule.equals)))
    out.push(fail(`must be ${show(rule.equals)}`, `equals: ${json(rule.equals)}`));
  if (r.pattern) {
    const text =
      typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
    if (text === undefined || !r.pattern.test(text))
      out.push(
        fail(
          `${text === undefined ? 'must be text that matches' : 'must match'} ${patternText(r.pattern.source)}`,
          `pattern: ${json(rule.pattern)}`,
        ),
      );
  }
  if (rule.min !== undefined || rule.max !== undefined) {
    const n = plainNumber(value);
    const ruleText = [
      rule.min !== undefined ? `min: ${rule.min}` : '',
      rule.max !== undefined ? `max: ${rule.max}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    if (n === undefined) out.push(fail(`must be a number ${range(rule)}`, ruleText));
    else if ((rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max))
      out.push(fail(`must be ${range(rule)}`, ruleText));
  }
  if (rule.minLength !== undefined || rule.maxLength !== undefined) {
    const ruleText = [
      rule.minLength !== undefined ? `minLength: ${rule.minLength}` : '',
      rule.maxLength !== undefined ? `maxLength: ${rule.maxLength}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const [len, unit] =
      typeof value === 'string'
        ? [Array.from(value).length, 'characters']
        : Array.isArray(value)
          ? [value.length, 'items']
          : [undefined, r.unit];
    if (len === undefined)
      out.push(fail(`must be text or a list with ${length(rule, unit)}`, ruleText));
    else if (
      (rule.minLength !== undefined && len < rule.minLength) ||
      (rule.maxLength !== undefined && len > rule.maxLength)
    )
      out.push(fail(`must have ${length(rule, unit)}, but has ${len}`, ruleText));
  }
  return out;
}

function isScalar(v: unknown): v is Scalar {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Equality for `in` and `equals`: the same value, or a number or boolean in its usual text form
 * (`"42"` for 42, `"true"` for true), since APIs often take either.
 */
function sameValue(value: Scalar, operand: Scalar): boolean {
  if (value === operand) return true;
  if (typeof value === 'string' && (typeof operand === 'number' || typeof operand === 'boolean'))
    return value === String(operand);
  if (typeof operand === 'string' && (typeof value === 'number' || typeof value === 'boolean'))
    return operand === String(value);
  return false;
}

/**
 * Equality for `notIn`, where missing a match lets a call through: also ignores case and
 * surrounding spaces, and compares anything that reads as a number numerically ("042" is 42).
 */
function looksLike(value: Scalar, operand: Scalar): boolean {
  if (sameValue(value, operand)) return true;
  const norm = (x: Scalar) => (typeof x === 'string' ? x.trim().toLowerCase() : x);
  const a = norm(value);
  const b = norm(operand);
  if (a === b) return true;
  const num = (x: Scalar) =>
    typeof x === 'number' ? x : typeof x === 'string' && x !== '' ? Number(x) : NaN;
  if (Number.isFinite(num(a)) && num(a) === num(b)) return true;
  return String(a) === String(b) && (typeof a === 'boolean' || typeof b === 'boolean');
}

const DECIMAL = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** A number, or a string that is plainly one (`"12.50"`), for min and max. */
function plainNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && DECIMAL.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plain-language descriptions

const show = (v: Scalar) => (typeof v === 'string' ? json(v) : String(v));
const oneOf = (values: Scalar[]) =>
  values.length === 1 ? show(values[0]!) : `one of ${values.map(show).join(', ')}`;
/** A pattern on one line, as written. */
const patternText = (p: string) => p.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
/** A markdown code span, with a longer fence when the text holds a backtick. */
const code = (text: string) => {
  const t = patternText(text);
  return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
};

function range(rule: ArgumentRule): string {
  if (rule.min !== undefined && rule.max !== undefined)
    return `between ${rule.min} and ${rule.max}`;
  return rule.min !== undefined ? `at least ${rule.min}` : `at most ${rule.max}`;
}

function length(rule: ArgumentRule, unit: string): string {
  if (rule.minLength !== undefined && rule.maxLength !== undefined)
    return `${rule.minLength} to ${rule.maxLength} ${unit}`;
  return rule.minLength !== undefined
    ? `at least ${rule.minLength} ${unit}`
    : `at most ${rule.maxLength} ${unit}`;
}

function phrases(r: Compiled, markdown = false): string[] {
  const { rule } = r;
  const out: string[] = [];
  if (rule.required) out.push('required');
  if (rule.forbidden) out.push('must not be set');
  if (rule.in) out.push(rule.in.length === 1 ? `must be ${show(rule.in[0]!)}` : oneOf(rule.in));
  if (rule.notIn) out.push(`not ${rule.notIn.map(show).join(' or ')}`);
  if (rule.equals !== undefined) out.push(`must be ${show(rule.equals)}`);
  if (rule.pattern !== undefined)
    out.push(`must match ${markdown ? code(rule.pattern) : patternText(rule.pattern)}`);
  if (rule.min !== undefined || rule.max !== undefined) out.push(range(rule));
  if (rule.minLength !== undefined || rule.maxLength !== undefined) out.push(length(rule, r.unit));
  return out;
}

// ---------------------------------------------------------------------------
// Checking rules against the operation's input schema (warnings only)

type Found =
  | { kind: 'found'; schemas: JsonSchema[] }
  | { kind: 'unknown' }
  | { kind: 'problem'; message: string };

const UNKNOWN: Found = { kind: 'unknown' };

const isObj = (v: unknown): v is JsonSchema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isRecord = isObj as (v: unknown) => v is Record<string, unknown>;

/** A schema and the alternatives and parts it is made of. */
function variants(s: JsonSchema): JsonSchema[] {
  const parts = ['anyOf', 'oneOf', 'allOf'].flatMap((k) =>
    Array.isArray(s[k]) ? (s[k] as unknown[]).filter(isObj) : [],
  );
  return [s, ...parts.flatMap(variants)];
}

const hasType = (s: JsonSchema, t: string) =>
  s.type === t || (Array.isArray(s.type) && s.type.includes(t));
/** A schema that says nothing about the value's shape: anything goes. */
const isOpen = (s: JsonSchema) =>
  s.type === undefined &&
  !isObj(s.properties) &&
  s.items === undefined &&
  !['anyOf', 'oneOf', 'allOf'].some((k) => Array.isArray(s[k]));

function schemaAt(root: JsonSchema, segments: Segment[]): Found {
  let current: JsonSchema[] = [root];
  let where = '';
  for (const seg of segments) {
    const found: JsonSchema[] = [];
    let open = false;
    let objectLike = false;
    for (const s of current.flatMap(variants)) {
      if (isObj(s.properties)) {
        objectLike = true;
        const p = (s.properties as Record<string, unknown>)[seg.name];
        if (Object.hasOwn(s.properties, seg.name) && isObj(p)) found.push(p);
        else if (s.additionalProperties !== undefined && s.additionalProperties !== false)
          open = true;
      } else if (hasType(s, 'object')) {
        objectLike = true;
        if (s.additionalProperties !== false) open = true;
      } else if (isOpen(s)) open = true;
    }
    if (found.length === 0) {
      if (open) return UNKNOWN;
      return {
        kind: 'problem',
        message: !objectLike
          ? `${where} is not an object`
          : where
            ? `there is no field "${seg.name}" in ${where}`
            : `there is no argument "${seg.name}"`,
      };
    }
    where = where ? `${where}.${seg.name}` : seg.name;
    current = found;
    for (let i = 0; i < seg.lists; i++) {
      const items: JsonSchema[] = [];
      let anything = false;
      for (const s of current.flatMap(variants)) {
        if (isObj(s.items)) items.push(s.items);
        else if (hasType(s, 'array') || isOpen(s)) anything = true;
      }
      if (items.length === 0) {
        if (anything) return UNKNOWN;
        return { kind: 'problem', message: `${where} is not a list` };
      }
      where = `${where}[]`;
      current = items;
    }
  }
  return { kind: 'found', schemas: current };
}

/** The JSON types a value at this schema can have, or undefined when the schema does not say. */
function kindsOf(schemas: JsonSchema[]): Set<string> | undefined {
  const out = new Set<string>();
  for (const s of schemas.flatMap(variants)) {
    if (typeof s.type === 'string') out.add(s.type);
    else if (Array.isArray(s.type)) for (const t of s.type) out.add(String(t));
    else if (isObj(s.properties)) out.add('object');
    else if (s.items !== undefined) out.add('array');
    else if (isOpen(s)) return undefined;
  }
  out.delete('null');
  return out.size > 0 ? out : undefined;
}

function typeWarnings(rule: ArgumentRule, kinds: Set<string>): string[] {
  const has = (...ts: string[]) => ts.some((t) => kinds.has(t));
  const is = [...kinds].join(' or ');
  const out: string[] = [];
  if ((rule.min !== undefined || rule.max !== undefined) && !has('number', 'integer', 'string'))
    out.push(`min and max compare numbers, but the field is ${is}`);
  if (rule.pattern !== undefined && !has('string', 'number', 'integer'))
    out.push(`pattern checks text, but the field is ${is}`);
  if ((rule.minLength !== undefined || rule.maxLength !== undefined) && !has('string', 'array'))
    out.push(`minLength and maxLength count characters or items, but the field is ${is}`);
  const couldMatch = (v: Scalar) => {
    if (v === null) return true;
    if (typeof v === 'number')
      return has('number', 'string') || (has('integer') && Number.isInteger(v));
    if (typeof v === 'boolean') return has('boolean', 'string');
    return (
      has('string') ||
      (has('number', 'integer') && String(Number(v)) === v) ||
      (has('boolean') && (v === 'true' || v === 'false'))
    );
  };
  const listed: Array<[string, Scalar[]]> = [
    ['in', rule.in ?? []],
    ['notIn', rule.notIn ?? []],
    ['equals', rule.equals !== undefined ? [rule.equals] : []],
  ];
  for (const [op, values] of listed) {
    const never = values.filter((v) => !couldMatch(v));
    if (never.length > 0)
      out.push(
        `${op} lists ${never.map(show).join(', ')}, which can never match: the field is ${is}`,
      );
  }
  return out;
}
