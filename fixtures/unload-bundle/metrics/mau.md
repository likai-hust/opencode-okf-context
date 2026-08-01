---
type: "Metric"
title: "mau"
description: "Monthly active users: distinct users with at least one session in the calendar month."
tags: ["metric","kpi"]
---
# mau

Monthly active users: distinct users with at least one session in the calendar month.

## Definition

```sql
SELECT COUNT(DISTINCT customer_id)
FROM sessions
WHERE started_at >= DATE_TRUNC(CURRENT_DATE(), MONTH)
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `mau`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
