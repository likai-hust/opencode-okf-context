---
type: "Metric"
title: "revenue"
description: "Recognized revenue from completed orders (excludes canceled and refunded)."
tags: ["metric","kpi"]
---
# revenue

Recognized revenue from completed orders (excludes canceled and refunded).

## Definition

```sql
SELECT SUM(gross_total - discount)
FROM orders
WHERE status = 'completed'
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `revenue`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
