---
type: "Metric"
title: "conversion_rate"
description: "Share of sessions that end in a completed order."
tags: ["metric","kpi"]
---
# conversion_rate

Share of sessions that end in a completed order.

## Definition

```sql
SELECT 1.0 * COUNT(DISTINCT orders.customer_id) / COUNT(DISTINCT sessions.session_id)
FROM sessions
LEFT JOIN orders USING (customer_id)
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `conversion_rate`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
