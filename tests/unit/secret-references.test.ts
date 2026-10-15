import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  envRefs,
  envValues,
  loadDotEnv,
  resolveEnv,
  UnreadSecretError,
  withSecretValues,
} from '../../src/config/env.js';
import { mockAuth, mockEnv } from '../../src/cli/commands/test.js';
import { parseConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import { REDACTED, Redactor } from '../../src/safety/redact.js';
import type { CliOptions, CliResult, CliRunner } from '../../src/secrets/cli.js';
import { CliOutputTooLargeError, CliTimeoutError } from '../../src/secrets/cli.js';
import {
  placeholderEnvironment,
  SECRET_PLACEHOLDER,
  SecretReferenceError,
  SecretResolver,
  secretReferences,
} from '../../src/secrets/index.js';
import { checkValue, cliEnvironment, PROVIDERS } from '../../src/secrets/providers.js';
import {
  MAX_REFERENCE_LENGTH,
  parseSecretReference,
  type SecretReference,
} from '../../src/secrets/reference.js';
import { tempDir } from '../helpers.js';

const minimal = { name: 'demo', source: { type: 'openapi', spec: './openapi.yaml' } };
const WINDOWS = process.platform === 'win32';

const parsed = (text: string) => {
  const p = parseSecretReference(text);
  if ('problem' in p) throw new Error(p.problem);
  return p;
};

describe('secret manager references: syntax', () => {
  it.each([
    ['op://Private/Stripe/credential', { provider: 'op' }],
    ['op://Dev Vault/Stripe API/live key', { provider: 'op' }],
    ['op://vault/item/section/field', { provider: 'op' }],
    ['op://abcdefghijklmnopqrstuvwxyz/x1y2z3/password', { provider: 'op' }],
    ['op://Contraseñas/Producción/clave-1.2_x', { provider: 'op' }],
    ['aws-sm://prod/stripe', { provider: 'aws-sm', secretId: 'prod/stripe' }],
    ['aws-sm://prod/db#password', { provider: 'aws-sm', secretId: 'prod/db', jsonKey: 'password' }],
    [
      'aws-sm://arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf#username',
      {
        provider: 'aws-sm',
        secretId: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf',
        jsonKey: 'username',
      },
    ],
    [
      'aws-sm://arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:x',
      {
        provider: 'aws-sm',
        secretId: 'arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:x',
      },
    ],
    ['aws-sm:///prod/db', { provider: 'aws-sm', secretId: '/prod/db' }],
    [
      'gcp-sm://projects/my-project/secrets/stripe-key',
      { provider: 'gcp-sm', project: 'my-project', secret: 'stripe-key', version: 'latest' },
    ],
    [
      'gcp-sm://projects/123456789/secrets/db_password/versions/7',
      { provider: 'gcp-sm', project: '123456789', secret: 'db_password', version: '7' },
    ],
    [
      'gcp-sm://projects/example.com:my-project/secrets/s/versions/prod',
      { provider: 'gcp-sm', project: 'example.com:my-project', secret: 's', version: 'prod' },
    ],
  ])('accepts %s', (text, expected) => {
    expect(parsed(text)).toMatchObject({ text, ...expected });
  });

  it.each([
    // Anything that reads like a flag or a second argument, or a shell construct.
    ['op://-vault/item/field', /not a valid reference/],
    ['op://vault/item/--account', /not a valid reference/],
    ['op://vault/item/field --account x', /not a valid reference/],
    ['op://vault/item/field  x', /not a valid reference/],
    ['op://vault/item/field ', /not a valid reference/],
    ['op://vault/item/field\n--account x', /not a valid reference/],
    ['op://vault/item/field\tx', /not a valid reference/],
    ['op://vault/item/field\u0000', /not a valid reference/],
    ['op://$(whoami)/item/field', /not a valid reference/],
    ['op://vault/`id`/field', /not a valid reference/],
    ['op://vault/item/field;id', /not a valid reference/],
    ['op://vault/item/field?attribute=otp', /not a valid reference/],
    ['op://vault/item', /not a valid reference/],
    ['op://a/b/c/d/e', /not a valid reference/],
    // The AWS CLI reads a parameter that starts with one of these from the file or URL.
    ['aws-sm://file:///etc/passwd', /not a valid reference/],
    ['aws-sm://fileb:///etc/passwd', /not a valid reference/],
    ['aws-sm://http://evil.example/x', /not a valid reference/],
    ['aws-sm://https://evil.example/x', /not a valid reference/],
    ['aws-sm://prod:x', /not a valid reference/],
    ['aws-sm://arn:aws:secretsmanager:eu-west-1:1234:secret:x', /not a valid reference/],
    ['aws-sm://arn:aws:s3:eu-west-1:123456789012:secret:x', /not a valid reference/],
    [
      'aws-sm://arn:aws:secretsmanager:eu-west-1:123456789012:secret:file://x',
      /not a valid reference/,
    ],
    ['aws-sm://--profile x', /not a valid reference/],
    ['aws-sm://-secret', /not a valid reference/],
    ['aws-sm://prod/db --region us-east-1', /not a valid reference/],
    ['aws-sm://$(id)', /not a valid reference/],
    ['aws-sm://prod;id', /not a valid reference/],
    ['aws-sm://prod/db#', /not a valid reference/],
    ['aws-sm://prod/db#key with space', /not a valid reference/],
    ['aws-sm://', /not a valid reference/],
    ['gcp-sm://projects/p/secrets/s', /not a valid reference/],
    ['gcp-sm://projects/my-project/secrets/--x', /not a valid reference/],
    ['gcp-sm://projects/my-project/secrets/-x', /not a valid reference/],
    ['gcp-sm://projects/my-project/secrets/s/versions/0', /not a valid reference/],
    ['gcp-sm://projects/my-project/secrets/s/versions/latest --x', /not a valid reference/],
    ['gcp-sm://my-project/s', /not a valid reference/],
    [`op://vault/item/${'a'.repeat(MAX_REFERENCE_LENGTH)}`, /longer than 1024 characters/],
    ['vault://secret/data/x', /unknown secret manager "vault"/],
    ['OP://vault/item/field', /unknown secret manager "OP"/],
  ])('refuses %j', (text, problem) => {
    const p = parseSecretReference(text);
    expect('problem' in p && p.problem).toMatch(problem);
  });

  it('shows a refused reference quoted, escaped and cut, never raw', () => {
    const p = parseSecretReference(`op://vault/item/x\n${'y'.repeat(300)}`);
    const problem = 'problem' in p ? p.problem : '';
    expect(problem).toContain('"${op://vault/item/x\\nyyy');
    expect(problem).not.toContain('\n');
    expect(problem).not.toContain('y'.repeat(200));
  });
});

describe('secret manager references in the config', () => {
  const auth = (token: string) => () =>
    parseConfig({ ...minimal, auth: { type: 'bearer', token } });

  it('counts as a reference in secret fields, with the same composition rules', () => {
    for (const ok of [
      '${op://vault/item/field}',
      'SSWS ${aws-sm://prod/okta#token}',
      '${gcp-sm://projects/my-project/secrets/token}',
      '${op://vault/item/field}${SUFFIX:-}',
    ])
      expect(auth(ok)()).toBeTruthy();
    // A reference that is not valid is refused, with the field, whatever surrounds it.
    expect(auth('${op://vault/item}')).toThrow(/auth\.token: .*not a valid reference/);
    expect(auth('Bearer ${aws-sm://--profile x}')).toThrow(/auth\.token: .*not a valid reference/);
    expect(auth('${vault://x}')).toThrow(/unknown secret manager "vault"/);
    // Still refused: defaults, and literal text next to references that may all be empty.
    expect(auth('hunter2${UNSET:-}')).toThrow(/or a secret manager/);
    expect(auth('${TOKEN:-hunter2}')).toThrow(/must not give a default value/);
  });

  it('is accepted alone in http.oauth.introspection.clientSecret, and nothing else is', () => {
    const introspection = (clientSecret: string) => () =>
      parseConfig({
        ...minimal,
        http: {
          oauth: {
            issuer: 'https://auth.example.com',
            resource: 'https://mcp.example.com/mcp',
            introspection: {
              url: 'https://auth.example.com/introspect',
              clientId: '${op://vault/introspection/username}',
              clientSecret,
            },
          },
        },
      });
    expect(introspection('${op://vault/introspection/password}')()).toBeTruthy();
    expect(introspection('pre-${op://vault/introspection/password}')).toThrow(
      /clientSecret must be environment variable references only/,
    );
    expect(introspection('${op://vault/introspection}')).toThrow(/not a valid reference/);
  });

  it('is checked in every other credential field', () => {
    const bad = '${aws-sm://-x}';
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { source: { ...minimal.source, headers: { 'X-Tenant': bad } } },
        /source\.headers\.X-Tenant/,
      ],
      [{ source: { type: 'postgres', url: bad } }, /source\.url/],
      [{ source: { type: 'mysql', url: `mysql://app:${bad}@db/shop` } }, /source\.url/],
      [{ auth: { type: 'basic', username: bad, password: '${P}' } }, /auth\.username/],
      [
        {
          auth: {
            type: 'oauth2',
            tokenUrl: 'https://x/token',
            clientId: bad,
            clientSecret: '${S}',
          },
        },
        /auth\.clientId/,
      ],
    ];
    for (const [extra, path] of cases) {
      expect(() => parseConfig({ ...minimal, ...extra })).toThrow(path);
      expect(() => parseConfig({ ...minimal, ...extra })).toThrow(/not a valid reference/);
    }
  });

  it('is only read in credential fields, never where requests go or what is opened', () => {
    const ref = '${op://vault/item/field}';
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ source: { ...minimal.source, baseUrl: ref } }, /source\.baseUrl: .*cannot be used here/],
      [
        { source: { ...minimal.source, baseUrl: `https://api.example.com/bot${ref}` } },
        /source\.baseUrl: .*cannot be used here/,
      ],
      [{ source: { type: 'sqlite', path: ref } }, /source\.path: .*cannot be used here/],
      [{ source: { type: 'duckdb', path: `./${ref}.duckdb` } }, /source\.path/],
      [
        {
          auth: { type: 'oauth2', tokenUrl: ref, clientId: 'apitame', clientSecret: '${S}' },
        },
        /auth\.tokenUrl: .*cannot be used here/,
      ],
      // In a database URL, only the whole URL or its user and password.
      [
        { source: { type: 'postgres', url: `postgres://app:pw@${ref}/shop` } },
        /source\.url: .*user or password/,
      ],
      [{ source: { type: 'postgres', url: `postgres://app:pw@db/${ref}` } }, /source\.url/],
      [{ source: { type: 'mysql', url: `mysql://app:pw@db/shop?ssl=${ref}` } }, /source\.url/],
      [{ source: { type: 'postgres', url: `${ref}/shop` } }, /source\.url/],
      [{ source: { type: 'postgres', url: `host=db password=${ref}` } }, /source\.url/],
      // Fields that never read references at all are errors too, not text sent as it is.
      [
        {
          auth: {
            type: 'oauth2',
            tokenUrl: 'https://x/token',
            clientId: 'a',
            clientSecret: '${S}',
            audience: ref,
          },
        },
        /auth\.audience: .*is not read here/,
      ],
      [{ description: `uses ${ref}` }, /description: .*is not read here/],
      [{ tools: [{ name: 'x', description: ref, operations: ['a'] }] }, /tools\.0\.description/],
    ];
    for (const [extra, message] of refused)
      expect(() => parseConfig({ ...minimal, ...extra })).toThrow(message);
    // Environment variables still work in those fields.
    expect(
      parseConfig({
        ...minimal,
        source: { ...minimal.source, baseUrl: 'https://api.example.com/bot${BOT}' },
      }),
    ).toBeTruthy();
    for (const url of [
      ref,
      'postgres://app:${op://vault/db/password}@db.internal:5432/shop?sslmode=require',
      'postgres://${op://vault/db/user}:${op://vault/db/password}@db/shop',
      'postgres://${DB_USER}:${aws-sm://prod/db#password}@${DB_HOST}/shop',
    ])
      expect(parseConfig({ ...minimal, source: { type: 'postgres', url } }).source).toMatchObject({
        url,
      });
    for (const field of ['token', 'value']) {
      const auth =
        field === 'token'
          ? { type: 'bearer', token: ref }
          : { type: 'apiKey', name: 'X', value: ref };
      expect(parseConfig({ ...minimal, auth })).toBeTruthy();
    }
    expect(
      parseConfig({
        ...minimal,
        source: { ...minimal.source, headers: { 'X-Api-Key': `Key ${ref}` } },
      }),
    ).toBeTruthy();
  });

  it('refuses a reference inside a default, which would be sent as written', () => {
    for (const extra of [
      { source: { ...minimal.source, headers: { 'X-Default': '${UNSET:-${op://v/i/user}}' } } },
      { source: { ...minimal.source, baseUrl: 'https://${HOST:-${OTHER}}/v1' } },
      { auth: { type: 'basic', username: '${U:-${op://v/i/user}}', password: '${P}' } },
    ])
      expect(() => parseConfig({ ...minimal, ...extra })).toThrow(
        /a default cannot hold another reference/,
      );
    expect(
      parseConfig({
        ...minimal,
        source: { ...minimal.source, headers: { 'X-Default': '${T:-x}' } },
      }),
    ).toBeTruthy();
  });

  it('has a secrets block with safe defaults, and no say over which program runs', () => {
    expect(parseConfig(minimal).secrets).toEqual({ timeoutSeconds: 15, aws: {} });
    const secrets = (s: Record<string, unknown>) => () => parseConfig({ ...minimal, secrets: s });
    // Where a CLI is comes from the environment that starts apitame, never from the config.
    for (const extra of [
      { op: { cli: '/opt/homebrew/bin/op' } },
      { aws: { cli: '/usr/local/bin/aws' } },
      { gcp: { cli: '/usr/bin/gcloud' } },
      { cli: '/bin/sh' },
    ])
      expect(secrets(extra)).toThrow(
        /APITAME_OP_CLI, APITAME_AWS_CLI or APITAME_GCLOUD_CLI in the environment/,
      );
    expect(secrets({ aws: { region: 'eu-west-1', profile: 'apitame' } })().secrets.aws).toEqual({
      region: 'eu-west-1',
      profile: 'apitame',
    });
    for (const region of ['--region', 'eu west 1', 'EU-WEST-1', 'eu-west-1;id'])
      expect(secrets({ aws: { region } })).toThrow(/region/);
    for (const profile of ['--debug', '-x', 'a b', 'a;b', ''])
      expect(secrets({ aws: { profile } })).toThrow(/profile/);
    expect(secrets({ timeoutSeconds: 0 })).toThrow(/timeoutSeconds/);
    // 1Password references are read one at a time: a long timeout would add up.
    expect(secrets({ timeoutSeconds: 60 })().secrets.timeoutSeconds).toBe(60);
    expect(secrets({ timeoutSeconds: 61 })).toThrow(/timeoutSeconds/);
    expect(secrets({ timeoutMs: 1000 })).toThrow(/Unknown key "timeoutMs" \(use timeoutSeconds\)/);
  });
});

describe('resolving references in config values', () => {
  const values = new Map([['op://vault/item/field', 'fake-op-value-1234']]);

  it('reads values attached to the environment, in one pass', () => {
    const env = withSecretValues({ TOKEN: 'fake-env-${op://vault/item/field}' }, values);
    expect(resolveEnv('Bearer ${op://vault/item/field}', 'auth.token', env)).toBe(
      'Bearer fake-op-value-1234',
    );
    // A value is never searched for references: an environment variable that holds the text of
    // a reference stays that text.
    expect(resolveEnv('${TOKEN}', 'auth.token', env)).toBe('fake-env-${op://vault/item/field}');
    expect(envValues('${TOKEN} ${op://vault/item/field}', env)).toEqual([
      'fake-env-${op://vault/item/field}',
      'fake-op-value-1234',
    ]);
    expect(envRefs('${TOKEN} ${op://vault/item/field}')).toEqual(['TOKEN']);
  });

  it('never takes an environment variable for a reference, and refuses one that was not read', () => {
    // A variable that happens to be named like a reference is not one.
    const env = { 'op://vault/item/field': 'fake-from-env' };
    expect(() => resolveEnv('${op://vault/item/field}', 'auth.token', env)).toThrow(
      UnreadSecretError,
    );
    expect(() =>
      resolveEnv('${op://vault/item/other}', 'auth.token', withSecretValues({}, values)),
    ).toThrow(
      /Secret reference "\$\{op:\/\/vault\/item\/other\}" \(used by auth\.token\) was not read/,
    );
  });

  it('keeps values out of the environment itself, so no child process sees them', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/bin' };
    const env = withSecretValues(base, values);
    expect(Object.keys(env)).toEqual(['PATH']);
    expect(JSON.stringify({ ...env })).not.toContain('fake-op-value');
    // Read only: nothing reaches the environment it wraps through it, process.env included.
    expect(() => {
      env.LOADED = 'x';
    }).toThrow(TypeError);
    expect(() => {
      delete env.PATH;
    }).toThrow(TypeError);
    expect(base).toEqual({ PATH: '/bin' });
    const proc = withSecretValues(process.env, values);
    expect(proc.PATH).toBe(process.env.PATH);
    expect(() => {
      proc.APITAME_TEST_WRITE = 'x';
    }).toThrow(TypeError);
    expect(process.env.APITAME_TEST_WRITE).toBeUndefined();
  });

  it('puts placeholders in place of references for commands that send nothing', () => {
    const config = parseConfig({
      ...minimal,
      source: { type: 'mysql', url: '${op://vault/db/url}' },
    });
    const env = placeholderEnvironment(config, ['auth', 'source'], {});
    expect(
      resolveEnv(config.source.type === 'mysql' ? config.source.url : '', 'source.url', env),
    ).toBe(`mysql://apitame:${SECRET_PLACEHOLDER}@127.0.0.1/apitame`);
    const api = parseConfig({ ...minimal, auth: { type: 'bearer', token: '${op://v/i/f}' } });
    expect(
      resolveEnv('${op://v/i/f}', 'auth.token', placeholderEnvironment(api, ['auth'], {})),
    ).toBe(SECRET_PLACEHOLDER);
  });
});

const ref = (text: string) => parsed(text) as SecretReference;

describe('secret manager CLIs: command lines and answers', () => {
  const settings = parseConfig({
    ...minimal,
    secrets: { aws: { region: 'eu-west-1', profile: 'apitame' } },
  }).secrets;

  it('runs each CLI with a fixed command line and the reference as one argument', () => {
    expect(PROVIDERS.op.args(ref('op://Dev Vault/Stripe/api key'), settings)).toEqual([
      'read',
      '--no-newline',
      'op://Dev Vault/Stripe/api key',
    ]);
    expect(PROVIDERS['aws-sm'].args(ref('aws-sm://prod/db#password'), settings)).toEqual([
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      'prod/db',
      '--query',
      'SecretString',
      '--output',
      'json',
      '--region',
      'eu-west-1',
      '--profile',
      'apitame',
    ]);
    expect(
      PROVIDERS['aws-sm'].args(ref('aws-sm://prod/db'), parseConfig(minimal).secrets),
    ).not.toContain('--region');
    expect(
      PROVIDERS['gcp-sm'].args(ref('gcp-sm://projects/my-project/secrets/db-password'), settings),
    ).toEqual([
      'secrets',
      'versions',
      'access',
      'latest',
      '--secret=db-password',
      '--project=my-project',
      '--format=json',
      '--quiet',
    ]);
  });

  it('reads the value from what each CLI prints, and only that', () => {
    const out = (s: string) => Buffer.from(s);
    expect(PROVIDERS.op.value(out('fake-op-value'), ref('op://v/i/f'))).toBe('fake-op-value');
    const aws = PROVIDERS['aws-sm'];
    expect(aws.value(out('"fake-aws-value"\n'), ref('aws-sm://x'))).toBe('fake-aws-value');
    const json = JSON.stringify(JSON.stringify({ username: 'app', password: 'fake-db-pass' }));
    expect(aws.value(out(json), ref('aws-sm://x#password'))).toBe('fake-db-pass');
    expect(() => aws.value(out(json), ref('aws-sm://x#pasword'))).toThrow(/no key "pasword"/);
    expect(() => aws.value(out('null\n'), ref('aws-sm://x'))).toThrow(/binary secrets/);
    expect(() => aws.value(out('"not json"'), ref('aws-sm://x#k'))).toThrow(/is not JSON/);
    expect(() => aws.value(out('"[1]"'), ref('aws-sm://x#k'))).toThrow(/not a JSON object/);
    expect(() => aws.value(out(JSON.stringify('{"k":1}')), ref('aws-sm://x#k'))).toThrow(
      /does not hold text/,
    );
    // An error never repeats what the secret holds.
    try {
      aws.value(out(json), ref('aws-sm://x#token'));
    } catch (err) {
      expect((err as Error).message).not.toContain('fake-db-pass');
    }
    const gcp = PROVIDERS['gcp-sm'];
    const data = Buffer.from('fake-gcp-value ✓').toString('base64url');
    expect(
      gcp.value(
        out(JSON.stringify({ payload: { data } })),
        ref('gcp-sm://projects/my-project/secrets/s'),
      ),
    ).toBe('fake-gcp-value ✓');
    expect(() => gcp.value(out('{}'), ref('gcp-sm://projects/my-project/secrets/s'))).toThrow(
      /no payload\.data/,
    );
    const binary = Buffer.from([0xff, 0xfe, 0x00]).toString('base64');
    expect(() =>
      gcp.value(
        out(JSON.stringify({ payload: { data: binary } })),
        ref('gcp-sm://projects/my-project/secrets/s'),
      ),
    ).toThrow(/not UTF-8 text/);
    expect(() => PROVIDERS.op.value(Buffer.from([0xc3, 0x28]), ref('op://v/i/f'))).toThrow(
      /not UTF-8 text/,
    );
  });

  it('refuses values that no credential has', () => {
    expect(() => checkValue('')).toThrow(/empty/);
    expect(() => checkValue('fake-value\n')).toThrow(/ends with a line break.*printf/);
    expect(() => checkValue('fake-value\r\n')).toThrow(/ends with a line break/);
    expect(() => checkValue('fake\nvalue')).toThrow(/line break or another control character/);
    expect(() => checkValue('fake\u0000value')).toThrow(/control character/);
    expect(() => checkValue('fake\u007fvalue')).toThrow(/control character/);
    expect(() => checkValue('fake\tvalue with spaces')).not.toThrow();
    // Unicode line breaks, C1 controls and a byte order mark, and values of only spaces.
    for (const odd of [
      'fake\u2028value',
      'fake\u2029value',
      'fake\u0085value',
      '\uFEFFfake-value',
      'fake\u009bvalue',
    ])
      expect(() => checkValue(odd)).toThrow(/control character/);
    for (const blank of ['    ', ' \t ']) expect(() => checkValue(blank)).toThrow(/only spaces/);
  });

  it('explains failures from what the CLI printed, without repeating it', () => {
    const secret = 'fake-secret-in-stderr-123';
    const cases: Array<[keyof typeof PROVIDERS, string, RegExp]> = [
      ['op', `[ERROR] You are not currently signed in. ${secret}`, /not signed in to 1Password/],
      ['op', `[ERROR] "Prod" isn't a vault in this account. ${secret}`, /vault not found/],
      ['op', `[ERROR] "x" isn't an item in the "Prod" vault ${secret}`, /item not found/],
      [
        'aws-sm',
        `An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: ${secret}`,
        /secret not found/,
      ],
      [
        'aws-sm',
        `An error occurred (AccessDeniedException) when calling the GetSecretValue operation: ${secret}`,
        /secretsmanager:GetSecretValue/,
      ],
      [
        'aws-sm',
        `An error occurred (SomethingNew) when calling it: ${secret}`,
        /^AWS answered SomethingNew$/,
      ],
      ['aws-sm', `Unable to locate credentials. ${secret}`, /no AWS credentials/],
      [
        'gcp-sm',
        `ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied ${secret}`,
        /roles\/secretmanager\.secretAccessor/,
      ],
      [
        'gcp-sm',
        `ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [projects/1/secrets/x] not found or has no versions. ${secret}`,
        /secret or version not found/,
      ],
      [
        'gcp-sm',
        `ERROR: (gcloud.secrets.versions.access) You do not currently have an active account selected. ${secret}`,
        /gcloud auth login/,
      ],
    ];
    for (const [provider, stderr, expected] of cases) {
      const why = PROVIDERS[provider].explain(stderr) ?? '';
      expect(why).toMatch(expected);
      expect(why).not.toContain(secret);
    }
    expect(PROVIDERS.op.explain(`something new ${secret}`)).toBeUndefined();
    // Not an AWS error code, however it is written.
    expect(PROVIDERS['aws-sm'].explain(`An error occurred (${secret}) when`)).toBeUndefined();
  });

  it('passes only credentials and a region from .env, which may come with the config', () => {
    const dir = tempDir('apitame-dotenv-cli-');
    try {
      writeFileSync(
        join(dir.dir, '.env'),
        [
          'OP_SERVICE_ACCOUNT_TOKEN=fake-dotenv-op-token',
          'OP_CONNECT_HOST=https://connect.attacker.example',
          'OP_CONFIG_DIR=./evil-op',
          'AWS_ACCESS_KEY_ID=fake-dotenv-key-id',
          'AWS_SECRET_ACCESS_KEY=fake-dotenv-key-secret',
          'AWS_SESSION_TOKEN=fake-dotenv-session',
          'AWS_PROFILE=dotenv-profile',
          'AWS_REGION=eu-west-1',
          'AWS_DEFAULT_REGION=evil.example.com',
          'AWS_CONFIG_FILE=./evil-aws-config',
          'AWS_ENDPOINT_URL=https://attacker.example',
          'CLOUDSDK_PYTHON=./evil-python',
          'CLOUDSDK_CONFIG=./evil-gcloud',
          'HOME=./evil-home',
          'XDG_CONFIG_HOME=./evil-xdg',
          'HTTPS_PROXY=http://attacker.example:3128',
          'PATH=./tools',
          '',
        ].join('\n'),
      );
      // The real environment: its own values keep the usual rules.
      const env: NodeJS.ProcessEnv = { USER: 'u', OP_CONNECT_TOKEN: 'fake-real-connect-token' };
      loadDotEnv(dir.dir, env);
      const keys = (provider: keyof typeof PROVIDERS) =>
        Object.keys(cliEnvironment(PROVIDERS[provider], env)).sort();
      // A Connect host from .env next to the user's own Connect token would send it there.
      expect(keys('op')).toEqual(['OP_CONNECT_TOKEN', 'OP_SERVICE_ACCOUNT_TOKEN', 'USER']);
      expect(keys('aws-sm')).toEqual([
        'AWS_ACCESS_KEY_ID',
        'AWS_PAGER',
        'AWS_PROFILE',
        'AWS_REGION',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'USER',
      ]);
      expect(keys('gcp-sm')).toEqual(['CLOUDSDK_CORE_DISABLE_PROMPTS', 'USER']);
      // With a Connect token from .env too, the pair comes from .env and nothing of the user's
      // goes to that host.
      const both: NodeJS.ProcessEnv = {};
      writeFileSync(
        join(dir.dir, '.env'),
        'OP_CONNECT_HOST=https://connect.example\nOP_CONNECT_TOKEN=fake-dotenv-connect-token\n',
      );
      loadDotEnv(dir.dir, both);
      expect(Object.keys(cliEnvironment(PROVIDERS.op, both)).sort()).toEqual([
        'OP_CONNECT_HOST',
        'OP_CONNECT_TOKEN',
      ]);
    } finally {
      dir.cleanup();
    }
  });

  it('gives each CLI only the environment it needs', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://proxy:3128',
      APITAME_HTTP_TOKEN: 'fake-http-token',
      APITAME_CONFIG: '/x/apitame.config.yaml',
      DATABASE_URL: 'postgres://u:fake-db-password@db/x',
      GITHUB_TOKEN: 'fake-github-token',
      NODE_OPTIONS: '--require /tmp/x.js',
      OP_SERVICE_ACCOUNT_TOKEN: 'fake-op-sa-token',
      AWS_PROFILE: 'prod',
      AWS_PAGER: 'less',
      AWS_CLI_AUTO_PROMPT: 'on',
      CLOUDSDK_CONFIG: '/home/u/.gcloud',
      GCE_METADATA_HOST: '169.254.169.254',
    };
    const keys = (provider: keyof typeof PROVIDERS) =>
      Object.keys(cliEnvironment(PROVIDERS[provider], env)).sort();
    expect(keys('op')).toEqual(['HOME', 'HTTPS_PROXY', 'OP_SERVICE_ACCOUNT_TOKEN', 'PATH']);
    expect(keys('aws-sm')).toEqual(['AWS_PAGER', 'AWS_PROFILE', 'HOME', 'HTTPS_PROXY', 'PATH']);
    expect(cliEnvironment(PROVIDERS['aws-sm'], env).AWS_PAGER).toBe('');
    expect(keys('gcp-sm')).toEqual([
      'CLOUDSDK_CONFIG',
      'CLOUDSDK_CORE_DISABLE_PROMPTS',
      'GCE_METADATA_HOST',
      'HOME',
      'HTTPS_PROXY',
      'PATH',
    ]);
  });
});

/** A config with references, and a folder with files named like the CLIs for PATH lookups. */
const bin = tempDir('apitame-secrets-bin-');
afterAll(() => bin.cleanup());
for (const name of ['op', 'aws', 'gcloud']) {
  for (const file of WINDOWS ? [`${name}.exe`] : [name]) {
    writeFileSync(join(bin.dir, file), '');
    chmodSync(join(bin.dir, file), 0o755);
  }
}
const cliPath = (name: string) => join(bin.dir, WINDOWS ? `${name}.exe` : name);

function configWith(extra: Record<string, unknown>): Config {
  return parseConfig({ ...minimal, ...extra });
}

/** A runner that answers from a table and records every call. */
function fakeRunner(answer: (file: string, args: string[]) => Partial<CliResult> | Error) {
  const calls: Array<{ file: string; args: string[]; opts: CliOptions }> = [];
  let active = 0;
  let maxActive = 0;
  const run: CliRunner = async (file, args, opts) => {
    calls.push({ file, args, opts });
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    const a = answer(file, args);
    if (a instanceof Error) throw a;
    return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: '', ...a };
  };
  return { run, calls, maxActive: () => maxActive };
}

const values: Record<string, string> = {
  'op://vault/api/token': 'fake-op-token-value',
  'op://vault/api/user': 'fake-op-user-value',
  'op://vault/db/password': 'fake op/pass@word',
};
const answerOp = (_file: string, args: string[]) => {
  const v = values[args[2] as string];
  return v === undefined
    ? { code: 1, stderr: `[ERROR] "${args[2]}" isn't an item. fake-leak-in-stderr` }
    : { stdout: Buffer.from(v) };
};

describe('SecretResolver', () => {
  const env = { PATH: bin.dir, HOME: '/home/u', APITAME_HTTP_TOKEN: 'fake-http-token' };

  it('reads every reference once, registers each value, and answers resolveEnv', async () => {
    const fake = fakeRunner(answerOp);
    const resolver = new SecretResolver({ run: fake.run });
    const redactor = new Redactor();
    const config = configWith({
      auth: {
        type: 'basic',
        username: '${op://vault/api/user}',
        password: '${op://vault/api/token}',
      },
      source: {
        ...minimal.source,
        headers: { 'X-Token': '${op://vault/api/token}' },
      },
    });
    const out = await resolver.environment(config, ['auth', 'source'], { redactor, env });
    expect(resolveEnv('${op://vault/api/token}', 'auth.password', out)).toBe('fake-op-token-value');
    // Two references, three fields: two calls, with the CLI found on PATH.
    expect(fake.calls.map((c) => [c.file, c.args])).toEqual([
      [cliPath('op'), ['read', '--no-newline', 'op://vault/api/user']],
      [cliPath('op'), ['read', '--no-newline', 'op://vault/api/token']],
    ]);
    expect(Object.keys(fake.calls[0]!.opts.env).sort()).toEqual(['HOME', 'PATH']);
    expect(fake.calls[0]!.opts.timeoutMs).toBe(15_000);
    expect(redactor.text('a fake-op-token-value b fake-op-user-value')).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
    // A value from a secret manager is a secret wherever it ends up, encoded forms included.
    const withDb = configWith({
      source: { type: 'postgres', url: 'postgres://app:${op://vault/db/password}@db/shop' },
    });
    await resolver.environment(withDb, ['source'], { redactor, env });
    expect(redactor.text(`x ${encodeURIComponent('fake op/pass@word')} y`)).toBe(`x ${REDACTED} y`);
  });

  it('reads once per process: a second build asks again only for new references or settings', async () => {
    const fake = fakeRunner(answerOp);
    const resolver = new SecretResolver({ run: fake.run });
    const config = configWith({ auth: { type: 'bearer', token: '${op://vault/api/token}' } });
    const redactor = new Redactor();
    await resolver.environment(config, ['auth'], { redactor, env });
    const other = new Redactor();
    await resolver.environment(config, ['auth'], { redactor: other, env });
    expect(fake.calls).toHaveLength(1);
    // The cached value is registered with the second command's redactor too.
    expect(other.text('fake-op-token-value')).toBe(REDACTED);
    // Other settings for the CLI (an AWS region): read again.
    const aws = fakeRunner(() => ({ stdout: Buffer.from('"fake-aws-value"') }));
    const awsResolver = new SecretResolver({ run: aws.run });
    const awsConfig = (region: string) =>
      configWith({
        auth: { type: 'bearer', token: '${aws-sm://prod/api}' },
        secrets: { aws: { region } },
      });
    await awsResolver.environment(awsConfig('eu-west-1'), ['auth'], { redactor, env });
    await awsResolver.environment(awsConfig('eu-west-1'), ['auth'], { redactor, env });
    await awsResolver.environment(awsConfig('us-east-1'), ['auth'], { redactor, env });
    expect(aws.calls.map((c) => c.args.at(-1))).toEqual(['eu-west-1', 'us-east-1']);
  });

  it('is all or nothing: one failure stops everything and names fields and references, never values', async () => {
    const fake = fakeRunner(answerOp);
    const resolver = new SecretResolver({ run: fake.run });
    const config = configWith({
      auth: { type: 'bearer', token: '${op://vault/api/token}' },
      source: {
        ...minimal.source,
        headers: { 'X-A': '${op://vault/missing/a}', 'X-B': '${op://vault/missing/b}' },
      },
    });
    const err = await resolver
      .environment(config, ['auth', 'source'], { redactor: new Redactor(), env })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(SecretReferenceError);
    const message = (err as Error).message;
    expect(message).toMatch(/^Could not read 2 secret references:/);
    expect(message).toContain('"${op://vault/missing/a}" (used by source.headers.X-A)');
    expect(message).toContain('"${op://vault/missing/b}" (used by source.headers.X-B)');
    expect(message).toMatch(/exited with code 1: item not found in that vault/);
    expect(message).toContain(`Run ${cliPath('op')} read --no-newline op://vault/missing/a`);
    expect(message).not.toContain('fake-leak-in-stderr');
    expect(message).not.toContain('fake-op-token-value');
  });

  it('runs 1Password calls one at a time and other CLIs in parallel, a few at a time', async () => {
    const op = fakeRunner((_f, args) => ({ stdout: Buffer.from(`fake-${args[2]}`) }));
    const many = (scheme: string, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`X-${i}`, `\${${scheme}${i}}`]));
    await new SecretResolver({ run: op.run }).environment(
      configWith({ source: { ...minimal.source, headers: many('op://vault/item/f', 6) } }),
      ['source'],
      { redactor: new Redactor(), env },
    );
    expect(op.calls).toHaveLength(6);
    expect(op.maxActive()).toBe(1);
    const aws = fakeRunner(() => ({ stdout: Buffer.from('"fake-aws-value"') }));
    await new SecretResolver({ run: aws.run }).environment(
      configWith({ source: { ...minimal.source, headers: many('aws-sm://prod/s', 10) } }),
      ['source'],
      { redactor: new Redactor(), env },
    );
    expect(aws.calls).toHaveLength(10);
    expect(aws.maxActive()).toBe(4);
  });

  it('says what went wrong: no CLI, a timeout, too much output, a bad value', async () => {
    const config = configWith({ auth: { type: 'bearer', token: '${aws-sm://prod/api}' } });
    const failure = async (run: CliRunner, e: NodeJS.ProcessEnv = env) =>
      (
        (await new SecretResolver({ run })
          .environment(config, ['auth'], { redactor: new Redactor(), env: e })
          .catch((err: Error) => err)) as Error
      ).message;
    const never: CliRunner = async () => {
      throw new Error('must not run');
    };
    expect(await failure(never, { PATH: join(bin.dir, 'nothing-here') })).toMatch(
      /aws was not found on PATH\. Install the AWS CLI/,
    );
    expect(await failure(fakeRunner(() => new CliTimeoutError(15_000)).run)).toMatch(
      /did not answer within 15 seconds and was stopped/,
    );
    expect(await failure(fakeRunner(() => new CliOutputTooLargeError(1_048_576)).run)).toMatch(
      /printed more than 1 MB and was stopped/,
    );
    expect(await failure(fakeRunner(() => ({ stdout: Buffer.from('"fake\\n"') })).run)).toMatch(
      /ends with a line break/,
    );
    expect(await failure(fakeRunner(() => ({ stdout: Buffer.from('""') })).run)).toMatch(
      /value is empty/,
    );
    const crashed = fakeRunner(() => ({ code: null, signal: 'SIGSEGV', stderr: 'fake-core' }));
    expect(await failure(crashed.run)).toMatch(/AWS CLI \(aws\) was stopped by SIGSEGV\. Run /);
  });

  it('refuses values too short to be hidden in secret fields', async () => {
    const short = fakeRunner(() => ({ stdout: Buffer.from('abc') }));
    const read = (extra: Record<string, unknown>) =>
      new SecretResolver({ run: short.run })
        .environment(configWith(extra), ['auth', 'source'], { redactor: new Redactor(), env })
        .then(
          () => 'read',
          (err: Error) => err.message,
        );
    for (const extra of [
      { auth: { type: 'bearer', token: '${op://v/i/f}' } },
      { auth: { type: 'apiKey', name: 'X', value: '${op://v/i/f}' } },
      { auth: { type: 'basic', username: 'u', password: '${op://v/i/f}' } },
      { source: { ...minimal.source, headers: { 'X-Key': '${op://v/i/f}' } } },
      { source: { type: 'postgres', url: 'postgres://app:${op://v/i/f}@db/shop' } },
    ])
      expect(await read(extra)).toMatch(/fewer than 4 characters, too few to be hidden/);
    // A short user name is no secret on its own.
    expect(
      await read({ auth: { type: 'basic', username: '${op://v/i/f}', password: '${P}' } }),
    ).toBe('read');
  });

  it('finds a CLI through APITAME_*_CLI from the real environment, never from .env', async () => {
    const fake = fakeRunner(answerOp);
    const config = configWith({ auth: { type: 'bearer', token: '${op://vault/api/token}' } });
    const read = (e: NodeJS.ProcessEnv) =>
      new SecretResolver({ run: fake.run })
        .environment(config, ['auth'], { redactor: new Redactor(), env: e })
        .then(
          () => fake.calls.at(-1)?.file,
          (err: Error) => err.message,
        );
    // Set by the environment that starts apitame: used, without PATH.
    expect(await read({ APITAME_OP_CLI: cliPath('op') })).toBe(cliPath('op'));
    expect(await read({ APITAME_OP_CLI: 'op' })).toMatch(/APITAME_OP_CLI must be an absolute path/);
    expect(await read({ APITAME_OP_CLI: join(bin.dir, 'missing') })).toMatch(
      /APITAME_OP_CLI \(.*missing\) is not an executable file/,
    );
    // Set by .env, which may come with the config: refused, and so is a PATH it sets.
    const dir = tempDir('apitame-dotenv-cli-path-');
    try {
      writeFileSync(join(dir.dir, '.env'), `APITAME_OP_CLI=${cliPath('op')}\nPATH=${bin.dir}\n`);
      const fromDotEnv: NodeJS.ProcessEnv = {};
      loadDotEnv(dir.dir, fromDotEnv);
      expect(await read(fromDotEnv)).toMatch(
        /APITAME_OP_CLI is set in \.env, which cannot choose a program/,
      );
      delete fromDotEnv.APITAME_OP_CLI;
      expect(await read(fromDotEnv)).toMatch(/op was not found on PATH/);
    } finally {
      dir.cleanup();
    }
  });

  it('logs each reference read, never its value', async () => {
    const lines: string[] = [];
    const resolver = new SecretResolver({
      run: fakeRunner(answerOp).run,
      log: (l) => lines.push(l),
    });
    await resolver.environment(
      configWith({
        auth: {
          type: 'basic',
          username: '${op://vault/api/user}',
          password: '${op://vault/api/token}',
        },
      }),
      ['auth'],
      { redactor: new Redactor(), env },
    );
    expect(lines).toEqual([
      `read secret reference "\${op://vault/api/user}" for auth.username with ${cliPath('op')}`,
      `read secret reference "\${op://vault/api/token}" for auth.password with ${cliPath('op')}`,
    ]);
    expect(lines.join('\n')).not.toContain('fake-op');
  });

  it('checks references for doctor without reading them offline', async () => {
    const fake = fakeRunner(answerOp);
    const resolver = new SecretResolver({ run: fake.run });
    const config = configWith({ auth: { type: 'bearer', token: '${op://vault/api/token}' } });
    const offline = await resolver.check(config, ['auth'], {
      redactor: new Redactor(),
      env,
      offline: true,
    });
    expect(offline).toEqual([
      {
        reference: 'op://vault/api/token',
        provider: 'op',
        fields: ['auth.token'],
        cli: cliPath('op'),
      },
    ]);
    expect(fake.calls).toHaveLength(0);
    const online = await resolver.check(config, ['auth'], { redactor: new Redactor(), env });
    expect(online[0]).toMatchObject({ ok: true, cli: cliPath('op') });
    expect(JSON.stringify(online)).not.toContain('fake-op-token-value');
  });

  it('lists references by scope, so introspection secrets are only read when needed', () => {
    const config = configWith({
      auth: { type: 'bearer', token: '${op://vault/api/token}' },
      http: {
        oauth: {
          issuer: 'https://auth.example.com',
          resource: 'https://mcp.example.com/mcp',
          introspection: {
            url: 'https://auth.example.com/introspect',
            clientId: 'apitame',
            clientSecret: '${gcp-sm://projects/my-project/secrets/introspection}',
          },
        },
      },
    });
    expect(secretReferences(config, ['auth', 'source']).map((u) => u.reference.text)).toEqual([
      'op://vault/api/token',
    ]);
    expect(secretReferences(config, ['introspection'])).toEqual([
      {
        reference: expect.objectContaining({ provider: 'gcp-sm', secret: 'introspection' }),
        fields: ['http.oauth.introspection.clientSecret'],
      },
    ]);
  });
});

describe('redaction of values read', () => {
  it('hides the JSON-escaped form too, in text that is not parsed as JSON', () => {
    const redactor = new Redactor();
    const secret = 'pa"ss\\word-9999';
    redactor.addSecret(secret);
    const html = `<p>${JSON.stringify(secret)}</p>`;
    expect(redactor.text(html)).toBe(`<p>"${REDACTED}"</p>`);
    expect(redactor.text(`raw ${secret}`)).toBe(`raw ${REDACTED}`);
  });
});

describe('test against the mock', () => {
  it('sends fake credentials of the same kind, never configured ones', () => {
    expect(mockAuth({ type: 'none' })).toEqual({ type: 'none' });
    expect(mockAuth({ type: 'bearer', token: '${op://v/i/f}' })).toEqual({
      type: 'bearer',
      token: 'apitame-mock-credential',
    });
    expect(mockAuth({ type: 'apiKey', in: 'header', name: 'X-Key', value: '${KEY}' })).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-Key',
      value: 'apitame-mock-credential',
    });
    // No client credentials grant, so nothing asks the real token endpoint.
    expect(
      mockAuth({
        type: 'oauth2',
        flow: 'client_credentials',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'a',
        clientSecret: '${S}',
        scopes: [],
        clientAuthMethod: 'client_secret_basic',
      }),
    ).toEqual({ type: 'bearer', token: 'apitame-mock-credential' });
    const config = parseConfig({
      ...minimal,
      source: { ...minimal.source, headers: { 'X-Tenant': '${TENANT_KEY}' } },
    });
    const before = process.env.TENANT_KEY;
    process.env.TENANT_KEY = 'fake-real-tenant-key';
    try {
      // A real value for a static header is not sent to the mock either.
      expect(mockEnv({ config, path: '/x/apitame.config.yaml', dir: '/x' }).TENANT_KEY).toBe(
        'apitame-mock-credential',
      );
    } finally {
      if (before === undefined) delete process.env.TENANT_KEY;
      else process.env.TENANT_KEY = before;
    }
  });
});
