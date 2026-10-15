---
title: Sharding and partitioning
category: Scale
summary: Split data and traffic by a key so no single database, topic or index carries all of it.
tools: [Kafka (Strimzi), CloudNativePG, OpenSearch, Valkey]
order: 40
---

## Why
Vertical scaling ends: one Postgres primary has one disk and one write path; one Kafka partition is consumed by one consumer at a time. Past that point you divide the data by a **shard key** and let each piece scale on its own.

## How Adhar does it
- **Streams** — Kafka topics (Strimzi) are partitioned; messages with the same key land on the same partition, which keeps order per key and spreads load across consumers.
- **Relational** — the `Database` claim gives each service (or each tenant tier) its own CloudNativePG cluster. That is *functional* sharding: split by service first, by key only when one service outgrows a primary.
- **Search** — OpenSearch indexes are split into primary shards with replicas across nodes.
- **Cache** — Valkey caches can run clustered, hashing keys across slots.

## Use it
Choose the key by the access pattern: `tenant_id` for SaaS isolation, `order_id` for even write spread, `customer_id` when reads are per customer. Create the topic with enough partitions for peak consumers:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata: { name: orders, labels: { strimzi.io/cluster: platform } }
spec: { partitions: 24, replicas: 3 }
```

## Watch out
- A skewed key (one giant tenant) creates a **hot shard**. Hash the key or split big tenants explicitly.
- Cross-shard queries and transactions get expensive — design so the common path stays on one shard.
- Adding partitions later reshuffles key placement; size for growth up front.
