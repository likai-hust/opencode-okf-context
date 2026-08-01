---
type: "Metric"
title: "gross_margin"
description: "Gross margin = (revenue - COGS) / revenue."
tags: ["metric","kpi"]
---
# gross_margin

Gross margin = (revenue - COGS) / revenue.

## Definition

```sql
SELECT (SUM(gross_total - cogs)) / NULLIF(SUM(gross_total), 0)
FROM order_items
JOIN products USING (product_id)
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `gross_margin`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
