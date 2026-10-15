---
title: Backup and disaster recovery
category: Resilience
summary: Decide how much data you can lose and how long you can be down — then prove you can restore within it.
tools: [Velero, CloudNativePG, BackupPolicy claim, Restore claim]
order: 50
---

## Why
Backups that have never been restored are hopes. DR planning starts from two numbers: **RPO** (how much data may be lost) and **RTO** (how long recovery may take). Everything else follows from them.

## How Adhar does it
- **Cluster state and volumes** — the `BackupPolicy` claim schedules Velero backups by namespace or label selector, with retention, volume snapshots, hooks and encryption. The `Restore` claim brings a backup back into the same or another namespace. Both are under [Platform → Backup Policies](/platform?section=backup-policies).
- **Databases** — CloudNativePG streams WAL to object storage, giving point-in-time recovery to any second within retention.
- **Everything else** is in Git; Argo CD rebuilds it.

## Use it
```yaml
apiVersion: platform.adhar.io/v1alpha1
kind: BackupPolicy
metadata: { name: shop-prod-nightly }
spec:
  parameters:
    backupTool: velero
    schedule: "0 2 * * *"
    retentionDays: 30
    includedNamespaces: [shop-prod]
    snapshotVolumes: true
    storageLocation: { provider: minio, bucket: platform-backups }
```

## Watch out
- Store backups **off-cluster and off-account** — a backup in the cluster it protects dies with it.
- Run a scheduled **restore drill** into a scratch namespace and check the app actually starts.
- Secrets restored from backup may be stale; rotate after a real recovery.
