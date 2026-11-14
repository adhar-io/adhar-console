import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { flipElementWithCompanions } from './appset.ts'

// Enabling Volcano from the Marketplace must also enable adhar-batch-volcano, or
// Volcano runs with no queue binding and no run integrity: any team could name any
// queue. Both lines change in ONE edit, so they land in one commit.
const APPSET = `spec:
  generators:
    - list:
        elements:
          # Volcano: off until the production gate.
          - name: "volcano"
            enabled: "false"
            manifestPath: "core/volcano/manifests"
          # Its policies; synced only where Volcano is.
          - name: "adhar-batch-volcano"
            enabled: "false"
            manifestPath: "core/adhar-batch/manifests/volcano"
          - name: "harbor"
            enabled: "false"
            manifestPath: "application/harbor/manifests"
`

function enabledOf(text: string, name: string): string | undefined {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim() === `- name: "${name}"`)
  return lines[i + 1]?.match(/enabled:\s*"(true|false)"/)?.[1]
}

Deno.test('enabling volcano also enables adhar-batch-volcano, in one edit', () => {
  const r = flipElementWithCompanions(APPSET, 'volcano', true)
  if (!r.ok) throw new Error(r.reason)
  assertEquals([r.changed, r.companions], [true, ['adhar-batch-volcano']])
  assertEquals([enabledOf(r.text, 'volcano'), enabledOf(r.text, 'adhar-batch-volcano'), enabledOf(r.text, 'harbor')], [
    'true',
    'true',
    'false',
  ])
  // Only the two enabled: lines differ; every comment survives.
  const diff = APPSET.split('\n').filter((l, i) => l !== r.text.split('\n')[i])
  assertEquals(diff.length, 2)
})

Deno.test('the companion is switched in both directions, and off with the package', () => {
  const on = flipElementWithCompanions(APPSET, 'adhar-batch-volcano', true)
  if (!on.ok) throw new Error(on.reason)
  assertEquals(enabledOf(on.text, 'volcano'), 'true')
  const off = flipElementWithCompanions(on.text, 'volcano', false)
  if (!off.ok) throw new Error(off.reason)
  assertEquals([enabledOf(off.text, 'volcano'), enabledOf(off.text, 'adhar-batch-volcano')], ['false', 'false'])
})

Deno.test('a package already on still commits its missing companion', () => {
  const half = APPSET.replace('- name: "volcano"\n            enabled: "false"', '- name: "volcano"\n            enabled: "true"')
  const r = flipElementWithCompanions(half, 'volcano', true)
  if (!r.ok) throw new Error(r.reason)
  assertEquals([r.changed, r.companions], [true, ['adhar-batch-volcano']])
})

Deno.test('a stack without the companion element still toggles the package; others are untouched', () => {
  const older = APPSET.replace(/ {10}# Its policies[\s\S]*?manifests\/volcano"\n/, '')
  const r = flipElementWithCompanions(older, 'volcano', true)
  if (!r.ok) throw new Error(r.reason)
  assertEquals([r.changed, r.companions, enabledOf(r.text, 'volcano')], [true, [], 'true'])
  const h = flipElementWithCompanions(APPSET, 'harbor', true)
  if (!h.ok) throw new Error(h.reason)
  assertEquals([h.companions, enabledOf(h.text, 'volcano')], [[], 'false'])
})
