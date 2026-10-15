import type { SecretsConfig } from '../config/schema.js';
import type { SecretProvider, SecretReference } from './reference.js';

const WINDOWS = process.platform === 'win32';

/** A value apitame refuses to use, said without the value. */
export class SecretValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretValueError';
  }
}

/** How apitame talks to one secret manager's CLI. */
export interface Provider {
  /** For messages: `1Password CLI (op)`. */
  label: string;
  /** Where its settings live under `secrets`. */
  key: 'op' | 'aws' | 'gcp';
  /** How many calls may run at once. */
  concurrency: number;
  /** What to do when the CLI is not found. */
  install: string;
  /** Its own environment variables, passed on by prefix. */
  envPrefixes: string[];
  /** Variables passed on by name, on top of the common ones. */
  envNames: string[];
  /** Variables set for every call, overriding the environment. */
  envFixed: Record<string, string>;
  /** Variables never passed on, even with a matching prefix. */
  envDropped: string[];
  /** The arguments after the program name. */
  args(ref: SecretReference, settings: SecretsConfig): string[];
  /** The secret from what the CLI printed. */
  value(stdout: Buffer, ref: SecretReference): string;
  /** A short explanation of a failure, picked from what the CLI printed on stderr. */
  explain(stderr: string): string | undefined;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Bytes as UTF-8 text, refusing anything else (binary secrets are not supported). */
function text(bytes: Buffer, what: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new SecretValueError(
      `${what} is not UTF-8 text. Binary secrets are not supported: store the value as text.`,
    );
  }
}

function json(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SecretValueError(`${what} is not JSON.`);
  }
}

/** The first rule that matches. Rules name causes; they never repeat what the CLI printed. */
function firstMatch(stderr: string, rules: Array<[RegExp, string]>): string | undefined {
  return rules.find(([pattern]) => pattern.test(stderr))?.[1];
}

const OP_RULES: Array<[RegExp, string]> = [
  [
    /not currently signed in|account is not signed in|not signed in|no active session|session expired|sign in to/i,
    'not signed in to 1Password. Sign in (op signin), turn on the 1Password app integration, or set OP_SERVICE_ACCOUNT_TOKEN',
  ],
  [
    /authorization (prompt )?(was )?(dismissed|denied|timed? ?out)|did not authorize|not authorized by the user/i,
    'the 1Password app did not authorize the request',
  ],
  [
    /no accounts? (are )?(configured|found)|add an account/i,
    'no 1Password account is set up for this user',
  ],
  [
    /invalid (service account )?token|token is invalid|401|unauthorized/i,
    '1Password refused the token',
  ],
  [/rate limit|too many requests|429/i, '1Password rate limit reached'],
  [/isn't a vault|vault .*not found|no vault/i, 'vault not found, or not shared with this account'],
  [/isn't an item|item .*not found|no item/i, 'item not found in that vault'],
  [
    /isn't a field|field .*not found|no field|does not have a field/i,
    'field not found in that item',
  ],
  [
    /could not resolve|connection refused|network|timeout|no such host/i,
    'could not reach 1Password',
  ],
];

const AWS_CODES: Record<string, string> = {
  ResourceNotFoundException:
    'secret not found: check its name, secrets.aws.region (or AWS_REGION) and the account',
  AccessDeniedException:
    'access denied: the credentials need secretsmanager:GetSecretValue on the secret, and kms:Decrypt when it uses a customer managed key',
  DecryptionFailure: 'AWS could not decrypt the secret with its KMS key',
  InvalidRequestException:
    'AWS refused the request (for example a secret that is scheduled for deletion)',
  InvalidParameterException: 'AWS refused a parameter of the request',
  UnrecognizedClientException: 'AWS refused the credentials',
  InvalidClientTokenId: 'AWS refused the credentials',
  ExpiredTokenException: 'the AWS credentials have expired',
  ExpiredToken: 'the AWS credentials have expired',
};

const AWS_RULES: Array<[RegExp, string]> = [
  [
    /Unable to locate credentials|NoCredentials/i,
    'no AWS credentials: configure a profile (secrets.aws.profile or AWS_PROFILE), environment credentials or a role',
  ],
  [
    /must specify a region|NoRegion/i,
    'no AWS region: set secrets.aws.region, AWS_REGION or a region in the profile',
  ],
  [/config profile .*could not be found|ProfileNotFound/i, 'the AWS profile does not exist'],
  [
    /SSO.*(expired|invalid)|Token has expired|refresh failed|aws sso login/i,
    'the AWS SSO session has expired: run aws sso login',
  ],
  [
    /Could not connect to the endpoint|EndpointConnectionError|Connect timeout|Read timeout/i,
    'could not reach AWS Secrets Manager',
  ],
];

const GCP_RULES: Array<[RegExp, string]> = [
  [
    /SERVICE_DISABLED|API has not been used|is not enabled|API .*disabled/i,
    'the Secret Manager API is not enabled in that project',
  ],
  [
    /PERMISSION_DENIED|does not have .*permission|Permission .* denied/i,
    'permission denied: the account needs the Secret Manager Secret Accessor role (roles/secretmanager.secretAccessor) on the secret',
  ],
  [/NOT_FOUND|not found or has no versions/i, 'secret or version not found'],
  [
    /FAILED_PRECONDITION|is in DISABLED state|is in DESTROYED state/i,
    'that version is disabled or destroyed',
  ],
  [
    /UNAUTHENTICATED|do not currently have an active account|gcloud auth login|Reauthentication|refresh token|credentials? (are|is) (invalid|expired)/i,
    'not signed in to Google Cloud: run gcloud auth login, or use a service account (see docs/configuration.md)',
  ],
  [/INVALID_ARGUMENT/, 'Google Cloud refused an argument of the request'],
  [/RESOURCE_EXHAUSTED|quota/i, 'Google Cloud quota exceeded'],
  [/UNAVAILABLE|Unable to find the server|connection/i, 'could not reach Google Secret Manager'],
];

export const PROVIDERS: Record<SecretProvider, Provider> = {
  op: {
    label: '1Password CLI (op)',
    key: 'op',
    // With the 1Password app integration, the first call asks the user to authorize and the
    // next ones reuse it: one call at a time asks once.
    concurrency: 1,
    install:
      'Install the 1Password CLI (https://developer.1password.com/docs/cli/get-started/), or set secrets.op.cli to its absolute path',
    envPrefixes: ['OP_'],
    envNames: [],
    envFixed: {},
    envDropped: [],
    // `op read <reference> [flags]`; -n, --no-newline: "Do not print a new line after the secret."
    args: (ref) => ['read', '--no-newline', ref.text],
    value: (stdout) => text(stdout, 'The value'),
    explain: (stderr) => firstMatch(stderr, OP_RULES),
  },
  'aws-sm': {
    label: 'AWS CLI (aws)',
    key: 'aws',
    concurrency: 4,
    install:
      'Install the AWS CLI (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), or set secrets.aws.cli to its absolute path',
    envPrefixes: ['AWS_'],
    envNames: [],
    // No pager (the CLI v2 pipes long output through less), and never the interactive prompt.
    envFixed: { AWS_PAGER: '' },
    envDropped: ['AWS_PAGER', 'AWS_CLI_AUTO_PROMPT'],
    args: (ref, settings) => {
      if (ref.provider !== 'aws-sm') throw new Error('not an aws-sm reference');
      const { region, profile } = settings.aws;
      return [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        ref.secretId,
        // SecretString only, as JSON: a JSON string, or null for a binary secret. A key is
        // read from it here, not through --query.
        '--query',
        'SecretString',
        '--output',
        'json',
        ...(region ? ['--region', region] : []),
        ...(profile ? ['--profile', profile] : []),
      ];
    },
    value: (stdout, ref) => {
      if (ref.provider !== 'aws-sm') throw new Error('not an aws-sm reference');
      const secret = json(text(stdout, 'The answer').trim(), 'The answer of the AWS CLI');
      if (secret === null) {
        throw new SecretValueError(
          'The secret has no SecretString: binary secrets (SecretBinary) are not supported.',
        );
      }
      if (typeof secret !== 'string') {
        throw new SecretValueError('The answer of the AWS CLI is not a SecretString.');
      }
      if (ref.jsonKey === undefined) return secret;
      const object = json(secret, `The secret (read for #${ref.jsonKey})`);
      if (typeof object !== 'object' || object === null || Array.isArray(object)) {
        throw new SecretValueError(
          `The secret is not a JSON object, so it has no key "${ref.jsonKey}".`,
        );
      }
      if (!Object.hasOwn(object, ref.jsonKey)) {
        throw new SecretValueError(`The secret's JSON object has no key "${ref.jsonKey}".`);
      }
      const value = (object as Record<string, unknown>)[ref.jsonKey];
      if (typeof value !== 'string') {
        throw new SecretValueError(`The secret's key "${ref.jsonKey}" does not hold text.`);
      }
      return value;
    },
    explain: (stderr) => {
      const code = /An error occurred \(([A-Za-z]{1,64})\)/.exec(stderr)?.[1];
      if (code) return AWS_CODES[code] ?? `AWS answered ${code}`;
      return firstMatch(stderr, AWS_RULES);
    },
  },
  'gcp-sm': {
    label: 'Google Cloud CLI (gcloud)',
    key: 'gcp',
    concurrency: 4,
    install: WINDOWS
      ? 'On Windows gcloud is a batch file, which apitame cannot run without a shell: pass the value in an environment variable instead'
      : 'Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), or set secrets.gcp.cli to its absolute path',
    envPrefixes: ['CLOUDSDK_'],
    // Where the metadata server is, on Google Cloud and in emulators.
    envNames: ['GCE_METADATA_HOST', 'GCE_METADATA_IP'],
    envFixed: { CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
    envDropped: [],
    args: (ref) => {
      if (ref.provider !== 'gcp-sm') throw new Error('not a gcp-sm reference');
      return [
        'secrets',
        'versions',
        'access',
        ref.version,
        `--secret=${ref.secret}`,
        `--project=${ref.project}`,
        // The whole answer as JSON, with the payload in base64: the exact bytes, whatever they
        // are, instead of text that gcloud may have re-encoded.
        '--format=json',
        '--quiet',
      ];
    },
    value: (stdout) => {
      const answer = json(text(stdout, 'The answer').trim(), 'The answer of gcloud') as {
        payload?: { data?: unknown };
      } | null;
      const data = answer?.payload?.data;
      if (typeof data !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) {
        throw new SecretValueError('The answer of gcloud has no payload.data.');
      }
      return text(Buffer.from(data, 'base64'), 'The value');
    },
    explain: (stderr) => firstMatch(stderr, GCP_RULES),
  },
};

/**
 * What the CLI needs from the environment, and nothing else: no `APITAME_*` variable, no
 * database URL, no API token read for another field. Common variables (where the home folder,
 * temporary folder and proxy are, the language), the provider's own variables by prefix, and the
 * fixed ones.
 */
const COMMON_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Windows
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'USERNAME',
];

export function cliEnvironment(provider: Provider, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const named = new Set(
    [...COMMON_ENV, ...provider.envNames].map((n) => (WINDOWS ? n.toUpperCase() : n)),
  );
  const dropped = new Set(provider.envDropped.map((n) => (WINDOWS ? n.toUpperCase() : n)));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = WINDOWS ? name.toUpperCase() : name;
    if (dropped.has(key)) continue;
    if (named.has(key) || provider.envPrefixes.some((p) => key.startsWith(p))) out[name] = value;
  }
  return { ...out, ...provider.envFixed };
}

/**
 * Refuse values that cannot be meant: empty, or with a line break or another control character
 * (which no header, URL or password field takes). Tabs are allowed.
 */
export function checkValue(value: string): void {
  if (value === '') throw new SecretValueError('The value is empty.');
  if (/[\r\n]$/.test(value) && !/[\r\n]/.test(value.replace(/\r?\n$/, ''))) {
    throw new SecretValueError(
      'The value ends with a line break, which no credential has. Store it without one (printf, not echo).',
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0A-\x1F\x7F]/.test(value)) {
    throw new SecretValueError('The value contains a line break or another control character.');
  }
}
