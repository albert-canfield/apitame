/**
 * `apitame diff`: what a new version of an OpenAPI spec changes for the agent, under one config.
 *
 * Both versions are built into a runtime with the same config, exactly as `serve` and `inspect`
 * would build them, and compared: operations, access levels, what the allowlist lets through,
 * config references that stopped matching, the arguments of allowed writes and the token cost of
 * the tool list. It only reads the two specs: nothing is sent to the API.
 */
import type { Config, PermissionConfig } from '../config/schema.js';
import { Logger } from '../log.js';
import { decide, matchesAny } from '../safety/policy.js';
import { Redactor } from '../safety/redact.js';
import { OpenApiRuntime } from '../server/openapi-runtime.js';
import { resolveBaseUrl, type LoadedSpec } from '../sources/openapi/load.js';
import type { Operation } from '../sources/openapi/operations.js';
import { toolListCost } from '../tokens/estimate.js';
import type { Access, JsonSchema } from '../types.js';

/** An operation as the agent meets it under the config. */
export interface OperationRef {
  id: string;
  method: string;
  path: string;
  access: Access;
  /** The tools that reach it: its groups, or call_operation. Empty when the agent cannot call it. */
  tools: string[];
  /** An allowed write that asks a human before it runs. */
  confirm: boolean;
  /** Why the agent cannot call it. */
  blocked?: string;
}

/**
 * The same operation under another name. `id`: a new id for the same method and path (path
 * parameter names aside). `endpoint`: the same id on another method or path.
 */
export interface Rename {
  kind: 'id' | 'endpoint';
  before: OperationRef;
  after: OperationRef;
}

export interface AccessChange {
  before: OperationRef;
  after: OperationRef;
  /** Riskier now: read to write or destructive, or write to destructive. */
  escalation: boolean;
}

/**
 * A write the agent can call now that no one named in the config: allowed by a `writes.allow`
 * pattern, or a POST, PUT, PATCH or DELETE that runs as a read through a `writes.treatAsRead`
 * pattern or `x-apitame-access: read` in the spec.
 */
export interface NewWrite extends OperationRef {
  /** What lets it through. */
  via: 'writes.allow' | 'writes.treatAsRead' | 'x-apitame-access';
  /** The patterns that match it (none for `x-apitame-access`). */
  allowedBy: string[];
  /**
   * `added`: not in the old spec. `renamed`: a new id for an old endpoint, so nothing in the config
   * that named the old id (rules, confirm, groups) applies to it. `changed`: the same id was a read,
   * or could not be called, before.
   */
  why: 'added' | 'renamed' | 'changed';
  /** The operation in the old spec, for `renamed` and `changed`. */
  before?: OperationRef;
}

/** A name or pattern in the config that matched an operation before and matches none now. */
export interface StaleReference {
  /** Where it is: `writes.allow`, `writes.rules`, `tools.<name>`, `http.oauth.permissions.<entry>.writes`, ... */
  where: string;
  ref: string;
  /** The operations it matched in the old spec. */
  matched: string[];
  /** The new ids of those operations, when they were renamed. */
  renamedTo: string[];
}

/** An argument of a write: a path as `writes.rules` writes it (`body.items[].price`). */
export interface ArgumentRef {
  path: string;
  required: boolean;
}

/** Changes to the arguments of a write the agent can call, in both versions under the same id. */
export interface WriteChange extends OperationRef {
  added: ArgumentRef[];
  /** Arguments that were optional and are required now. */
  nowRequired: string[];
  removed: string[];
  /** Rules in `writes.rules` for this operation that no longer fit its arguments. */
  rules: string[];
}

export interface ToolTokens {
  name: string;
  /** Null when the tool is not in that version's tool list. */
  before: number | null;
  after: number | null;
}

export interface SpecDiff {
  operations: { before: number; after: number };
  added: OperationRef[];
  removed: OperationRef[];
  renamed: Rename[];
  accessChanges: AccessChange[];
  newWrites: NewWrite[];
  staleConfig: StaleReference[];
  writeChanges: WriteChange[];
  /** Where requests go, when the spec decides it (no `source.baseUrl`) and it changed. */
  baseUrl: { before: string | null; after: string | null } | null;
  /** The tool list as `inspect` estimates it. `tools` lists only the tools whose cost changed. */
  tokens: { before: number; after: number; tools: ToolTokens[] };
}

/** What `--fail-on` can check, each with the number of findings it counts. */
export const DIFF_CATEGORIES = {
  'new-writes': (d: SpecDiff) => d.newWrites.length,
  'access-changes': (d: SpecDiff) => d.accessChanges.length,
  added: (d: SpecDiff) => d.added.length,
  removed: (d: SpecDiff) => d.removed.length,
  renamed: (d: SpecDiff) => d.renamed.length,
  'stale-config': (d: SpecDiff) => d.staleConfig.length,
  'write-changes': (d: SpecDiff) => d.writeChanges.length,
  'base-url': (d: SpecDiff) => (d.baseUrl ? 1 : 0),
} as const;

export type DiffCategory = keyof typeof DIFF_CATEGORIES | 'any';

export const FAIL_ON_VALUES: DiffCategory[] = [
  ...(Object.keys(DIFF_CATEGORIES) as Array<keyof typeof DIFF_CATEGORIES>),
  'any',
];

/** The number of findings in one category; `any` counts them all. */
export function countFindings(diff: SpecDiff, category: DiffCategory): number {
  if (category === 'any')
    return Object.values(DIFF_CATEGORIES).reduce((sum, count) => sum + count(diff), 0);
  return DIFF_CATEGORIES[category](diff);
}

const CALL = 'call_operation';
const READ_METHODS = new Set(['get', 'head', 'options']);
const RANK: Record<Access, number> = { read: 0, write: 1, destructive: 2 };

/**
 * The config a runtime is built with for comparing: the same tools, allowlist and rules, without
 * what only matters when calls are made (base URL, static headers, rate limits, audit log), so no
 * environment variable is needed and nothing is written.
 */
function forComparing(config: Config): Config {
  if (config.source.type !== 'openapi')
    throw new Error(
      `apitame diff compares OpenAPI specs; this config's source is ${config.source.type}.`,
    );
  const { baseUrl: _baseUrl, ...source } = config.source;
  return {
    ...config,
    source: { ...source, headers: {} },
    limits: { ...config.limits, maxCallsPerMinute: 0, maxWritesPerMinute: 0, perTool: {} },
    audit: { include: config.audit.include },
  };
}

function runtimeFor(config: Config, spec: LoadedSpec, configDir: string): OpenApiRuntime {
  const redactor = new Redactor();
  return new OpenApiRuntime(forComparing(config), spec, {
    configDir,
    // No credentials: they do not change what the agent sees, and diff never calls the API.
    env: {},
    redactor,
    logger: new Logger(redactor, 'silent'),
  });
}

/** One version of the spec under the config. */
class Side {
  readonly ops: Operation[];
  readonly byId: Map<string, Operation>;
  private readonly groups = new Map<string, string[]>();
  private readonly callable = new Set<string>();
  private readonly refs = new Map<string, OperationRef>();

  constructor(
    readonly rt: OpenApiRuntime,
    private readonly config: Config,
  ) {
    this.ops = rt.operations;
    this.byId = rt.byId;
    for (const s of rt.summarizeTools()) {
      if (s.kind === 'group' || s.kind === 'operation')
        for (const id of s.operations)
          this.groups.set(id, [...(this.groups.get(id) ?? []), s.name]);
      else if (s.kind === 'call') for (const id of s.operations) this.callable.add(id);
    }
  }

  ref(op: Operation): OperationRef {
    let ref = this.refs.get(op.id);
    if (ref) return ref;
    const d = decide(op.id, op.access, { mode: this.config.mode, writes: this.config.writes });
    const tools = this.groups.get(op.id) ?? (this.callable.has(op.id) ? [CALL] : []);
    const blocked = op.unsupported
      ? `unsupported: ${op.unsupported}`
      : !d.allowed
        ? this.config.mode === 'read-only'
          ? 'read-only mode'
          : 'not in writes.allow'
        : tools.length === 0
          ? 'in no tool, and longTail is off'
          : undefined;
    ref = {
      id: op.id,
      method: op.method.toUpperCase(),
      path: op.path,
      access: op.access,
      tools: blocked ? [] : tools,
      confirm: !blocked && d.allowed && d.needsConfirmation,
      ...(blocked ? { blocked } : {}),
    };
    this.refs.set(op.id, ref);
    return ref;
  }

  /** A write the agent can call. */
  canWrite(op: Operation): boolean {
    return op.access !== 'read' && !this.ref(op).blocked;
  }

  /** A write, or a POST, PUT, PATCH or DELETE that runs as a read, that the agent can call. */
  canChangeState(op: Operation): boolean {
    return (op.access !== 'read' || !READ_METHODS.has(op.method)) && !this.ref(op).blocked;
  }
}

/** Method and path, with path parameter names left out: `/pets/{id}` and `/pets/{petId}` agree. */
const endpointOf = (op: Operation) => `${op.method} ${op.path.replace(/\{[^}]*\}/g, '{}')}`;

interface Pair {
  before: Operation;
  after: Operation;
  kind: 'same' | 'id' | 'endpoint';
}

/**
 * Match the operations of two versions: by id first, then, among the ids that exist on one side
 * only, by method and path when exactly one operation on each side has them.
 */
function matchOperations(before: Side, after: Side): Pair[] {
  const pairs: Pair[] = [];
  for (const b of before.ops) {
    const a = after.byId.get(b.id);
    if (a)
      pairs.push({
        before: b,
        after: a,
        kind: endpointOf(a) === endpointOf(b) ? 'same' : 'endpoint',
      });
  }
  const byEndpoint = (ops: Operation[]) => {
    const out = new Map<string, Operation[]>();
    for (const op of ops) out.set(endpointOf(op), [...(out.get(endpointOf(op)) ?? []), op]);
    return out;
  };
  const gone = byEndpoint(before.ops.filter((o) => !after.byId.has(o.id)));
  const fresh = byEndpoint(after.ops.filter((o) => !before.byId.has(o.id)));
  for (const [endpoint, olds] of gone) {
    const news = fresh.get(endpoint);
    if (olds.length === 1 && news?.length === 1)
      pairs.push({ before: olds[0]!, after: news[0]!, kind: 'id' });
  }
  return pairs;
}

/** Compare two versions of a spec under one config. Reads both specs; never calls the API. */
export function diffSpecs(
  config: Config,
  beforeSpec: LoadedSpec,
  afterSpec: LoadedSpec,
  configDir = process.cwd(),
): SpecDiff {
  const before = new Side(runtimeFor(config, beforeSpec, configDir), config);
  const after = new Side(runtimeFor(config, afterSpec, configDir), config);
  const pairs = matchOperations(before, after);
  const pairOfBefore = new Map(pairs.map((p) => [p.before.id, p]));
  const pairOfAfter = new Map(pairs.map((p) => [p.after.id, p]));
  const order = new Map(after.ops.map((o, i) => [o.id, i]));
  const changed = pairs
    .filter((p) => p.kind !== 'same')
    .sort((x, y) => order.get(x.after.id)! - order.get(y.after.id)!);

  const renamed: Rename[] = changed.map((p) => ({
    kind: p.kind as Rename['kind'],
    before: before.ref(p.before),
    after: after.ref(p.after),
  }));

  const accessChanges: AccessChange[] = pairs
    .filter((p) => p.before.access !== p.after.access)
    .sort((x, y) => order.get(x.after.id)! - order.get(y.after.id)!)
    .map((p) => ({
      before: before.ref(p.before),
      after: after.ref(p.after),
      escalation: RANK[p.after.access] > RANK[p.before.access],
    }));

  return {
    operations: { before: before.ops.length, after: after.ops.length },
    added: after.ops.filter((o) => !pairOfAfter.has(o.id)).map((o) => after.ref(o)),
    removed: before.ops.filter((o) => !pairOfBefore.has(o.id)).map((o) => before.ref(o)),
    renamed,
    accessChanges,
    newWrites: newWrites(config, before, after, pairOfAfter),
    staleConfig: staleReferences(config, before, after, pairs),
    writeChanges: writeChanges(config, before, after, pairs),
    baseUrl: baseUrlChange(config, beforeSpec, afterSpec),
    tokens: tokenChange(before.rt, after.rt),
  };
}

/**
 * Writes the agent can call in the new version that no one named by exact id in the config, and
 * that it could not call before. A renamed operation counts: the config knows it only under its
 * old id, so its rules, confirmation and group do not follow it.
 */
function newWrites(
  config: Config,
  before: Side,
  after: Side,
  pairOfAfter: Map<string, Pair>,
): NewWrite[] {
  const out: NewWrite[] = [];
  for (const op of after.ops) {
    if (!after.canChangeState(op)) continue;
    const { allow, treatAsRead } = config.writes;
    const asRead = op.access === 'read';
    if ((asRead ? treatAsRead : allow).includes(op.id)) continue;
    const pair = pairOfAfter.get(op.id);
    let why: NewWrite['why'] = 'added';
    if (pair?.kind === 'id') why = 'renamed';
    else if (pair) {
      if (before.canChangeState(pair.before)) continue;
      why = 'changed';
    }
    const patterns = (list: string[]) =>
      list.filter((p) => p.includes('*') && matchesAny(op.id, [p]));
    const via: NewWrite['via'] = !asRead
      ? 'writes.allow'
      : matchesAny(op.id, treatAsRead)
        ? 'writes.treatAsRead'
        : 'x-apitame-access';
    out.push({
      ...after.ref(op),
      via,
      allowedBy: via === 'x-apitame-access' ? [] : patterns(asRead ? treatAsRead : allow),
      why,
      ...(pair ? { before: before.ref(pair.before) } : {}),
    });
  }
  return out;
}

/** Every place in the config that names operations, with the names or patterns it uses. */
function references(config: Config): Array<{ where: string; refs: string[]; exact: boolean }> {
  const out = [
    { where: 'writes.allow', refs: config.writes.allow, exact: false },
    { where: 'writes.confirm', refs: config.writes.confirm, exact: false },
    { where: 'writes.treatAsRead', refs: config.writes.treatAsRead, exact: false },
    { where: 'writes.destructive', refs: config.writes.destructive, exact: false },
    { where: 'writes.rules', refs: Object.keys(config.writes.rules), exact: true },
    ...config.tools.map((g) => ({ where: `tools.${g.name}`, refs: g.operations, exact: true })),
  ];
  const permissions = config.http.oauth?.permissions;
  if (permissions) {
    const entries: Array<[string, PermissionConfig]> = [
      ...Object.entries(permissions.default ? { default: permissions.default } : {}),
      ...Object.entries(permissions.byScope).map(([k, v]): [string, PermissionConfig] => [
        `byScope.${k}`,
        v,
      ]),
      ...Object.entries(permissions.byClient).map(([k, v]): [string, PermissionConfig] => [
        `byClient.${k}`,
        v,
      ]),
    ];
    for (const [label, entry] of entries)
      if (entry.writes)
        out.push({
          where: `http.oauth.permissions.${label}.writes`,
          refs: entry.writes,
          exact: false,
        });
  }
  return out;
}

/** Names and patterns that matched an operation in the old spec and match none in the new one. */
function staleReferences(
  config: Config,
  before: Side,
  after: Side,
  pairs: Pair[],
): StaleReference[] {
  const renamedTo = new Map(
    pairs.filter((p) => p.kind === 'id').map((p) => [p.before.id, p.after.id]),
  );
  const out: StaleReference[] = [];
  for (const { where, refs, exact } of references(config)) {
    const matches = (id: string, ref: string) => (exact ? id === ref : matchesAny(id, [ref]));
    for (const ref of new Set(refs)) {
      const matched = before.ops.filter((o) => matches(o.id, ref)).map((o) => o.id);
      if (matched.length === 0 || after.ops.some((o) => matches(o.id, ref))) continue;
      out.push({
        where,
        ref,
        matched,
        renamedTo: matched.flatMap((id) => (renamedTo.has(id) ? [renamedTo.get(id)!] : [])),
      });
    }
  }
  return out;
}

/** Changes to the arguments of writes the agent can call in the new version, under the same id. */
function writeChanges(config: Config, before: Side, after: Side, pairs: Pair[]): WriteChange[] {
  const oldWarnings = new Set(before.rt.rules.warnings);
  const newWarnings = after.rt.rules.warnings.filter((w) => !oldWarnings.has(w));
  const out: WriteChange[] = [];
  for (const pair of pairs) {
    if (pair.kind === 'id' || !after.canWrite(pair.after)) continue;
    const id = pair.after.id;
    const old = argumentsOf(pair.before.inputSchema);
    const now = argumentsOf(pair.after.inputSchema);
    const added = outermost([...now.keys()].filter((p) => !old.has(p)));
    const removed = outermost([...old.keys()].filter((p) => !now.has(p)));
    const nowRequired = [...now].filter(([p, req]) => req && old.get(p) === false).map(([p]) => p);

    const rules: string[] = [];
    const paths = Object.hasOwn(config.writes.rules, id)
      ? Object.keys(config.writes.rules[id]!)
      : [];
    for (const path of paths) {
      const prefix = `writes.rules.${id}.${path}: `;
      const warning = newWarnings.find((w) => w.startsWith(prefix));
      const gone = removed.find(
        (r) => path === r || path.startsWith(`${r}.`) || path.startsWith(`${r}[`),
      );
      if (warning) rules.push(warning);
      else if (gone) rules.push(`${prefix}the new spec removes ${gone}.`);
    }

    if (added.length + removed.length + nowRequired.length + rules.length === 0) continue;
    out.push({
      ...after.ref(pair.after),
      added: added.map((path) => ({ path, required: now.get(path) === true })),
      nowRequired,
      removed,
      rules,
    });
  }
  return out;
}

const isObj = (v: unknown): v is JsonSchema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Limits for walking a tool input schema. Compact schemas are acyclic and shallow already. */
const MAX_ARGUMENT_DEPTH = 10;
const MAX_ARGUMENTS = 2_000;

/**
 * The schema and the parts it is made of. Parts of `anyOf` (and `oneOf`) are alternatives: a
 * field they require is only required in that alternative, so it does not count as required.
 */
function parts(
  s: JsonSchema,
  alternative = false,
): Array<{ schema: JsonSchema; alternative: boolean }> {
  const out = [{ schema: s, alternative }];
  for (const p of Array.isArray(s.allOf) ? s.allOf : [])
    if (isObj(p)) out.push(...parts(p, alternative));
  for (const key of ['anyOf', 'oneOf'])
    for (const p of Array.isArray(s[key]) ? (s[key] as unknown[]) : [])
      if (isObj(p)) out.push(...parts(p, true));
  return out;
}

/**
 * Every argument of a tool input schema, by the path `writes.rules` uses for it (`amount`,
 * `body.state`, `body.items[].price`), and whether it is required where it appears.
 */
export function argumentsOf(schema: JsonSchema): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const visit = (s: JsonSchema, at: string, depth: number) => {
    if (depth > MAX_ARGUMENT_DEPTH) return;
    for (const { schema: part, alternative } of parts(s)) {
      if (isObj(part.properties)) {
        const required = new Set(
          !alternative && Array.isArray(part.required) ? (part.required as unknown[]) : [],
        );
        for (const [name, sub] of Object.entries(part.properties)) {
          if (out.size >= MAX_ARGUMENTS) return;
          const path = at ? `${at}.${name}` : name;
          out.set(path, out.get(path) === true || required.has(name));
          if (isObj(sub)) visit(sub, path, depth + 1);
        }
      }
      if (isObj(part.items)) visit(part.items, `${at}[]`, depth + 1);
    }
  };
  visit(schema, '', 0);
  return out;
}

/** Leave out paths inside another path of the list: `body` covers `body.name`. */
function outermost(paths: string[]): string[] {
  return paths.filter(
    (p) => !paths.some((q) => q !== p && (p.startsWith(`${q}.`) || p.startsWith(`${q}[`))),
  );
}

function baseUrlChange(config: Config, before: LoadedSpec, after: LoadedSpec): SpecDiff['baseUrl'] {
  // source.baseUrl overrides the servers in the spec, so a new server changes nothing.
  if (config.source.type !== 'openapi' || config.source.baseUrl) return null;
  const was = resolveBaseUrl(before.doc, before.location) ?? null;
  const now = resolveBaseUrl(after.doc, after.location) ?? null;
  return was === now ? null : { before: was, after: now };
}

function tokenChange(before: OpenApiRuntime, after: OpenApiRuntime): SpecDiff['tokens'] {
  const was = toolListCost(before.listTools(), before.instructions());
  const now = toolListCost(after.listTools(), after.instructions());
  const wasByName = new Map(was.tools.map((t) => [t.name, t.tokens]));
  const nowByName = new Map(now.tools.map((t) => [t.name, t.tokens]));
  const names = [...new Set([...now.tools.map((t) => t.name), ...was.tools.map((t) => t.name)])];
  return {
    before: was.total,
    after: now.total,
    tools: names
      .map((name) => ({
        name,
        before: wasByName.get(name) ?? null,
        after: nowByName.get(name) ?? null,
      }))
      .filter((t) => t.before !== t.after),
  };
}
