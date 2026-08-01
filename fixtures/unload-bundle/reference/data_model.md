---
type: "Reference"
title: "Data Model Reference"
description: "Canonical warehouse data model: layers, ER diagram, conventions, freshness SLAs."
tags: ["reference","architecture"]
---
# Data Model Reference

This document describes the canonical data model for the analytics warehouse. Every table and metric in the bundle traces back to this model.

## Layered architecture

The warehouse is organized into four layers:

1. **Bronze (raw)** — landed source data, append-only. Tables: raw_orders, raw_events, raw_payments.
2. **Silver (cleaned)** — deduplicated, typed, validated. Tables: orders, events, payments.
3. **Gold (curated)** — business-facing marts: orders_mart, customer_365, finance_daily.
4. **Semantic (metrics)** — the metric layer powering dashboards.

## Entity relationships

- customers 1---N orders
- orders 1---N order_items
- products 1---N order_items
- orders 1---1 payments (most orders)
- customers 1---N sessions
- sessions 1---N events

## Key conventions

- Every fact table has an `id` PK and a `*_at` timestamp column.
- Dimensions use surrogate keys; natural keys live in `source_key` columns.
- Money is stored as NUMERIC (not FLOAT); currency is USD unless stated.
- Times are UTC timestamps; date partitions use the `_partitiondate` pseudo-column.

## Freshness SLAs

- orders: 15 min
- order_items: 15 min
- events: 5 min
- products: 1 hour
- inventory: 1 hour

## Cross-references

See [[tables/customers]], [[tables/orders]], [[metrics/revenue]], [[metrics/active_customers]].
