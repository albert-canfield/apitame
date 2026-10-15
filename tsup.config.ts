import { defineConfig } from 'tsup';

export default defineConfig({
  // One build for the CLI and the library, so both share chunks (the SQL code loads on demand).
  // duckdb-worker is the DuckDB child process; the driver forks it from dist/duckdb-worker.js.
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    'duckdb-worker': 'src/sources/sql/duckdb-worker.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: true,
  clean: true,
  // Source maps of the bundled SQL parsers would add several megabytes to every install.
  sourcemap: false,
  dts: { entry: { index: 'src/index.ts' } },
  banner: { js: '#!/usr/bin/env node' },
  // Bundle the three SQL dialect parsers instead of installing the whole package (about 88 MB).
  noExternal: ['node-sql-parser', 'big-integer'],
  // Optional peer dependencies, loaded with import() only when needed: the DuckDB driver for
  // DuckDB sources, OpenTelemetry when an OTLP endpoint is set (src/telemetry/otel.ts).
  external: ['@duckdb/node-api', /^@opentelemetry\//],
});
