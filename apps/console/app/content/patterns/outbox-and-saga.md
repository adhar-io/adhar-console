---
title: Transactional outbox and sagas
category: Data
summary: Change data and publish the event atomically, and coordinate multi-service work with compensations instead of distributed transactions.
tools: [CloudNativePG, Kafka, Dapr, Argo Workflows]
order: 30
---

## Why
"Write to the database, then publish to Kafka" fails halfway: the row is saved but the event is lost (or the reverse). And a business process spanning orders, payments and shipping can't hold a lock across three databases.

## How Adhar does it
- **Outbox** — write the business row and an `outbox` row in the **same Postgres transaction**; a relay (a small worker, or change-data-capture) publishes outbox rows to Kafka and marks them sent. Dapr's state store supports the same outbox pattern for its pub/sub.
- **Saga** — a sequence of local transactions, each with a compensating action. Orchestrate long-running sagas with **Argo Workflows** (steps, retries, `onExit` compensation) or choreograph them through events.

## Use it
```sql
BEGIN;
  INSERT INTO orders (...) VALUES (...);
  INSERT INTO outbox (aggregate_id, type, payload) VALUES ($1, 'OrderPlaced', $2);
COMMIT;
```
Saga: reserve stock → charge card → book shipment; on failure, release stock and refund.

## Watch out
- The relay delivers **at least once** — consumers deduplicate by event id.
- Compensations are business actions (a refund), not rollbacks; some steps can't be undone and must come last.
- Make saga state visible; a stuck saga is invisible money.
