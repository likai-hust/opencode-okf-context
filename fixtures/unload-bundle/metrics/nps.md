---
type: "Metric"
title: "nps"
description: "Net promoter score from survey responses, computed on a 0-100 scale."
tags: ["metric","kpi"]
---
# nps

Net promoter score from survey responses, computed on a 0-100 scale.

## Definition

```sql
SELECT AVG(likelihood)
FROM nps_responses
WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
```

## Business context

Used by the growth dashboard. Re-computed hourly by the dbt job `nps`.

## Definition of done

- Matches the finance-team definition
- Nullable dimensions are handled
- Tested against the previous month
