---
type: BigQuery Table
title: orders
description: Order fact table. One row per order, linked to customers.
resource: bigquery://myproject.analytics.orders
tags: [core, transactional]
status: stable
---

# orders

The `orders` table records every order placed by a customer.

## Schema

| column | type | description |
|---|---|---|
| `order_id` | STRING | Stable order identifier (PK). |
| `customer_id` | STRING | FK to [customers](/tables/customers.md). |
| `amount_cents` | INT64 | Order total in cents. |
| `placed_at` | TIMESTAMP | Order placement time. |

## Notes

- A customer is "active" if they have at least one row here in the last 30 days.
