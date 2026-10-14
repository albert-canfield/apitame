import type { OpenApiDocument } from './load.js';
import { isObject } from './schema.js';

type Obj = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

/** Swagger 2.0 `collectionFormat` to OpenAPI 3 style and explode. */
function arrayStyle(param: Obj): { style?: string; explode?: boolean } {
  if (param.type !== 'array') return {};
  const fmt = typeof param.collectionFormat === 'string' ? param.collectionFormat : 'csv';
  switch (fmt) {
    case 'multi':
      return { style: 'form', explode: true };
    case 'ssv':
      return { style: 'spaceDelimited', explode: false };
    case 'pipes':
      return { style: 'pipeDelimited', explode: false };
    default:
      // csv (the Swagger 2.0 default) and tsv, which has no OpenAPI 3 equivalent.
      return param.in === 'query' ? { style: 'form', explode: false } : { style: 'simple' };
  }
}

const SCHEMA_KEYS = [
  'type',
  'format',
  'items',
  'enum',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
];

/** Non-body parameter fields that live in `schema` in OpenAPI 3. */
function paramSchema(param: Obj): Obj {
  const schema: Obj = {};
  for (const k of SCHEMA_KEYS) if (param[k] !== undefined) schema[k] = param[k];
  if (schema.type === 'file') {
    schema.type = 'string';
    schema.format = 'binary';
  }
  if (isObject(schema.items)) schema.items = paramSchema(schema.items);
  if (param['x-nullable'] === true) schema.nullable = true;
  return schema;
}

/** Swagger 2.0 schemas are OpenAPI 3.0 schemas, except for `x-nullable` and `type: file`. */
function fixSchema(schema: unknown, seen = new WeakSet<object>()): unknown {
  if (!isObject(schema) || seen.has(schema)) return schema;
  seen.add(schema);
  if (schema['x-nullable'] === true) schema.nullable = true;
  if (schema.type === 'file') {
    schema.type = 'string';
    schema.format = 'binary';
  }
  for (const v of Object.values(schema)) {
    if (Array.isArray(v)) v.forEach((x) => fixSchema(x, seen));
    else fixSchema(v, seen);
  }
  return schema;
}

function convertParams(params: unknown[]): Obj[] {
  return params.filter(isObject).flatMap((p): Obj[] => {
    if (p.in === 'body' || p.in === 'formData') return [];
    return [
      {
        name: p.name,
        in: p.in,
        ...(p.description ? { description: p.description } : {}),
        ...(p.required === true || p.in === 'path' ? { required: true } : {}),
        schema: paramSchema(p),
        ...arrayStyle(p),
      },
    ];
  });
}

function requestBody(params: unknown[], consumes: string[]): Obj | undefined {
  const list = params.filter(isObject);
  const body = list.find((p) => p.in === 'body');
  if (body) {
    const types = consumes.length > 0 ? consumes : ['application/json'];
    return {
      ...(body.description ? { description: body.description } : {}),
      required: body.required === true,
      content: Object.fromEntries(types.map((t) => [t, { schema: fixSchema(body.schema ?? {}) }])),
    };
  }
  const form = list.filter((p) => p.in === 'formData');
  if (form.length === 0) return undefined;
  const hasFile = form.some((p) => p.type === 'file');
  const type =
    hasFile || consumes.includes('multipart/form-data')
      ? 'multipart/form-data'
      : 'application/x-www-form-urlencoded';
  const properties = Object.fromEntries(
    form.map((p) => [
      p.name as string,
      { ...paramSchema(p), ...(p.description ? { description: p.description } : {}) },
    ]),
  );
  const required = form.filter((p) => p.required === true).map((p) => p.name as string);
  return {
    required: required.length > 0,
    content: {
      [type]: {
        schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
      },
    },
  };
}

function responses(raw: unknown, produces: string[]): Obj {
  const out: Obj = {};
  if (!isObject(raw)) return { default: { description: 'Response' } };
  const types = produces.length > 0 ? produces : ['application/json'];
  for (const [code, r] of Object.entries(raw)) {
    if (!isObject(r)) continue;
    out[code] = {
      description: typeof r.description === 'string' ? r.description : '',
      ...(r.schema !== undefined
        ? {
            content: Object.fromEntries(types.map((t) => [t, { schema: fixSchema(r.schema) }])),
          }
        : {}),
      ...(isObject(r.headers) ? { headers: r.headers } : {}),
    };
  }
  return out;
}

function securitySchemes(defs: unknown): Obj {
  const out: Obj = {};
  if (!isObject(defs)) return out;
  for (const [name, d] of Object.entries(defs)) {
    if (!isObject(d)) continue;
    if (d.type === 'basic') out[name] = { type: 'http', scheme: 'basic' };
    else if (d.type === 'apiKey') out[name] = { type: 'apiKey', in: d.in, name: d.name };
    else if (d.type === 'oauth2') {
      const scopes = isObject(d.scopes) ? d.scopes : {};
      const flow =
        d.flow === 'application'
          ? { clientCredentials: { tokenUrl: d.tokenUrl, scopes } }
          : d.flow === 'accessCode'
            ? {
                authorizationCode: {
                  authorizationUrl: d.authorizationUrl,
                  tokenUrl: d.tokenUrl,
                  scopes,
                },
              }
            : d.flow === 'password'
              ? { password: { tokenUrl: d.tokenUrl, scopes } }
              : { implicit: { authorizationUrl: d.authorizationUrl, scopes } };
      out[name] = { type: 'oauth2', flows: flow };
    }
  }
  return out;
}

/**
 * Convert a dereferenced Swagger 2.0 document to OpenAPI 3.0, in memory.
 * Covers what apitame uses: servers, parameters, bodies, form data,
 * responses, tags and security. Vendor extensions on operations are kept.
 */
export function convertSwagger2(doc: Obj): OpenApiDocument {
  const schemes = Array.isArray(doc.schemes) ? (doc.schemes as string[]) : [];
  const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
  const basePath = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/+$/, '') : '';
  const servers =
    typeof doc.host === 'string'
      ? [{ url: `${scheme}://${doc.host}${basePath}` }]
      : basePath
        ? [{ url: basePath }]
        : [];
  const globalConsumes = Array.isArray(doc.consumes) ? (doc.consumes as string[]) : [];
  const globalProduces = Array.isArray(doc.produces) ? (doc.produces as string[]) : [];

  const paths: Obj = {};
  for (const [path, item] of Object.entries(isObject(doc.paths) ? doc.paths : {})) {
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    const outItem: Obj = {};
    if (shared.length > 0) outItem.parameters = convertParams(shared);
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      // Body and form parameters can be declared on the path item too.
      const all = [
        ...shared.filter(
          (s) => isObject(s) && !own.some((o) => isObject(o) && o.name === s.name && o.in === s.in),
        ),
        ...own,
      ];
      const consumes = Array.isArray(op.consumes) ? (op.consumes as string[]) : globalConsumes;
      const produces = Array.isArray(op.produces) ? (op.produces as string[]) : globalProduces;
      const body = requestBody(all, consumes);
      const converted: Obj = {};
      for (const [k, v] of Object.entries(op)) {
        if (!['parameters', 'consumes', 'produces', 'responses', 'schemes'].includes(k)) {
          converted[k] = v;
        }
      }
      converted.parameters = convertParams(own);
      if (body) converted.requestBody = body;
      converted.responses = responses(op.responses, produces);
      outItem[method] = converted;
    }
    paths[path] = outItem;
  }

  const schemes2 = securitySchemes(doc.securityDefinitions);
  return {
    openapi: '3.0.3',
    info: isObject(doc.info)
      ? (doc.info as OpenApiDocument['info'])
      : { title: 'API', version: '' },
    servers,
    paths,
    ...(Array.isArray(doc.tags) ? { tags: doc.tags as OpenApiDocument['tags'] } : {}),
    ...(Array.isArray(doc.security) ? { security: doc.security } : {}),
    components: {
      ...(Object.keys(schemes2).length > 0 ? { securitySchemes: schemes2 } : {}),
    },
  };
}
