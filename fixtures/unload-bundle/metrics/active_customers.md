---
type: "Metric"
title: "active_customers"
description: "Distinct customers with at least one order in the trailing 30-day window."
tags: ["metric","kpi"]
---
# active_customers

Distinct customers with at least one order in the trailing 30-day window.

## Definition

```sql
SELECT COUNT(DISTINCT customer_id)
FROM orders
WHERE placed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `active_customers`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
