---
type: "Metric"
title: "retention"
description: "Cohort retention: % of a signup cohort placing an order in month N after signup."
tags: ["metric","kpi"]
---
# retention

Cohort retention: % of a signup cohort placing an order in month N after signup.

## Definition

```sql
WITH base AS (
  SELECT customer_id, DATE_TRUNC(signup_at, MONTH) AS cohort
  FROM customers
)
SELECT cohort, COUNT(DISTINCT customer_id) FROM base GROUP BY 1
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `retention`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
