---
type: "Metric"
title: "arpu"
description: "Average revenue per paying user in a period."
tags: ["metric","kpi"]
---
# arpu

Average revenue per paying user in a period.

## Definition

```sql
SELECT SUM(gross_total) / COUNT(DISTINCT customer_id)
FROM orders
WHERE status = 'completed'
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `arpu`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
