import { stringify as toYaml } from 'yaml';
import { sampleFromSchema } from '../mock/sample.js';
import type { OpenApiRuntime } from '../server/openapi-runtime.js';
import type { TableDetail, TableInfo } from '../sources/sql/driver.js';
import { operationTitle, signature, type Operation } from '../sources/openapi/operations.js';
import { truncate, typeLabel } from '../sources/openapi/schema.js';
import type { JsonSchema } from '../types.js';

export interface GeneratedFile {
  /** Path relative to the skills directory. */
  path: string;
  content: string;
}

/** Skill names: lowercase letters, digits and single hyphens, max 64 chars (Agent Skills spec). */
export function skillName(base: string, suffix: string): string {
  const name = `${base}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return name || 'api-skill';
}

/**
 * Text that comes from a database or a spec, made inert for a markdown file an agent will
 * read as instructions: one line, no leading heading, list or quote marker, no table breaks.
 */
function inline(text: string, max = 300): string {
  return truncate(text, max)
    .replace(/^([#>*+-]|\d+[.)])/, '\\$1')
    .replace(/\|/g, '\\|');
}

/** A plain SQL identifier, safe to print unquoted in an example query. */
const plainIdentifier = (s: string | null) => s === null || /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);

function frontmatter(name: string, description: string): string {
  return `---\n${toYaml({ name, description: truncate(description, 1000) }, { lineWidth: 0 }).trimEnd()}\n---\n`;
}

const json = (v: unknown) => JSON.stringify(v);

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

interface ToolRef {
  tool: string;
  kind: 'group' | 'operation' | 'call';
}

interface Workflow {
  title: string;
  steps: string[];
}

function sampleArgs(
  op: Operation,
  includeOptional: (name: string) => boolean = () => false,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of op.params) {
    if (p.required || includeOptional(p.name))
      args[p.key] = sampleFromSchema(p.rawSchema ?? p.schema, p.name);
  }
  if (op.body && op.body.required)
    args.body = sampleFromSchema(op.body.rawSchema ?? op.body.schema, 'body');
  return args;
}

function callExample(
  op: Operation,
  ref: ToolRef,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  if (ref.kind === 'group')
    return `\`${ref.tool}\` with \`${json({ operation: op.id, params: args, ...extra })}\``;
  if (ref.kind === 'operation') return `\`${ref.tool}\` with \`${json({ ...args, ...extra })}\``;
  return `\`call_operation\` with \`${json({ operationId: op.id, params: args, ...extra })}\``;
}

const PAGINATION =
  /^(page|per_page|perPage|page_size|pageSize|limit|offset|cursor|after|before|next|page_token|pageToken|starting_after)$/;
const FILTER = /^(q|query|search|filter|status|state|name|tags?|type|sort|since|from|to|labels?)$/i;
/** Filters worth showing in a first example call. */
const KEY_FILTER = /^(q|query|search|status|state)$/i;

/** True when the operation's success response is a list (or wraps one, like {items: [...]}). */
function returnsCollection(op: Operation): boolean {
  const schema = op.response?.schema;
  if (!schema) return /^(list|find|search)/i.test(op.id);
  if (schema.type === 'array') return true;
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  return Object.values(props).some((p) => p.type === 'array');
}

/** Find common multi-step workflows from the shape of the API. Deterministic. */
function inferWorkflows(rt: OpenApiRuntime, refOf: Map<string, ToolRef>): Workflow[] {
  // Examples follow the argument rules, so the skill never shows a call the server refuses.
  const exampleArgs = (op: Operation, includeOptional?: (name: string) => boolean) =>
    rt.rules.example(op.id, sampleArgs(op, includeOptional));
  const exposed = rt.operations.filter((o) => refOf.has(o.id));
  const reads = exposed.filter((o) => o.access === 'read' && o.method === 'get');
  const workflows: Workflow[] = [];
  const used = new Set<string>();

  // 1. List or search a collection, then open one item.
  const openedItems = new Set<string>();
  for (const list of reads) {
    if (workflows.length >= 2) break;
    if (!returnsCollection(list) || list.path.endsWith('}')) continue;
    const parent = list.path.split('/').slice(0, -1).join('/');
    const isItemOf = (base: string, o: Operation) =>
      o.path.startsWith(`${base}/`) && /^\{[^}]+\}$/.test(o.path.slice(base.length + 1));
    const item =
      reads.find((o) => o.id !== list.id && isItemOf(list.path, o)) ??
      (parent ? reads.find((o) => o.id !== list.id && isItemOf(parent, o)) : undefined);
    if (!item || openedItems.has(item.id)) continue;
    const firstFilter = list.params.find(
      (p) => !p.required && p.in === 'query' && KEY_FILTER.test(p.name),
    );
    const listArgs = exampleArgs(list, (n) => n === firstFilter?.name);
    const listKeys = new Set(list.params.map((p) => p.name));
    const idParam = [...item.params]
      .reverse()
      .find((p) => p.in === 'path' && !listKeys.has(p.name));
    workflows.push({
      title: `${operationTitle(list).replace(/\.$/, '')}, then open one`,
      steps: [
        `Call ${callExample(list, refOf.get(list.id)!, listArgs)}.`,
        `Take the identifier${idParam ? ` (\`${idParam.key}\`)` : ''} of the item the user means from the result, then call ${callExample(item, refOf.get(item.id)!, exampleArgs(item))}.`,
        'Summarize the fields the user asked about instead of pasting the raw JSON.',
      ],
    });
    openedItems.add(item.id);
    used.add(list.id);
  }

  // 2. Filtered search on an operation with filter parameters.
  const search =
    reads.find(
      (o) =>
        !used.has(o.id) &&
        o.params.some((p) => p.in === 'query' && /^(q|query|search|term)$/i.test(p.name)),
    ) ??
    reads.find(
      (o) => !used.has(o.id) && o.params.some((p) => p.in === 'query' && FILTER.test(p.name)),
    );
  if (search && workflows.length < 5) {
    const filterParams = search.params
      .filter((p) => p.in === 'query' && FILTER.test(p.name))
      .map((p) => p.key);
    const qParam = search.params.find((p) => /^(q|query|search|term)$/i.test(p.name));
    const hintSource = [qParam?.description, search.description].find(
      (d) => d && /for example|e\.g\./i.test(d),
    );
    const hint = hintSource ? ` ${truncate(hintSource, 160)}` : '';
    workflows.push({
      title: `${operationTitle(search).replace(/\.$/, '')}${qParam ? '' : ' with filters'}`,
      steps: [
        `Call ${callExample(search, refOf.get(search.id)!, exampleArgs(search))}.${hint}`,
        `Useful parameters: ${filterParams.map((f) => `\`${f}\``).join(', ')}. Ask the user for missing values instead of guessing.`,
      ],
    });
    used.add(search.id);
  }

  // 3. Pagination.
  const paged = reads.find((o) => o.params.filter((p) => PAGINATION.test(p.name)).length > 0);
  if (paged && workflows.length < 5) {
    const params = paged.params.filter((p) => PAGINATION.test(p.name)).map((p) => `\`${p.key}\``);
    workflows.push({
      title: 'Page through long lists',
      steps: [
        `List operations such as \`${paged.id}\` accept ${params.join(', ')}. Start small, and only fetch the next page if the user needs more.`,
        'Large responses are cut to fit the response limit; a "note" field says when that happened.',
      ],
    });
  }

  // 4. Writes, when enabled.
  const create = exposed.find((o) => o.access === 'write' && o.method === 'post');
  if (create && workflows.length < 6) {
    const args = exampleArgs(create);
    const ref = refOf.get(create.id)!;
    workflows.push({
      title: `${operationTitle(create).replace(/\.$/, '')} safely`,
      steps: [
        `Preview first: ${callExample(create, ref, args, { dryRun: true })}. Show the user the request that would be sent.`,
        `If they agree, call again without \`dryRun\`.`,
        'Read the item back with the matching read operation to confirm the change.',
      ],
    });
  }
  const destructive = exposed.find((o) => o.access === 'destructive');
  if (destructive && workflows.length < 6) {
    const args = exampleArgs(destructive);
    const ref = refOf.get(destructive.id)!;
    workflows.push({
      title: `${operationTitle(destructive).replace(/\.$/, '')} (needs confirmation)`,
      steps: [
        `Call ${callExample(destructive, ref, args)}. Nothing happens yet: the server asks the user to approve, or returns a preview with a \`confirm\` token.`,
        'If you get a token, show the preview to the user and wait for an explicit yes.',
        `Only then call again with the same arguments plus \`"confirm": "<token>"\`. Never invent or reuse tokens.`,
      ],
    });
  }

  // 5. Long tail.
  const tail = rt.operations.find(
    (o) => o.access === 'read' && !o.unsupported && refOf.get(o.id)?.kind === 'call',
  );
  if (tail && rt.config.longTail.enabled && workflows.length < 6) {
    const words = operationTitle(tail)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(' ')
      .slice(0, 4)
      .join(' ');
    workflows.push({
      title: 'Find an operation that has no dedicated tool',
      steps: [
        `Call \`search_operations\` with \`${json({ query: words })}\`.`,
        `Pick the matching \`operationId\`, check its \`status\` is "available", then call \`call_operation\` with \`${json({ operationId: tail.id, params: exampleArgs(tail) })}\`.`,
      ],
    });
  }
  return workflows;
}

/** SKILL.md plus a reference file for an OpenAPI source. */
export function generateOpenApiSkill(rt: OpenApiRuntime): GeneratedFile[] {
  const name = skillName(rt.name, 'api');
  const title = rt.spec.doc.info?.title ?? rt.name;
  const summaries = rt.summarizeTools();
  const tools = rt.listTools();

  const refOf = new Map<string, ToolRef>();
  for (const s of summaries) {
    if (s.kind === 'group' || s.kind === 'operation')
      for (const id of s.operations) refOf.set(id, { tool: s.name, kind: s.kind });
  }
  const call = summaries.find((s) => s.kind === 'call');
  if (call)
    for (const id of call.operations)
      if (!refOf.has(id)) refOf.set(id, { tool: 'call_operation', kind: 'call' });

  const blocked = rt.operations.filter((o) => o.access !== 'read' && !refOf.has(o.id));
  const topics = summaries
    .filter((s) => s.kind === 'group' || s.kind === 'operation')
    .map((s) => s.name.replace(/_/g, ' '));
  const description =
    `Use the ${title} through the "${rt.name}" MCP server (generated by apitame). ` +
    `Use for requests that involve ${listWords(topics.slice(0, 6)) || 'this API'} data${rt.mode === 'read-only' ? ' (read-only access)' : ''}. ` +
    'Covers which tool to call, argument shapes, common multi-step workflows and the safety rules for writes.';

  const intro = rt.spec.doc.info?.description
    ? truncate(rt.spec.doc.info.description.split(/\n\s*\n/)[0] ?? '', 400)
    : '';
  const lines: string[] = [frontmatter(name, description), `# ${title}`, ''];
  if (intro) lines.push(intro, '');
  lines.push(
    `These tools come from the \`${rt.name}\` MCP server, generated by apitame from the OpenAPI spec.`,
    rt.mode === 'read-only'
      ? `The server runs in **read-only mode**${blocked.length > 0 ? `: ${blocked.length} write operation${blocked.length === 1 ? ' is' : 's are'} blocked` : ''}.`
      : 'The server runs in **read-write mode** with an allowlist: only listed writes run, destructive ones need the user to approve.',
    '',
    '## Tools',
    '',
    '| Tool | Use it to | Operations |',
    '| --- | --- | --- |',
  );
  for (const s of summaries) {
    const def = tools.find((t) => t.name === s.name);
    const purpose =
      s.kind === 'search'
        ? `Find any of the ${rt.operations.length} operations by keyword`
        : s.kind === 'call'
          ? 'Call an operation that has no dedicated tool'
          : truncate((def?.description ?? '').split('\n')[0] ?? '', 90).replace(/\|/g, '\\|');
    const ops =
      s.kind === 'group' || s.kind === 'operation'
        ? s.operations.map((o) => `\`${o}\``).join(', ')
        : s.kind === 'search'
          ? 'all'
          : 'any available';
    lines.push(`| \`${s.name}\` | ${purpose} | ${ops} |`);
  }
  lines.push(
    '',
    'Grouped tools take `{"operation": "<operation id>", "params": {...}}`. Results are JSON: `{"status": <http status>, "data": <body>}`.',
    '',
    'Add `"fields"` with dot paths to keep only what you need, for example `"fields": ["id", "name", "items.owner.login"]`. Arrays are handled for you, so `items.name` keeps `name` in every item. It saves a lot of context on large responses.',
    ...(rt.config.limits.maxPages > 1 && rt.operations.some((o) => o.paging && refOf.has(o.id))
      ? [
          '',
          `List operations that page take \`"pages"\` (up to ${rt.config.limits.maxPages}) to read the following pages in one call, with the items merged. \`pagination\` in the result says how many pages were read and whether more exist, and \`next\` holds the arguments that continue: pass them with the same arguments as before instead of building a cursor or page number yourself.`,
        ]
      : []),
    ...(rt.operations.some(
      (o) => refOf.has(o.id) && (o.body?.kind === 'multipart' || o.body?.kind === 'binary'),
    )
      ? [
          '',
          'Files are passed inline as `{"filename": "photo.png", "contentType": "image/png", "base64": "..."}` (or `"text"` instead of `"base64"` for text files). Local file paths are not accepted.',
        ]
      : []),
    '',
    '## Workflows',
    '',
  );
  const workflows = inferWorkflows(rt, refOf);
  if (workflows.length === 0)
    lines.push(
      'Call the tool whose description matches the request. Check `status` in every result.',
      '',
    );
  for (const w of workflows) {
    lines.push(`### ${w.title}`, '');
    w.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }

  lines.push('## Safety rules', '');
  if (rt.mode === 'read-only') {
    lines.push(
      '- Write operations are blocked by the server. Do not look for workarounds. If the user needs one, name the operation and tell them it must be enabled in `apitame.config.yaml` (`mode: read-write` and `writes.allow`).',
    );
  } else {
    lines.push(
      '- Only allowlisted writes run. Preview every write with `"dryRun": true` and show the user the request first.',
      '- Destructive operations need explicit approval from the user. Never send a `confirm` token the user did not approve.',
    );
    const ruled = rt.operations.filter((o) => refOf.has(o.id) && rt.rules.has(o.id));
    if (ruled.length > 0)
      lines.push(
        '- Some writes have argument rules. The server refuses a call that breaks one before anything is sent or anyone is asked. Follow them, and if the user asks for something they forbid, say so instead of looking for a way around them:',
        ...ruled.map((o) => `  - \`${o.id}\`: ${rt.rules.describe(o.id, true)}`),
      );
  }
  lines.push(
    `- Responses over ${Math.round(rt.config.limits.maxResponseBytes / 1000)} KB are cut. Use filters, pagination and \`fields\` rather than fetching everything.`,
    '- Never ask the user for API keys or tokens: the server already holds them, and they are never shown to you.',
    '- A non-2xx `status` is an API error: read `data` for the reason before retrying.',
    '',
    '## Reference',
    '',
    'Every operation with its parameters: [references/operations.md](references/operations.md).',
    '',
  );

  return [
    { path: `${name}/SKILL.md`, content: lines.join('\n') },
    { path: `${name}/references/operations.md`, content: operationsReference(rt, refOf) },
  ];
}

function paramTable(op: Operation): string[] {
  const rows: string[] = [];
  if (op.params.length > 0 || op.body) {
    rows.push(
      '| Parameter | In | Type | Required | Description |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const p of op.params) {
      rows.push(
        `| \`${p.key}\` | ${p.in} | ${typeLabel(p.schema).replace(/\|/g, '\\|')} | ${p.required ? 'yes' : 'no'} | ${truncate(p.description, 120).replace(/\|/g, '\\|')} |`,
      );
    }
    if (op.body) {
      rows.push(
        `| \`body\` | body | ${typeLabel(op.body.schema as JsonSchema).replace(/\|/g, '\\|')} | ${op.body.required ? 'yes' : 'no'} | ${op.body.contentType} |`,
      );
    }
  } else rows.push('No parameters.');
  return rows;
}

function operationsReference(rt: OpenApiRuntime, refOf: Map<string, ToolRef>): string {
  const lines = [`# ${rt.spec.doc.info?.title ?? rt.name}: operations`, ''];
  lines.push(`${rt.operations.length} operations. Mode: ${rt.mode}.`, '');
  const byTool = new Map<string, Operation[]>();
  for (const op of rt.operations) {
    const ref = refOf.get(op.id);
    const key = ref ? (ref.kind === 'call' ? 'call_operation' : ref.tool) : '(blocked)';
    byTool.set(key, [...(byTool.get(key) ?? []), op]);
  }
  const order = [...byTool.keys()].sort((a, b) =>
    a === '(blocked)'
      ? 1
      : b === '(blocked)'
        ? -1
        : a === 'call_operation'
          ? 1
          : b === 'call_operation'
            ? -1
            : a.localeCompare(b),
  );
  for (const key of order) {
    const heading =
      key === '(blocked)'
        ? 'Blocked in the current mode'
        : key === 'call_operation'
          ? 'Reachable through call_operation'
          : `Tool \`${key}\``;
    lines.push(`## ${heading}`, '');
    for (const op of byTool.get(key)!) {
      lines.push(
        `### ${op.id}`,
        '',
        `\`${op.method.toUpperCase()} ${op.path}\`${op.access === 'read' ? '' : ` (${op.access})`}${op.deprecated ? ' (deprecated)' : ''}`,
        '',
      );
      if (op.summary || op.description) lines.push(inline(op.summary || op.description, 300), '');
      lines.push(...paramTable(op), '', `Signature: \`${signature(op)}\``, '');
      const rules = refOf.has(op.id)
        ? rt.rules.list(true).filter((r) => r.operation === op.id)
        : [];
      if (rules.length > 0)
        lines.push(
          'Rules, checked by the server before anything is sent:',
          '',
          ...rules.map((r) => `- \`${r.path}\`: ${r.text}`),
          '',
        );
    }
  }
  return lines.join('\n');
}

/** SKILL.md plus a schema reference for a SQL source. */
export function generateSqlSkill(input: {
  name: string;
  engine: 'postgres' | 'sqlite' | 'mysql' | 'duckdb';
  description?: string;
  tables: TableInfo[];
  details: TableDetail[];
  namedQueries: Array<{ name: string; description: string }>;
  rowLimit: number;
}): GeneratedFile[] {
  const engine = { postgres: 'PostgreSQL', sqlite: 'SQLite', mysql: 'MySQL', duckdb: 'DuckDB' }[
    input.engine
  ];
  const name = skillName(input.name, 'db');
  const home = input.engine === 'postgres' ? 'public' : input.engine === 'duckdb' ? 'main' : null;
  const qualifiedRaw = (t: { schema: string | null; name: string }) =>
    home && t.schema && t.schema !== home ? `${t.schema}.${t.name}` : t.name;
  const qualified = (t: { schema: string | null; name: string }) => inline(qualifiedRaw(t), 200);
  const tableNames = input.tables.map(qualified);
  const description =
    `Query the "${input.name}" ${engine} database through the apitame MCP server (read-only). ` +
    `Tables: ${tableNames.slice(0, 12).join(', ')}${tableNames.length > 12 ? ', and more' : ''}. ` +
    'Use when the user asks questions this data can answer. Covers schema, joins and safe query rules.';

  const lines: string[] = [frontmatter(name, description), `# ${input.name} database`, ''];
  if (input.description) lines.push(input.description, '');
  lines.push(
    `Read-only access to a ${engine} database through the \`${input.name}\` MCP server generated by apitame.`,
    '',
    '## Tools',
    '',
    '| Tool | Use it to |',
    '| --- | --- |',
    input.engine === 'duckdb'
      ? '| `list_tables` | See every table and view with row estimates. |'
      : '| `list_tables` | See every table and view (with row estimates on PostgreSQL). |',
    '| `describe_table` | Get columns, keys and indexes before writing SQL. |',
    `| \`query\` | Run one SELECT. At most ${input.rowLimit} rows come back. |`,
    ...input.namedQueries.map((q) => `| \`${q.name}\` | ${q.description.replace(/\|/g, '\\|')} |`),
    '',
    '## Schema',
    '',
    '| Table | Rows (approx.) | Primary key | Links to |',
    '| --- | --- | --- | --- |',
  );
  for (const d of input.details) {
    const links = d.foreignKeys
      .map((fk) => `${fk.references.table.replace(/^public\./, '')} (${fk.columns.join(', ')})`)
      .join('; ');
    const rows = d.rowEstimate ?? input.tables.find((t) => t.name === d.name)?.rowEstimate;
    lines.push(
      `| \`${qualified(d)}\` | ${rows ?? '?'} | ${d.primaryKey.join(', ') || '-'} | ${links || '-'} |`,
    );
  }
  if (input.details.length < input.tables.length) {
    lines.push(
      '',
      `${input.tables.length - input.details.length} more tables are not described here; use \`list_tables\`.`,
    );
  }

  lines.push('', '## Example queries', '');
  // Example queries only use tables whose names can be printed unquoted.
  const examples = sqlExamples(
    input.details.filter(
      (d) =>
        plainIdentifier(d.schema) &&
        plainIdentifier(d.name) &&
        d.columns.every((c) => plainIdentifier(c.name)),
    ),
    qualifiedRaw,
  );
  for (const ex of examples) lines.push(`### ${ex.title}`, '', '```sql', ex.sql, '```', '');
  if (examples.length === 0)
    lines.push(
      'Start with `list_tables`, then `describe_table`, then a small `SELECT ... LIMIT 10`.',
      '',
    );

  lines.push(
    '## Rules',
    '',
    '- One SELECT per call. INSERT, UPDATE, DELETE, DDL, multiple statements and side-effect functions are refused by the server.',
    `- Always add \`LIMIT\` (and \`ORDER BY\` when order matters). Results are capped at ${input.rowLimit} rows.`,
    '- Call `describe_table` before querying a table you have not seen; do not guess column names.',
    '- Prefer aggregates (`count`, `sum`, `GROUP BY`) over pulling raw rows when the user asks for numbers.',
    ...(input.namedQueries.length > 0
      ? ['- Prefer the named query tools when they fit: they are reviewed and parameterized.']
      : []),
    '- If a valid query is refused because the parser cannot read it, simplify it or ask the user to add it as a named query.',
    ...(input.engine === 'duckdb'
      ? [
          "- DuckDB SQL works: `FROM <table> LIMIT 5`, `GROUP BY ALL`, `QUALIFY`, `SELECT * EXCLUDE (col)`. Reading files (`read_csv`, `FROM 'data.csv'`), the catalog (`duckdb_*`, `information_schema`, `SHOW`, `DESCRIBE`: use `list_tables` and `describe_table`) and table functions other than `range`, `generate_series` and `unnest` are refused.",
        ]
      : []),
    '',
    '## Reference',
    '',
    'All columns per table: [references/schema.md](references/schema.md).',
    '',
  );

  const ref = [`# ${input.name}: schema`, ''];
  for (const d of input.details) {
    ref.push(`## ${qualified(d)}${d.type === 'view' ? ' (view)' : ''}`, '');
    if (d.comment) ref.push(inline(d.comment, 1000), '');
    ref.push('| Column | Type | Null | Notes |', '| --- | --- | --- | --- |');
    for (const c of d.columns) {
      const fk = d.foreignKeys.find((f) => f.columns.includes(c.name));
      const notes = [
        c.primaryKey ? 'PK' : '',
        fk ? inline(`FK -> ${fk.references.table}(${fk.references.columns.join(', ')})`) : '',
        c.comment ? inline(c.comment) : '',
      ]
        .filter(Boolean)
        .join('; ');
      ref.push(
        `| ${inline(c.name, 200)} | ${inline(c.type, 100)} | ${c.nullable ? 'yes' : 'no'} | ${notes} |`,
      );
    }
    ref.push('');
  }

  return [
    {
      path: `${name}/SKILL.md`,
      content: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'),
    },
    { path: `${name}/references/schema.md`, content: ref.join('\n') },
  ];
}

const capitalize = (s: string) => {
  const words = s.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const singular = (s: string) =>
  s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('s') ? s.slice(0, -1) : s;

function sqlExamples(
  details: TableDetail[],
  qualified: (t: { schema: string | null; name: string }) => string,
): Array<{ title: string; sql: string }> {
  const out: Array<{ title: string; sql: string }> = [];
  const byName = new Map(details.map((d) => [d.name, d]));
  const nameCol = (d: TableDetail) =>
    d.columns.find((c) => /^(name|title|email|label|sku|username|full_name)$/i.test(c.name))?.name;
  const label = (d: TableDetail) => nameCol(d) ?? d.primaryKey[0] ?? d.columns[0]?.name ?? '*';
  const timeCol = (d: TableDetail) =>
    d.columns.find(
      (c) =>
        /(created|updated|ordered|placed)_?(at|on|date)?$|^date$|timestamp/i.test(c.name) &&
        /time|date/i.test(c.type),
    )?.name;
  const alias = (name: string) =>
    name
      .split(/[_\s]+/)
      .map((w) => w[0] ?? '')
      .join('') || 't';

  // Rank relationships: joins to a table with a human-readable column, from a table with a timestamp, read best.
  const candidates = details
    .flatMap((d) =>
      d.foreignKeys
        .filter((fk) => fk.columns.length === 1)
        .map((fk) => ({
          d,
          fk,
          target: byName.get(fk.references.table.split('.').pop() ?? fk.references.table),
        }))
        .filter(
          (
            c,
          ): c is { d: TableDetail; fk: TableDetail['foreignKeys'][number]; target: TableDetail } =>
            Boolean(c.target),
        ),
    )
    .map((c) => ({ ...c, score: (nameCol(c.target) ? 2 : 0) + (timeCol(c.d) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);

  for (const { d, fk, target } of candidates.slice(0, 2)) {
    const a = alias(d.name);
    let b = alias(target.name);
    if (b === a) b = `${b}2`;
    const order = timeCol(d);
    const extra = d.columns.find((c) =>
      /^(status|state|total|amount|quantity|price)$/i.test(c.name),
    )?.name;
    out.push({
      title: `${capitalize(d.name)} with their ${singular(target.name).replace(/_/g, ' ')}`,
      sql: [
        `SELECT ${a}.${d.primaryKey[0] ?? fk.columns[0]}, ${b}.${label(target)}${extra ? `, ${a}.${extra}` : ''}${order ? `, ${a}.${order}` : ''}`,
        `FROM ${qualified(d)} ${a}`,
        `JOIN ${qualified(target)} ${b} ON ${b}.${fk.references.columns[0]} = ${a}.${fk.columns[0]}`,
        order ? `ORDER BY ${a}.${order} DESC` : `ORDER BY ${a}.${d.primaryKey[0] ?? fk.columns[0]}`,
        'LIMIT 20;',
      ].join('\n'),
    });
  }
  const top = candidates[0];
  if (top) {
    const a = alias(top.d.name);
    let b = alias(top.target.name);
    if (b === a) b = `${b}2`;
    out.push({
      title: `Count ${top.d.name.replace(/_/g, ' ')} per ${singular(top.target.name).replace(/_/g, ' ')}`,
      sql: [
        `SELECT ${b}.${label(top.target)}, count(*) AS ${top.d.name}_count`,
        `FROM ${qualified(top.d)} ${a}`,
        `JOIN ${qualified(top.target)} ${b} ON ${b}.${top.fk.references.columns[0]} = ${a}.${top.fk.columns[0]}`,
        `GROUP BY ${b}.${label(top.target)}`,
        `ORDER BY ${top.d.name}_count DESC`,
        'LIMIT 10;',
      ].join('\n'),
    });
  }
  const timed = details.find((d) => timeCol(d));
  if (timed) {
    out.push({
      title: `Latest ${timed.name}`,
      sql: `SELECT *\nFROM ${qualified(timed)}\nORDER BY ${timeCol(timed)} DESC\nLIMIT 10;`,
    });
  }
  if (out.length === 0 && details[0])
    out.push({
      title: `Peek at ${details[0].name}`,
      sql: `SELECT *\nFROM ${qualified(details[0])}\nLIMIT 10;`,
    });
  return out;
}
