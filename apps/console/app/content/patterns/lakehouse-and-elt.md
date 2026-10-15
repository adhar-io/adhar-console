---
title: Lakehouse and ELT pipelines
category: Data
summary: Land raw data cheaply in open formats, transform it in place, and query it with one engine.
tools: [Airbyte, dbt, Dagster, Iceberg, Trino, Object storage, Metabase]
order: 40
---

## Why
Copying operational databases into a proprietary warehouse is expensive and locks the data in. A lakehouse keeps data in **open table formats on object storage** and brings compute to it, so analytics never touch production databases.

## How Adhar does it
- **Extract & load** — Airbyte connections sync sources (Postgres, SaaS APIs) into the lake; manage them under [Develop → Pipelines](/develop?section=pipelines).
- **Store** — Iceberg tables on the platform object store ([Platform → Tables](/platform?section=tables), [Buckets](/platform?section=buckets)).
- **Transform** — dbt models, orchestrated by Dagster.
- **Query & share** — Trino for SQL, Metabase for dashboards under [Decide](/decide).

## Use it
Raw (as loaded) → staged (typed, deduplicated) → marts (business-ready). Each layer is a dbt model with tests; Dagster runs them after the Airbyte sync completes.

## Watch out
- Mask or drop personal data at the **staging** layer, not in dashboards.
- Small-file problems kill query speed — compact Iceberg tables on a schedule.
- Freshness is a contract: alert when a source stops syncing.
