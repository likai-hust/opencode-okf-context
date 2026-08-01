---
type: "Reference"
title: "SLA Policy"
description: "Service-level agreements: freshness, availability, support response times, breach procedure."
tags: ["reference","ops","sla"]
---
# SLA Policy

This policy defines service-level agreements for the data platform. It governs freshness, availability, and support response times.

## 1. Scope

Applies to all production data products: the analytics warehouse, the data API, and the metric layer. Internal tools and sandbox environments are explicitly out of scope.

## 2. Definitions

- **Freshness** — the maximum acceptable age of data in a table or metric.
- **Availability** — the percentage of time a service answers requests successfully.
- **On-call window** — 09:00-21:00 local, with best-effort outside.

## 3. Freshness SLAs

| Product | Target | Alert at | Breach if |
|---|---|---|---|
| orders, order_items | 15 min | 20 min | > 30 min |
| events | 5 min | 8 min | > 15 min |
| products, inventory | 1 hour | 70 min | > 2 hours |
| core metrics | 1 hour | 70 min | > 2 hours |

## 4. Availability SLAs

- Data API: 99.9% monthly availability. 429s are not counted as downtime.
- Warehouse query service: 99.5% monthly availability.
- Dashboards: 99.0% monthly availability.

Excluded events: scheduled maintenance (announced 48h ahead), force majeure, dependency outages beyond control.

## 5. Support response times

| Severity | Description | First response | Update frequency |
|---|---|---|---|
| S1 | Complete outage of a core product | 15 min | every 30 min |
| S2 | Major degradation, workaround exists | 1 hour | every 4 hours |
| S3 | Minor issue, no business impact | 1 business day | weekly |
| S4 | Question / request | 2 business days | as needed |

## 6. Breach procedure

1. The alerting system fires at the "alert at" threshold.
2. On-call acknowledges within the response window for the severity.
3. Investigation happens in the #data-oncall channel; status updates posted.
4. A post-incident review is held within 5 business days for S1/S2.

## 7. Penalties and credits

SLA credits are issued per the customer contract. The credit formula is 5% of the monthly fee for every full breach, capped at 25%.

## 8. Metrics to track

- Median and p95 of table freshness, computed daily.
- Availability percentages per service.
- Mean time to acknowledge (MTTA) and mean time to resolve (MTTR).
- Number of breaches per month, by severity.

## 9. Escalation matrix

- Level 1: on-call engineer (page via PagerDuty).
- Level 2: platform lead (escalated after 30 min without response).
- Level 3: head of engineering (after 1 hour for S1).

## 10. Review cadence

This policy is reviewed quarterly by the data platform team and approved by the CTO. Any change is versioned in this document.

## Cross-references

See [[runbooks/sla_breach_response]], [[reference/compliance]], [[tables/orders]].


## 11. Detailed failure scenarios

### 11.1 Query service down

When the warehouse query service is unavailable for more than 5 minutes:

1. The health check flips to "degraded" and pages on-call.
2. Downstream dashboards switch to the cached snapshot (stale by design).
3. A status page entry is created within 10 minutes of detection.
4. The incident is declared S2 unless the ETA exceeds 2 hours, in which case it is escalated to S1.

### 11.2 Freshness breach on core metrics

A core metric being stale for more than 2 hours is an S2 incident:

1. The metric is marked "unverified" in the dashboard and removed from any external reports.
2. On-call runs the refresh_failure runbook.
3. The metric is re-verified after the pipeline recovers.
4. A freshness SLA credit may be issued per section 7.

### 11.3 Partial data load

A partial load (some rows missing) is detected by the row-count checks:

1. The load is quarantined in the staging area.
2. The affected date partitions are flagged as incomplete.
3. A backfill is scheduled via the order_backfill runbook.
4. Consumers are notified before the corrected data lands.

## 12. Operational checklists

### 12.1 Daily checks

- [ ] Verify all core tables are within their freshness targets.
- [ ] Review the alert dashboard for overnight pages.
- [ ] Confirm the nightly backfill queue is empty.

### 12.2 Weekly checks

- [ ] Run the metric_drift_check runbook for all core metrics.
- [ ] Review MTTA / MTTR for the week.
- [ ] Update the escalation contacts if the roster changed.

### 12.3 Monthly checks

- [ ] Review the SLA credit report.
- [ ] Rebalance on-call schedules.
- [ ] Audit runbook accuracy against the last incidents.

## 13. Frequently asked questions

**Q: Are weekends and holidays covered?** Yes, the platform runs 24x7 with on-call coverage year-round.

**Q: What counts toward availability?** Successful responses, including cached reads. 429s from rate limiting and 4xx client errors do not count as downtime.

**Q: Can a customer get a credit for one bad day?** Credits are computed monthly based on full breaches; a single partial day rarely triggers a credit by itself.

**Q: Who decides the severity when in doubt?** The on-call engineer assigns the initial severity. If the impact is unclear, the default is S3, and it can be escalated at any time.

**Q: Where do I find the current SLA status?** The public status page shows real-time availability and freshness for every covered service.

## 14. Version history

| Version | Date | Change |
|---|---|---|
| 3.2 | 2026-07-01 | Added partial-load scenario, clarified availability counting |
| 3.1 | 2026-03-15 | New escalation matrix, reduced S1 first-response to 15 min |
| 3.0 | 2025-12-01 | Reorganized sections, added FAQ |
| 2.4 | 2025-09-10 | Added freshness SLAs for the metric layer |
| 2.0 | 2025-06-01 | Initial public SLA policy |

## 15. Real-world examples

### Example A: orders stale by 45 minutes

At 09:45 the freshness check reports that `orders` was last updated at 09:00 (45 min ago). Target is 15 min, breach threshold 30 min.

1. Alert fires at 09:20 (the 20-min alert threshold).
2. On-call acknowledges at 09:22.
3. The refresh_failure runbook identifies a locked query on the warehouse.
4. The query is killed and the job re-runs; orders land at 09:40.
5. The breach (duration 25 min, since it recovered before the 30-min breach point) is logged as an S3 near-miss.
6. Post-incident: the locking query is optimized to prevent recurrence.

### Example B: complete API outage for 11 minutes

The data API returns 503s for 11 minutes on a Tuesday.

1. Uptime monitor pages on-call within 2 minutes.
2. Status page is updated within 5 minutes.
3. On-call identifies a bad deploy and rolls back.
4. Service recovers after 11 minutes of downtime.
5. Monthly availability impact: 11 minutes / 44640 minutes = 99.98% — still above the 99.9% target.
6. No SLA credit is due, but a post-incident review is scheduled because it was an S1.

### Example C: dashboard unavailable for 3 hours during a peak sale

3 hours of dashboard downtime during a flash sale.

1. The dashboard is served from the cached snapshot after the first 5 minutes.
2. The underlying warehouse was fine; the dashboard service had a memory leak.
3. A hotfix restores the live view after 3 hours.
4. Since the dashboard SLA is 99.0% monthly and this is a single 3-hour incident in a 720-hour month (99.58%), no credit is issued — but the incident is still documented.

## 16. Key contacts

| Role | Contact | Response target |
|---|---|---|
| On-call engineer | #data-oncall | immediate |
| Platform lead | #data-platform | 30 min |
| Head of engineering | #eng-leads | 1 hour (S1) |
| Data quality | #data-quality | 4 hours |
| Customer success (credits) | #cs-sla | 1 business day |
