---
type: "BigQuery Table"
title: "events"
description: "Raw behavioral events (page views, clicks)."
tags: ["table","core"]
---
# events

Raw behavioral events (page views, clicks).

## Schema

| column | type | notes |
|---|---|---|
| `event_id` | STRING | — |
| `session_id` | STRING | — |
| `event_name` | STRING | — |
| `occurred_at` | TIMESTAMP | — |
| `properties` | JSON | — |

~~2.1B rows. Managed by the data-platform team.

## See also

Related concepts in the data model.
