/**
 * Read the `dryRun` control argument. Tool arguments are not validated by the
 * MCP server, so anything but a clear true or false is refused: a preview must
 * never be sent for real because an agent wrote "dryRun": 1.
 */
export function parseDryRun(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(
    `"dryRun" must be true or false, not ${JSON.stringify(value)}. Nothing was done.`,
  );
}

/**
 * Read the `pages` control argument: how many pages of a list to read. A whole number of at
 * least 1 (a numeric string is accepted too); the runtime caps it at `limits.maxPages`.
 */
export function parsePages(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return n;
  throw new Error(
    `"pages" must be a whole number of at least 1, not ${JSON.stringify(value)}. Nothing was done.`,
  );
}
