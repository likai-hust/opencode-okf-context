---
type: Metric
title: active_customers
description: Count of distinct customers who placed at least one order in the trailing 30-day window.
tags: [growth, engagement]
status: stable
---

# active_customers

Active customers is a rolling engagement metric derived from [orders](/tables/orders.md).

## Definition

```sql
SELECT COUNT(DISTINCT customer_id)
FROM orders
WHERE placed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
```

## Usage

- Used by the growth dashboard.
- Re-computed hourly.
