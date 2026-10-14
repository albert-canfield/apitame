import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { dereference } from '@readme/openapi-parser';
import { parse as parseYaml } from 'yaml';
import { isObject } from './schema.js';
import { convertSwagger2 } from './swagger2.js';

export type OpenApiDocument = Record<string, unknown> & {
  openapi: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: Array<{ url: string; variables?: Record<string, { default?: string }> }>;
  paths?: Record<string, unknown>;
  tags?: Array<{ name: string; description?: string }>;
};

export interface LoadedSpec {
  doc: OpenApiDocument;
  /** Where the spec came from: absolute file path or URL. */
  location: string;
  isUrl: boolean;
  /** Set when the document was converted in memory, for example from Swagger 2.0. */
  convertedFrom?: string;
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

/** Paths probed when `init` is given a base URL instead of a spec URL. */
export const DISCOVERY_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/v3/api-docs',
  '/api-docs',
  '/api/openapi.json',
  '/docs/openapi.json',
  '/.well-known/openapi.json',
];

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function looksLikeSpec(v: unknown): v is Record<string, unknown> {
  return isObject(v) && (typeof v.openapi === 'string' || typeof v.swagger === 'string');
}

async function fetchText(
  url: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function parseMaybe(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

/**
 * Find the spec URL for a URL that may be a spec or an API base URL.
 * Returns the URL that serves a spec, or throws with what was tried.
 */
export async function discoverSpecUrl(url: string): Promise<string> {
  try {
    const first = await fetchText(url);
    if (first.ok && looksLikeSpec(parseMaybe(first.text))) return url;
  } catch {
    // fall through to discovery
  }
  const base = url.replace(/\/+$/, '');
  for (const path of DISCOVERY_PATHS) {
    const candidate = `${base}${path}`;
    try {
      const res = await fetchText(candidate, 8_000);
      if (res.ok && looksLikeSpec(parseMaybe(res.text))) return candidate;
    } catch {
      // try the next path
    }
  }
  throw new SpecError(
    `No OpenAPI document found at ${url}. Tried the URL itself and ${DISCOVERY_PATHS.join(', ')}. ` +
      'Pass the spec URL or a local file instead.',
  );
}

/** Load and fully dereference an OpenAPI 3.0 / 3.1 (or Swagger 2.0) document from a file or URL. */
export async function loadSpec(spec: string, baseDir = process.cwd()): Promise<LoadedSpec> {
  const url = isUrl(spec);
  const location = url ? spec : resolve(baseDir, spec);
  if (!url && !existsSync(location)) throw new SpecError(`OpenAPI file not found: ${location}`);

  let doc: unknown;
  try {
    doc = await dereference(location, {
      resolve: { http: { timeout: 15_000 } },
      dereference: { circular: true },
    } as Parameters<typeof dereference>[1]);
  } catch (err) {
    throw new SpecError(`Could not read OpenAPI document ${location}: ${(err as Error).message}`);
  }

  if (!isObject(doc)) throw new SpecError(`${location} is not an OpenAPI document.`);
  if (typeof doc.swagger === 'string') {
    if (doc.swagger !== '2.0') {
      throw new SpecError(
        `${location} is Swagger ${doc.swagger}. apitame supports Swagger 2.0 and OpenAPI 3.0 and 3.1.`,
      );
    }
    return {
      doc: convertSwagger2(doc),
      location,
      isUrl: url,
      convertedFrom: 'Swagger 2.0',
    };
  }
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\./.test(doc.openapi)) {
    throw new SpecError(
      `${location} has unsupported "openapi" version ${String(doc.openapi)}. Use 3.0.x or 3.1.x.`,
    );
  }
  return { doc: doc as OpenApiDocument, location, isUrl: url };
}

/**
 * Resolve the base URL requests go to. Order: explicit override, then the
 * first server in the spec (with variables substituted, and relative URLs
 * resolved against the spec URL).
 */
export function resolveBaseUrl(
  doc: OpenApiDocument,
  location: string,
  override?: string,
): string | undefined {
  if (override) return override.replace(/\/+$/, '');
  const server = doc.servers?.[0];
  if (!server?.url) return undefined;
  let u = server.url.replace(
    /\{([^}]+)\}/g,
    (_m, name: string) => server.variables?.[name]?.default ?? '',
  );
  if (!isUrl(u)) {
    if (!isUrl(location)) return undefined;
    u = new URL(u, location).toString();
  }
  return u.replace(/\/+$/, '');
}
