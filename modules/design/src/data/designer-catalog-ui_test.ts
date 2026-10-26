import { assertEquals } from 'jsr:@std/assert@1'
import { appHasUi, uiVerdict } from './designer-catalog.ts'

Deno.test('what a platform app says decides first', () => {
  assertEquals(uiVerdict({ name: 'portal', language: 'Go' }, [{ type: 'web' }]), 'ui')
  assertEquals(uiVerdict({ name: 'jobs', language: 'TypeScript' }, [{ type: 'worker' }]), 'not-ui')
  assertEquals(uiVerdict({ name: 'etl', language: 'TypeScript' }, [{ type: 'data' }]), 'not-ui')
  assertEquals(uiVerdict({ name: 'agent', language: 'TypeScript' }, [{ type: 'ai' }]), 'not-ui')
})

// `service` is the XRD's default: every app the console scaffolded carried it,
// the React SPA included, and it used to hide that app from the designer.
Deno.test('type service alone vetoes nothing — the repository is checked', () => {
  assertEquals(uiVerdict({ name: 'reactapp', language: 'JavaScript' }, [{ type: 'service' }]), 'check')
  assertEquals(uiVerdict({ name: 'reactapp', language: 'JavaScript' }, [{}]), 'check')
  // …but a back-end language still rules it out without reading a file.
  assertEquals(uiVerdict({ name: 'orders', language: 'Java' }, [{ type: 'service' }]), 'not-ui')
})

Deno.test('a repo backing a UI app and a backend app is a UI target', () => {
  const apps = [{ labels: { 'adhar.io/dashboard-type': 'backend-jvm' } }, { labels: { 'adhar.io/dashboard-type': 'frontend' } }]
  assertEquals(uiVerdict({ name: 'shop', language: 'Java' }, apps), 'ui')
})

Deno.test('mirrors, archived and empty repos are never UI targets', () => {
  assertEquals(uiVerdict({ name: 'upstream', language: 'TypeScript', mirror: true }, []), 'not-ui')
  assertEquals(uiVerdict({ name: 'old-portal', language: 'TypeScript', archived: true }, [{ type: 'web' }]), 'not-ui')
  assertEquals(uiVerdict({ name: 'new', empty: true }, []), 'not-ui')
})

Deno.test('back-end languages are ruled out; web languages and unknown need a package.json check', () => {
  assertEquals(uiVerdict({ name: 'a', language: 'Go' }, []), 'not-ui')
  assertEquals(uiVerdict({ name: 'b', language: 'Java' }, []), 'not-ui')
  assertEquals(uiVerdict({ name: 'c', language: 'TypeScript' }, []), 'check')
  assertEquals(uiVerdict({ name: 'd', language: 'Vue' }, []), 'check')
  assertEquals(uiVerdict({ name: 'e', language: null }, []), 'check')
  assertEquals(uiVerdict({ name: 'f' }, []), 'check')
})

// The same order the Application composition picks the dashboard template in
// (argocd-multienv.yaml): the field, then the scaffolder's label, then a
// browser app (type web / adhar.io/frontend), else nothing said.
Deno.test('an app says it has a UI the way the composition picks its dashboard', () => {
  assertEquals(appHasUi({ dashboard: 'backend-jvm', labels: { 'adhar.io/dashboard-type': 'frontend' } }), false)
  assertEquals(appHasUi({ dashboard: 'auto', labels: { 'adhar.io/dashboard-type': 'fullstack' } }), true)
  assertEquals(appHasUi({ type: 'web', labels: { 'adhar.io/dashboard-type': 'backend-generic' } }), false)
  assertEquals(appHasUi({ type: 'service', labels: { 'adhar.io/frontend': 'true' } }), true)
  assertEquals(appHasUi({ type: 'service', labels: { 'adhar.io/frontend': 'false' } }), undefined)
  // An unknown value is ignored, not trusted — and never read off the prototype.
  assertEquals(appHasUi({ labels: { 'adhar.io/dashboard-type': 'cobol' } }), undefined)
  assertEquals(appHasUi({ labels: { 'adhar.io/dashboard-type': 'constructor' } }), undefined)
  assertEquals(appHasUi({ type: 'Web' }), true)
  assertEquals(appHasUi({}), undefined)
})
