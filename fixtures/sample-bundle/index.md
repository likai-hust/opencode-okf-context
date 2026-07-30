---
okf_version: "0.2"
---

# Demo Knowledge Bundle

A small OKF bundle for testing the opencode-okf plugin.

## Tables

* [customers](tables/customers.md) - Customer master table (one row per customer)
* [orders](tables/orders.md) - Order fact table (one row per order, links to customers)

## Metrics

* [active_customers](metrics/active_customers.md) - Count of customers who placed an order in the last 30 days
