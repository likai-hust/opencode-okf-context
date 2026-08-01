---
type: "BigQuery Table"
title: "payments"
description: "Payment transactions fact."
tags: ["table","core"]
---
# payments

Payment transactions fact.

## Schema

| column | type | notes |
|---|---|---|
| `payment_id` | STRING | — |
| `order_id` | STRING | — |
| `amount` | NUMERIC | — |
| `paid_at` | TIMESTAMP | — |
| `method` | STRING | — |

~~22M rows. Managed by the data-platform team.

## See also

Related concepts in the data model.
