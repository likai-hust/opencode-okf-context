---
type: "Metric"
title: "churn_rate"
description: "Share of customers with no activity in the trailing 60 days."
tags: ["metric","kpi"]
---
# churn_rate

Share of customers with no activity in the trailing 60 days.

## Definition

```sql
SELECT 1.0 * churned_customers / total_customers
FROM daily_snapshot
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `churn_rate`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
