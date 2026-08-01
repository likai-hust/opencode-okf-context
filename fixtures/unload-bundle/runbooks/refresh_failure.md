---
type: "Runbook"
title: "Table Refresh Failure"
description: "What to do when a scheduled refresh fails."
tags: ["runbook","ops"]
---
# Table Refresh Failure

What to do when a scheduled refresh fails.

## Steps

1. Check the job log
2. Re-run the dbt job
3. If locked, kill the stuck query
4. Verify the freshness metric

## Owner

Data platform on-call.
