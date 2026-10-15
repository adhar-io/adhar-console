---
title: Cache-aside
category: Scale
summary: Serve hot reads from memory and keep the database for writes and misses.
tools: [Valkey, Prometheus]
order: 50
---

## Why
Most traffic reads the same small set of data. Hitting the database for every read wastes its capacity on work that could be answered in microseconds.

## How Adhar does it
[Platform → Caches](/platform?section=caches) provisions an operator-managed **Valkey** (Redis-compatible) instance with an exporter and ServiceMonitor already wired, so hit rate and memory are on a dashboard from day one. Connection details arrive as a Kubernetes Secret.

## Use it
1. Read: look in the cache; on a miss, read the database and write the value with a TTL.
2. Write: update the database, then **delete** the cache key (don't update it in place).

```ts
const hit = await cache.get(`product:${id}`)
if (hit) return JSON.parse(hit)
const row = await db.product.find(id)
await cache.set(`product:${id}`, JSON.stringify(row), { EX: 300 })
return row
```

## Watch out
- Always set a TTL — it bounds staleness and memory.
- A popular key expiring under load causes a **stampede**; add jitter to TTLs or use a short lock.
- The cache is not a source of truth. If losing it loses data, it is a database.
