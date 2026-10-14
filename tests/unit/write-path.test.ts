import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmOrChallenge, ConfirmationStore } from '../../src/safety/confirm.js';
import { callOperation, fakeApi } from '../helpers.js';

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

const tokenIn = (out: string) => /"confirm": "([^"]+)"/.exec(out)?.[1];

const ok = { '200': { description: 'ok' } };

describe('dryRun', () => {
  const api = () =>
    fakeApi({
      paths: { '/jobs': { post: { operationId: 'createJob', responses: ok } } },
      config: { mode: 'read-write', writes: { allow: ['createJob'] } },
    });

  it('treats the string "true" as a dry run', async () => {
    const { rt, sent } = api();
    const out = text(await callOperation(rt, 'createJob', {}, { dryRun: 'true' }));
    expect(out).toContain('Nothing was sent');
    expect(sent).toHaveLength(0);
  });

  it('refuses anything but true or false instead of sending', async () => {
    const { rt, sent } = api();
    for (const dryRun of [1, 'yes', {}]) {
      const res = await callOperation(rt, 'createJob', {}, { dryRun });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('"dryRun" must be true or false');
    }
    expect(sent).toHaveLength(0);
  });

  it('sends with false or "false"', async () => {
    const { rt, sent } = api();
    await callOperation(rt, 'createJob', {}, { dryRun: false });
    await callOperation(rt, 'createJob', {}, { dryRun: 'false' });
    expect(sent).toHaveLength(2);
  });
});

describe('API parameters named like control arguments', () => {
  const api = () =>
    fakeApi({
      paths: {
        '/jobs/{id}': {
          delete: {
            operationId: 'deleteJob',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'dryRun', in: 'query', schema: { type: 'boolean' } },
              { name: 'confirm', in: 'query', schema: { type: 'string' } },
            ],
            responses: ok,
          },
        },
      },
      config: {
        mode: 'read-write',
        writes: { allow: ['deleteJob'] },
        confirmation: { method: 'token' },
        tools: [{ name: 'delete_job', operations: ['deleteJob'] }],
      },
    });

  it('keeps dryRun and confirm as controls and exposes the API ones as api_*', async () => {
    const { rt } = api();
    const tool = rt.listTools().find((t) => t.name === 'delete_job');
    const props = tool?.inputSchema.properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['dryRun', 'confirm', 'api_dryRun', 'api_confirm', 'id']),
    );
    expect(tool?.inputSchema.required).toEqual(['id']);
  });

  it('never sends a dry run to the API, and passes api_* through', async () => {
    const { rt, sent } = api();
    const preview = text(await rt.callTool('delete_job', { id: '7', dryRun: true }));
    expect(preview).toContain('Nothing was sent');
    expect(sent).toHaveLength(0);

    const challenge = text(await rt.callTool('delete_job', { id: '7', api_dryRun: true }));
    const token = tokenIn(challenge);
    expect(token).toBeTruthy();
    await rt.callTool('delete_job', { id: '7', api_dryRun: true, confirm: token });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).searchParams.get('dryRun')).toBe('true');
    expect(new URL(sent[0]!.url).searchParams.get('confirm')).toBeNull();
  });
});

describe('rate limits and confirmation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not use up an approval when the write limit is reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rt, sent } = fakeApi({
      paths: {
        '/notes': { post: { operationId: 'createNote', responses: ok } },
        '/notes/{id}': {
          delete: {
            operationId: 'deleteNote',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: ok,
          },
        },
      },
      config: {
        mode: 'read-write',
        writes: { allow: ['createNote', 'deleteNote'] },
        confirmation: { method: 'token' },
        limits: { maxWritesPerMinute: 1 },
      },
    });
    const token = tokenIn(text(await callOperation(rt, 'deleteNote', { id: '1' })));
    expect(token).toBeTruthy();
    await callOperation(rt, 'createNote');
    expect(sent).toHaveLength(1);

    const limited = await callOperation(rt, 'deleteNote', { id: '1' }, { confirm: token });
    expect(text(limited)).toContain('Rate limit');
    expect(sent).toHaveLength(1);

    vi.setSystemTime(Date.now() + 61_000);
    const done = await callOperation(rt, 'deleteNote', { id: '1' }, { confirm: token });
    expect(done.isError).toBeFalsy();
    expect(sent).toHaveLength(2);
  });
});

describe('writes.destructive and writes.treatAsRead', () => {
  it('accept the same * patterns as allow and confirm', async () => {
    const { rt, sent } = fakeApi({
      paths: {
        '/projects/{id}/archive': {
          post: {
            operationId: 'archiveProject',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: ok,
          },
        },
        '/search/projects': { post: { operationId: 'searchProjects', responses: ok } },
      },
      config: {
        mode: 'read-write',
        writes: { allow: ['archive*'], destructive: ['archive*'], treatAsRead: ['search*'] },
        confirmation: { method: 'token' },
      },
    });
    const archive = text(await callOperation(rt, 'archiveProject', { id: '1' }));
    expect(archive).toContain('CONFIRMATION REQUIRED');
    expect(sent).toHaveLength(0);
    const search = await callOperation(rt, 'searchProjects');
    expect(search.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
  });
});

describe('confirmation.method: elicitation', () => {
  it('refuses when there is no way to ask the human, instead of falling back to a token', async () => {
    const outcome = await confirmOrChallenge({
      id: 'deletePet',
      preview: 'DELETE /pets/1',
      args: {},
      confirmToken: undefined,
      method: 'elicitation',
      store: new ConfirmationStore(60_000),
      ctx: undefined,
    });
    expect(outcome.proceed).toBe(false);
    if (!outcome.proceed)
      expect(JSON.stringify(outcome.result)).toContain('does not support elicitation');
  });
});
