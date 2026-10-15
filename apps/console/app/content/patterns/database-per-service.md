---
title: Database per service
category: Data
summary: Each service owns its data store; others reach the data through its API or its events, never its tables.
tools: [Database claim, CloudNativePG, MongoDB, Valkey]
order: 10
---

## Why
A database shared by five services is a five-way contract nobody can change. One team's migration breaks another's query, and the database becomes the deployment bottleneck. Owning the store makes each service independently deployable.

## How Adhar does it
The `Database` claim provisions a database for one service: **CloudNativePG** on the platform, or RDS / Cloud SQL / Azure SQL in the cloud — same spec, chosen by the environment's provider. It covers engine and version, size, multi-AZ, encryption, backup retention and maintenance window, and writes credentials to a Secret in the service's namespace. Create one from [Platform → Databases](/platform?section=databases).

## Use it
```yaml
apiVersion: platform.adhar.io/v1alpha1
kind: Database
metadata: { name: orders-db, namespace: shop-prod }
spec:
  parameters:
    engine: postgresql
    engineVersion: "16"
    storageSize: 50Gi
    multiAZ: true
    enableEncryption: true
    backupRetentionDays: 14
```
Adhar claims keep their settings under `spec.parameters`; the composition (CloudNativePG, RDS, …) is picked for you.

## Watch out
- Reports and joins across services move to **events + a read model** or the lakehouse, not cross-database queries.
- One logical database per service doesn't mean one cluster per service — small services can share a CNPG cluster with separate databases and users.
- Give each service a pooled connection budget (PgBouncer) so autoscaling doesn't exhaust connections.
