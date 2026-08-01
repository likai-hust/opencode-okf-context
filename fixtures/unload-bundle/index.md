---
okf_version: "0.2"
---

# Unload Test Bundle

A large OKF bundle used to test multi-turn unload behavior: 40 concepts across tables, metrics, glossary, runbooks, and reference (5 large docs).

## Tables

* [customers](tables/customers.md) - Customer master table. One row per customer identity.
* [orders](tables/orders.md) - Order fact table. One row per order placed.
* [order_items](tables/order_items.md) - Line items within orders.
* [products](tables/products.md) - Product catalog dimension.
* [events](tables/events.md) - Raw behavioral events (page views, clicks).
* [sessions](tables/sessions.md) - Web/app sessions dimension.
* [inventory](tables/inventory.md) - Inventory snapshot by day.
* [payments](tables/payments.md) - Payment transactions fact.

## Metrics

* [active_customers](metrics/active_customers.md) - Distinct customers with at least one order in the trailing 30-day window.
* [revenue](metrics/revenue.md) - Recognized revenue from completed orders (excludes canceled and refunded).
* [mau](metrics/mau.md) - Monthly active users: distinct users with at least one session in the calendar month.
* [retention](metrics/retention.md) - Cohort retention: % of a signup cohort placing an order in month N after signup.
* [churn_rate](metrics/churn_rate.md) - Share of customers with no activity in the trailing 60 days.
* [ltv](metrics/ltv.md) - Lifetime value: cumulative gross profit per customer.
* [conversion_rate](metrics/conversion_rate.md) - Share of sessions that end in a completed order.
* [arpu](metrics/arpu.md) - Average revenue per paying user in a period.
* [nps](metrics/nps.md) - Net promoter score from survey responses, computed on a 0-100 scale.
* [gross_margin](metrics/gross_margin.md) - Gross margin = (revenue - COGS) / revenue.

## Glossary

* [aov](glossary/aov.md) - Average order value = revenue / number of orders.
* [cogs](glossary/cogs.md) - Cost of goods sold per unit.
* [mrr](glossary/mrr.md) - Monthly recurring revenue from subscription plans.
* [arr](glossary/arr.md) - Annualized recurring revenue = MRR * 12.
* [cac](glossary/cac.md) - Customer acquisition cost = total sales & marketing spend / new customers.
* [churn](glossary/churn.md) - Customers lost over a period.
* [cohort](glossary/cohort.md) - Group of customers who signed up in the same period.
* [gross_revenue](glossary/gross_revenue.md) - Total billed revenue before discounts and refunds.
* [net_revenue](glossary/net_revenue.md) - Gross revenue minus refunds and chargebacks.
* [payback_period](glossary/payback_period.md) - Months to recover CAC from gross margin.
* [run_rate](glossary/run_rate.md) - Annualized revenue based on the latest month.
* [take_rate](glossary/take_rate.md) - Platform fee as a share of GMV.

## Runbooks

* [Order Backfill](runbooks/order_backfill.md) - Procedure to backfill missing orders from the source system.
* [Metric Drift Check](runbooks/metric_drift_check.md) - Weekly check for unexpected drift in core metrics.
* [Table Refresh Failure](runbooks/refresh_failure.md) - What to do when a scheduled refresh fails.
* [SLA Breach Response](runbooks/sla_breach_response.md) - Steps when a freshness SLA is breached.
* [Data Quality Alerts](runbooks/data_quality_alerts.md) - How to respond to automated quality alerts.

## Reference

* [Data Model](reference/data_model.md) - canonical warehouse model
* [API Schema](reference/api_schema.md) - internal data API
* [SLA Policy](reference/sla_policy.md) - service-level agreements
* [Ownership Matrix](reference/ownership_matrix.md) - asset ownership
* [Compliance](reference/compliance.md) - governance posture
