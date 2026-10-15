import { describe, expect, it, vi } from 'vitest';
import { unauthenticatedHttpWarning } from '../../src/cli/commands/serve.js';
import {
  asksForConfirmation,
  ConfirmationStore,
  confirmOrChallenge,
  stableStringify,
} from '../../src/safety/confirm.js';
import { decide, matchesAny } from '../../src/safety/policy.js';
import { REDACTED, Redactor } from '../../src/safety/redact.js';
import type { ApprovalRound, ToolDefinition } from '../../src/types.js';

describe('policy.decide', () => {
  const readOnly = { mode: 'read-only' as const, writes: { allow: ['*'], confirm: [] } };
  const readWrite = {
    mode: 'read-write' as const,
    writes: { allow: ['addPet', 'delete*'], confirm: ['updatePet'] },
  };

  it('always allows reads', () => {
    expect(decide('getPet', 'read', readOnly)).toEqual({ allowed: true, needsConfirmation: false });
  });

  it('blocks every write in read-only mode, even with a wildcard allowlist', () => {
    for (const access of ['write', 'destructive'] as const) {
      const d = decide('addPet', access, readOnly);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toMatch(/read-only/);
    }
  });

  it('blocks writes that are not allowlisted in read-write mode', () => {
    const d = decide('updatePet', 'write', readWrite);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.hint).toMatch(/writes\.allow/);
  });

  it('allows allowlisted writes without confirmation', () => {
    expect(decide('addPet', 'write', readWrite)).toEqual({
      allowed: true,
      needsConfirmation: false,
    });
  });

  it('always requires confirmation for destructive operations', () => {
    expect(decide('deletePet', 'destructive', readWrite)).toEqual({
      allowed: true,
      needsConfirmation: true,
    });
  });

  it('requires confirmation for writes listed in writes.confirm', () => {
    const cfg = {
      mode: 'read-write' as const,
      writes: { allow: ['updatePet'], confirm: ['update*'] },
    };
    expect(decide('updatePet', 'write', cfg)).toEqual({ allowed: true, needsConfirmation: true });
  });

  it('matches wildcards exactly, not as regex', () => {
    expect(matchesAny('deletePet', ['delete*'])).toBe(true);
    expect(matchesAny('undeletePet', ['delete*'])).toBe(false);
    expect(matchesAny('a.b', ['a.b'])).toBe(true);
    expect(matchesAny('axb', ['a.b'])).toBe(false);
  });
});

describe('ConfirmationStore', () => {
  it('issues one-time tokens bound to operation and arguments', () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue('deletePet', { petId: 1 });
    expect(store.consume(token, 'deletePet', { petId: 2 })).toMatchObject({ ok: false });
    // A failed attempt burns the token.
    expect(store.consume(token, 'deletePet', { petId: 1 })).toMatchObject({ ok: false });

    const t2 = store.issue('deletePet', { petId: 1 }).token;
    expect(store.consume(t2, 'deleteUser', { petId: 1 })).toMatchObject({ ok: false });
    const t3 = store.issue('deletePet', { petId: 1, b: [1, 2] }).token;
    expect(store.consume(t3, 'deletePet', { b: [1, 2], petId: 1 })).toEqual({ ok: true });
    expect(store.consume(t3, 'deletePet', { b: [1, 2], petId: 1 })).toMatchObject({ ok: false });
  });

  it('expires tokens', () => {
    let now = 1_000;
    const store = new ConfirmationStore(5_000, () => now);
    const { token } = store.issue('x', {});
    now += 6_000;
    expect(store.consume(token, 'x', {})).toEqual({
      ok: false,
      reason: 'Confirmation token expired.',
    });
  });

  it('stableStringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3] } })).toBe(
      stableStringify({ a: { c: [3], d: 2 }, b: 1 }),
    );
  });
});

describe('confirmOrChallenge', () => {
  const base = { id: 'deletePet', preview: 'DELETE /pet/1', args: { petId: 1 } };

  it('returns a challenge with a token when the client cannot elicit', async () => {
    const store = new ConfirmationStore(60_000);
    const out = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'auto',
      store,
      ctx: undefined,
    });
    expect(out.proceed).toBe(false);
    if (!out.proceed) {
      const text = out.result.content[0]!.text;
      expect(text).toMatch(/CONFIRMATION REQUIRED/);
      const token = /"confirm": "(confirm_[^"]+)"/.exec(text)?.[1];
      expect(token).toBeTruthy();
      const second = await confirmOrChallenge({
        ...base,
        confirmToken: token,
        method: 'auto',
        store,
        ctx: undefined,
      });
      expect(second.proceed).toBe(true);
    }
  });

  it('uses elicitation when available, and respects a decline', async () => {
    const store = new ConfirmationStore(60_000);
    const elicit = vi.fn().mockResolvedValueOnce('accept').mockResolvedValueOnce('decline');
    expect(
      (
        await confirmOrChallenge({
          ...base,
          confirmToken: undefined,
          method: 'auto',
          store,
          ctx: { elicit },
        })
      ).proceed,
    ).toBe(true);
    const declined = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'auto',
      store,
      ctx: { elicit },
    });
    expect(declined.proceed).toBe(false);
    expect(elicit).toHaveBeenCalledTimes(2);
    expect(elicit.mock.calls[0]![0]).toContain('DELETE /pet/1');
  });

  it('falls back to a token when elicitation is unsupported (auto)', async () => {
    const store = new ConfirmationStore(60_000);
    const out = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'auto',
      store,
      ctx: { elicit: async () => 'unsupported' },
    });
    expect(out.proceed).toBe(false);
    if (!out.proceed) expect(out.result.content[0]!.text).toMatch(/CONFIRMATION REQUIRED/);
  });

  it('method "elicitation" refuses when the client cannot elicit', async () => {
    const store = new ConfirmationStore(60_000);
    const out = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'elicitation',
      store,
      ctx: { elicit: async () => 'unsupported' },
    });
    expect(out.proceed).toBe(false);
    if (!out.proceed) expect(out.result.isError).toBe(true);
  });

  it('method "token" never elicits', async () => {
    const store = new ConfirmationStore(60_000);
    const elicit = vi.fn();
    const out = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'token',
      store,
      ctx: { elicit },
    });
    expect(out.proceed).toBe(false);
    expect(elicit).not.toHaveBeenCalled();
  });
});

describe('approvals (protocol 2026-07-28)', () => {
  const base = { id: 'deletePet', preview: 'DELETE /pet/1', args: { petId: 1 } };
  const ask = (store: ConfirmationStore, approval: ApprovalRound, extra: object = {}) =>
    confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'auto',
      store,
      ctx: { approval },
      ...extra,
    });
  const stateOf = (out: Awaited<ReturnType<typeof confirmOrChallenge>>) => {
    if (out.proceed) throw new Error('expected a prompt');
    return out.result.inputRequired?.requestState ?? '';
  };

  it('keeps approval ids in a store of their own, apart from confirm tokens', () => {
    const store = new ConfirmationStore(60_000);
    const approval = store.approvals.issue('deletePet', { petId: 1 }).token;
    expect(approval).toMatch(/^approval_[\w-]{43}$/);
    const token = store.issue('deletePet', { petId: 1 }).token;
    expect(store.consume(approval, 'deletePet', { petId: 1 })).toMatchObject({ ok: false });
    expect(store.approvals.consume(token, 'deletePet', { petId: 1 })).toMatchObject({
      ok: false,
    });
    // Both still work where they belong: the failed attempts above were for unknown ids.
    expect(store.consume(token, 'deletePet', { petId: 1 })).toEqual({ ok: true });
    expect(store.approvals.consume(approval, 'deletePet', { petId: 1 })).toEqual({ ok: true });
  });

  it('expires approval ids', () => {
    let now = 1_000;
    const store = new ConfirmationStore(5_000, () => now);
    const { token } = store.approvals.issue('x', {});
    now += 6_000;
    expect(store.approvals.consume(token, 'x', {})).toEqual({
      ok: false,
      code: 'expired',
      reason: 'The approval expired.',
    });
  });

  it('asks in a first round, and runs only on an approved second round', async () => {
    const store = new ConfirmationStore(60_000);
    const elicit = vi.fn();
    const first = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'auto',
      store,
      ctx: { approval: { canAsk: true }, elicit },
    });
    expect(first.proceed).toBe(false);
    if (first.proceed) return;
    expect(first.result.isError).toBeUndefined();
    expect(first.result.inputRequired?.message).toContain('DELETE /pet/1');
    const state = stateOf(first);
    expect(state).toMatch(/^approval_/);
    expect(elicit).not.toHaveBeenCalled();

    expect((await ask(store, { canAsk: true, state, answer: 'accept' })).proceed).toBe(true);
    const again = await ask(store, { canAsk: true, state, answer: 'accept' });
    expect(again.proceed).toBe(false);
    if (!again.proceed) {
      expect(again.result.content[0]!.text).toMatch(/This approval was already used/);
      expect(again.audit).toBe('approval-refused');
      expect(again.reason).toBe('used');
    }
  });

  it('refuses and burns the id when the human did not approve', async () => {
    for (const answer of ['decline', 'cancel', undefined] as const) {
      const store = new ConfirmationStore(60_000);
      const state = stateOf(await ask(store, { canAsk: true }));
      const out = await ask(store, { canAsk: true, state, ...(answer ? { answer } : {}) });
      expect(out.proceed).toBe(false);
      if (!out.proceed) {
        expect(out.result.isError).toBe(true);
        expect(out.result.content[0]!.text).toMatch(/did not approve/);
      }
      expect(store.approvals.consume(state, base.id, { args: base.args, caller: null })).toEqual({
        ok: false,
        code: 'used',
        reason: 'This approval was already used.',
      });
    }
  });

  it('binds an approval to the arguments and to the caller', async () => {
    const store = new ConfirmationStore(60_000);
    const alice = { caller: { subject: 'alice' } };
    const state = stateOf(
      await confirmOrChallenge({
        ...base,
        confirmToken: undefined,
        method: 'auto',
        store,
        ctx: { approval: { canAsk: true }, ...alice },
      }),
    );
    const bob = await confirmOrChallenge({
      ...base,
      confirmToken: undefined,
      method: 'auto',
      store,
      ctx: { approval: { canAsk: true, state, answer: 'accept' }, caller: { subject: 'bob' } },
    });
    expect(bob.proceed).toBe(false);
    if (!bob.proceed) expect(bob.result.content[0]!.text).toMatch(/a different user/);

    const state2 = stateOf(await ask(store, { canAsk: true }));
    const other = await ask(
      store,
      { canAsk: true, state: state2, answer: 'accept' },
      { args: { petId: 2 } },
    );
    expect(other.proceed).toBe(false);
  });

  it('without a form, uses the token under auto and refuses under elicitation', async () => {
    const store = new ConfirmationStore(60_000);
    const auto = await ask(store, { canAsk: false });
    expect(auto.proceed).toBe(false);
    if (!auto.proceed) {
      expect(auto.result.inputRequired).toBeUndefined();
      expect(auto.result.content[0]!.text).toMatch(/CONFIRMATION REQUIRED/);
    }
    const strict = await ask(store, { canAsk: false }, { method: 'elicitation' });
    expect(strict.proceed).toBe(false);
    if (!strict.proceed) {
      expect(strict.result.isError).toBe(true);
      expect(strict.result.content[0]!.text).toMatch(/does not support elicitation/);
    }
  });

  it('method "token" never asks, even when the client could', async () => {
    const store = new ConfirmationStore(60_000);
    const out = await ask(store, { canAsk: true }, { method: 'token' });
    expect(out.proceed).toBe(false);
    if (!out.proceed) {
      expect(out.result.inputRequired).toBeUndefined();
      expect(out.result.content[0]!.text).toMatch(/CONFIRMATION REQUIRED/);
    }
  });
});

describe('serve over HTTP without authentication', () => {
  const tool = (properties: Record<string, unknown>): ToolDefinition => ({
    name: 't',
    description: 't',
    inputSchema: { type: 'object', properties },
  });
  const URL = 'http://127.0.0.1:3333/mcp';

  it('warns when some operation asks for a human decision', () => {
    const warning = unauthenticatedHttpWarning([tool({ confirm: {} })], 'auto', URL);
    expect(warning).toContain(`any local process that can reach ${URL}`);
    expect(warning).toContain('Set APITAME_HTTP_TOKEN or http.oauth');
    expect(warning).not.toContain('are refused');
    expect(unauthenticatedHttpWarning([tool({ confirm: {} })], 'elicitation', URL)).toContain(
      'Under confirmation.method: elicitation, approvals are refused',
    );
  });

  it('stays quiet when nothing asks for confirmation', () => {
    expect(unauthenticatedHttpWarning([tool({ dryRun: {} })], 'auto', URL)).toBeUndefined();
    expect(asksForConfirmation([tool({ api_confirm: {} })])).toBe(false);
  });
});

describe('Redactor', () => {
  it('removes registered secrets everywhere, including URL-encoded forms', () => {
    const r = new Redactor();
    r.addSecret('s3cr3t+value/1');
    expect(r.text('token=s3cr3t+value/1 and s3cr3t%2Bvalue%2F1')).toBe(
      `token=${REDACTED} and ${REDACTED}`,
    );
  });

  it('masks bearer tokens and URL passwords it was never told about', () => {
    const r = new Redactor();
    expect(r.text('Authorization: Bearer abcdefghijklmnop')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(r.text('postgres://user:hunter22@db:5432/x')).toBe(
      `postgres://user:${REDACTED}@db:5432/x`,
    );
  });

  it('hides sensitive headers and keys in structured data', () => {
    const r = new Redactor();
    r.addSensitiveHeader('X-Tenant-Key');
    expect(r.headers({ Authorization: 'Basic abc', 'x-tenant-key': 'k', Accept: 'json' })).toEqual({
      Authorization: REDACTED,
      'x-tenant-key': REDACTED,
      Accept: 'json',
    });
    expect(r.value({ user: { password: 'p', name: 'n' }, list: [{ access_token: 't' }] })).toEqual({
      user: { password: REDACTED, name: 'n' },
      list: [{ access_token: REDACTED }],
    });
  });

  it('catches the form-encoded spelling query strings use', () => {
    const r = new Redactor();
    r.addSecret("key with space!'()~");
    const query = new URLSearchParams({ api_key: "key with space!'()~" }).toString();
    expect(r.text(`GET /v1?${query}`)).toBe(`GET /v1?api_key=${REDACTED}`);
  });

  it('masks lowercase schemes when the value looks like a credential, not prose', () => {
    const r = new Redactor();
    expect(r.text('authorization: bearer abc123def456')).toBe(`authorization: bearer ${REDACTED}`);
    expect(r.text('use bearer authentication')).toBe('use bearer authentication');
    expect(r.text('authorization: bearer abcdefghijklmnop')).toBe(
      `authorization: bearer ${REDACTED}`,
    );
    expect(r.text('{"Authorization":"Basic dXNlcjpwYXNz"}')).toBe(
      `{"Authorization":"Basic ${REDACTED}"}`,
    );
  });

  it('redacts object keys and non-string values under sensitive keys', () => {
    const r = new Redactor();
    r.addSecret('acct-key-123456');
    expect(
      r.value({ 'acct-key-123456': { owner: 'a' }, pin: { password: 123456, token: { v: 1 } } }),
    ).toEqual({
      [REDACTED]: { owner: 'a' },
      pin: { password: REDACTED, token: REDACTED },
    });
  });

  it('stays fast on long dotted input (no quadratic backtracking)', () => {
    const r = new Redactor();
    const started = Date.now();
    r.text('a.'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('ignores very short secrets that would mangle output', () => {
    const r = new Redactor();
    r.addSecret('ab');
    expect(r.text('abc')).toBe('abc');
  });

  it('handles circular structures', () => {
    const r = new Redactor();
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(r.value(a)).toEqual({ x: 1, self: '[Circular]' });
  });
});
