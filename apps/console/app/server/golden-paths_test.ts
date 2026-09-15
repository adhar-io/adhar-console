import { assertEquals, assertMatch, assertNotMatch } from 'jsr:@std/assert@^1.0.0'
import { defaultImage, generateGoldenPathFiles } from './golden-paths.ts'

// The platform enforces two image policies cluster-wide. A golden path whose
// generated Deployment violates either is admission-DENIED, so the scaffold
// produces a repo, a build and an Argo CD Application — and then no workload.
//   disallow-latest-tag-enforce      — an explicit, non-latest tag is required
//   restrict-image-registries-enforce — only the platform registry is allowed
Deno.test('the default image satisfies both enforce policies', () => {
  const img = defaultImage('my-service')
  assertNotMatch(img, /:latest$/, 'must not use :latest')
  assertMatch(img, /:[0-9]/, 'must carry an explicit version tag')
  assertMatch(img, /^harbor-core\./, 'must be the platform registry')
  // The placeholder registry that existed nowhere.
  assertNotMatch(img, /registry\.adhar\.local/)
})

Deno.test('the registry and tag are overridable, and a trailing slash is tolerated', () => {
  assertEquals(defaultImage('svc', 'harbor.example.com/team/', '2.3.4'), 'harbor.example.com/team/svc:2.3.4')
  assertEquals(defaultImage('svc', 'harbor.example.com/team'), 'harbor.example.com/team/svc:0.1.0')
})

Deno.test('every family renders a deploy/ folder Argo CD can sync', () => {
  for (const family of ['microservice', 'frontend', 'data-pipeline', 'ml'] as const) {
    const files = generateGoldenPathFiles(family, { name: 'demo' })
    const paths = files.map((f) => f.path)
    // The Argo CD Application the scaffolder opens points at `deploy`; an empty
    // deploy/ leaves it stuck at sync status Unknown forever.
    const deploy = paths.filter((p) => p.startsWith('deploy/'))
    assertEquals(deploy.length > 0, true, `${family} produced no deploy/ files`)
    assertEquals(paths.includes('catalog-info.yaml'), true, `${family} has no catalog descriptor`)
  }
})

Deno.test('no rendered manifest carries a :latest image or the dead placeholder registry', () => {
  for (const family of ['microservice', 'frontend', 'data-pipeline', 'ml'] as const) {
    for (const f of generateGoldenPathFiles(family, { name: 'demo' })) {
      assertNotMatch(f.content, /registry\.adhar\.local/, `${family}:${f.path} still names the dead registry`)
      if (f.path.startsWith('deploy/')) {
        assertNotMatch(f.content, /image:.*:latest/, `${family}:${f.path} uses a :latest image`)
      }
    }
  }
})

Deno.test('a caller-supplied image is used verbatim', () => {
  const files = generateGoldenPathFiles('microservice', { name: 'demo', image: 'reg.io/x/demo:9.9.9' })
  const dep = files.find((f) => f.path === 'deploy/deployment.yaml')!
  assertMatch(dep.content, /image: reg\.io\/x\/demo:9\.9\.9/)
})

// Phase 4 (ADR-0020): the data-pipeline golden path must land in the platform
// lakehouse, not log a row count and write nowhere — the Iceberg REST catalog
// RustFS serves, the platform object-store credential under BOTH the S3_* and
// AWS_* names PyIceberg signs with, and a Trino-bootstrapped raw table.
Deno.test('the data-pipeline family writes the platform lakehouse', () => {
  const files = generateGoldenPathFiles('data-pipeline', { name: 'demo-etl' })
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]))
  assertMatch(byPath['dagster/pipeline.py'], /rustfs\.adhar-system\.svc\.cluster\.local:9000\/iceberg/)
  assertMatch(byPath['dagster/pipeline.py'], /header\.x-amz-content-sha256/, 'RustFS needs the SigV4 payload-hash header')
  assertMatch(byPath['dagster/pipeline.py'], /CREATE TABLE IF NOT EXISTS iceberg/, 'raw table is bootstrapped through Trino')
  assertNotMatch(byPath['dagster/pipeline.py'], /from __future__ import annotations/, 'Dagster 1.9 rejects postponed annotations on assets')
  assertMatch(byPath['deploy/external-secret.yaml'], /AWS_ACCESS_KEY_ID/)
  assertMatch(byPath['deploy/external-secret.yaml'], /key: root-creds/)
  assertMatch(byPath['deploy/cronworkflow.yaml'], /demo-etl-object-store/)
  assertMatch(byPath['deploy/kustomization.yaml'], /external-secret\.yaml/)
  assertEquals(files.some((f) => f.path === 'pipeline/main.py'), false, 'the toy ETL is gone')
})
