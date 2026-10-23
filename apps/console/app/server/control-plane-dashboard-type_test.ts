import { assertEquals } from 'jsr:@std/assert@1'
import { applicationManifest, dashboardTypeOf } from './control-plane.ts'

// Without the label the composition falls back to backend-generic, so every
// console-scaffolded Spring Boot service lost its JVM panels (2026-10-23).
Deno.test('the template declares the dashboard type and the XR carries it', () => {
  const doc = { metadata: { name: 'springboot-web-service', labels: { 'adhar.io/dashboard-type': 'backend-jvm' } } }
  const m = applicationManifest({ name: 'orders', project: 'shop', repoUrl: 'x', dashboardType: dashboardTypeOf(doc) })
  assertEquals(m.metadata.labels?.['adhar.io/dashboard-type'], 'backend-jvm')
})

Deno.test('an unknown or missing type adds no label', () => {
  assertEquals(dashboardTypeOf({ metadata: { labels: { 'adhar.io/dashboard-type': 'mainframe' } } }), undefined)
  assertEquals(dashboardTypeOf({ metadata: {} }), undefined)
  assertEquals(dashboardTypeOf(null), undefined)
  const m = applicationManifest({ name: 'orders', project: 'shop', repoUrl: 'x' })
  assertEquals('adhar.io/dashboard-type' in (m.metadata.labels ?? {}), false)
})

Deno.test('every template type the composition knows is accepted', () => {
  for (const t of ['backend-jvm', 'backend-generic', 'frontend', 'fullstack']) {
    assertEquals(dashboardTypeOf({ metadata: { labels: { 'adhar.io/dashboard-type': t } } }), t)
  }
})

// The scaffolder must actually pass it through.
Deno.test('the scaffolder stamps the template dashboard type on the Application', async () => {
  const src = await Deno.readTextFile(new URL('./scaffolder.ts', import.meta.url))
  for (const want of ['dashboardType = dashboardTypeOf(doc)', 'path: manifestPath, dashboardType })']) {
    if (!src.includes(want)) throw new Error(`scaffolder.ts lacks ${want}`)
  }
})
