# shop: schema

## customers

People who have an account in the shop

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | integer | no | PK |
| name | text | no |  |
| email | text | no |  |
| country | text | no |  |
| created_at | timestamp without time zone | no |  |

## order_items

Line items of each order, with the price paid

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | integer | no | PK |
| order_id | integer | no | FK -> orders(id) |
| product_id | integer | no | FK -> products(id) |
| quantity | integer | no |  |
| unit_price | numeric(10,2) | no |  |

## orders

One row per checkout; total includes all items

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | integer | no | PK |
| customer_id | integer | no | FK -> customers(id) |
| status | text | no | pending, paid, shipped or cancelled |
| total | numeric(10,2) | no |  |
| created_at | timestamp without time zone | no |  |

## products

Catalogue items with current price and stock

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | integer | no | PK |
| name | text | no |  |
| category | text | no |  |
| price | numeric(10,2) | no |  |
| stock | integer | no |  |
