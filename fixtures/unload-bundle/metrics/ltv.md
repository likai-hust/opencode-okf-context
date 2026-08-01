---
type: "Metric"
title: "ltv"
description: "Lifetime value: cumulative gross profit per customer."
tags: ["metric","kpi"]
---
# ltv

Lifetime value: cumulative gross profit per customer.

## Definition

```sql
SELECT customer_id, SUM(gross_total - cogs)
FROM order_items
JOIN products USING (product_id)
GROUP BY 1
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `ltv`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
