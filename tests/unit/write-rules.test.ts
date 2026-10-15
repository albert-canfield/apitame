import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { Redactor } from '../../src/safety/redact.js';
import { WriteRules, type RulesConfig, type RuleTarget } from '../../src/safety/rules.js';
import type { JsonSchema } from '../../src/types.js';

/** A tool input schema shaped like the ones built from OpenAPI operations. */
const schema: JsonSchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    amount: { type: 'integer' },
    confirmed: { type: 'boolean' },
    body: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed'] },
        title: { type: 'string' },
        password: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { price: { type: 'number' }, sku: { type: 'string' } },
          },
        },
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
        extra: {},
      },
    },
  },
  required: ['owner'],
  additionalProperties: false,
};

const targets: RuleTarget[] = [
  { id: 'op', access: 'write', schema },
  { id: 'remove', access: 'destructive', schema },
  { id: 'getThing', access: 'read', schema },
];

function rules(config: RulesConfig, redactor = new Redactor()) {
  return new WriteRules(config, targets, redactor);
}

const MISSING =
  'is missing; the rule requires it, mark it optional: true if leaving it out is safe';

/** The concrete paths of the broken rules for one call of `op`. */
function broken(config: RulesConfig['op'], args: Record<string, unknown>): string[] {
  return rules({ op: config })
    .check('op', args)
    .map((v) => `${v.at}: ${v.problem}`);
}

describe('writes.rules operators', () => {
  it('in: the value must be one of the listed values', () => {
    const rule = { owner: { in: ['acme', 'globex'] } };
    expect(broken(rule, { owner: 'acme' })).toEqual([]);
    expect(broken(rule, { owner: 'initech' })).toEqual(['owner: must be one of "acme", "globex"']);
    expect(broken(rule, { owner: 'ACME' })).toHaveLength(1);
    expect(broken(rule, { owner: null })).toHaveLength(1);
    expect(broken(rule, { owner: ['acme'] })).toHaveLength(1);
    expect(broken(rule, { owner: { name: 'acme' } })).toHaveLength(1);
    // A missing value is refused: for a write, leaving a value out often means "everything".
    expect(broken(rule, {})).toEqual([`owner: ${MISSING}`]);
    // Unless the rule says it may be left out; then only a value that is there is checked.
    const optional = { owner: { optional: true as const, in: ['acme'] } };
    expect(broken(optional, {})).toEqual([]);
    expect(broken(optional, { owner: 'acme' })).toEqual([]);
    expect(broken(optional, { owner: 'initech' })).toEqual(['owner: must be "acme"']);
    expect(broken(optional, { owner: null })).toEqual(['owner: must be "acme"']);
  });

  it('in and equals accept a number or boolean in its usual text form, and nothing looser', () => {
    expect(broken({ amount: { in: [5, 10] } }, { amount: '10' })).toEqual([]);
    expect(broken({ amount: { in: [5, 10] } }, { amount: '10.0' })).toHaveLength(1);
    expect(broken({ amount: { in: [5, 10] } }, { amount: ' 10' })).toHaveLength(1);
    expect(broken({ owner: { in: ['42'] } }, { owner: 42 })).toEqual([]);
    expect(broken({ confirmed: { equals: true } }, { confirmed: 'true' })).toEqual([]);
    expect(broken({ confirmed: { equals: true } }, { confirmed: 1 })).toHaveLength(1);
  });

  it('notIn: refuses listed values in any spelling an API might read the same way', () => {
    const rule = { owner: { notIn: ['main', 'release'] } };
    expect(broken(rule, { owner: 'feature' })).toEqual([]);
    expect(broken(rule, { owner: 'main' })).toEqual(['owner: must not be "main" or "release"']);
    for (const owner of ['MAIN', ' Release ', 'main\n'])
      expect(broken(rule, { owner }), owner).toHaveLength(1);
    expect(broken({ amount: { notIn: [42] } }, { amount: '042' })).toHaveLength(1);
    expect(broken({ amount: { notIn: [42] } }, { amount: '4.2e1' })).toHaveLength(1);
    expect(broken({ amount: { notIn: [42] } }, { amount: 43 })).toEqual([]);
    expect(broken({ confirmed: { notIn: [true] } }, { confirmed: 'TRUE' })).toHaveLength(1);
    // Lists, objects and null are refused: they could hide a listed value or mean the default.
    expect(broken(rule, { owner: ['main'] })).toEqual(['owner: must be a single value, not null']);
    expect(broken(rule, { owner: null })).toEqual(['owner: must be a single value, not null']);
    expect(broken({ owner: { optional: true, notIn: ['main'] } }, { owner: null })).toHaveLength(1);
    expect(broken(rule, {})).toEqual([`owner: ${MISSING}`]);
    expect(broken({ owner: { optional: true, notIn: ['main'] } }, {})).toEqual([]);
  });

  it('equals: the value must be exactly this one, null included', () => {
    expect(broken({ owner: { equals: 'acme' } }, { owner: 'acme' })).toEqual([]);
    expect(broken({ owner: { equals: 'acme' } }, { owner: 'other' })).toEqual([
      'owner: must be "acme"',
    ]);
    expect(broken({ body: { equals: null } }, { body: null })).toEqual([]);
    expect(broken({ body: { equals: null } }, { body: {} })).toHaveLength(1);
    expect(broken({ owner: { equals: 'acme' } }, {})).toEqual([`owner: ${MISSING}`]);
    expect(broken({ owner: { optional: true, equals: 'acme' } }, {})).toEqual([]);
  });

  it('pattern: the whole value must match; numbers are checked as text', () => {
    const rule = { owner: { pattern: '^(web|api)$' } };
    expect(broken(rule, { owner: 'web' })).toEqual([]);
    expect(broken(rule, { owner: 'website' })).toEqual(['owner: must match ^(web|api)$']);
    expect(broken({ amount: { pattern: '\\d{1,4}' } }, { amount: 1234 })).toEqual([]);
    expect(broken({ amount: { pattern: '\\d{1,4}' } }, { amount: 12345 })).toHaveLength(1);
    expect(broken(rule, { owner: true })).toEqual(['owner: must be text that matches ^(web|api)$']);
    expect(broken(rule, { owner: null })).toHaveLength(1);
    expect(broken(rule, {})).toEqual([`owner: ${MISSING}`]);
    expect(broken({ owner: { optional: true, pattern: 'web' } }, {})).toEqual([]);
  });

  it('min and max: numbers, and strings that are plainly numbers', () => {
    const rule = { amount: { min: 1, max: 5000 } };
    expect(broken(rule, { amount: 1 })).toEqual([]);
    expect(broken(rule, { amount: 5000 })).toEqual([]);
    expect(broken(rule, { amount: 5001 })).toEqual(['amount: must be between 1 and 5000']);
    expect(broken(rule, { amount: 0 })).toHaveLength(1);
    expect(broken(rule, { amount: -7 })).toHaveLength(1);
    expect(broken(rule, { amount: '12.50' })).toEqual([]);
    expect(broken(rule, { amount: '5000.01' })).toHaveLength(1);
    expect(broken(rule, { amount: '1e3' })).toEqual([]);
    for (const amount of ['0x10', ' 10', '10 ', '', 'ten', true, null, [10], { v: 10 }])
      expect(broken(rule, { amount }), JSON.stringify(amount)).toEqual([
        'amount: must be a number between 1 and 5000',
      ]);
    expect(broken({ amount: { max: 5 } }, { amount: 6 })).toEqual(['amount: must be at most 5']);
    expect(broken({ amount: { min: 5 } }, { amount: 4 })).toEqual(['amount: must be at least 5']);
    // A refund without an amount usually refunds everything: refused.
    expect(broken(rule, {})).toEqual([`amount: ${MISSING}`]);
    expect(broken({ amount: { optional: true, max: 5 } }, {})).toEqual([]);
    expect(broken({ amount: { optional: true, max: 5 } }, { amount: 6 })).toHaveLength(1);
  });

  it('minLength and maxLength: characters of text, items of a list', () => {
    const title = { 'body.title': { minLength: 2, maxLength: 5 } };
    expect(broken(title, { body: { title: 'abcde' } })).toEqual([]);
    expect(broken(title, { body: { title: '😀😀😀😀😀' } })).toEqual([]);
    expect(broken(title, { body: { title: 'abcdef' } })).toEqual([
      'body.title: must have 2 to 5 characters, but has 6',
    ]);
    expect(broken(title, { body: { title: 'a' } })).toHaveLength(1);
    const labels = { 'body.labels': { maxLength: 2 } };
    expect(broken(labels, { body: { labels: ['a', 'b'] } })).toEqual([]);
    expect(broken(labels, { body: { labels: ['a', 'b', 'c'] } })).toEqual([
      'body.labels: must have at most 2 items, but has 3',
    ]);
    expect(broken(title, { body: { title: 12 } })).toEqual([
      'body.title: must be text or a list with 2 to 5 characters',
    ]);
    expect(broken(title, { body: {} })).toEqual([`body.title: ${MISSING}`]);
    // Below a missing object, the value is missing too.
    expect(broken(title, {})).toEqual([`body.title: ${MISSING}`]);
    const optionalTitle = { 'body.title': { optional: true as const, maxLength: 5 } };
    expect(broken(optionalTitle, {})).toEqual([]);
    expect(broken(optionalTitle, { body: { title: 'abcdef' } })).toHaveLength(1);
  });

  it('required: present and not null, along the whole path', () => {
    const rule = { 'body.title': { required: true as const } };
    expect(broken(rule, { body: { title: 'x' } })).toEqual([]);
    expect(broken(rule, { body: { title: '' } })).toEqual([]);
    expect(broken(rule, { body: {} })).toEqual(['body.title: is required']);
    expect(broken(rule, { body: { title: null } })).toEqual(['body.title: is required']);
    expect(broken(rule, {})).toEqual(['body.title: is required']);
    expect(broken(rule, { body: null })).toEqual(['body.title: is required']);
    // Next to value operators it changes nothing but the wording: they need the value anyway.
    const amount = { amount: { required: true as const, max: 5000 } };
    expect(broken(amount, {})).toEqual(['amount: is required']);
    expect(broken(amount, { amount: 6000 })).toEqual(['amount: must be at most 5000']);
    expect(broken(amount, { amount: null })).toEqual(['amount: is required']);
  });

  it('forbidden: the argument must be left out; null counts as set', () => {
    const rule = { 'body.state': { forbidden: true as const } };
    expect(broken(rule, { body: { title: 'x' } })).toEqual([]);
    expect(broken(rule, {})).toEqual([]);
    expect(broken(rule, { body: { state: 'closed' } })).toEqual(['body.state: must not be set']);
    expect(broken(rule, { body: { state: null } })).toEqual(['body.state: must not be set']);
    expect(broken(rule, { body: { state: '' } })).toHaveLength(1);
  });

  it('[] checks every item of a list, with the index in the message', () => {
    const price = { 'body.items[].price': { max: 100 } };
    expect(broken(price, { body: { items: [{ price: 5 }, { price: 100 }] } })).toEqual([]);
    expect(
      broken(price, { body: { items: [{ price: 5 }, { price: 250 }, { price: 900 }] } }),
    ).toEqual([
      'body.items[1].price: must be at most 100',
      'body.items[2].price: must be at most 100',
    ]);
    // An empty list passes: there is no item to break the rule.
    expect(broken(price, { body: { items: [] } })).toEqual([]);
    // A missing list, or an item without the value, is missing for the rule.
    expect(broken(price, { body: {} })).toEqual([`body.items[].price: ${MISSING}`]);
    expect(broken(price, { body: { items: null } })).toEqual([`body.items[].price: ${MISSING}`]);
    expect(broken(price, { body: { items: [{ price: 1 }, { sku: 'x' }] } })).toEqual([
      `body.items[1].price: ${MISSING}`,
    ]);
    const optionalPrice = { 'body.items[].price': { optional: true as const, max: 100 } };
    expect(broken(optionalPrice, { body: {} })).toEqual([]);
    expect(broken(optionalPrice, { body: { items: [{ sku: 'x' }] } })).toEqual([]);
    expect(broken(optionalPrice, { body: { items: [{ price: 500 }] } })).toHaveLength(1);
    const labels = { 'body.labels[]': { in: ['bug', 'docs'] } };
    expect(broken(labels, { body: { labels: ['bug', 'docs'] } })).toEqual([]);
    expect(broken(labels, { body: { labels: ['bug', 'urgent'] } })).toEqual([
      'body.labels[1]: must be one of "bug", "docs"',
    ]);
    const sku = { 'body.items[].sku': { required: true as const } };
    expect(broken(sku, { body: { items: [{ sku: 'a' }, { price: 1 }] } })).toEqual([
      'body.items[1].sku: is required',
    ]);
    expect(broken(sku, { body: {} })).toEqual(['body.items[].sku: is required']);
    expect(broken(sku, { body: { items: null } })).toEqual(['body.items[].sku: is required']);
    const nested = { 'grid[][]': { max: 1 } };
    expect(broken(nested, { grid: [[0, 1], [2]] })).toEqual(['grid[1][0]: must be at most 1']);
  });

  it('refuses a value whose shape does not fit the path, instead of skipping the rule', () => {
    const price = { 'body.items[].price': { max: 100 } };
    expect(broken(price, { body: { items: { price: 900 } } })).toEqual([
      'body.items: must be a list',
    ]);
    expect(broken(price, { body: 'items' })).toEqual(['body: must be an object']);
    expect(broken(price, { body: { items: [5] } })).toEqual(['body.items[0]: must be an object']);
    expect(broken({ 'body.items[].sku': { forbidden: true } }, { body: { items: 'x' } })).toEqual([
      'body.items: must be a list',
    ]);
    // optional lets a value be left out, not sent in the wrong shape.
    expect(
      broken(
        { 'body.items[].price': { optional: true, max: 100 } },
        { body: { items: { price: 900 } } },
      ),
    ).toEqual(['body.items: must be a list']);
  });

  it('applies to destructive operations, and never to reads or operations without rules', () => {
    const r = rules({ remove: { owner: { in: ['acme'] } }, getThing: { owner: { in: ['acme'] } } });
    expect(r.check('remove', { owner: 'x' })).toHaveLength(1);
    expect(r.check('getThing', { owner: 'x' })).toEqual([]);
    expect(r.check('op', { owner: 'x' })).toEqual([]);
    expect(r.has('remove')).toBe(true);
    expect(r.has('getThing')).toBe(false);
  });
});

describe('writes.rules refusals', () => {
  it('names the operation, the path, the rule and the value, and lists every broken rule', () => {
    const r = rules({
      op: { amount: { max: 5000 }, 'body.state': { in: ['open', 'closed'] } },
    });
    const refused = r.enforce('op', { owner: 'acme', amount: 6000, body: { state: 'locked' } });
    expect(refused?.message).toBe(
      [
        'Refused by writes.rules for "op". Nothing was sent.',
        '- amount: must be at most 5000, got 6000 [rule amount max: 5000]',
        '- body.state: must be one of "open", "closed", got "locked" [rule body.state in: ["open","closed"]]',
        'These rules are set in apitame.config.yaml by whoever runs this server. Tell the user what was refused instead of looking for a way around it.',
      ].join('\n'),
    );
    expect(refused?.reason).toBe(
      'writes.rules.op.amount (max: 5000): amount must be at most 5000, got 6000; writes.rules.op.body.state (in: ["open","closed"]): body.state must be one of "open", "closed", got "locked"',
    );
    expect(r.enforce('op', { owner: 'acme', amount: 10, body: { state: 'open' } })).toBeUndefined();
  });

  it('shows no value for a missing argument, and says how to allow leaving it out', () => {
    const r = rules({ op: { amount: { min: 1, max: 5000 }, owner: { required: true } } });
    const refused = r.enforce('op', {});
    expect(refused?.message).toContain(
      '- amount: is missing; the rule requires it, mark it optional: true if leaving it out is safe [rule amount min: 1, max: 5000]',
    );
    expect(refused?.message).toContain('- owner: is required [rule owner required: true]');
    expect(refused?.reason).toBe(
      'writes.rules.op.amount (min: 1, max: 5000): amount is missing; the rule requires it, mark it optional: true if leaving it out is safe; writes.rules.op.owner (required: true): owner is required',
    );
  });

  it('shows values through the redactor, by value and by key', () => {
    const redactor = new Redactor();
    redactor.addSecret('sk_live_0123456789');
    const r = rules(
      { op: { owner: { in: ['acme'] }, 'body.password': { maxLength: 4 } } },
      redactor,
    );
    const refused = r.enforce('op', {
      owner: 'sk_live_0123456789',
      body: { password: 'hunter2-is-long' },
    });
    expect(refused?.message).toContain('owner: must be "acme", got "[REDACTED]"');
    expect(refused?.message).toContain(
      'body.password: must have at most 4 characters, but has 15, got "[REDACTED]"',
    );
    expect(refused?.message).not.toContain('sk_live_0123456789');
    expect(refused?.message).not.toContain('hunter2');
    expect(refused?.reason).not.toContain('sk_live_0123456789');
    expect(refused?.reason).not.toContain('hunter2');
  });

  it('keeps long values and long lists of problems short', () => {
    const r = rules({ op: { 'body.items[].price': { max: 1 } } });
    const items = Array.from({ length: 25 }, () => ({ price: 2 }));
    const message = r.enforce('op', { body: { items } })!.message;
    expect(message.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(11);
    expect(message).toContain('- and 15 more');
    const long = r.enforce('op', { body: { items: [{ price: 2, sku: 'x' }] } });
    expect(long).toBeDefined();
    const title = rules({ op: { owner: { in: ['a'] } } }).enforce('op', { owner: 'x'.repeat(500) });
    expect(title!.message).toContain(`got "${'x'.repeat(76)}...`);
  });
});

describe('writes.rules in skill examples', () => {
  it('adds values the rules need, fixes values they refuse and leaves optional ones out', () => {
    const r = rules({
      op: {
        amount: { max: 5000 },
        owner: { in: ['acme'] },
        'body.state': { optional: true, in: ['open', 'closed'] },
        'body.title': { optional: true, maxLength: 5 },
        'body.password': { forbidden: true },
        'body.items[].price': { max: 1 },
      },
    });
    expect(
      r.example('op', {
        owner: 'octocat',
        amount: 9000,
        body: { password: 'x', items: [{ price: 5 }] },
      }),
    ).toEqual({ owner: 'acme', amount: 5000, body: { items: [{ price: 5 }] } });
    expect(r.example('op', {})).toEqual({ owner: 'acme', amount: 5000 });
    expect(r.example('remove', { owner: 'x' })).toEqual({ owner: 'x' });
  });
});

describe('writes.rules descriptions', () => {
  it('describes rules in plain language, with units from the schema', () => {
    const r = rules({
      op: {
        amount: { required: true, min: 1, max: 5000 },
        owner: { in: ['acme'] },
        'body.state': { optional: true, in: ['open', 'closed'] },
        'body.title': { maxLength: 80 },
        'body.labels': { optional: true, minLength: 1, maxLength: 3 },
        'body.extra': { minLength: 1 },
        'body.password': { forbidden: true },
        'body.items[].sku': { pattern: '^[A-Z]{3}-\\d+$', notIn: ['XXX-0'] },
        confirmed: { equals: true },
        'body.metadata': { required: true },
      },
    });
    expect(r.describe('op')).toBe(
      [
        'amount: required, between 1 and 5000',
        'owner: required, must be "acme"',
        'body.state: if set, one of "open", "closed"',
        'body.title: required, at most 80 characters',
        'body.labels: if set, 1 to 3 items',
        'body.extra: required, at least 1 characters or items',
        'body.password: must not be set',
        'body.items[].sku: required, not "XXX-0", must match ^[A-Z]{3}-\\d+$',
        'confirmed: required, must be true',
        'body.metadata: required',
      ].join('; '),
    );
    expect(r.describe('remove')).toBeUndefined();
    expect(r.list()[0]).toEqual({
      operation: 'op',
      path: 'amount',
      rule: { required: true, min: 1, max: 5000 },
      text: 'required, between 1 and 5000',
    });
  });
});

describe('writes.rules warnings', () => {
  const warnings = (config: RulesConfig) => rules(config).warnings;

  it('reports ids that do not exist and rules on reads, which are never enforced', () => {
    expect(warnings({ createRefnd: { amount: { max: 1 } } })).toEqual([
      'writes.rules.createRefnd: no operation has this id (typo?). Rules take exact ids.',
    ]);
    expect(warnings({ getThing: { owner: { in: ['a'] } } })).toEqual([
      'writes.rules.getThing: "getThing" is a read operation; rules only apply to writes, so these are ignored.',
    ]);
    expect(
      new WriteRules({ q: { id: { max: 1 } } }, [], new Redactor(), 'named query').warnings[0],
    ).toMatch(/no named query has this id/);
  });

  it('reports arguments and fields that do not exist, and paths that do not fit the schema', () => {
    expect(
      warnings({
        op: {
          amout: { max: 1 },
          'body.titel': { maxLength: 1 },
          'body.items[].prise': { max: 1 },
          'body.title[]': { maxLength: 1 },
          'amount.value': { max: 1 },
        },
      }),
    ).toEqual([
      'writes.rules.op.amout: there is no argument "amout"',
      'writes.rules.op.body.titel: there is no field "titel" in body',
      'writes.rules.op.body.items[].prise: there is no field "prise" in body.items[]',
      'writes.rules.op.body.title[]: body.title is not a list',
      'writes.rules.op.amount.value: amount is not an object',
    ]);
  });

  it('reports operators that can never match the field type', () => {
    expect(
      warnings({
        op: {
          amount: { pattern: '\\d+', in: ['ten', 5, '6'] },
          confirmed: { max: 1, minLength: 1, notIn: ['yes'] },
          'body.state': { equals: 3 },
        },
      }),
    ).toEqual([
      'writes.rules.op.amount: in lists "ten", which can never match: the field is integer',
      'writes.rules.op.confirmed: min and max compare numbers, but the field is boolean',
      'writes.rules.op.confirmed: minLength and maxLength count characters or items, but the field is boolean',
      'writes.rules.op.confirmed: notIn lists "yes", which can never match: the field is boolean',
    ]);
  });

  it('stays quiet for maps, untyped fields and fields that do exist', () => {
    expect(
      warnings({
        op: {
          'body.metadata.order_id': { pattern: '\\d+' },
          'body.extra.anything[].goes': { max: 1 },
          'body.items[].price': { max: 100 },
          owner: { in: ['acme'] },
        },
      }),
    ).toEqual([]);
  });
});

describe('writes.rules in the config', () => {
  const base = {
    name: 'demo',
    source: { type: 'openapi', spec: './openapi.yaml' },
    mode: 'read-write',
  };
  const withRules = (rules: unknown, writes: Record<string, unknown> = {}) =>
    parseConfig({ ...base, writes: { allow: ['op'], rules, ...writes } });

  it('accepts every operator and defaults to no rules', () => {
    expect(parseConfig(base).writes.rules).toEqual({});
    const cfg = withRules({
      op: {
        amount: { required: true, min: 0, max: 5000 },
        owner: { in: ['acme', 42, true, null], notIn: ['x'], equals: 'acme' },
        'body.items[].sku': { pattern: '^[A-Z]+$', minLength: 1, maxLength: 9 },
        'body.force': { forbidden: true },
        'body.state': { optional: true, in: ['open', 'closed'] },
      },
    });
    expect(cfg.writes.rules.op?.amount).toEqual({ required: true, min: 0, max: 5000 });
    expect(cfg.writes.rules.op?.['body.state']).toEqual({ optional: true, in: ['open', 'closed'] });
  });

  it.each([
    [
      { op: { amount: { maximum: 5 } } },
      /writes\.rules\.op\.amount: Unknown key "maximum" \(did you mean max\?\)/,
    ],
    [{ op: { owner: { enum: ['a'] } } }, /Unknown key "enum" \(did you mean in\?\)/],
    [{ op: { owner: { regex: 'a' } } }, /Unknown key "regex" \(did you mean pattern\?\)/],
    [{ op: { owner: { oneOf: ['a'] } } }, /Unknown key "oneOf"/],
    [{ op: { amount: { max: '5000' } } }, /writes\.rules\.op\.amount\.max: max must be a number/],
    [{ op: { amount: { min: 'low' } } }, /min must be a number/],
    [{ op: { owner: { in: 'acme' } } }, /writes\.rules\.op\.owner\.in: in must be a list/],
    [{ op: { owner: { in: [] } } }, /writes\.rules\.op\.owner\.in/],
    [{ op: { owner: { notIn: [{ a: 1 }] } } }, /values must be text, numbers, true, false or null/],
    [{ op: { owner: { equals: ['a'] } } }, /values must be text, numbers, true, false or null/],
    [{ op: { owner: { pattern: 5 } } }, /pattern must be text/],
    [{ op: { owner: { maxLength: 1.5 } } }, /maxLength/],
    [{ op: { owner: { minLength: -1 } } }, /minLength/],
    [{ op: { owner: { required: false } } }, /required can only be true/],
    [{ op: { owner: { forbidden: 'yes' } } }, /forbidden can only be true/],
    [{ op: { owner: {} } }, /a rule needs at least one of in, notIn/],
    [{ op: { owner: { forbidden: true, in: ['a'] } } }, /cannot be combined/],
    [{ op: { owner: { forbidden: true, optional: true } } }, /cannot be combined/],
    [{ op: { owner: { optional: true } } }, /optional: true only applies next to in, notIn/],
    [{ op: { owner: { optional: true, required: true } } }, /cannot be both required and optional/],
    [
      { op: { owner: { optional: true, required: true, in: ['a'] } } },
      /cannot be both required and optional/,
    ],
    [{ op: { owner: { optional: false, in: ['a'] } } }, /optional can only be true/],
    [
      { op: { owner: { nullable: true, in: ['a'] } } },
      /Unknown key "nullable" \(did you mean optional\?\)/,
    ],
    [{ op: { amount: { min: 10, max: 1 } } }, /min \(10\) is greater than max \(1\)/],
    [
      { op: { owner: { minLength: 5, maxLength: 1 } } },
      /minLength \(5\) is greater than maxLength/,
    ],
    [
      { op: { owner: { pattern: '(a)\\1' } } },
      /writes\.rules\.op\.owner: pattern: backreferences are not supported/,
    ],
    [{ op: { owner: { pattern: 'a'.repeat(201) } } }, /patterns are limited to 200 characters/],
    [
      { 'create*': { amount: { max: 1 } } },
      /writes\.rules\.create\*: rules take an exact operation id/,
    ],
    [{ op: {} }, /writes\.rules\.op: no rules listed/],
    [{ op: { 'body..state': { max: 1 } } }, /not a valid rule path/],
    [{ op: { 'items[0].price': { max: 1 } } }, /not a valid rule path/],
    [
      { op: { 'items.*.price': { max: 1 } } },
      /\[\] for every item of a list \(not \* or an index\)/,
    ],
    [{ op: { 'items[]x': { max: 1 } } }, /not a valid rule path/],
    [{ op: { '': { max: 1 } } }, /not a valid rule path/],
    [['op'], /writes\.rules/],
  ])('refuses %j', (rules, message) => {
    expect(() => withRules(rules)).toThrow(message);
  });

  it('reports a bad path together with the other mistakes in the same rules', () => {
    expect(() =>
      withRules({ op: { 'items.*.price': { max: 1 }, amount: { max: 'lots' } } }),
    ).toThrow(/amount\.max: max must be a number[\s\S]*items\.\*\.price: not a valid rule path/);
  });

  it('refuses unknown keys under writes, so a typo cannot leave a write unrestricted', () => {
    expect(() =>
      parseConfig({ ...base, writes: { allow: ['op'], rule: { op: { amount: { max: 1 } } } } }),
    ).toThrow(/writes: Unknown key "rule" \(did you mean rules\?\)/);
    expect(() => parseConfig({ ...base, writes: { alow: ['op'] } })).toThrow(
      /writes: Unknown key "alow"/,
    );
  });
});
