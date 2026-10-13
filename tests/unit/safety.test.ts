import { describe, expect, it, vi } from 'vitest';
import {
  ConfirmationStore,
  confirmOrChallenge,
  stableStringify,
} from '../../src/safety/confirm.js';
import { decide, matchesAny } from '../../src/safety/policy.js';
import { REDACTED, Redactor } from '../../src/safety/redact.js';

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
