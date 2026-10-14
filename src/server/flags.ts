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
