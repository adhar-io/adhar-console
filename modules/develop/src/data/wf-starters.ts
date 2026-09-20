import { layoutGraph, type StepNode, type WorkflowGraph } from './wf-model.ts'

/**
 * Starter workflows for the platform.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE NOT GENERIC EXAMPLES
 * ---------------------------------------------------------------------------
 * A blank canvas asks you to know Argo before you can use it, and a generic
 * "hello world" teaches nothing about THIS platform. Each starter here is
 * wired to the tools the Adhar stack actually runs — Gitea for source, kaniko
 * pushing to Harbor, Argo CD for delivery, Trino and the lakehouse for data —
 * so the first workflow someone opens is one that would genuinely run here.
 *
 * They are deliberately multi-stage, with parallel branches where the real
 * pipeline has them: a build and a test that both follow checkout, joining
 * again at publish. That shape is the reason a DAG is worth drawing at all,
 * and a single-file starter would not show it.
 *
 * Every image is pinned to a tag rather than `latest`, because a starter is
 * copied and a floating tag turns into an unreproducible pipeline months
 * later.
 */

export interface Starter {
  id: string
  title: string
  blurb: string
  /** What it needs to actually run, stated plainly rather than discovered. */
  requires: string
  build(namespace: string): WorkflowGraph
}

const s = (
  id: string,
  image: string,
  command: string,
  dependsOn: string[] = [],
  extra: Partial<StepNode> = {},
): StepNode => ({
  id,
  label: id.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
  image,
  command,
  dependsOn,
  x: 0,
  y: 0,
  ...extra,
})

/** Lay the starter out so it opens as a readable shape, not a pile. */
function graph(name: string, namespace: string, steps: StepNode[], params: WorkflowGraph['params'] = []): WorkflowGraph {
  return { name, namespace, params, steps: layoutGraph(steps), serviceAccountName: 'argo-workflow' }
}

export const STARTERS: Starter[] = [
  {
    id: 'build-test-publish',
    title: 'Build, test and publish a container',
    blurb:
      'Clone from Gitea, then build and test in parallel, then push to Harbor. The shape most service pipelines have.',
    requires: 'A Gitea repo, and a Harbor push secret mounted on the service account.',
    build: (ns) =>
      graph('build-test-publish', ns, [
        s('checkout', 'alpine/git:2.45.2', 'git clone --depth 1 "$REPO_URL" /work && ls /work', [], {
          env: { REPO_URL: '{{workflow.parameters.repo}}' },
        }),
        s(
          'build',
          'gcr.io/kaniko-project/executor:v1.23.2',
          '/kaniko/executor --context /work --destination "$IMAGE:{{workflow.parameters.tag}}"',
          ['checkout'],
          { env: { IMAGE: '{{workflow.parameters.image}}', DOCKER_CONFIG: '/kaniko/.docker' } },
        ),
        s('test', 'node:22-alpine', 'cd /work && npm ci && npm test', ['checkout']),
        s(
          'publish',
          'alpine:3.20',
          'echo "published {{workflow.parameters.image}}:{{workflow.parameters.tag}}"',
          ['build', 'test'],
        ),
      ], [
        { name: 'repo', value: 'https://gitea.example.com/adhar/service.git' },
        { name: 'image', value: 'harbor.example.com/library/service' },
        { name: 'tag', value: 'v0.1.0' },
      ]),
  },
  {
    id: 'gitops-promote',
    title: 'Promote a release through environments',
    blurb:
      'Update the image tag in the GitOps repo, let Argo CD sync, wait for health, then repeat for the next environment.',
    requires: 'Write access to the GitOps repository and the Argo CD CLI image.',
    build: (ns) =>
      graph('gitops-promote', ns, [
        s(
          'set-tag-staging',
          'alpine/git:2.45.2',
          'git clone --depth 1 "$GITOPS" /gitops && cd /gitops && sed -i "s|tag:.*|tag: {{workflow.parameters.tag}}|" envs/staging/values.yaml && git commit -am "promote staging {{workflow.parameters.tag}}" && git push',
          [],
          { env: { GITOPS: '{{workflow.parameters.gitops}}' } },
        ),
        s(
          'wait-staging',
          'quay.io/argoproj/argocd:v2.12.3',
          'argocd app wait "$APP-staging" --health --timeout 600',
          ['set-tag-staging'],
          { env: { APP: '{{workflow.parameters.app}}' } },
        ),
        s('smoke-staging', 'curlimages/curl:8.9.1', 'curl -fsS "$URL/health"', ['wait-staging'], {
          env: { URL: '{{workflow.parameters.stagingUrl}}' },
        }),
        s(
          'set-tag-production',
          'alpine/git:2.45.2',
          'git clone --depth 1 "$GITOPS" /gitops && cd /gitops && sed -i "s|tag:.*|tag: {{workflow.parameters.tag}}|" envs/production/values.yaml && git commit -am "promote production {{workflow.parameters.tag}}" && git push',
          ['smoke-staging'],
          { env: { GITOPS: '{{workflow.parameters.gitops}}' } },
        ),
        s(
          'wait-production',
          'quay.io/argoproj/argocd:v2.12.3',
          'argocd app wait "$APP-production" --health --timeout 900',
          ['set-tag-production'],
          { env: { APP: '{{workflow.parameters.app}}' } },
        ),
      ], [
        { name: 'app', value: 'checkout' },
        { name: 'gitops', value: 'https://gitea.example.com/adhar/gitops.git' },
        { name: 'tag', value: 'v0.1.0' },
        { name: 'stagingUrl', value: 'https://checkout.staging.example.com' },
      ]),
  },
  {
    id: 'data-pipeline',
    title: 'Extract, transform and load',
    blurb:
      'Pull from a source, land it in the lakehouse, transform with Trino, then verify the row counts agree.',
    requires: 'Lakehouse object storage credentials and a reachable Trino coordinator.',
    build: (ns) =>
      graph('data-pipeline', ns, [
        s('extract', 'python:3.12-slim', 'python -c "print(\'extract {{workflow.parameters.date}}\')"', [], {
          env: { SOURCE_DSN: '{{workflow.parameters.source}}' },
        }),
        s('land', 'amazon/aws-cli:2.17.0', 'aws s3 cp /tmp/out.parquet "$BUCKET/raw/{{workflow.parameters.date}}/"', ['extract'], {
          env: { BUCKET: '{{workflow.parameters.bucket}}' },
        }),
        s(
          'transform',
          'trinodb/trino:455',
          'trino --server "$TRINO" --execute "INSERT INTO analytics.daily SELECT * FROM raw.events WHERE day = DATE \'{{workflow.parameters.date}}\'"',
          ['land'],
          { env: { TRINO: '{{workflow.parameters.trino}}' } },
        ),
        s(
          'verify',
          'trinodb/trino:455',
          'trino --server "$TRINO" --execute "SELECT count(*) FROM analytics.daily WHERE day = DATE \'{{workflow.parameters.date}}\'"',
          ['transform'],
          { env: { TRINO: '{{workflow.parameters.trino}}' } },
        ),
      ], [
        { name: 'date', value: '2026-09-20' },
        { name: 'source', value: 'postgres://reader@db/app' },
        { name: 'bucket', value: 's3://lakehouse' },
        { name: 'trino', value: 'http://trino.adhar-system.svc.cluster.local:8080' },
      ]),
  },
  {
    id: 'scheduled-backup',
    title: 'Back up a database and verify the restore',
    blurb:
      'Dump, upload, then restore into a scratch database and count the rows. A backup nobody has restored is a hope.',
    requires: 'Database credentials and write access to the backup bucket.',
    build: (ns) =>
      graph('scheduled-backup', ns, [
        s('dump', 'postgres:16-alpine', 'pg_dump "$DSN" -Fc -f /tmp/backup.dump && ls -lh /tmp/backup.dump', [], {
          env: { DSN: '{{workflow.parameters.dsn}}' },
        }),
        s('upload', 'amazon/aws-cli:2.17.0', 'aws s3 cp /tmp/backup.dump "$BUCKET/{{workflow.parameters.date}}.dump"', ['dump'], {
          env: { BUCKET: '{{workflow.parameters.bucket}}' },
        }),
        s(
          'verify-restore',
          'postgres:16-alpine',
          'pg_restore -d "$SCRATCH_DSN" /tmp/backup.dump && psql "$SCRATCH_DSN" -c "select count(*) from information_schema.tables"',
          ['dump'],
          { env: { SCRATCH_DSN: '{{workflow.parameters.scratchDsn}}' } },
        ),
        s('report', 'alpine:3.20', 'echo "backup {{workflow.parameters.date}} uploaded and restore-verified"', [
          'upload',
          'verify-restore',
        ]),
      ], [
        { name: 'dsn', value: 'postgres://user@db/app' },
        { name: 'scratchDsn', value: 'postgres://user@db/scratch' },
        { name: 'bucket', value: 's3://backups' },
        { name: 'date', value: '2026-09-20' },
      ]),
  },
  {
    id: 'ml-train',
    title: 'Train, evaluate and register a model',
    blurb:
      'Prepare features, train, evaluate against a threshold, and register only if it beats the incumbent.',
    requires: 'A GPU node pool for training, and a model registry endpoint.',
    build: (ns) =>
      graph('ml-train', ns, [
        s('features', 'python:3.12-slim', 'python -m pipeline.features --date {{workflow.parameters.date}}'),
        s('train', 'pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime', 'python -m pipeline.train --epochs {{workflow.parameters.epochs}}', ['features']),
        s('evaluate', 'python:3.12-slim', 'python -m pipeline.evaluate --min-auc {{workflow.parameters.minAuc}}', ['train']),
        s(
          'register',
          'python:3.12-slim',
          'python -m pipeline.register --registry "$REGISTRY"',
          ['evaluate'],
          {
            env: { REGISTRY: '{{workflow.parameters.registry}}' },
            // Only register a model that cleared the bar; the evaluate step
            // writes this parameter.
            when: '{{tasks.evaluate.outputs.parameters.passed}} == true',
          },
        ),
      ], [
        { name: 'date', value: '2026-09-20' },
        { name: 'epochs', value: '10' },
        { name: 'minAuc', value: '0.82' },
        { name: 'registry', value: 'http://mlflow.adhar-system.svc.cluster.local:5000' },
      ]),
  },
  {
    id: 'blank',
    title: 'Start from nothing',
    blurb: 'One step, wired to nothing. For when you know exactly what you want.',
    requires: 'Nothing.',
    build: (ns) => graph('new-workflow', ns, [s('step-1', 'alpine:3.20', 'echo hello')]),
  },
]

export function starterById(id: string): Starter | undefined {
  return STARTERS.find((x) => x.id === id)
}
