---
type: "Reference"
title: "API Schema Reference"
description: "Complete reference for the internal data API: endpoints, auth, rate limits, errors."
tags: ["reference","api"]
---
# API Schema Reference

Complete reference for the internal data API. All endpoints return JSON over HTTPS and authenticate with a service token.

## Authentication

Header: `Authorization: Bearer <token>`. Tokens are minted by the platform team and rotate every 90 days.

## Endpoints

### GET /v1/orders

Returns orders matching the filter criteria.

Query params:
- `customer_id` (string) — filter by customer
- `start_date` / `end_date` (ISO date) — window filter
- `status` (enum: all | placed | completed | canceled | refunded)
- `limit` (int, default 100, max 1000)
- `cursor` (string) — pagination cursor

Response (200):
```json
{
  "data": [{ "order_id": "o_123", "customer_id": "c_9", "placed_at": "2026-07-01T10:00:00Z", "status": "completed", "gross_total": 129.99 }],
  "next_cursor": "eyJ..."
}
```

### GET /v1/orders/{order_id}

Returns a single order with line items.

Response (200): order object with `items: [{product_id, quantity, unit_price}]`.

Errors:
- 404 when the order does not exist
- 403 when the token lacks scope `orders:read`

### POST /v1/orders

Creates an order (platform-internal use only). Requires scope `orders:write`.

Request body: `{customer_id, items: [{product_id, quantity}], discount_code?}`

Response (201): the created order with a `purchase_token` valid for 15 minutes.

### GET /v1/metrics/{metric_id}

Reads a computed metric. Supported metric ids: `revenue`, `active_customers`, `mau`, `retention`, `churn_rate`, `ltv`, `conversion_rate`, `arpu`.

Query params: `date`, `start_date`, `end_date`, `cohort_month`, `dimension` (one of: plan, country, channel).

Response (200):
```json
{ "metric": "revenue", "value": 4821093.42, "currency": "USD", "as_of": "2026-07-31" }
```

## Rate limits

- 60 requests/minute per token (burst), sustained 30 rpm.
- 429 responses include `Retry-After`.

## Error model

All errors use the shape `{"error": {"code": "...", "message": "..."}}`. Codes: `auth_invalid`, `auth_expired`, `rate_limited`, `not_found`, `validation_failed`, `server_error`.

## Backward compatibility

- V1 is frozen; additive changes only.
- Deprecated fields stay for 2 releases.
- Breaking changes require a major version and 90-day notice.

## Cross-references

See [[reference/sla_policy]], [[tables/orders]], [[metrics/revenue]].


## Pagination

The list endpoints use cursor-based pagination:

1. The first request omits `cursor`; the response returns the first page plus `next_cursor`.
2. A subsequent request passes the previous `next_cursor` in the `cursor` param.
3. When `next_cursor` is `null`, there are no more pages.

Cursors are opaque strings and must not be decoded client-side. They expire after 30 minutes; an expired cursor returns `validation_failed`.

## Idempotency

`POST /v1/orders` supports idempotency keys:

- Send header `Idempotency-Key: <uuid>` on creation requests.
- The platform stores the key for 24 hours.
- Re-sending the same key returns the original response (201) without creating a duplicate.
- A different key on the same logical order creates a duplicate — always reuse the same key for retries.

## Timeouts and retries

- Server-side request timeout: 30 seconds for reads, 60 seconds for writes.
- Recommended client retry policy: exponential backoff with jitter, up to 3 retries.
- Retry on: 429, 500, 502, 503, 504. Never retry on 4xx (except 429).
- The `Retry-After` header is authoritative when present.

## Webhooks

The platform can push order and metric events to a subscriber endpoint:

- Events: `order.created`, `order.completed`, `order.canceled`, `metric.updated`.
- Delivery: at-least-once over the last 5 minutes, retried with backoff for up to 24 hours.
- Signature: each payload is signed with the `X-Webhook-Signature` header (HMAC-SHA256 of the body using the shared secret).
- Verification: compute the HMAC locally and compare; reject mismatches.

Webhook payload shape:
```json
{
  "event": "order.completed",
  "occurred_at": "2026-07-31T22:15:00Z",
  "data": { "order_id": "o_456", "customer_id": "c_9", "gross_total": 89.5 }
}
```

## Testing

Each endpoint has a sandbox mode:

- Use header `X-Sandbox: 1` to run against synthetic data.
- Sandbox writes are isolated per API key.
- Sandbox rate limits are the same as production.
- A nightly job wipes sandbox data.

## Monitoring & observability

Every request emits structured logs with:

- `request_id` — correlatable across services
- `endpoint`, `status`, `latency_ms`
- `api_key_short` — last 4 chars of the key (never the full key)
- `error_code` when applicable

The team monitors p95 latency and error rate per endpoint, alerting above thresholds:
- p95 latency > 500ms for reads, > 2s for writes
- error rate > 1% over 10 minutes

## Deprecation calendar

| Feature | Deprecated | Removed |
|---|---|---|
| `status=all` filter | 2026-06-01 | 2026-12-01 |
| `v1` orders shape v1 | 2026-09-01 | 2027-03-01 |
| HMAC v1 webhook signing | 2026-10-01 | 2027-04-01 |

## Versioning & changelog

### Versioning policy

- The API is versioned via the URL path (`/v1/`, `/v2/`).
- Backward-compatible changes ship within the current version.
- Breaking changes require a new major version.
- Each major version is supported for at least 18 months after the next major release.

### Changelog

**2026-07-31 (v1.9)**
- Added `cohort_month` filter to `GET /v1/metrics/{metric_id}`.
- Added `metric.updated` webhook event.
- Increased write timeout from 45s to 60s.

**2026-06-15 (v1.8)**
- Introduced idempotency keys for order creation.
- Added the `X-Sandbox` header for testing.
- Deprecated `status=all` (see deprecation calendar).

**2026-05-01 (v1.7)**
- Added cursor pagination to all list endpoints.
- Added rate-limit headers `X-RateLimit-Limit/Remaining/Reset`.
- Webhook signature algorithm upgraded to HMAC-SHA256.

### Example: full pagination walkthrough

```bash
# Page 1
curl -H "Authorization: Bearer $TOKEN" "https://api.example.com/v1/orders?limit=100"
# -> { "data": [...], "next_cursor": "eyJwYWdlIjoiMiJ9" }

# Page 2
curl -H "Authorization: Bearer $TOKEN" "https://api.example.com/v1/orders?limit=100&cursor=eyJwYWdlIjoiMiJ9"
# -> { "data": [...], "next_cursor": null }
```

### Example: idempotent order creation

```bash
curl -X POST "https://api.example.com/v1/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"c_9","items":[{"product_id":"p_1","quantity":2}]}'
# -> 201 { "order_id": "o_789", ... }
# Re-sending the same key returns the identical body, no duplicate order.
```

### Example: webhook signature verification

```python
import hashlib, hmac

def verify(secret: str, body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

### Troubleshooting checklist

1. **401 / auth_invalid** — token malformed or wrong scope. Re-issue via the platform portal.
2. **403 / auth_expired** — token older than 90 days. Rotate.
3. **429 / rate_limited** — back off using `Retry-After`.
4. **404 / not_found** — id is wrong, or data not yet replicated (check freshness).
5. **500 / server_error** — retry with backoff; if persistent, page on-call.
6. **Slow responses** — check the monitoring dashboard for p95 latency.
7. **Webhook not arriving** — verify the endpoint URL, secret, and signature; check delivery logs.
