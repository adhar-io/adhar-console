---
title: Event-driven integration and CQRS
category: Data
summary: Services announce what happened; others react and keep their own read-optimised views.
tools: [Kafka (Strimzi), Dapr pub/sub, Argo Events]
order: 20
---

## Why
Synchronous call chains couple availability: if inventory is down, checkout is down. Publishing events (`OrderPlaced`) decouples them in time — consumers catch up when they recover — and lets each consumer build the view it needs (**CQRS**: separate write model and read models).

## How Adhar does it
- **Kafka** (Strimzi) is the shared event backbone; topics are created from [Platform → Topics](/platform?section=topics), or a dedicated cluster from Messaging Clusters for a heavy product.
- **Dapr pub/sub** lets services publish and subscribe with one API, swappable between Kafka and RabbitMQ.
- **Argo Events** turns events into workflows (start a pipeline, a job, a notification).

## Use it
- Name events in the past tense, version their schema, and include an id and timestamp.
- The writer stores state and publishes; each reader projects events into its own table or index (search in OpenSearch, analytics in the lakehouse).

## Watch out
- Read models are **eventually consistent** — design the UI for it ("processing…").
- Consumers must be idempotent and tolerate out-of-order delivery across partitions.
- Schema changes are additive; a breaking change is a new event type.
