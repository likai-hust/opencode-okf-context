---
type: "Runbook"
title: "Order Backfill"
description: "Procedure to backfill missing orders from the source system."
tags: ["runbook","ops"]
---
# Order Backfill

Procedure to backfill missing orders from the source system.

## Steps

1. Identify the date range via the missing_orders query
2. Request a source export
3. Load into the staging table
4. Validate row counts
5. Promote to production

## Owner

Data platform on-call.
