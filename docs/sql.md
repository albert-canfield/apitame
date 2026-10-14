# SQL sources

apitame serves PostgreSQL, MySQL (and MariaDB), SQLite and DuckDB databases as MCP tools: browse the schema, run read-only SELECT queries, and expose reviewed, parameterized queries as their own tools.

## Quick start

```bash
# PostgreSQL: the URL is saved to .env as DATABASE_URL, the config only references it
npx apitame init postgres://apitame_ro:password@localhost:5432/shop

# MySQL or MariaDB: same handling of the URL
npx apitame init mysql://apitame_ro:password@localhost:3306/shop

# Or point at a variable you already have
npx apitame init '$DATABASE_URL'

# SQLite: any .db, .sqlite, .sqlite3 or .db3 file, or any file with a SQLite header
npx apitame init ./shop.db

# DuckDB: the driver is an optional extra, so run apitame together with it (see DuckDB below)
npx -p apitame -p @duckdb/node-api apitame init ./data.duckdb

npx apitame test       # describes every table, runs a sample query, tries known injection payloads
npx apitame inspect
```

`init` introspects the schema and writes a skill with the tables, their relationships and example joins, so the agent starts with a map instead of guessing column names.

## Tools

| Tool | Input | Notes |
| --- | --- | --- |
| `list_tables` | `schema?` (PostgreSQL) | Tables and views the role can read, with row estimates and comments on PostgreSQL and DuckDB. |
| `describe_table` | `table` (`name` or `schema.name`) | Columns, types, nullability, defaults, primary key, foreign keys, indexes and comments. |
| `query` | `sql`, `limit?` | One read-only SELECT. Returns `{"columns": [...], "rows": [[...]], "rowCount", "truncated"?, "elapsedMs"}`. |
| named queries | declared parameters | One tool per entry in `sql.queries`. |

Rows come back as arrays, not objects, because repeating column names on every row wastes tokens.

## A read-only role

apitame enforces read-only access itself, but the strongest guarantee is a role that cannot write. For PostgreSQL:

```sql
CREATE ROLE apitame_ro LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE shop TO apitame_ro;
GRANT USAGE ON SCHEMA public TO apitame_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO apitame_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO apitame_ro;
ALTER ROLE apitame_ro SET default_transaction_read_only = on;
ALTER ROLE apitame_ro SET statement_timeout = '10s';
```

Then connect with `postgres://apitame_ro:change-me@host:5432/shop`.

For MySQL or MariaDB:

```sql
CREATE USER 'apitame_ro'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT ON shop.* TO 'apitame_ro'@'%';
```

`apitame doctor` (and `init`) check the credentials and warn when the role or user could write. On managed services (RDS, Cloud SQL, Neon, Supabase) the same statements work from an admin connection. Point apitame at a replica if you have one.

For SQLite and DuckDB, apitame opens the file read-only. Make the file itself read-only to the user running apitame if you want the operating system to enforce it too (`chmod 444 data.duckdb`); `doctor` and `init` say whether it is.

## How a query is checked

See the [safety model](safety.md#sql-sources) for the full explanation. In order:

1. The lexer (database-accurate quoting) requires one statement starting with SELECT, WITH, VALUES or `(`, and refuses write keywords, side-effect functions and credential catalogs.
2. The SQL parser must read it as a single SELECT without `INTO` or row locks.
3. PostgreSQL runs it in a `READ ONLY` transaction with `statement_timeout`, through the single-statement extended protocol and a cursor capped at the row limit. MySQL runs it in `START TRANSACTION READ ONLY` with `max_execution_time` (`max_statement_time` on MariaDB) and `sql_select_limit`, with multi-statement queries disabled. SQLite runs it on a read-only connection, checks each statement is read-only, and kills the worker thread on timeout. DuckDB opens the file read-only with file access off and the configuration locked, checks that DuckDB reads one SELECT statement, streams rows up to the limit and interrupts the query on timeout.
4. The role you connect with (for SQLite and DuckDB, the file's permissions).

When a valid query is refused because the parser does not understand some syntax, the error says so. Simplify the query, or add it as a named query.

### Functions that are refused

Anything that sleeps, signals other sessions, reads or writes files, opens connections, changes settings, takes advisory locks, touches large objects, changes sequences or runs SQL passed as a string. That includes `pg_sleep`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_read_file`, `pg_ls_dir`, `set_config`, `nextval`, `setval`, `lo_import`, `dblink*`, `query_to_xml`, `pg_advisory_lock*`, `pg_notify` and, for SQLite, `load_extension`, `readfile`, `writefile` and `fts3_tokenizer`. The full list is in `src/sources/sql/guard.ts`; DuckDB's additions are in `src/sources/sql/duckdb-rules.ts` and listed [below](#duckdb).

### MySQL specifics

MySQL reads SQL differently from PostgreSQL and SQLite, and the lexer follows it:

- `/*! ... */` executable comments and `/*+ ... */` optimizer hints are refused: MySQL runs the first and the second could lift the timeout.
- `--` starts a comment only when whitespace follows, and `#` starts a comment.
- Both `'...'` and `"..."` are strings, with backslash escapes; identifiers use backticks.
- `SLEEP`, `BENCHMARK`, `LOAD_FILE`, `GET_LOCK` and replication wait functions are refused, as are `LOCK IN SHARE MODE`, `FOR SHARE`, `INTO OUTFILE` and the `mysql`, `performance_schema` and `sys` schemas.
- Named query parameters are bound with server-side prepared statements, so values are never escaped into SQL text (this stays safe even with `NO_BACKSLASH_ESCAPES`).
- MySQL commits DDL implicitly, so a dry run of a DDL named query is refused instead of being run for real.

## DuckDB

DuckDB files work like SQLite files: `list_tables`, `describe_table`, the read-only `query` tool, named read queries and a generated skill.

### Running apitame with the DuckDB driver

DuckDB's Node.js driver, `@duckdb/node-api`, ships one native binary per platform (40 to 120 MB unpacked). It is an optional peer dependency of apitame, so the default install stays small and does not include it. Add it next to apitame in one of these ways:

```bash
# npx: both packages in one temporary install (works for every command)
npx -p apitame -p @duckdb/node-api apitame init ./data.duckdb
npx -p apitame -p @duckdb/node-api apitame test

# pnpm
pnpm --package=apitame --package=@duckdb/node-api dlx apitame init ./data.duckdb

# a global install
npm install -g apitame @duckdb/node-api

# or a project install
npm install apitame @duckdb/node-api
```

Without the driver, every command that needs it stops with a message that shows the `npx -p` line above, and `init` writes nothing. `add-to` writes client configs that start the server the same way, so MCP clients get the driver too:

```json
{ "command": "npx", "args": ["-y", "-p", "apitame@<major.minor>", "-p", "@duckdb/node-api", "apitame", "serve", "--config", "..."] }
```

`doctor` checks that the driver loads, shows the DuckDB version, and warns when a client config in the folder starts the server without it. DuckDB releases are versioned as prereleases (`1.5.6-r.1`), so the peer dependency accepts any version and apitame checks at startup that DuckDB is 1.4 or later. It has been tested with 1.4.5 and 1.5.6.

### Sources

`init` recognises `.duckdb` and `.ddb` files, `duckdb:./path` and any file with a DuckDB header (a DuckDB file called `warehouse.db` is detected as DuckDB, not SQLite). The config stores the path relative to the config file:

```yaml
source:
  type: duckdb
  path: ./data.duckdb
```

### What runs

- Free-form `query` and named read queries. DuckDB syntax works: `FROM orders LIMIT 5`, `GROUP BY ALL`, `QUALIFY`, `SELECT * EXCLUDE (col)`, list and struct literals, lambdas.
- No named write queries: the file is always opened read-only, and a config with `write: true` on a DuckDB source is refused when it loads.
- Each call opens the file in its own read-only DuckDB instance and closes it afterwards (a few milliseconds). Other programs can write to the file between calls, and every call sees the latest data.
- DuckDB lets one process write to a file or several read it, not both. While another program (a DuckDB shell, a notebook, a data job) has the file open for writing, calls fail with a message that says so; close it, or point apitame at a copy of the file.
- Results: integers come back as numbers (as strings above 2^53), `DECIMAL` as strings so no digits are lost, dates and timestamps as strings, lists and structs as JSON, and `BLOB` values as `<binary N bytes>`.

### How a DuckDB query is checked

1. **Lexer.** PostgreSQL's quoting rules, which DuckDB follows: nested block comments, `E''` strings with backslash escapes, dollar quoting, and a plain backslash in standard strings (so `SELECT '\'; DELETE FROM t; --'` is two statements, as DuckDB reads it). A query may also start with `FROM`. On top of the shared keyword list it refuses `INSTALL`, `LOAD`, `EXPORT`, `IMPORT`, `SET` and `RESET` (`ATTACH`, `DETACH`, `PRAGMA`, `COPY` and `CHECKPOINT` are refused for every engine). It refuses a string in a FROM clause (`FROM 'orders.csv'`, which DuckDB reads as a file) and a quoted table name that looks like a path, and it only accepts reviewed table functions in FROM.
2. **Parser.** No bundled SQL parser reads DuckDB's dialect (the PostgreSQL parser refuses `EXCLUDE`, `GROUP BY ALL`, `QUALIFY` and FROM-first queries), so apitame asks DuckDB: `json_serialize_sql(?)` on a separate in-memory database with the query bound as a parameter. The query is parsed there, never run. The result must be exactly one SELECT with no error. apitame walks the parse tree for table references, resolving CTE names per scope as DuckDB does (a CTE never hides a real table of the same name in its own body or in outer queries), for function calls and for table functions, and refuses any tree shape it does not know. This layer cannot disagree with DuckDB about what a query means, but it is not independent of DuckDB either: a DuckDB parser bug would affect both.
3. **Database.** The file is opened with `access_mode=READ_ONLY`, `enable_external_access=false` (no `read_csv`, no `FROM 'file.csv'`, no `COPY`, `ATTACH` or `INSTALL`, no network), extension autoloading and autoinstalling off, community and unsigned extensions off, persistent secrets off, and `lock_configuration=true`, so `SET` cannot undo any of it. apitame reads these settings back and refuses to run anything if one did not apply. Then DuckDB's own `extractStatements()` must find exactly one statement and `prepare()` must report a SELECT, rows are streamed until the row limit, and `interrupt()` stops the query at `limits.timeoutMs`.
4. **Role.** DuckDB has no users or roles. A file that is read-only for the user running apitame is the layer that does not depend on apitame; `doctor` and `init` report whether the file is writable.

### DuckDB functions that are refused

DuckDB runs some functions even on a read-only database with a locked configuration: `query()` and `query_table()` run SQL strings and read tables by name, `enable_logging(storage = 'stdout')` prints every later query to standard output (the MCP channel over stdio), and `enable_peg_parser()` switches the SQL parser for every connection. apitame refuses these by name in the lexer and the parser, and because each call uses a fresh DuckDB instance, nothing such a function changes could outlive one call even if it got through.

- Run SQL strings or read tables by name: `query`, `query_table`, `json_execute_serialized_sql`, `json_serialize_plan`, `duckdb_table_sample`, `pragma_storage_info` (it holds minimum and maximum values).
- Read files or other databases: every `read_*` function (`read_csv`, `read_json`, `read_parquet`, `read_text`, `read_blob` and their variants), `glob`, `sniff_csv`, `parquet_*` metadata readers, `iceberg_*`, `delta_*`, `sqlite_*`, `postgres_*`, `mysql_*`, `arrow_*`, and any function ending in `_scan`, `_attach`, `_query` or `_execute`.
- Change the engine: `enable_logging`, `disable_logging`, `truncate_duckdb_logs`, `enable_profiling`, `disable_profiling`, `enable_peg_parser`, `disable_peg_parser`, `check_peg_parser`, `checkpoint`, `force_checkpoint`, `write_log`, `sleep_ms`.
- Secrets and logs: `duckdb_secrets`, `which_secret`, `getenv`, `duckdb_logs`, `duckdb_logs_parsed`, `duckdb_log_contexts`.

Table functions in FROM must be on a reviewed list: `range`, `generate_series`, `unnest`, `repeat`, `repeat_row`, `json_each`, `json_tree`, `summary`, the `duckdb_*` catalog functions (`duckdb_tables`, `duckdb_columns`, `duckdb_constraints` and others), `pragma_table_info`, `pragma_show`, `pragma_version`, `pragma_platform`, `pragma_database_size`, `pragma_collations`, `pg_timezone_names` and `icu_calendar_names`. A table function added by a future DuckDB release is refused until it is reviewed.

## Named queries

Named queries are SQL you write and review once, exposed as tools with typed parameters. They are the best way to give an agent a common question with a good query behind it.

```yaml
sql:
  queries:
    - name: top_customers
      description: Customers ranked by total spent on paid and shipped orders
      sql: >-
        SELECT c.id, c.name, sum(o.total) AS spent
        FROM customers c JOIN orders o ON o.customer_id = c.id
        WHERE o.status IN ('paid', 'shipped')
        GROUP BY c.id, c.name ORDER BY spent DESC
        LIMIT :limit
      params:
        limit: { type: integer, description: How many customers to return }

    - name: cancel_order
      description: Mark one pending order as cancelled
      write: true
      sql: UPDATE orders SET status = 'cancelled' WHERE id = :order_id AND status = 'pending'
      params:
        order_id: { type: integer }
```

- Parameters use `:name` in the SQL and are declared under `params` with a `type` (`string`, `number`, `integer`, `boolean`), an optional `description` and `required` (default `true`). Values are bound by the driver (`$1` on PostgreSQL and DuckDB, `?` on MySQL, named binding on SQLite), never pasted into the SQL. `dryRun` and `confirm` are reserved and cannot be parameter names. Casts such as `::int` and text inside strings are left alone.
- A query that uses an undeclared parameter, or a "read" query that is really a write, is skipped with a warning at startup. Run `apitame inspect` to see warnings.
- Write queries need `write: true`, `mode: read-write` and an entry in `writes.allow`. Until then they are reported as blocked by `inspect` and are invisible to the agent. DuckDB sources do not support write queries.
- On DuckDB, read queries go through the lexer when the server starts and through DuckDB's parser on their first call.
- DELETE, DROP, TRUNCATE, ALTER, MERGE and UPDATE without WHERE are destructive and always need confirmation. Other writes can be added to `writes.confirm`.
- `"dryRun": true` runs the write inside a transaction that is rolled back and returns `wouldAffectRows`. The confirmation preview includes the same count.
- On MySQL, a rollback only undoes changes to transactional tables. A dry run, and the row count in the confirmation preview, is therefore refused (the preview shows "unknown") unless every table the statement touches uses InnoDB (or NDB) and has no triggers. DDL is never dry-run on MySQL, because it commits implicitly.

## Limiting what can be seen

```yaml
sql:
  tables:
    allow: [orders, order_items, products]   # if set, only these
    deny: [customers_pii, api_keys]          # never these
```

The lists apply to `list_tables`, `describe_table`, `query` (including joins, subqueries and CTE bodies) and the schema in the generated skill. Entries can be bare (`orders`) or schema-qualified (`sales.orders`). For PostgreSQL, `source.schemas` (default `[public]`) limits which schemas are introspected and searched.

CTE names are resolved the way the database does, so `WITH customers AS (SELECT * FROM customers)` still counts as reading the real `customers` table. Functions that run a SQL string or read a table by name (`ts_stat`, `crosstab`, `pgstattuple` and similar) are refused, and so are planner statistics (`pg_stats`, `sqlite_stat4`, MySQL's `column_statistics`), which hold sampled values.

The lists hide data, not structure. Catalog queries (`information_schema.columns`, `sqlite_master`, `pragma_table_info`) still show the names and columns of denied tables. A view, partition or child table of a denied table is a table of its own: deny it too, or better, keep sensitive tables out of reach with the database role.

## Limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `limits.rowLimit` | 200 | Maximum rows per result. The agent can request fewer with `limit`. |
| `limits.timeoutMs` | 10000 for SQL configs created by `init` | Cancels the query on the server and on the client. |
| `limits.maxResponseBytes` | 50000 | Rows are trimmed further if the JSON is still larger. |

## Docker example

[`examples/postgres-shop`](../examples/postgres-shop) has a Docker Compose file that starts PostgreSQL 17 with sample data and the read-only role above:

```bash
cd examples/postgres-shop
docker compose up -d
export DATABASE_URL=postgres://apitame_ro:read-only-demo@localhost:5433/shop
npx apitame test
npx apitame serve
```

The same `seed.sql` also works with SQLite: `sqlite3 shop.db < seed.sql`.
