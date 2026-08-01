---
type: "BigQuery Table"
title: "orders"
description: "Order fact table. One row per order placed."
tags: ["table","core"]
---
# orders

Order fact table. One row per order placed.

## Schema

| column | type | notes |
|---|---|---|
| `order_id` | STRING | — |
| `customer_id` | STRING | — |
| `placed_at` | TIMESTAMP | — |
| `status` | STRING | — |
| `gross_total` | NUMERIC | — |
| `discount` | NUMERIC | — |

~~18M rows. Managed by the data-platform team.

## See also

Related concepts in the data model.
