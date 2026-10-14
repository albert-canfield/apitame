import { describe, expect, it } from 'vitest';
import { withoutGuardrails, parseConfig } from '../../src/config/load.js';
import { suggestAuth } from '../../src/generator/config.js';
import { sampleFromSchema } from '../../src/mock/sample.js';
import { groupOperations } from '../../src/sources/openapi/grouping.js';
import type { OpenApiDocument } from '../../src/sources/openapi/load.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';

const get = (summary: string) => ({
  get: { summary, responses: { '200': { description: 'ok' } } },
});

describe('grouping untagged APIs', () => {
  it('ranks top-level resources before nested product areas', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Pay', version: '1' },
      paths: {
        '/v1/customers': get('List customers'),
        '/v1/customers/{id}': get('Get a customer'),
        '/v1/charges': get('List charges'),
        '/v1/treasury/accounts': get('List treasury accounts'),
        '/v1/treasury/accounts/{id}': get('Get a treasury account'),
        '/v1/treasury/transfers': get('List treasury transfers'),
        '/v1/treasury/transfers/{id}': get('Get a treasury transfer'),
        '/v1/treasury/flows': get('List flows'),
      },
    } as unknown as OpenApiDocument;
    const ops = extractOperations(doc);
    const { groups, longTail } = groupOperations(doc, ops, {
      maxTools: 4,
      maxOperationsPerTool: 15,
      longTail: true,
    });
    expect(groups.map((g) => g.name)).toEqual(['customers', 'charges']);
    expect(longTail).toHaveLength(5);
  });

  it('keeps tagged groups ranked by their reads', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      paths: {
        '/a/b/c': {
          get: { tags: ['deep'], responses: {} },
          post: { tags: ['deep'], responses: {} },
        },
        '/a/b/d': { get: { tags: ['deep'], responses: {} } },
        '/x': { get: { tags: ['shallow'], responses: {} } },
      },
    } as unknown as OpenApiDocument;
    const { groups } = groupOperations(doc, extractOperations(doc), {
      maxTools: 12,
      maxOperationsPerTool: 15,
      longTail: true,
    });
    expect(groups.map((g) => g.name)).toEqual(['deep', 'shallow']);
  });
});

describe('auth suggestion', () => {
  it('prefers bearer over basic when the API accepts both', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Pay', version: '1' },
      security: [{ basicAuth: [] }, { bearerAuth: [] }],
      components: {
        securitySchemes: {
          basicAuth: { type: 'http', scheme: 'basic' },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    } as unknown as OpenApiDocument;
    expect(suggestAuth(doc, 'pay')).toMatchObject({ auth: { type: 'bearer' }, env: ['PAY_TOKEN'] });
  });
});

describe('samples for patterns', () => {
  it('uses the literal prefix of simple patterns', () => {
    expect(sampleFromSchema({ type: 'string', pattern: '^/v1/accounts' })).toBe('/v1/accounts');
    expect(sampleFromSchema({ type: 'string', pattern: '^cus_' })).toBe('cus_');
    expect(sampleFromSchema({ type: 'string', pattern: '^[0-9]+$' })).toBe('example');
  });
});

describe('self-checks skip guardrails', () => {
  it('turns off rate limits and the audit file', () => {
    const config = parseConfig({
      name: 'x',
      source: { type: 'sqlite', path: 'x.db' },
      limits: { maxCallsPerMinute: 5 },
      audit: { file: 'audit.jsonl', include: 'all' },
    });
    const out = withoutGuardrails({ config, path: '/x/apitame.config.yaml', dir: '/x' });
    expect(out.config.limits).toMatchObject({ maxCallsPerMinute: 0, maxWritesPerMinute: 0 });
    expect(out.config.audit.file).toBeUndefined();
    expect(config.limits.maxCallsPerMinute).toBe(5);
  });
});
