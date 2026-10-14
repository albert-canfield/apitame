-- PostgreSQL-only setup for the shop example: table comments and a read-only role.
-- The docker compose file runs this after seed.sql.

COMMENT ON TABLE customers IS 'People who have an account in the shop';
COMMENT ON TABLE products IS 'Catalogue items with current price and stock';
COMMENT ON TABLE orders IS 'One row per checkout; total includes all items';
COMMENT ON TABLE order_items IS 'Line items of each order, with the price paid';
COMMENT ON COLUMN orders.status IS 'pending, paid, shipped or cancelled';

-- A role that can read and nothing else. apitame also enforces read-only
-- transactions, but the database role is the layer that cannot be bypassed.
CREATE ROLE apitame_ro LOGIN PASSWORD 'read-only-demo';
GRANT CONNECT ON DATABASE shop TO apitame_ro;
GRANT USAGE ON SCHEMA public TO apitame_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO apitame_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO apitame_ro;
ALTER ROLE apitame_ro SET default_transaction_read_only = on;
ALTER ROLE apitame_ro SET statement_timeout = '10s';
