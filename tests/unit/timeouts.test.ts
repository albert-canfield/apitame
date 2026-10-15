import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from '../../src/auth/index.js';
import { Redactor } from '../../src/safety/redact.js';
import { IntrospectionVerifier } from '../../src/server/introspection.js';
import { JwtVerifier } from '../../src/server/oauth.js';
import { fetchText } from '../../src/sources/openapi/load.js';
import { withDeadline } from '../../src/util/deadline.js';
import { forceGc, outcomeWithin, startDripServer } from '../helpers.js';

/**
 * Each request below goes to a server that sends its headers, then drips the body forever, and
 * a full garbage collection runs while it waits. A timeout signal that only the request holds
 * (`AbortSignal.timeout`) can be collected then and never fire, which left the request hanging
 * for good. The deadline must still end it.
 */
const TIMEOUT_MS = 300;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function endsDespiteGc(head: string, start: (url: string) => Promise<unknown>) {
  const drip = await startDripServer(head);
  close = drip.close;
  const started = Date.now();
  const pending = start(drip.url);
  // Collect garbage while the request waits, as a busy server does.
  const collector = setInterval(forceGc, 50);
  const outcome = await outcomeWithin(pending, 3_000).finally(() => clearInterval(collector));
  expect(outcome.state, 'the request still hangs').toBe('rejected');
  expect(Date.now() - started).toBeLessThan(2_500);
  return outcome.error!;
}

describe('request timeouts survive garbage collection', () => {
  it('the OAuth2 client credentials token request', async () => {
    const err = await endsDespiteGc('{"access_token":"', (url) =>
      createAuth(
        {
          type: 'oauth2',
          flow: 'client_credentials',
          tokenUrl: url,
          clientId: 'cid',
          clientSecret: '${CS}',
          scopes: [],
          clientAuthMethod: 'client_secret_basic',
        },
        new Redactor(),
        { CS: 'fake-key-client-secret' },
        fetch,
        TIMEOUT_MS,
      ).apply({ url: new URL('https://api.example.com'), headers: {} }),
    );
    expect(err.message).toMatch(/timed out/i);
  });

  it('the key set of the authorization server', async () => {
    const err = await endsDespiteGc('{"keys":[', (url) =>
      new JwtVerifier(
        {
          issuer: 'https://auth.example.com',
          resource: 'https://mcp.example.com/mcp',
          scopes: [],
          audiences: [],
          jwksUri: `${url}jwks`,
        },
        fetch,
        Date.now,
        TIMEOUT_MS,
      ).warmUp(),
    );
    expect(err.message).toMatch(/timed out/i);
  });

  it('token introspection, and a later request for the same token is not stuck behind it', async () => {
    let verifier: IntrospectionVerifier | undefined;
    const err = await endsDespiteGc('{"active":true,', (url) => {
      verifier = new IntrospectionVerifier(
        {
          issuer: 'https://auth.example.com',
          resource: 'https://mcp.example.com/mcp',
          scopes: [],
          audiences: [],
        },
        { url, clientId: 'x', clientSecret: 'y' },
        { timeoutMs: TIMEOUT_MS },
      );
      return verifier.verifyAccessToken('opaque-token-1');
    });
    expect(err.message).toMatch(/timed out/i);
    const again = await outcomeWithin(verifier!.verifyAccessToken('opaque-token-1'), 3_000);
    expect(again.state).toBe('rejected');
  });

  it('a spec loaded from a URL', async () => {
    const err = await endsDespiteGc('{"openapi":"3.1.0",', (url) => fetchText(url, TIMEOUT_MS));
    expect(err.message).toMatch(/timed out/i);
  });
});

describe('withDeadline', () => {
  it('rejects at the deadline even when the work ignores the signal', async () => {
    const started = Date.now();
    await expect(
      withDeadline(
        50,
        () => new Error('too late'),
        () => new Promise(() => {}),
      ),
    ).rejects.toThrow('too late');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('aborts the signal at the deadline, and reports the deadline whoever noticed first', async () => {
    let seen: AbortSignal | undefined;
    const err = await withDeadline(
      50,
      () => new Error('deadline'),
      (signal) => {
        seen = signal;
        return new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted by the signal'))),
        );
      },
    ).catch((e: unknown) => e as Error);
    expect(seen?.aborted).toBe(true);
    expect(err.message).toBe('deadline');
  });

  it('passes results and other errors through, and leaves the signal alone after', async () => {
    let seen: AbortSignal | undefined;
    const work = async (signal: AbortSignal) => {
      seen = signal;
      return 42;
    };
    expect(await withDeadline(50, () => new Error('deadline'), work)).toBe(42);
    await expect(
      withDeadline(
        50,
        () => new Error('deadline'),
        async () => {
          throw new Error('own failure');
        },
      ),
    ).rejects.toThrow('own failure');
    // Past the deadline: the timer was cleared, so nothing aborts a finished request.
    await new Promise((r) => setTimeout(r, 120));
    expect(seen?.aborted).toBe(false);
  });
});
