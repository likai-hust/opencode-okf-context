---
type: BigQuery Table
title: customers
description: Customer master table. One row per customer.
resource: bigquery://myproject.analytics.customers
tags: [core, identity]
status: stable
---

# customers

The `customers` table is the source of truth for customer identity.

## Schema

| column | type | description |
|---|---|---|
| `customer_id` | STRING | Stable customer identifier (PK). |
| `email` | STRING | Lowercased, verified email. |
| `created_at` | TIMESTAMP | Account creation time. |

## Notes

- Related to [orders](/tables/orders.md) via `customer_id`.
- Emails are normalized to lowercase before insert.
