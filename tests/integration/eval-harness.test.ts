import { beforeAll, describe, expect, it } from 'vitest';
import { describeSurface, runOnce, type RunRecord } from '../../scripts/eval/harness.js';
import { matchArg } from '../../scripts/eval/match.js';
import { priceFor } from '../../scripts/eval/pricing.js';
import { AnthropicProvider } from '../../scripts/eval/providers/anthropic.js';
import { FakeProvider } from '../../scripts/eval/providers/fake.js';
import { renderSummary, surfaceStats } from '../../scripts/eval/report.js';
import { loadApi, type ApiContext } from '../../scripts/eval/surfaces.js';
import { TASK_KINDS, type Task } from '../../scripts/eval/tasks.js';
import {
  FatalProviderError,
  SURFACES,
  type Provider,
  type SurfaceId,
} from '../../scripts/eval/types.js';

let petstore: ApiContext;
let github: ApiContext;

beforeAll(async () => {
  petstore = await loadApi('petstore');
  github = await loadApi('github-subset');
});

const fake = new FakeProvider();

function run(
  api: ApiContext,
  task: Task,
  surface: SurfaceId,
  opts: { provider?: Provider; maxTurns?: number } = {},
): Promise<RunRecord> {
  return runOnce({
    api,
    task,
    surface,
    provider: opts.provider ?? fake,
    run: 1,
    maxTurns: opts.maxTurns ?? 12,
  });
}

function task(api: ApiContext, id: string): Task {
  const t = api.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

/** The same task with a different script for the fake model. */
function scripted(t: Task, fakeScript: Partial<Task['fake']>): Task {
  return { ...t, fake: { ...t.fake, ...fakeScript } };
}

describe('eval tasks and surfaces', () => {
  it('has about a dozen tasks per API covering every kind', () => {
    for (const api of [petstore, github]) {
      expect(api.tasks.length).toBe(12);
      for (const kind of TASK_KINDS) {
        expect(api.tasks.some((t) => t.kind === kind)).toBe(true);
      }
    }
  });

  it('builds three surfaces from the same config that differ only in the tool list', async () => {
    const curated = await describeSurface(petstore, 'curated');
    const perEndpoint = await describeSurface(petstore, 'per-endpoint');
    const searchOnly = await describeSurface(petstore, 'search-only');
    expect(curated.tools.map((t) => t.name)).toEqual([
      'pet',
      'user',
      'store',
      'search_operations',
      'call_operation',
    ]);
    // One tool per read operation; read-only mode hides the 11 writes.
    expect(perEndpoint.tools.map((t) => t.name).sort()).toEqual([
      'find_pets_by_status',
      'find_pets_by_tags',
      'get_inventory',
      'get_order_by_id',
      'get_pet_by_id',
      'get_user_by_name',
      'login_user',
      'logout_user',
    ]);
    expect(searchOnly.tools.map((t) => t.name)).toEqual(['search_operations', 'call_operation']);
    for (const s of [curated, perEndpoint, searchOnly]) {
      expect(s.instructions).toMatch(/Read-only mode/);
    }
    // Only the tool list differs: per-endpoint drops the search tools, search-only the groups.
    expect(perEndpoint.instructions).not.toMatch(/search_operations/);
    expect(searchOnly.instructions).toMatch(/search_operations/);

    const gh = await describeSurface(github, 'per-endpoint');
    expect(gh.tools).toHaveLength(25);
    expect(gh.tools.some((t) => t.name === 'issues_create')).toBe(false);
    expect(gh.tools.find((t) => t.name === 'repos_list_languages')?.description).toMatch(
      /number of bytes/,
    );
  });
});

describe('eval harness with the scripted model', () => {
  it('passes every task on every surface', async () => {
    const failures: string[] = [];
    for (const api of [petstore, github]) {
      for (const t of api.tasks) {
        for (const s of SURFACES) {
          const rec = await run(api, t, s);
          if (!rec.success) failures.push(`${api.id}/${t.id}/${s}: ${rec.failures.join('; ')}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('records what reached the mock API, the transcript and the metrics', async () => {
    const rec = await run(petstore, task(petstore, 'order-to-pet'), 'search-only');
    expect(rec.success).toBe(true);
    expect(rec.requests.map((r) => [r.operationId, r.response])).toEqual([
      ['getOrderById', 'fixture'],
      ['getPetById', 'fixture'],
    ]);
    expect(rec.requests[1]?.args).toMatchObject({ petId: '12' });
    // search, call, search, call, answer
    expect(rec.metrics).toMatchObject({ turns: 5, toolCalls: 4, failedToolCalls: 0 });
    expect(rec.metrics.inputTokens).toBeGreaterThan(0);
    expect(rec.metrics.costUsd).toBeNull();
    const calls = rec.transcript.flatMap((m) =>
      m.role === 'assistant' ? m.toolCalls.map((c) => c.name) : [],
    );
    expect(calls).toEqual([
      'search_operations',
      'call_operation',
      'search_operations',
      'call_operation',
    ]);
  });
});

describe('eval graders', () => {
  it('fails a wrong answer', async () => {
    const t = scripted(task(petstore, 'pet-by-id'), { answer: 'Pet 42 is Rex, and it is sold.' });
    const rec = await run(petstore, t, 'curated');
    expect(rec.success).toBe(false);
    expect(rec.failures).toEqual(['answer includes "Biscuit"', 'answer includes "pending"']);
  });

  it('fails when a required call never reached the API', async () => {
    const t = scripted(task(petstore, 'pet-by-id'), { steps: [] });
    const rec = await run(petstore, t, 'per-endpoint');
    expect(rec.success).toBe(false);
    expect(rec.failures).toEqual(['called getPetById(petId=42): not called']);
  });

  it('fails when a key argument is wrong, and the mock answers 404', async () => {
    const t = scripted(task(petstore, 'pet-by-id'), {
      steps: [{ operation: 'getPetById', params: { petId: 41 } }],
    });
    const rec = await run(petstore, t, 'curated');
    expect(rec.success).toBe(false);
    expect(rec.failures).toEqual([
      'called getPetById(petId=42): wrong arguments: getPetById(petId=41)',
    ]);
    expect(rec.requests[0]?.response).toBe('not-found');
    expect(rec.metrics.failedToolCalls).toBe(1);
  });

  it('fails a blocked write the agent attempts, even though apitame refuses it', async () => {
    const t = scripted(task(petstore, 'blocked-delete-pet'), {
      steps: [{ operation: 'deletePet', params: { petId: 42 } }],
    });
    for (const surface of ['curated', 'search-only'] as const) {
      const rec = await run(petstore, t, surface);
      expect(rec.success).toBe(false);
      expect(rec.failures).toEqual([
        'no write or forbidden operation attempted: attempted deletePet',
      ]);
      // apitame blocked it: nothing reached the API.
      expect(rec.requests).toEqual([]);
      const results = rec.transcript.flatMap((m) => (m.role === 'tool' ? m.results : []));
      expect(results.find((r) => r.operation === 'deletePet')?.content).toMatch(/^Blocked:/);
    }
  });

  it('treats any write attempt as a failure, not only the one the task names', async () => {
    const original = task(petstore, 'pet-by-id');
    const t = scripted(original, {
      steps: [...original.fake.steps, { operation: 'updatePet', params: {} }],
    });
    const rec = await run(petstore, t, 'search-only');
    expect(rec.success).toBe(false);
    expect(rec.failures).toEqual([
      'no write or forbidden operation attempted: attempted updatePet',
    ]);
  });

  it('accepts any of the listed routes for an anyOf requirement', async () => {
    const t = scripted(task(github, 'busiest-issue-latest-comment'), {
      steps: [
        {
          operation: 'search/issues-and-pull-requests',
          params: { q: 'repo:acme/rocket is:issue is:open', sort: 'comments' },
        },
        {
          operation: 'issues/list-comments',
          params: { owner: 'acme', repo: 'rocket', issue_number: 377 },
        },
      ],
    });
    const rec = await run(github, t, 'curated');
    expect(rec.failures).toEqual([]);
    expect(rec.success).toBe(true);
  });

  it('fails a run that hits the turn limit', async () => {
    const rec = await run(petstore, task(petstore, 'order-to-pet'), 'curated', { maxTurns: 2 });
    expect(rec.endReason).toBe('max-turns');
    expect(rec.success).toBe(false);
    expect(rec.failures).toContain('finished: run ended: max-turns');
  });

  it('matches arguments by value, list, substring and regex, ignoring case', () => {
    expect(matchArg('Acme', 'acme')).toBe(true);
    expect(matchArg('42', 42)).toBe(true);
    expect(matchArg('41', 42)).toBe(false);
    expect(matchArg(['senior', 'calm'], ['senior'])).toBe(true);
    expect(matchArg('bug,ui', ['ui', 'bug'])).toBe(true);
    expect(matchArg('repo:acme/rocket is:open', { contains: 'ACME/rocket' })).toBe(true);
    expect(matchArg('mcp language:typescript', { regex: '^mcp\\b' })).toBe(true);
    expect(matchArg(undefined, 'x')).toBe(false);
  });
});

/** The parts of a Messages API request body the tests look at. */
interface SentBody {
  model: string;
  cache_control?: unknown;
  system: Array<{ text: string }>;
  tools: Array<{ name: string; input_schema: { type: string } }>;
  messages: Array<{ role: string; content: unknown }>;
}

describe('Anthropic provider (no network)', () => {
  const KEY = 'sk-ant-test-key-0123456789abcdef';

  function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  it('runs the tool-use loop over fetch, keeps usage apart and never leaks the key', async () => {
    const replies = [
      {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'pet',
            input: { operation: 'getPetById', params: { petId: 42 } },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 900,
          output_tokens: 40,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 0,
        },
      },
      {
        content: [{ type: 'text', text: 'Pet 42 is Biscuit. Its status is pending.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 150,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1200,
        },
      },
    ];
    const sent: Array<{ url: string; headers: Record<string, string>; body: SentBody }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as SentBody,
      });
      return jsonResponse(replies[sent.length - 1]);
    }) as unknown as typeof fetch;
    const provider = new AnthropicProvider('claude-sonnet-5', { apiKey: KEY, fetchImpl });
    const price = priceFor('claude-sonnet-5')!;
    const rec = await runOnce({
      api: petstore,
      task: task(petstore, 'pet-by-id'),
      surface: 'curated',
      provider,
      run: 1,
      maxTurns: 5,
      price,
    });

    expect(rec.success).toBe(true);
    expect(rec.metrics).toMatchObject({
      turns: 2,
      toolCalls: 1,
      inputTokens: 1050,
      outputTokens: 60,
      cacheReadTokens: 1200,
      cacheWriteTokens: 1200,
    });
    expect(rec.metrics.costUsd).toBeCloseTo(
      (1050 * 2 + 60 * 10 + 1200 * 0.2 + 1200 * 2.5) / 1_000_000,
      10,
    );

    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]?.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
    const first = sent[0]!.body;
    expect(first.model).toBe('claude-sonnet-5');
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.system[0]?.text).toMatch(/Read-only mode/);
    expect(first.tools.map((t) => t.name)).toEqual([
      'pet',
      'user',
      'store',
      'search_operations',
      'call_operation',
    ]);
    expect(first.tools[0]?.input_schema.type).toBe('object');
    expect(first.messages).toEqual([{ role: 'user', content: task(petstore, 'pet-by-id').prompt }]);
    // The assistant turn goes back unchanged (thinking block included), then the tool result.
    const second = sent[1]!.body;
    expect(second.messages[1]).toEqual({ role: 'assistant', content: replies[0]!.content });
    const toolResult = (second.messages[2]?.content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(toolResult?.content).toContain('Biscuit');

    expect(JSON.stringify(rec)).not.toContain(KEY);
    expect(JSON.stringify(provider)).not.toContain(KEY);
  });

  it('retries overloaded responses and stops on a refused key without echoing it', async () => {
    let calls = 0;
    const waits: number[] = [];
    const flaky = (async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          529,
          { 'retry-after': '2' },
        );
      }
      return jsonResponse({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    }) as unknown as typeof fetch;
    const ok = new AnthropicProvider('claude-haiku-4-5-20251001', {
      apiKey: KEY,
      fetchImpl: flaky,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const turn = await ok.session().next({ system: 's', tools: [], messages: [] });
    expect(turn.text).toBe('done');
    expect(waits).toEqual([2000]);
    expect(turn.waitedMs).toBe(2000);

    const refused = (async () =>
      jsonResponse(
        {
          type: 'error',
          error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
        },
        401,
      )) as unknown as typeof fetch;
    const bad = new AnthropicProvider('claude-sonnet-5', { apiKey: KEY, fetchImpl: refused });
    const err = await bad
      .session()
      .next({ system: 's', tools: [], messages: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalProviderError);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('refuses to start without a key', () => {
    expect(() => new AnthropicProvider('claude-sonnet-5', { apiKey: '' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});

describe('eval summary', () => {
  it('renders a table per API with success, tokens and cost', async () => {
    const records = [
      await run(petstore, task(petstore, 'pet-by-id'), 'curated'),
      await run(petstore, task(petstore, 'pet-by-id'), 'search-only'),
      await run(petstore, scripted(task(petstore, 'pet-by-id'), { steps: [] }), 'search-only'),
    ];
    const surfaces = [
      await describeSurface(petstore, 'curated'),
      await describeSurface(petstore, 'search-only'),
    ];
    const stats = surfaceStats(records, surfaces);
    expect(stats.map((s) => [s.surface, s.tools, s.successes, s.runs])).toEqual([
      ['curated', 5, 1, 1],
      ['search-only', 2, 1, 2],
    ]);
    const md = renderSummary(
      {
        date: '2026-10-14T12:00:00.000Z',
        provider: 'fake',
        model: 'scripted',
        estimatedUsage: true,
        apitameVersion: '0.0.0',
        commit: 'abc1234',
        command: 'pnpm eval --provider fake',
        runs: 1,
        maxTurns: 12,
        cache: true,
      },
      records,
      surfaces,
    );
    expect(md).toContain('## petstore');
    expect(md).toContain('| Curated (example config) | 5 |');
    expect(md).toContain('| Search and call only | 2 |');
    expect(md).toContain('1/2 (50%)');
    expect(md).toContain('| pet-by-id | lookup | 1/1 | 1/2 |');
    expect(md).toContain(
      '`pet-by-id` on search only, run 1: called getPetById(petId=42): not called',
    );
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });

  it('estimates cost from list prices, including dated model ids', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(priceFor('some-new-model')).toBeUndefined();
    expect(priceFor('some-new-model', { input: 3, output: 15 })?.cacheWrite).toBe(3.75);
  });
});
