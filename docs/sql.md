# SQL sources

apitame serves PostgreSQL, MySQL (and MariaDB) and SQLite databases as MCP tools: browse the schema, run read-only SELECT queries, and expose reviewed, parameterized queries as their own tools.

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

npx apitame test       # describes every table, runs a sample query, tries known injection payloads
npx apitame inspect
```

`init` introspects the schema and writes a skill with the tables, their relationships and example joins, so the agent starts with a map instead of guessing column names.

## Tools

| Tool | Input | Notes |
| --- | --- | --- |
| `list_tables` | `schema?` (PostgreSQL) | Tables and views the role can read, with row estimates and comments on PostgreSQL. |
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

For SQLite, apitame opens the file read-only. Make the file itself read-only to the user running apitame if you want the operating system to enforce it too.

## How a query is checked

See the [safety model](safety.md#sql-sources) for the full explanation. In order:

1. The lexer (database-accurate quoting) requires one statement starting with SELECT, WITH, VALUES or `(`, and refuses write keywords, side-effect functions and credential catalogs.
2. The SQL parser must read it as a single SELECT without `INTO` or row locks.
3. PostgreSQL runs it in a `READ ONLY` transaction with `statement_timeout`, through the single-statement extended protocol and a cursor capped at the row limit. MySQL runs it in `START TRANSACTION READ ONLY` with `max_execution_time` (`max_statement_time` on MariaDB) and `sql_select_limit`, with multi-statement queries disabled. SQLite runs it on a read-only connection, checks each statement is read-only, and kills the worker thread on timeout.
4. The role you connect with.

When a valid query is refused because the parser does not understand some syntax, the error says so. Simplify the query, or add it as a named query.

### Functions that are refused

Anything that sleeps, signals other sessions, reads or writes files, opens connections, changes settings, takes advisory locks, touches large objects, changes sequences or runs SQL passed as a string. That includes `pg_sleep`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_read_file`, `pg_ls_dir`, `set_config`, `nextval`, `setval`, `lo_import`, `dblink*`, `query_to_xml`, `pg_advisory_lock*`, `pg_notify` and, for SQLite, `load_extension`, `readfile`, `writefile` and `fts3_tokenizer`. The full list is in `src/sources/sql/guard.ts`.

### MySQL specifics

MySQL reads SQL differently from PostgreSQL and SQLite, and the lexer follows it:

- `/*! ... */` executable comments and `/*+ ... */` optimizer hints are refused: MySQL runs the first and the second could lift the timeout.
- `--` starts a comment only when whitespace follows, and `#` starts a comment.
- Both `'...'` and `"..."` are strings, with backslash escapes; identifiers use backticks.
- `SLEEP`, `BENCHMARK`, `LOAD_FILE`, `GET_LOCK` and replication wait functions are refused, as are `LOCK IN SHARE MODE`, `FOR SHARE`, `INTO OUTFILE` and the `mysql`, `performance_schema` and `sys` schemas.
- Named query parameters are bound with server-side prepared statements, so values are never escaped into SQL text (this stays safe even with `NO_BACKSLASH_ESCAPES`).
- MySQL commits DDL implicitly, so a dry run of a DDL named query is refused instead of being run for real.

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

- Parameters use `:name` in the SQL and are declared under `params` with a `type` (`string`, `number`, `integer`, `boolean`), an optional `description` and `required` (default `true`). Values are bound by the driver (`$1` on PostgreSQL, `?` on MySQL, named binding on SQLite), never pasted into the SQL. `dryRun` and `confirm` are reserved and cannot be parameter names. Casts such as `::int` and text inside strings are left alone.
- A query that uses an undeclared parameter, or a "read" query that is really a write, is skipped with a warning at startup. Run `apitame inspect` to see warnings.
- Write queries need `write: true`, `mode: read-write` and an entry in `writes.allow`. Until then they are reported as blocked by `inspect` and are invisible to the agent.
- DELETE, DROP, TRUNCATE, ALTER, MERGE and UPDATE without WHERE are destructive and always need confirmation. Other writes can be added to `writes.confirm`.
- `"dryRun": true` runs the write inside a transaction that is rolled back and returns `wouldAffectRows`. The confirmation preview includes the same count.

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
