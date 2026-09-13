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
