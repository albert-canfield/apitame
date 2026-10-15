import type { Config } from '../../config/schema.js';
import {
  assertSecureUrl,
  FETCH_TIMEOUT_MS,
  JwtVerifier,
  metadataUrls,
  oauthWarnings,
  protectedResourceMetadataUrl,
  readCapped,
  reason,
  show,
} from '../../server/oauth.js';
import { isLoopback } from '../../server/transport.js';
import type { Finding } from './doctor.js';

/**
 * `doctor` checks for `serve --transport http` deployments: authentication, and with `http.oauth`
 * the resource URL, the issuer's metadata, its signing keys and the public URL behind the
 * reverse proxy. Each check is a function in `HTTP_CHECKS`; later checks read what earlier ones
 * found from the shared context.
 */

type HttpConfig = Config['http'];
type Add = (status: Finding['status'], check: string, detail: string) => void;

export interface HttpCheckOptions {
  /** The host `serve --transport http` listens on (its `--host`). */
  host: string;
  /** `APITAME_HTTP_TOKEN`, as `serve` reads it. */
  token?: string | undefined;
  /** Skip the checks that contact the authorization server or the public URL. */
  offline?: boolean | undefined;
  fetch?: typeof fetch;
}

/** What the HTTP checks share. A check may record what later checks need. */
export interface HttpCheckContext {
  http: HttpConfig;
  host: string;
  /** Whether `host` is a loopback address, as `serve` decides it. */
  loopback: boolean;
  token: string | undefined;
  offline: boolean;
  fetch: typeof fetch;
  add: Add;
  /** `http.oauth.resource`, once `checkResource` found it usable. */
  resource?: URL;
  /** The issuer's metadata document and where it was found, once `checkIssuer` read it. */
  issuerMetadata?: { url: string; document: Record<string, unknown> };
  /** Where the signing keys are (`http.oauth.jwksUri` or the metadata's `jwks_uri`). */
  jwksUri?: string;
}

export type HttpCheck = (ctx: HttpCheckContext) => void | Promise<void>;

const AUTH = 'HTTP auth';
const RESOURCE = 'OAuth resource';
const ISSUER = 'OAuth issuer';
const KEYS = 'OAuth keys';
const PUBLIC = 'Public URL';

/** A shorter `APITAME_HTTP_TOKEN` is reported: it is the only thing between the network and every tool. */
const MIN_TOKEN_CHARS = 32;
/** The path `serve` answers MCP requests on. */
const MCP_PATH = '/mcp';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const loopbackUrl = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

/**
 * A URL from a remote document, safe to print: normalized (control and non-ASCII characters
 * percent-encoded) when it parses, shortened by `show` when it does not.
 */
const shownUrl = (value: string) => (URL.canParse(value) ? new URL(value).href : show(value));

type Document = { ok: true; json: unknown } | { ok: false; problem: string };

/**
 * GET a JSON document with the hardening `JwtVerifier` uses for the issuer's documents:
 * no redirects, a timeout, and at most 1 MB.
 */
async function getDocument(url: string, fetchImpl: typeof fetch): Promise<Document> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const why = reason(err);
    const hint = /redirect/i.test(why) ? ' Redirects are not followed: use the final URL.' : '';
    return { ok: false, problem: `Fetching ${url} failed (${why}).${hint}` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, problem: `${url} answered HTTP ${res.status}.` };
  }
  let text: string;
  try {
    text = await readCapped(res, url);
  } catch (err) {
    return { ok: false, problem: (err as Error).message };
  }
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, problem: `${url} did not answer with JSON.` };
  }
}

/** Authentication: required beyond loopback, and a token and OAuth cannot be combined. */
function checkAuthentication(ctx: HttpCheckContext): void {
  const { host, token, add } = ctx;
  const oauth = ctx.http.oauth;
  if (token && oauth) {
    add(
      'fail',
      AUTH,
      'APITAME_HTTP_TOKEN and http.oauth are both set, so serve refuses to start. Unset APITAME_HTTP_TOKEN to require OAuth access tokens, or remove http.oauth to use the static token.',
    );
    return;
  }
  if (oauth) {
    add('ok', AUTH, `OAuth access tokens from ${oauth.issuer} required on ${host}`);
    for (const w of oauthWarnings(oauth)) add('warn', AUTH, w);
    return;
  }
  if (token) {
    if (/^(["']).*\1$/s.test(token) || /\s/.test(token)) {
      // `docker run --env-file` keeps quotes as part of the value, and clients never send them.
      add(
        'warn',
        AUTH,
        'APITAME_HTTP_TOKEN contains quotes or spaces, which clients would have to send as part of the token. docker run --env-file keeps quotes: write NAME=value without them.',
      );
    } else if (token.length < MIN_TOKEN_CHARS) {
      add(
        'warn',
        AUTH,
        `APITAME_HTTP_TOKEN has ${token.length} characters. It is all that stands between the network and the tools: use a long random value, for example from "openssl rand -hex 32".`,
      );
    } else add('ok', AUTH, `bearer token (APITAME_HTTP_TOKEN) required on ${host}`);
    return;
  }
  if (!ctx.loopback) {
    add(
      'fail',
      AUTH,
      `none, and serve refuses to listen on ${host} without authentication. Set APITAME_HTTP_TOKEN (clients then send it as a bearer token) or configure http.oauth.`,
    );
    return;
  }
  add(
    'info',
    AUTH,
    `none on ${host}: any local process that can reach the port can call the tools and answer approval prompts. Set APITAME_HTTP_TOKEN or http.oauth when an agent with a shell runs on this machine.`,
  );
}

/** `http.oauth.resource`: the public URL clients connect to, through the reverse proxy. */
function checkResource(ctx: HttpCheckContext): void {
  const oauth = ctx.http.oauth;
  if (!oauth) return;
  let url: URL;
  try {
    url = assertSecureUrl(oauth.resource, 'http.oauth.resource');
  } catch (err) {
    ctx.add(
      'fail',
      RESOURCE,
      `${(err as Error).message}, so serve refuses to start. Clients reach apitame through TLS (a reverse proxy); http is only accepted on localhost, 127.0.0.1 and [::1].`,
    );
    return;
  }
  if (url.hash) {
    ctx.add('fail', RESOURCE, `http.oauth.resource must not have a fragment: ${oauth.resource}`);
    return;
  }
  ctx.resource = url;
  let problems = 0;
  const warn = (detail: string) => {
    problems++;
    ctx.add('warn', RESOURCE, detail);
  };
  if (url.search) {
    warn(
      `${oauth.resource} has a query string. Resource indicators should not have one (RFC 8707), and authorization servers may refuse it.`,
    );
  }
  if (loopbackUrl(url) && !ctx.loopback) {
    warn(
      `${oauth.resource} names a loopback address, but serve listens on ${ctx.host}: clients on other machines connect through another URL, and their tokens name that one. Set it to the public URL, such as https://mcp.example.com/mcp.`,
    );
  }
  const path = url.pathname;
  if (path !== MCP_PATH && path !== '/') {
    if (path.endsWith(MCP_PATH)) {
      ctx.add(
        'info',
        RESOURCE,
        `apitame answers MCP on ${MCP_PATH}, so the reverse proxy must map ${path} to ${MCP_PATH} and pass /.well-known/oauth-protected-resource${path} through unchanged.`,
      );
    } else {
      warn(
        `clients connect to ${path}, but apitame answers MCP on ${MCP_PATH} only. Use a resource URL that ends in ${MCP_PATH}, such as ${url.origin}${MCP_PATH}, unless the reverse proxy maps ${path} to ${MCP_PATH}.`,
      );
    }
  }
  if (problems > 0) return;
  const proxy =
    ctx.loopback && !loopbackUrl(url)
      ? `; on loopback the Host and Origin checks also accept ${url.hostname}, for a reverse proxy on this machine`
      : '';
  ctx.add('ok', RESOURCE, `${oauth.resource}${proxy}`);
}

/**
 * The issuer's metadata (RFC 8414, or OpenID Connect discovery), found as `JwtVerifier` finds it.
 * apitame reads the key set's location there, and MCP clients read where to sign users in.
 */
async function checkIssuer(ctx: HttpCheckContext): Promise<void> {
  const oauth = ctx.http.oauth;
  if (!oauth) return;
  try {
    const issuer = assertSecureUrl(oauth.issuer, 'http.oauth.issuer');
    if (issuer.search || issuer.hash)
      throw new Error(`http.oauth.issuer must not have a query or fragment: ${oauth.issuer}`);
    if (oauth.jwksUri) assertSecureUrl(oauth.jwksUri, 'http.oauth.jwksUri');
  } catch (err) {
    ctx.add('fail', ISSUER, `${(err as Error).message}, so serve refuses to start.`);
    return;
  }
  if (ctx.offline) {
    ctx.add('info', ISSUER, 'skipped (--offline)');
    return;
  }
  if (oauth.jwksUri) ctx.jwksUri = oauth.jwksUri;
  const problems: string[] = [];
  for (const url of metadataUrls(oauth.issuer)) {
    const got = await getDocument(url, ctx.fetch);
    if (!got.ok) {
      problems.push(got.problem);
      continue;
    }
    // As in JwtVerifier: something that is not metadata (a catch-all page) is no verdict on the
    // issuer, so the next location is tried.
    const doc = got.json;
    const usable =
      isRecord(doc) &&
      (typeof doc.jwks_uri === 'string' || (oauth.jwksUri && typeof doc.issuer === 'string'));
    if (!usable) {
      problems.push(`${url} is not authorization server metadata.`);
      continue;
    }
    reportMetadata(ctx, oauth, url, doc);
    return;
  }
  if (oauth.jwksUri) {
    ctx.add(
      'warn',
      ISSUER,
      `no authorization server metadata found: ${problems.join(' ')} serve reads the keys from http.oauth.jwksUri, but MCP clients need the metadata to find where to sign users in.`,
    );
    return;
  }
  ctx.add(
    'fail',
    ISSUER,
    `could not read the authorization server metadata of ${oauth.issuer}: ${problems.join(' ')} serve cannot find the signing keys. Check http.oauth.issuer, or set http.oauth.jwksUri if the server publishes no metadata.`,
  );
}

function reportMetadata(
  ctx: HttpCheckContext,
  oauth: NonNullable<HttpConfig['oauth']>,
  url: string,
  doc: Record<string, unknown>,
): void {
  if (doc.issuer !== oauth.issuer) {
    const slash =
      typeof doc.issuer === 'string' &&
      doc.issuer.replace(/\/$/, '') === oauth.issuer.replace(/\/$/, '');
    ctx.add(
      'fail',
      ISSUER,
      `${url} names issuer ${show(doc.issuer)}, but http.oauth.issuer is "${oauth.issuer}". apitame and MCP clients refuse metadata that names another issuer (RFC 8414).${slash ? " They differ only in a trailing slash: use the exact value of the tokens' iss claim, which is normally the one in the metadata." : ''}`,
    );
    // JwtVerifier refuses this metadata, so it finds no keys through it.
    if (!oauth.jwksUri) return;
  } else {
    ctx.issuerMetadata = { url, document: doc };
  }
  const published = typeof doc.jwks_uri === 'string' ? doc.jwks_uri : undefined;
  if (published && !oauth.jwksUri) {
    try {
      // The normalized form: a remote value is never printed raw.
      ctx.jwksUri = assertSecureUrl(published, 'jwks_uri').href;
    } catch {
      ctx.add(
        'fail',
        ISSUER,
        `${url} names jwks_uri ${shownUrl(published)}, which is not an https URL, so serve refuses it.`,
      );
      return;
    }
  }
  if (doc.issuer !== oauth.issuer) return;
  const warnings: string[] = [];
  if (published && oauth.jwksUri && published !== oauth.jwksUri) {
    warnings.push(
      `http.oauth.jwksUri is ${oauth.jwksUri}, but the issuer publishes its keys at ${shownUrl(published)}. apitame only reads http.oauth.jwksUri: remove it unless the published location is wrong.`,
    );
  }
  if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
    warnings.push(
      `${url} names no authorization_endpoint or token_endpoint, so MCP clients cannot sign users in.`,
    );
  }
  const pkce = doc.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || !pkce.includes('S256')) {
    warnings.push(
      `${url} does not list S256 in code_challenge_methods_supported. MCP clients require PKCE with S256 and may refuse to sign users in.`,
    );
  }
  for (const w of warnings) ctx.add('warn', ISSUER, w);
  if (warnings.length === 0) ctx.add('ok', ISSUER, `${url} names this issuer`);
}

/** The signing keys, loaded exactly as `serve` loads them at startup. */
async function checkSigningKeys(ctx: HttpCheckContext): Promise<void> {
  const oauth = ctx.http.oauth;
  // Without a key set location, checkIssuer has reported why.
  if (!oauth || ctx.offline || !ctx.jwksUri) return;
  try {
    // The resource plays no part in loading keys. A stand-in keeps a resource problem, reported
    // by checkResource, from hiding a problem with the keys.
    const verifier = new JwtVerifier(
      { ...oauth, resource: ctx.resource?.href ?? oauth.issuer, jwksUri: ctx.jwksUri },
      ctx.fetch,
    );
    const keys = await verifier.warmUp();
    if (keys === 0) {
      ctx.add(
        'fail',
        KEYS,
        `${ctx.jwksUri} has no key apitame can use, so every token would be refused. apitame verifies with RSA keys of 2048 bits or more, EC keys (P-256, P-384, P-521) and Ed25519 or Ed448 keys.`,
      );
    } else ctx.add('ok', KEYS, `${keys} signing key${keys === 1 ? '' : 's'} at ${ctx.jwksUri}`);
  } catch (err) {
    ctx.add('fail', KEYS, `${(err as Error).message} Every token is refused until the keys load.`);
  }
}

/**
 * The resource URL as clients reach it: through the reverse proxy, the endpoint answers a request
 * without a token with apitame's challenge, and the metadata document it points to names this
 * resource and issuer. Not reachable from here is not an error: doctor may run before the deploy.
 */
async function checkPublicUrl(ctx: HttpCheckContext): Promise<void> {
  const oauth = ctx.http.oauth;
  if (!oauth || ctx.offline || !ctx.resource) return;
  const metadataUrl = protectedResourceMetadataUrl(oauth.resource);
  let res: Response;
  try {
    // A redirect is an answer too (a proxy that adds a trailing slash, say), so it is not followed.
    res = await ctx.fetch(oauth.resource, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    ctx.add(
      'info',
      PUBLIC,
      `${oauth.resource} is not reachable from here (${reason(err)}). Run doctor again once apitame runs behind its public URL.`,
    );
    return;
  }
  await res.body?.cancel().catch(() => {});
  const challenge = res.headers.get('www-authenticate') ?? '';
  if (res.status !== 401 || !challenge.includes(`resource_metadata="${metadataUrl}"`)) {
    ctx.add(
      'warn',
      PUBLIC,
      `${oauth.resource} answered HTTP ${res.status} without apitame's challenge pointing to ${metadataUrl}. Check that the reverse proxy passes ${ctx.resource.pathname} to apitame's ${MCP_PATH}, and that apitame runs with this config.`,
    );
    return;
  }
  const got = await getDocument(metadataUrl, ctx.fetch);
  if (!got.ok) {
    ctx.add(
      'warn',
      PUBLIC,
      `${got.problem} The reverse proxy must pass ${new URL(metadataUrl).pathname} to apitame, or MCP clients cannot find the authorization server.`,
    );
    return;
  }
  const doc = isRecord(got.json) ? got.json : {};
  const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers : [];
  if (doc.resource !== oauth.resource || !servers.includes(oauth.issuer)) {
    ctx.add(
      'warn',
      PUBLIC,
      `${metadataUrl} names resource ${show(doc.resource)} and authorization servers ${show(servers)}, not the ones in this config: another server answers at this URL, or apitame runs with another config.`,
    );
    return;
  }
  ctx.add('ok', PUBLIC, `${oauth.resource} reaches apitame, and its metadata names this issuer`);
}

/**
 * The HTTP checks, in order. A check for another way to verify tokens (token introspection, say)
 * goes after `checkIssuer`, whose metadata it can read from the context.
 */
export const HTTP_CHECKS: HttpCheck[] = [
  checkAuthentication,
  checkResource,
  checkIssuer,
  checkSigningKeys,
  checkPublicUrl,
];

/** HTTP checks run when asked for, or when the config or the environment has HTTP settings. */
export function wantsHttpChecks(
  http: HttpConfig,
  opts: { http?: boolean | undefined; host?: string | undefined },
  token: string | undefined,
): boolean {
  return opts.http === true || opts.host !== undefined || http.oauth !== undefined || !!token;
}

export async function checkHttp(http: HttpConfig, opts: HttpCheckOptions, add: Add): Promise<void> {
  const ctx: HttpCheckContext = {
    http,
    host: opts.host,
    loopback: isLoopback(opts.host),
    token: opts.token || undefined,
    offline: opts.offline === true,
    fetch: opts.fetch ?? fetch,
    add,
  };
  for (const check of HTTP_CHECKS) await check(ctx);
}
