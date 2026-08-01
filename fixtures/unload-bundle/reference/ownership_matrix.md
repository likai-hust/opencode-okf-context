---
type: "Reference"
title: "Ownership Matrix"
description: "Who owns and can modify each table, metric, and runbook."
tags: ["reference","governance"]
---
# Ownership Matrix

Defines who owns and can modify each part of the data platform.

## Ownership principles

- Every asset has exactly one accountable owner (the person who answers for it).
- Contributors can propose changes; the owner approves them.
- Ownership is recorded in the asset manifest, not in this document only.

## Tables

| Table | Owner | Team | Review cadence |
|---|---|---|---|
| customers | Data Eng | Platform | quarterly |
| orders | Data Eng | Platform | quarterly |
| order_items | Data Eng | Platform | quarterly |
| products | Catalog | Product | semi-annual |
| events | Data Eng | Platform | monthly |
| sessions | Data Eng | Platform | monthly |
| inventory | Supply Chain | Ops | semi-annual |
| payments | FinTech | Finance | quarterly |

## Metrics

| Metric | Owner | Team |
|---|---|---|
| revenue | Finance | Finance |
| active_customers | Growth | Growth |
| mau | Growth | Growth |
| retention | Growth | Growth |
| churn_rate | Growth | Growth |
| ltv | Finance | Finance |
| conversion_rate | Growth | Growth |
| arpu | Finance | Finance |
| nps | CX | Customer |

## Runbooks

| Runbook | Owner |
|---|---|
| order_backfill | Data Eng |
| metric_drift_check | Growth |
| refresh_failure | Data Eng |
| sla_breach_response | On-call |
| data_quality_alerts | Data Quality |

## Change process

1. Propose a change in the #data-governance channel.
2. The owner reviews within 5 business days.
3. Approved changes are merged by the owner.
4. Ownership changes are recorded here and in the manifest.

## Cross-references

See [[glossary/cohort]], [[reference/compliance]].
