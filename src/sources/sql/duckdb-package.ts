/**
 * Names and messages for the optional DuckDB driver. Kept apart from the driver so the
 * CLI can mention it (init, add-to, doctor) without loading any SQL code.
 */

/** The driver is an optional peer dependency: it is not installed with apitame. */
export const DUCKDB_PACKAGE = '@duckdb/node-api';

/**
 * The driver release apitame is tested with, pinned in client configs and hints so every
 * start runs the same DuckDB. To move to a newer release: update the devDependency in
 * package.json and this constant, run the test suite, and check docs/sql.md.
 */
export const DUCKDB_TESTED_VERSION = '1.5.6-r.1';

/** The pinned package spec, for npx -p and npm install. */
export const DUCKDB_SPEC = `${DUCKDB_PACKAGE}@${DUCKDB_TESTED_VERSION}`;

/** How to run apitame with the driver without installing anything. */
export const DUCKDB_NPX = `npx -p apitame -p ${DUCKDB_SPEC} apitame`;

/** The command to suggest for a source: DuckDB needs the driver next to apitame. */
export function apitameCommand(sourceType: string): string {
  return sourceType === 'duckdb' ? DUCKDB_NPX : 'npx apitame';
}

export function duckdbMissingMessage(detail?: string): string {
  return [
    `DuckDB support needs the "${DUCKDB_PACKAGE}" package, which apitame does not install by default (its native binary adds 40 to 120 MB).`,
    `Run apitame together with it, for example: ${DUCKDB_NPX} init ./data.duckdb`,
    `(the same works for serve, test, inspect and doctor), or install it next to apitame: npm install ${DUCKDB_SPEC}`,
    ...(detail ? [`(loading it failed with: ${detail})`] : []),
  ].join('\n');
}
