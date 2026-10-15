/**
 * Secret manager references. Credential fields (see ReferencePlacement) read, next to `${VAR}`,
 *
 * - `${op://vault/item/field}` or `${op://vault/item/section/field}` (1Password, through `op`),
 * - `${aws-sm://secret-id}` or `${aws-sm://secret-id#key}` (AWS Secrets Manager, through `aws`),
 * - `${gcp-sm://projects/p/secrets/s}` or `.../versions/v` (Google Secret Manager, through `gcloud`).
 *
 * A scheme followed by `://` can never be an environment variable name, so the two kinds of
 * reference cannot be confused. Each reference is checked here against a strict pattern before
 * any program sees it: it becomes one argument of a fixed command line, never a flag or a second
 * argument, and no shell is involved.
 */

export type SecretProvider = 'op' | 'aws-sm' | 'gcp-sm';

export const SECRET_PROVIDERS: readonly SecretProvider[] = ['op', 'aws-sm', 'gcp-sm'];

/**
 * A `${NAME}`, `${NAME:-default}` or `${scheme://...}` reference. Groups: 1 the variable name,
 * 2 its default, 3 the secret manager reference (`op://...`, without `${` and `}`).
 */
export const REFERENCE_SOURCE = String.raw`\$\{(?:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?|([A-Za-z][A-Za-z0-9+.-]*:\/\/[^}]*))\}`;

/** The longest secret manager reference accepted, `op://` and the like included. */
export const MAX_REFERENCE_LENGTH = 1024;

export type SecretReference =
  | { provider: 'op'; text: string }
  | { provider: 'aws-sm'; text: string; secretId: string; jsonKey?: string }
  | { provider: 'gcp-sm'; text: string; project: string; secret: string; version: string };

/**
 * A 1Password name: letters, digits, spaces, `-`, `_` and `.`, which is what 1Password accepts
 * in a secret reference (other names are written as their ID). It never starts with `-` or a
 * space, never ends with a space, and a space is never followed by another space or a `-`, so
 * nothing in it reads like a flag (`field --account x`), even though it is one argument anyway.
 */
const OP_NAME = String.raw`[\p{L}\p{N}_.](?:[\p{L}\p{N}_.-]| (?![ /-]|$))*`;
const OP_REF = new RegExp(
  String.raw`^op:\/\/${OP_NAME}\/${OP_NAME}(?:\/${OP_NAME})?\/${OP_NAME}$`,
  'u',
);

/**
 * An AWS secret name (letters, digits and `/_+=.@-`, never `:`, not starting with `-`) or a full
 * ARN, then an optional `#key` of the JSON object stored in the secret. Nothing else: the AWS CLI
 * reads any parameter that starts with `file://`, `fileb://`, `http://` or `https://` from that
 * file or URL, and none of those can match without a `:` outside an ARN.
 */
const AWS_NAME = String.raw`[A-Za-z0-9/_+=.@][A-Za-z0-9/_+=.@-]{0,511}`;
const AWS_ARN = String.raw`arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+`;
const AWS_REF = new RegExp(
  String.raw`^aws-sm:\/\/(${AWS_NAME}|${AWS_ARN})(?:#([A-Za-z0-9_.@+/-]{1,256}))?$`,
);

/** A project id (or number, or a domain-scoped id), a secret id, and a version number or alias. */
const GCP_PROJECT = String.raw`[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20}|[a-z0-9][a-z0-9.-]{0,62}:[a-z][a-z0-9-]{4,28}[a-z0-9]`;
const GCP_REF = new RegExp(
  String.raw`^gcp-sm:\/\/projects\/(${GCP_PROJECT})\/secrets\/([A-Za-z0-9_][A-Za-z0-9_-]{0,254})(?:\/versions\/([1-9][0-9]{0,18}|[A-Za-z][A-Za-z0-9_-]{0,62}))?$`,
);

const HELP: Record<SecretProvider, string> = {
  op: 'use op://vault/item/field or op://vault/item/section/field, with names made of letters, digits, spaces, "-", "_" and "." that do not start with "-" (write the ID for any other name)',
  'aws-sm':
    'use aws-sm://secret-name or aws-sm://secret-name#key, with a secret name made of letters, digits and "/_+=.@-" that does not start with "-" (or the full ARN, arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME), and a key made of letters, digits and "_.@+/-"',
  'gcp-sm':
    'use gcp-sm://projects/PROJECT/secrets/SECRET or gcp-sm://projects/PROJECT/secrets/SECRET/versions/VERSION, with a project id or number, a secret id made of letters, digits, "_" and "-", and a version number, latest or an alias',
};

/** A reference as it may be shown in a message: quoted, control characters escaped, cut when long. */
export function shownReference(text: string): string {
  const cut = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  return JSON.stringify(`\${${cut}}`);
}

/**
 * Parse a secret manager reference (the text between `${` and `}`), or say what is wrong with it.
 * Nothing is accepted that a pattern does not describe exactly.
 */
export function parseSecretReference(text: string): SecretReference | { problem: string } {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text)?.[1];
  const shown = shownReference(text);
  if (!scheme || !(SECRET_PROVIDERS as readonly string[]).includes(scheme)) {
    return {
      problem: `${shown} names an unknown secret manager${scheme ? ` "${scheme}"` : ''}. Use op:// (1Password), aws-sm:// (AWS Secrets Manager) or gcp-sm:// (Google Secret Manager).`,
    };
  }
  const provider = scheme as SecretProvider;
  if (text.length > MAX_REFERENCE_LENGTH) {
    return { problem: `${shown} is longer than ${MAX_REFERENCE_LENGTH} characters.` };
  }
  if (provider === 'op' && OP_REF.test(text)) return { provider, text };
  if (provider === 'aws-sm') {
    const m = AWS_REF.exec(text);
    if (m) return { provider, text, secretId: m[1] as string, ...(m[2] ? { jsonKey: m[2] } : {}) };
  }
  if (provider === 'gcp-sm') {
    const m = GCP_REF.exec(text);
    if (m) {
      return {
        provider,
        text,
        project: m[1] as string,
        secret: m[2] as string,
        version: m[3] ?? 'latest',
      };
    }
  }
  return { problem: `${shown} is not a valid reference: ${HELP[provider]}.` };
}

/** The secret manager references in a value, as written between `${` and `}`. */
export function secretReferencesIn(value: string): string[] {
  return [...value.matchAll(new RegExp(REFERENCE_SOURCE, 'g'))]
    .map((m) => m[3])
    .filter((t): t is string => t !== undefined);
}

/**
 * Where a config field may hold secret manager references:
 *
 * - `anywhere`: credential fields (the credentials under `auth` and `http.oauth.introspection`,
 *   and `source.headers` values);
 * - `userinfo`: a database URL, as the whole URL or as its user and password only;
 * - `never`: every other field that reads `${VAR}` (`source.baseUrl`, `auth.tokenUrl`,
 *   `source.path`), since it chooses where requests go or what is opened.
 */
export type ReferencePlacement = 'anywhere' | 'userinfo' | 'never';

/** Where secret manager references are read, for messages. */
export const CREDENTIAL_FIELDS =
  'the credentials under auth and http.oauth.introspection, source.headers values, and the user and password of a database URL';

/** Whether every secret manager reference in a URL template sits in its user and password. */
function onlyInUserinfo(value: string): boolean {
  if (/^\$\{[^}]*\}$/.test(value) && secretReferencesIn(value).length === 1) return true;
  // References become one character each, so their own `/` and `:` do not count.
  const masked = value.replace(new RegExp(REFERENCE_SOURCE, 'g'), (_m, name?: string) =>
    name === undefined ? '\u0001' : 'v',
  );
  const total = masked.split('\u0001').length - 1;
  const scheme = masked.indexOf('://');
  if (scheme < 0) return false;
  const rest = masked.slice(scheme + 3);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? '' : authority.slice(0, at);
  return userinfo.split('\u0001').length - 1 === total;
}

/** What is wrong with the references in a config value, if anything. */
export function referenceProblem(
  value: string,
  placement: ReferencePlacement = 'anywhere',
): string | undefined {
  const all = [...value.matchAll(new RegExp(REFERENCE_SOURCE, 'g'))];
  // `${UNSET:-${op://...}}` would be sent as written: nothing reads a reference in a default.
  if (all.some((m) => m[2]?.includes('${'))) {
    return 'a default cannot hold another reference ("${NAME:-${...}}"): references inside a default are never read. Set the variable instead.';
  }
  const texts = secretReferencesIn(value);
  for (const text of texts) {
    const parsed = parseSecretReference(text);
    if ('problem' in parsed) return parsed.problem;
  }
  if (texts.length === 0) return undefined;
  const shown = shownReference(texts[0] as string);
  if (placement === 'never') {
    return `${shown} cannot be used here. Secret manager references are only read in credential fields (${CREDENTIAL_FIELDS}), never in a field that chooses where requests go or what is opened. Use an environment variable here.`;
  }
  if (placement === 'userinfo' && !onlyInUserinfo(value)) {
    return `${shown} can only be the whole connection URL or its user or password ("postgres://app:\${op://vault/db/password}@db.internal/shop"), not the host, port, database or options.`;
  }
  return undefined;
}
