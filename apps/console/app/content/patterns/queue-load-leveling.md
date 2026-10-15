---
title: Queue-based load leveling
category: Scale
summary: Put a queue between a bursty producer and a steady consumer so spikes become backlog, not outages.
tools: [RabbitMQ, Kafka, KEDA]
order: 60
---

## Why
Traffic arrives in bursts; downstream work (payments, emails, ML inference) has a fixed speed. Calling it synchronously turns every burst into timeouts. A queue absorbs the burst and lets consumers drain it at their own pace.

## How Adhar does it
- [Platform → Queues](/platform?section=queues) creates a RabbitMQ queue with its exchange binding **and a dead-letter queue** for messages that keep failing.
- [Platform → Topics](/platform?section=topics) creates Kafka topics for high-volume or replayable streams.
- KEDA scales consumers on queue depth or consumer lag — the backlog itself decides how many workers run.

## Use it
1. The API accepts the request, writes a message, returns `202 Accepted` with a job id.
2. Workers consume, process idempotently, and ack.
3. A status endpoint (or a callback event) reports completion.

## Watch out
- Consumers must be **idempotent** — at-least-once delivery means duplicates will happen.
- Alert on queue *age* (oldest message), not just depth.
- Watch the dead-letter queue; it is where bugs go to hide.
