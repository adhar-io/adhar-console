import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1'
import {
  affectedScopes,
  appIgnoreKey,
  canApproveWaivers,
  canEditScanPolicy,
  DEFAULT_POLICY,
  gateDecisionPatch,
  gateOf,
  ignoreEntry,
  isActive,
  isExpiringSoon,
  isPlatformAdmin,
  mergeConfigMapData,
  newWaiver,
  parsePolicy,
  readScanSummary,
  renderTrivyIgnore,
  renderWaiverConfigMap,
  SCAN_APPROVAL_ANNOTATION,
  serializePolicy,
  sweep,
  transition,
  type TransitionCtx,
  TRIVYIGNORE_KEY,
  validatePolicy,
  validateWaiverRequest,
  type WaiverRecord,
  WAIVERS_JSON_KEY,
} from './scan-waivers-model.ts'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const alice = { id: 'u-alice', label: 'Alice' }
const bob = { id: 'u-bob', label: 'Bob' }
const DIGEST = `sha256:${'a'.repeat(64)}`

function req(over: Record<string, unknown> = {}) {
  return {
    kind: 'vuln',
    scope: 'project',
    target: { project: 'shop', app: 'cart', package: 'openssl', purl: 'pkg:deb/debian/openssl@3.0.11' },
    findingId: 'CVE-2024-0001',
    severity: 'HIGH',
    justification: 'Not reachable: TLS terminates at the gateway.',
    vex: { status: 'not_affected', justification: 'vulnerable_code_not_in_execute_path' },
    expiresAt: iso(NOW + 30 * DAY),
    ...over,
  }
}

function waiver(over: Partial<WaiverRecord> = {}): WaiverRecord {
  const v = validateWaiverRequest(req(), NOW, 90)
  if (!v.ok) throw new Error(v.detail)
  return { ...newWaiver('wv-1', v.value, alice, NOW), ...over }
}

function ctx(over: Partial<TransitionCtx> = {}): TransitionCtx {
  return { actor: bob, canApprove: true, platformAdmin: false, now: NOW, maxDays: 90, ...over }
}

/* ── roles ── */

Deno.test('roles: reviewers, platform admins and policy editors', () => {
  assert(canApproveWaivers({ roles: ['security-reviewer'] }))
  assert(canApproveWaivers({ groups: ['/org/Platform-Engineers'] }))
  assert(canApproveWaivers({ roles: ['platform-admin'] }))
  assert(!canApproveWaivers({ roles: ['developer'], groups: ['/shop/members'] }))
  assert(!canApproveWaivers({ groups: ['not-security-reviewer'] }))
  assert(!canApproveWaivers(null))
  assert(isPlatformAdmin({ roles: ['super-admin'] }))
  assert(!isPlatformAdmin({ roles: ['security-reviewer'] }))
  assert(canEditScanPolicy({ roles: ['platform-engineer'] }))
  assert(!canEditScanPolicy({ roles: ['security-reviewer'] }))
})

/* ── validation ── */

Deno.test('validateWaiverRequest: a complete request', () => {
  const v = validateWaiverRequest(req(), NOW, 90)
  assert(v.ok)
  if (!v.ok) return
  assertEquals(v.value.severity, 'high')
  assertEquals(v.value.target.project, 'shop')
  assertEquals(v.value.vex.justification, 'vulnerable_code_not_in_execute_path')
})

Deno.test('validateWaiverRequest: expiry is required, in the future, within the policy maximum', () => {
  const missing = validateWaiverRequest(req({ expiresAt: undefined }), NOW, 90)
  assert(!missing.ok && missing.error === 'missing_expiry')
  const past = validateWaiverRequest(req({ expiresAt: iso(NOW - DAY) }), NOW, 90)
  assert(!past.ok && past.error === 'invalid_expiry')
  const long = validateWaiverRequest(req({ expiresAt: iso(NOW + 31 * DAY) }), NOW, 30)
  assert(!long.ok && long.error === 'expiry_too_long')
})

Deno.test('validateWaiverRequest: scope needs the target it narrows to', () => {
  const app = validateWaiverRequest(req({ scope: 'app', target: { project: 'shop' } }), NOW, 90)
  assert(!app.ok && app.error === 'missing_app')
  const dig = validateWaiverRequest(req({ scope: 'digest', target: { project: 'shop', app: 'cart' } }), NOW, 90)
  assert(!dig.ok && dig.error === 'missing_digest')
  const ok = validateWaiverRequest(req({ scope: 'digest', target: { project: 'shop', app: 'cart', digest: DIGEST } }), NOW, 90)
  assert(ok.ok)
  const badProject = validateWaiverRequest(req({ target: { project: '../etc' } }), NOW, 90)
  assert(!badProject.ok && badProject.error === 'invalid_project')
})

Deno.test('validateWaiverRequest: not_affected needs a VEX justification; false positive implies not_affected', () => {
  const v = validateWaiverRequest(req({ vex: { status: 'not_affected' } }), NOW, 90)
  assert(!v.ok && v.error === 'invalid_vex')
  const fp = validateWaiverRequest(req({ vex: { justification: 'component_not_present' }, falsePositive: true }), NOW, 90)
  assert(fp.ok && fp.value.vex.status === 'not_affected' && fp.value.falsePositive === true)
  const inv = validateWaiverRequest(req({ vex: { status: 'under_investigation' } }), NOW, 90)
  assert(inv.ok)
  const short = validateWaiverRequest(req({ justification: 'ok' }), NOW, 90)
  assert(!short.ok && short.error === 'missing_justification')
})

/* ── state machine ── */

Deno.test('transition: requested → approved by another reviewer', () => {
  const t = transition(waiver(), 'approve', ctx({ comment: 'Accepted' }))
  assert(t.ok)
  if (!t.ok) return
  assertEquals(t.value.status, 'approved')
  assertEquals(t.value.approvedBy, bob)
  assertEquals(t.value.history.map((h) => h.action), ['request', 'approve'])
  assertEquals(t.value.history[1].from, 'requested')
  assertEquals(t.value.history[1].comment, 'Accepted')
})

Deno.test('transition: approval needs a reviewer role', () => {
  const t = transition(waiver(), 'approve', ctx({ canApprove: false }))
  assert(!t.ok && t.status === 403)
})

Deno.test('transition: no self-approval, except a platform admin with a stated reason', () => {
  const me = ctx({ actor: alice })
  const a = transition(waiver(), 'approve', me)
  assert(!a.ok && a.error === 'self_approval')
  const b = transition(waiver(), 'approve', { ...me, platformAdmin: true })
  assert(!b.ok && b.error === 'self_approval_reason')
  const c = transition(waiver(), 'approve', { ...me, platformAdmin: true, selfApproveReason: 'Weekend hotfix, no other reviewer on call.' })
  assert(c.ok && c.value.selfApproved === true && c.value.history[1].selfApproveReason)
})

Deno.test('transition: reject and revoke need a comment; terminal states stay terminal', () => {
  const r = transition(waiver(), 'reject', ctx())
  assert(!r.ok && r.error === 'missing_comment')
  const rejected = transition(waiver(), 'reject', ctx({ comment: 'Upgrade instead' }))
  assert(rejected.ok && rejected.value.status === 'rejected')
  if (!rejected.ok) return
  const again = transition(rejected.value, 'approve', ctx())
  assert(!again.ok && again.error === 'invalid_transition')
  const approved = transition(waiver(), 'approve', ctx())
  assert(approved.ok)
  if (!approved.ok) return
  const rv = transition(approved.value, 'revoke', ctx({ actor: alice, canApprove: false, comment: 'Fixed upstream' }))
  assert(rv.ok && rv.value.status === 'revoked', 'the requester may revoke their own waiver')
  const stranger = transition(approved.value, 'revoke', ctx({ actor: { id: 'x', label: 'X' }, canApprove: false, comment: 'no' }))
  assert(!stranger.ok && stranger.status === 403)
})

Deno.test('transition: only the requester withdraws; comments never change status', () => {
  assert(!transition(waiver(), 'withdraw', ctx()).ok)
  const w = transition(waiver(), 'withdraw', ctx({ actor: alice }))
  assert(w.ok && w.value.status === 'revoked')
  const c = transition(waiver(), 'comment', ctx({ comment: 'Which path?' }))
  assert(c.ok && c.value.status === 'requested' && c.value.history.length === 2)
})

Deno.test('transition: an approval past its expiry or beyond the policy max is refused', () => {
  const late = transition(waiver({ expiresAt: iso(NOW - 1) }), 'approve', ctx())
  assert(!late.ok && late.error === 'expired')
  const tooLong = transition(waiver({ expiresAt: iso(NOW + 60 * DAY) }), 'approve', ctx({ maxDays: 30 }))
  assert(!tooLong.ok && tooLong.error === 'expiry_too_long')
})

/* ── expiry ── */

Deno.test('expiry: active, expiring soon, and the sweep', () => {
  const live = waiver({ status: 'approved', expiresAt: iso(NOW + 3 * DAY) })
  const far = waiver({ id: 'wv-2', status: 'approved', expiresAt: iso(NOW + 30 * DAY) })
  const gone = waiver({ id: 'wv-3', status: 'approved', expiresAt: iso(NOW - DAY) })
  const stale = waiver({ id: 'wv-4', status: 'requested', expiresAt: iso(NOW - DAY) })
  const told = waiver({ id: 'wv-5', status: 'approved', expiresAt: iso(NOW + 2 * DAY), expiryNotifiedAt: iso(NOW - DAY) })
  assert(isActive(live, NOW) && !isActive(gone, NOW))
  assert(isExpiringSoon(live, NOW) && !isExpiringSoon(far, NOW))
  const s = sweep([live, far, gone, stale, told], NOW)
  assertEquals(s.expire.map((w) => w.id).sort(), ['wv-3', 'wv-4'])
  assertEquals(s.warn.map((w) => w.id), ['wv-1'])
})

/* ── rendering ── */

Deno.test('ignoreEntry: scope targeting → purls / paths, expiry carried', () => {
  const e = ignoreEntry(waiver({ status: 'approved', approvedBy: bob, target: { project: 'shop', purl: 'pkg:npm/lodash@4.17.20', path: 'app/package-lock.json' } }))
  assertEquals(e.id, 'CVE-2024-0001')
  assertEquals(e.purls, ['pkg:npm/lodash@4.17.20'])
  assertEquals(e.paths, ['app/package-lock.json'])
  assertEquals(e.expired_at, '2026-11-20T12:00:00Z')
  assertStringIncludes(e.statement, 'approved by Bob')
  // Licenses never carry purls (Trivy matches them by name and path).
  const lic = ignoreEntry(waiver({ kind: 'license', findingId: 'GPL-3.0', target: { project: 'shop', purl: 'pkg:npm/x@1' } }))
  assertEquals(lic.purls, undefined)
})

Deno.test('renderTrivyIgnore: sections, quoting, determinism, empty file', () => {
  const a = waiver({ id: 'wv-b', status: 'approved', justification: 'has "quotes"\nand newline' })
  const b = waiver({ id: 'wv-a', status: 'approved', kind: 'license', findingId: 'AGPL-3.0', target: { project: 'shop' } })
  const out = renderTrivyIgnore([a, b])
  assertStringIncludes(out, 'vulnerabilities:\n  - id: "CVE-2024-0001"')
  assertStringIncludes(out, 'licenses:\n  - id: "AGPL-3.0"')
  assertStringIncludes(out, 'expired_at: 2026-11-20T12:00:00Z')
  assertStringIncludes(out, '\\"quotes\\" and newline')
  assert(out.indexOf('vulnerabilities:') < out.indexOf('licenses:'))
  assertEquals(renderTrivyIgnore([b, a]), out)
  assertStringIncludes(renderTrivyIgnore([]), '{}')
})

Deno.test('renderWaiverConfigMap: only approved + unexpired; project/app/digest/platform targeting', () => {
  const project = waiver({ id: 'p', status: 'approved', scope: 'project', target: { project: 'shop' } })
  const app = waiver({ id: 'a', status: 'approved', scope: 'app', findingId: 'CVE-2024-0002', target: { project: 'shop', app: 'cart' } })
  const dig = waiver({ id: 'd', status: 'approved', scope: 'digest', findingId: 'CVE-2024-0003', target: { project: 'shop', app: 'cart', digest: DIGEST } })
  const plat = waiver({ id: 'g', status: 'approved', scope: 'platform', findingId: 'CVE-2024-0004', target: { project: 'shop' } })
  const pending = waiver({ id: 'r', status: 'requested', findingId: 'CVE-2024-0005' })
  const expired = waiver({ id: 'x', status: 'approved', findingId: 'CVE-2024-0006', expiresAt: iso(NOW - 1) })
  const other = waiver({ id: 'o', status: 'approved', findingId: 'CVE-2024-0007', target: { project: 'blog' } })
  const all = [project, app, dig, plat, pending, expired, other]

  const cm = renderWaiverConfigMap(all, 'shop', NOW)
  assertEquals([cm.namespace, cm.name, cm.count], ['shop', 'scan-waivers', 3])
  assertStringIncludes(cm.data[TRIVYIGNORE_KEY], 'CVE-2024-0001')
  for (const id of ['CVE-2024-0002', 'CVE-2024-0003', 'CVE-2024-0004', 'CVE-2024-0005', 'CVE-2024-0006', 'CVE-2024-0007']) {
    assert(!cm.data[TRIVYIGNORE_KEY].includes(id), `${id} must not be namespace-wide`)
  }
  const cart = cm.data[appIgnoreKey('cart')]
  assertStringIncludes(cart, 'CVE-2024-0001')
  assertStringIncludes(cart, 'CVE-2024-0002')
  assert(!cart.includes('CVE-2024-0003'), 'digest scope is never rendered into an ignore file')
  const records = JSON.parse(cm.data[WAIVERS_JSON_KEY]).waivers as Array<{ id: string; status: string; requestedBy: string }>
  assertEquals(records.map((r) => r.id).sort(), ['a', 'd', 'p'])
  assertEquals(records[0].requestedBy, 'Alice')

  const g = renderWaiverConfigMap(all, null, NOW)
  assertEquals([g.namespace, g.name, g.count], ['adhar-system', 'scan-waivers-global', 1])
  assertStringIncludes(g.data[TRIVYIGNORE_KEY], 'CVE-2024-0004')
})

Deno.test('mergeConfigMapData: owned keys replaced, stale app files dropped, others kept, idempotent', () => {
  const existing = { [TRIVYIGNORE_KEY]: 'old', [appIgnoreKey('gone')]: 'old', 'README': 'operator note' }
  const rendered = { [TRIVYIGNORE_KEY]: 'new', [WAIVERS_JSON_KEY]: '{}' }
  const m = mergeConfigMapData(existing, rendered)
  assert(m.changed)
  assertEquals(m.data, { README: 'operator note', [TRIVYIGNORE_KEY]: 'new', [WAIVERS_JSON_KEY]: '{}' })
  assertEquals(mergeConfigMapData(m.data, rendered).changed, false)
})

Deno.test('affectedScopes', () => {
  assertEquals(affectedScopes([
    { scope: 'app', target: { project: 'shop' } },
    { scope: 'project', target: { project: 'blog' } },
    { scope: 'digest', target: { project: 'shop' } },
  ]), { projects: ['blog', 'shop'], global: false })
  assertEquals(affectedScopes([{ scope: 'platform', target: { project: 'shop' } }]), { projects: [], global: true })
})

/* ── policy ── */

Deno.test('policy: parse with fallbacks, serialize round-trip, validate', () => {
  const global = parsePolicy({ failOnSeverity: 'critical, high', mode: 'enforce', maxWaiverDays: '30', licenseDeny: 'AGPL-3.0,GPL-3.0' })
  assertEquals(global.failOnSeverity, ['CRITICAL', 'HIGH'])
  assertEquals(global.mode, 'enforce')
  assertEquals(global.maxWaiverDays, 30)
  // A project ConfigMap overrides only the keys it sets.
  const project = parsePolicy({ mode: 'warn' }, global)
  assertEquals(project.mode, 'warn')
  assertEquals(project.licenseDeny, ['AGPL-3.0', 'GPL-3.0'])
  assertEquals(parsePolicy(serializePolicy(global)), global)
  assertEquals(parsePolicy(undefined), DEFAULT_POLICY)

  assert(validatePolicy({ ...global }).ok)
  assert(!validatePolicy({ ...global, mode: 'block' }).ok)
  assert(!validatePolicy({ ...global, failOnSeverity: ['SEVERE'] }).ok)
  assert(!validatePolicy({ ...global, maxWaiverDays: 0 }).ok)
  assert(!validatePolicy({ ...global, scanners: ['sast'] }).ok)
})

/* ── the gate ── */

Deno.test('readScanSummary: JSON summary or one result per count', () => {
  assertEquals(readScanSummary([{ name: 'scan-summary', value: '{"critical":2,"high":5,"fixable":4}' }]).summary, { critical: 2, high: 5, fixable: 4 })
  const r = readScanSummary([
    { name: 'VULN_CRITICAL', value: '1' },
    { name: 'vuln-high', value: '3' },
    { name: 'scan-gate', value: 'FAIL' },
    { name: 'IMAGE_DIGEST', value: DIGEST },
    { name: 'scan-findings', value: '["CVE-1","CVE-2"]' },
  ])
  assertEquals(r.summary, { critical: 1, high: 3 })
  assertEquals(r.gate, 'fail')
  assertEquals(r.digest, DIGEST)
  assertEquals(r.findings, ['CVE-1', 'CVE-2'])
})

Deno.test('gateOf: awaiting from a running gate task or the gate annotation; decision wins', () => {
  const running = {
    metadata: { name: 'cart-ci-1', namespace: 'shop', labels: { 'adhar.io/app': 'cart' } },
    status: { conditions: [{ type: 'Succeeded', status: 'Unknown' }], childReferences: [{ pipelineTaskName: 'scan-approval' }] },
  }
  assertEquals(gateOf(running).state, 'awaiting')
  assertEquals(gateOf(running).app, 'cart')
  const annotated = { ...running, status: { conditions: [{ type: 'Succeeded', status: 'Unknown' }] }, metadata: { ...running.metadata, annotations: { 'adhar.io/scan-gate': 'awaiting-approval' } } }
  assertEquals(gateOf(annotated).state, 'awaiting')
  const decided = { ...running, metadata: { ...running.metadata, annotations: { [SCAN_APPROVAL_ANNOTATION]: 'approved', 'adhar.io/scan-approval-by': 'Bob' } } }
  assertEquals(gateOf(decided).state, 'approved')
  assertEquals(gateOf(decided).decision?.by, 'Bob')
  // A finished run is never "awaiting", whatever the annotation says.
  const finished = { ...annotated, status: { conditions: [{ type: 'Succeeded', status: 'False' }] } }
  assertEquals(gateOf(finished).state, 'none')
  const passed = { metadata: { name: 'r', namespace: 'shop' }, status: { conditions: [{ type: 'Succeeded', status: 'True' }], results: [{ name: 'scan-gate', value: 'pass' }] } }
  assertEquals(gateOf(passed).state, 'passed')
})

Deno.test('gateDecisionPatch: the decision annotation plus who / when / why', () => {
  const p = gateDecisionPatch('rejected', 'Bob', '2026-10-21T12:00:00Z', ' too risky ')
  assertEquals(p.metadata.annotations[SCAN_APPROVAL_ANNOTATION], 'rejected')
  assertEquals(p.metadata.annotations['adhar.io/scan-approval-comment'], 'too risky')
})
