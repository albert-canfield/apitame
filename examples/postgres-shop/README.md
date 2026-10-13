# PostgreSQL shop example

A small online shop (customers, products, orders, order items) with a read-only database role and three named queries, one of them a write.

## Run it with Docker

```bash
cd examples/postgres-shop
docker compose up -d
export DATABASE_URL=postgres://apitame_ro:apitame_ro@localhost:5433/shop
npx apitame inspect
npx apitame test       # every table, the named queries, and injection payloads that must be refused
npx apitame serve
```

`docker-compose.yml` starts PostgreSQL 17 and runs `seed.sql` (data) and `roles.sql` (table comments and the `apitame_ro` role with `default_transaction_read_only = on`).

## Or with SQLite

`seed.sql` is portable:

```bash
sqlite3 shop.db < seed.sql
npx apitame init shop.db --out ./sqlite --name shop
npx apitame test --config ./sqlite/apitame.config.yaml
```

## What is in the config

- `top_customers` and `orders_for_customer`: named read queries with typed parameters.
- `cancel_order`: a named write query. It stays hidden until you set `mode: read-write` and add it to `writes.allow`. Because it has a WHERE clause it is a plain write; a DELETE or an UPDATE without WHERE would always ask for confirmation.

Questions to try once an agent is connected:

- "Who are our top 5 customers and which countries are they in?"
- "Which products sold the most units in the last three months?"
- "Delete all cancelled orders." Refused: the `query` tool only runs SELECT.
