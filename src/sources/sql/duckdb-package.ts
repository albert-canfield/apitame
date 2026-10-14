/**
 * Names and messages for the optional DuckDB driver. Kept apart from the driver so the
 * CLI can mention it (init, add-to, doctor) without loading any SQL code.
 */

/** The driver is an optional peer dependency: it is not installed with apitame. */
export const DUCKDB_PACKAGE = '@duckdb/node-api';

/** How to run apitame with the driver without installing anything. */
export const DUCKDB_NPX = `npx -p apitame -p ${DUCKDB_PACKAGE} apitame`;

/** The command to suggest for a source: DuckDB needs the driver next to apitame. */
export function apitameCommand(sourceType: string): string {
  return sourceType === 'duckdb' ? DUCKDB_NPX : 'npx apitame';
}

export function duckdbMissingMessage(detail?: string): string {
  return [
    `DuckDB support needs the "${DUCKDB_PACKAGE}" package, which apitame does not install by default (its native binary adds 40 to 120 MB).`,
    `Run apitame together with it, for example: ${DUCKDB_NPX} init ./data.duckdb`,
    `(the same works for serve, test, inspect and doctor), or install it next to apitame: npm install ${DUCKDB_PACKAGE}`,
    ...(detail ? [`(loading it failed with: ${detail})`] : []),
  ].join('\n');
}
