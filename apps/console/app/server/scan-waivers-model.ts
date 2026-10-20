import { normaliseToken } from './role-tokens.ts'

/**
 * Scan waivers, scan policy and the manual scan gate — the pure half.
 *
 * Everything here is I/O-free so it can be unit-tested; `scan-waivers.ts` does
 * the database, the apiserver and the notifications. The contract with the
 * platform (which enforces what is written here in CI and at runtime):
 *
 *   • Waivers — ConfigMap `scan-waivers` in the project namespace `<project>`
 *     (`scan-waivers-global` in `adhar-system` for platform-wide ones), label
 *     `adhar.io/scan-waivers: "true"`, keys
 *       `trivyignore.yaml`  Trivy's YAML ignore file — ONLY approved, unexpired
 *                           waivers that apply to the whole namespace scope;
 *       `trivyignore.app.<app>.yaml`  the same plus that app's own waivers;
 *       `waivers.json`      the full records of every active waiver (including
 *                           digest-scoped ones, which a Trivy ignore file cannot
 *                           express — the CI gate and the OpenVEX attestation
 *                           read them from here).
 *   • Scan policy — ConfigMap `scan-policy` in `<project>` (`scan-policy-global`
 *     in `adhar-system`), string keys `failOnSeverity`, `ignoreUnfixed`,
 *     `licenseDeny`, `licenseWarn`, `scanners`, `mode`, `manualApproval`,
 *     `maxWaiverDays`.
 *   • Manual gate — a paused PipelineRun is approved or rejected by setting the
 *     annotation in {@link SCAN_APPROVAL_ANNOTATION}. That name lives here and
 *     nowhere else: the UI asks the server to decide, it never patches it.
 */

/* ─────────────────────────── contract constants ─────────────────────────── */

export const WAIVER_KIND = 'security.waiver'
export const GATE_DECISION_KIND = 'security.gate-decision'

export const PLATFORM_NAMESPACE = 'adhar-system'
export const WAIVERS_CM = 'scan-waivers'
export const WAIVERS_GLOBAL_CM = 'scan-waivers-global'
export const POLICY_CM = 'scan-policy'
export const POLICY_GLOBAL_CM = 'scan-policy-global'
export const WAIVERS_LABEL = 'adhar.io/scan-waivers'
export const POLICY_LABEL = 'adhar.io/scan-policy'

/** The ONE place the gate's decision annotation is named. */
export const SCAN_APPROVAL_ANNOTATION = 'adhar.io/scan-approval'
/** Who decided, when and why — written next to the decision for the audit trail on the run itself. */
export const SCAN_APPROVAL_BY_ANNOTATION = 'adhar.io/scan-approval-by'
export const SCAN_APPROVAL_AT_ANNOTATION = 'adhar.io/scan-approval-at'
export const SCAN_APPROVAL_COMMENT_ANNOTATION = 'adhar.io/scan-approval-comment'
/** Gate state the platform may publish on the run (`awaiting-approval`, `passed`, `failed`, `warned`). */
export const SCAN_GATE_ANNOTATION = 'adhar.io/scan-gate'

export const TRIVYIGNORE_KEY = 'trivyignore.yaml'
export const WAIVERS_JSON_KEY = 'waivers.json'
export const appIgnoreKey = (app: string) => `trivyignore.app.${app}.yaml`
const OWNED_KEY = /^trivyignore(\.app\.[a-z0-9-]+)?\.yaml$|^waivers\.json$/

export const DEFAULT_MAX_WAIVER_DAYS = 90
export const EXPIRING_SOON_DAYS = 7
const DAY = 86_400_000

/* ───────────────────────────────── types ───────────────────────────────── */

export type WaiverKind = 'vuln' | 'license' | 'misconfig' | 'secret'
export type WaiverScope = 'digest' | 'app' | 'project' | 'platform'
export type WaiverStatus = 'requested' | 'approved' | 'rejected' | 'expired' | 'revoked'
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'
/** OpenVEX statuses. */
export type VexStatus = 'not_affected' | 'affected' | 'fixed' | 'under_investigation'
/** OpenVEX justifications for `not_affected`. */
export type VexJustification =
  | 'component_not_present'
  | 'vulnerable_code_not_present'
  | 'vulnerable_code_not_in_execute_path'
  | 'vulnerable_code_cannot_be_controlled_by_adversary'
  | 'inline_mitigations_already_exist'

export const WAIVER_KINDS: readonly WaiverKind[] = ['vuln', 'license', 'misconfig', 'secret']
export const WAIVER_SCOPES: readonly WaiverScope[] = ['digest', 'app', 'project', 'platform']
export const VEX_STATUSES: readonly VexStatus[] = ['not_affected', 'affected', 'fixed', 'under_investigation']
export const VEX_JUSTIFICATIONS: readonly VexJustification[] = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

export interface Actor {
  id: string
  label: string
}

export interface WaiverTarget {
  project: string
  app?: string
  repo?: string
  image?: string
  digest?: string
  package?: string
  /** Package URL (`pkg:npm/lodash@4.17.20`) — what Trivy's `purls` matches. */
  purl?: string
  version?: string
  /** File / package path inside the image (Trivy's `paths`). */
  path?: string
}

export type WaiverAction =
  | 'request'
  | 'approve'
  | 'reject'
  | 'revoke'
  | 'withdraw'
  | 'expire'
  | 'comment'
  | 'extend'
  | 'supersede'
  | 'sync'

export interface WaiverEvent {
  at: string
  by: Actor
  action: WaiverAction
  from?: WaiverStatus
  to?: WaiverStatus
  comment?: string
  [k: string]: unknown
}

/** What a requester states; the rest of a record is the review around it. */
export interface WaiverFields {
  kind: WaiverKind
  scope: WaiverScope
  target: WaiverTarget
  /** CVE / GHSA id, license id (SPDX), AVD misconfig id or secret rule id. */
  findingId: string
  severity?: Severity
  title?: string
  justification: string
  vex: { status: VexStatus; justification?: VexJustification; impact?: string }
  falsePositive?: boolean
  expiresAt: string
  /** Set on a re-review (extend) request: the waiver this one replaces when approved. */
  supersedes?: string
  /** Where the request came from (a paused PipelineRun's manual gate). */
  source?: { pipelineRun?: string }
}

export interface WaiverRecord extends WaiverFields {
  id: string
  requestedBy: Actor
  requestedAt: string
  approvedBy?: Actor
  approvedAt?: string
  decidedBy?: Actor
  decidedAt?: string
  selfApproved?: boolean
  status: WaiverStatus
  supersededBy?: string
  history: WaiverEvent[]
  /** One "expiring soon" notification per waiver. */
  expiryNotifiedAt?: string
  /** Outcome of the last ConfigMap render that included (or dropped) it. */
  sync?: { at: string; ok: boolean; detail: string }
  [k: string]: unknown
}

/* ──────────────────────────────── roles ──────────────────────────────── */

type UserLike = { id?: string; roles?: readonly string[]; groups?: readonly string[] } | null | undefined

const APPROVER_TOKENS = new Set([
  'admin', 'super-admin', 'superadmin',
  'platform-admin', 'platform-admins',
  'platform-engineer', 'platform-engineers', 'platform-eng',
  'security-reviewer', 'security-reviewers', 'security-admin', 'security-admins', 'security', 'secops',
])
const PLATFORM_ADMIN_TOKENS = new Set(['admin', 'super-admin', 'superadmin', 'platform-admin', 'platform-admins'])
const POLICY_ADMIN_TOKENS = new Set([
  ...PLATFORM_ADMIN_TOKENS,
  'platform-engineer', 'platform-engineers', 'platform-eng',
  'security-admin', 'security-admins',
])

function hasToken(user: UserLike, tokens: Set<string>): boolean {
  if (!user) return false
  for (const raw of [...(user.roles ?? []), ...(user.groups ?? [])]) {
    if (typeof raw === 'string' && tokens.has(normaliseToken(raw))) return true
  }
  return false
}

/** May review (approve / reject / revoke) waivers and decide scan gates. */
export const canApproveWaivers = (user: UserLike) => hasToken(user, APPROVER_TOKENS)
export const isPlatformAdmin = (user: UserLike) => hasToken(user, PLATFORM_ADMIN_TOKENS)
/** May change scan policy (project and global). */
export const canEditScanPolicy = (user: UserLike) => hasToken(user, POLICY_ADMIN_TOKENS)

/* ─────────────────────────── validation ─────────────────────────── */

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:+\-/() ]{0,127}$/

export const isDnsLabel = (s: unknown): s is string => typeof s === 'string' && DNS_LABEL.test(s)

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail: string }
const fail = (status: number, error: string, detail: string): { ok: false; status: number; error: string; detail: string } => ({ ok: false, status, error, detail })

export interface WaiverRequestBody {
  kind?: unknown
  scope?: unknown
  target?: unknown
  findingId?: unknown
  severity?: unknown
  title?: unknown
  justification?: unknown
  vex?: unknown
  falsePositive?: unknown
  expiresAt?: unknown
  source?: unknown
}

const str = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** Days between now and an ISO instant (fractional). */
export const daysUntil = (iso: string, now: number) => (Date.parse(iso) - now) / DAY

/**
 * Validate a waiver request. Pure. `maxDays` comes from the effective scan
 * policy; an expiry is always required — a waiver that never ends is a
 * suppression nobody revisits.
 */
export function validateWaiverRequest(body: WaiverRequestBody | null | undefined, now: number, maxDays: number): Result<WaiverFields> {
  if (!body || typeof body !== 'object') return fail(400, 'invalid_body', 'Expected a JSON object.')
  const kind = body.kind as WaiverKind
  if (!WAIVER_KINDS.includes(kind)) return fail(400, 'invalid_kind', `kind must be one of ${WAIVER_KINDS.join(', ')}.`)
  const scope = body.scope as WaiverScope
  if (!WAIVER_SCOPES.includes(scope)) return fail(400, 'invalid_scope', `scope must be one of ${WAIVER_SCOPES.join(', ')}.`)
  const t = (body.target && typeof body.target === 'object' ? body.target : {}) as Record<string, unknown>
  const target: WaiverTarget = { project: str(t.project, 63) ?? '' }
  for (const k of ['app', 'repo', 'image', 'digest', 'package', 'purl', 'version', 'path'] as const) {
    const v = str(t[k], 500)
    if (v) target[k] = v
  }
  if (!isDnsLabel(target.project)) return fail(400, 'invalid_project', 'target.project must be the project (its namespace name).')
  if (target.app !== undefined && !isDnsLabel(target.app)) return fail(400, 'invalid_app', 'target.app must be a DNS-1123 label.')
  if ((scope === 'app' || scope === 'digest') && !target.app) return fail(400, 'missing_app', `A ${scope}-scoped waiver needs target.app.`)
  if (scope === 'digest') {
    if (!target.digest || !DIGEST.test(target.digest)) return fail(400, 'missing_digest', 'A digest-scoped waiver needs target.digest (sha256:…).')
  }
  if (target.digest && !DIGEST.test(target.digest)) return fail(400, 'invalid_digest', 'target.digest must be sha256:<64 hex>.')
  const findingId = str(body.findingId, 128)
  if (!findingId || !FINDING_ID.test(findingId)) return fail(400, 'invalid_finding', 'findingId is required (CVE / GHSA / license / rule id).')
  const justification = str(body.justification, 4000)
  if (!justification || justification.length < 10) return fail(400, 'missing_justification', 'Explain why this finding is acceptable (at least 10 characters).')

  const v = (body.vex && typeof body.vex === 'object' ? body.vex : {}) as Record<string, unknown>
  const falsePositive = body.falsePositive === true
  const vexStatus = (v.status ?? (falsePositive ? 'not_affected' : undefined)) as VexStatus
  if (!VEX_STATUSES.includes(vexStatus)) return fail(400, 'invalid_vex', `vex.status must be one of ${VEX_STATUSES.join(', ')}.`)
  const vexJust = v.justification as VexJustification | undefined
  if (vexStatus === 'not_affected') {
    if (!vexJust || !VEX_JUSTIFICATIONS.includes(vexJust)) {
      return fail(400, 'invalid_vex', `"not affected" needs a VEX justification (${VEX_JUSTIFICATIONS.join(', ')}).`)
    }
  } else if (vexJust !== undefined && vexJust !== null && (vexJust as string) !== '' && !VEX_JUSTIFICATIONS.includes(vexJust)) {
    return fail(400, 'invalid_vex', 'Unknown VEX justification.')
  }
  const exp = str(body.expiresAt, 40)
  const expMs = exp ? Date.parse(exp) : NaN
  if (!exp || Number.isNaN(expMs)) return fail(400, 'missing_expiry', 'An expiry date is required.')
  if (expMs <= now) return fail(400, 'invalid_expiry', 'The expiry must be in the future.')
  if (daysUntil(exp, now) > maxDays + 1 / 24) return fail(400, 'expiry_too_long', `Waivers may last at most ${maxDays} days under the scan policy.`)
  const sev = typeof body.severity === 'string' ? body.severity.toLowerCase() as Severity : undefined
  const src = body.source && typeof body.source === 'object' ? body.source as Record<string, unknown> : undefined

  return {
    ok: true,
    value: {
      kind,
      scope,
      target,
      findingId,
      ...(sev && SEVERITIES.includes(sev) ? { severity: sev } : {}),
      ...(str(body.title, 300) ? { title: str(body.title, 300) } : {}),
      justification,
      vex: {
        status: vexStatus,
        ...(vexJust && VEX_JUSTIFICATIONS.includes(vexJust) ? { justification: vexJust } : {}),
        ...(str(v.impact, 2000) ? { impact: str(v.impact, 2000) } : {}),
      },
      ...(falsePositive ? { falsePositive: true } : {}),
      expiresAt: new Date(expMs).toISOString(),
      ...(src && str(src.pipelineRun, 300) ? { source: { pipelineRun: str(src.pipelineRun, 300) } } : {}),
    },
  }
}

/* ─────────────────────────── state machine ─────────────────────────── */

export interface TransitionCtx {
  actor: Actor
  /** Role facts about the actor, computed by the caller from the session. */
  canApprove: boolean
  platformAdmin: boolean
  now: number
  comment?: string
  /** Platform admins may approve their own request, but only with a stated reason. */
  selfApproveReason?: string
  maxDays: number
}

/** Which transitions exist, and who may take them. */
const TRANSITIONS: Record<WaiverStatus, Partial<Record<WaiverAction, WaiverStatus>>> = {
  requested: { approve: 'approved', reject: 'rejected', withdraw: 'revoked', expire: 'expired' },
  approved: { revoke: 'revoked', expire: 'expired', supersede: 'revoked' },
  rejected: {},
  expired: {},
  revoked: {},
}

export const isTerminal = (s: WaiverStatus) => Object.keys(TRANSITIONS[s]).length === 0

/**
 * Apply one state change. Pure: returns the new record (with the event appended)
 * or the reason it is refused. Comments are always allowed and never change
 * the status.
 */
export function transition(rec: WaiverRecord, action: WaiverAction, ctx: TransitionCtx): Result<WaiverRecord> {
  const at = new Date(ctx.now).toISOString()
  const comment = ctx.comment?.trim().slice(0, 4000) || undefined
  if (action === 'comment') {
    if (!comment) return fail(400, 'missing_comment', 'A comment needs text.')
    return { ok: true, value: { ...rec, history: [...rec.history, { at, by: ctx.actor, action, comment }] } }
  }
  const to = TRANSITIONS[rec.status][action]
  if (!to) return fail(409, 'invalid_transition', `A ${rec.status} waiver cannot be ${pastTense(action)}.`)

  const self = rec.requestedBy.id === ctx.actor.id
  let selfApproved = false
  switch (action) {
    case 'approve': {
      if (!ctx.canApprove) return fail(403, 'forbidden', 'Approving a waiver needs the security-reviewer, platform-engineer or platform-admin role.')
      if (self) {
        if (!ctx.platformAdmin) return fail(403, 'self_approval', 'You cannot approve your own waiver request — another reviewer must.')
        if (!ctx.selfApproveReason?.trim() || ctx.selfApproveReason.trim().length < 10) {
          return fail(400, 'self_approval_reason', 'Approving your own request needs a stated reason (at least 10 characters).')
        }
        selfApproved = true
      }
      if (Date.parse(rec.expiresAt) <= ctx.now) return fail(409, 'expired', 'This request\'s expiry has already passed — ask for a new date.')
      if (daysUntil(rec.expiresAt, ctx.now) > ctx.maxDays + 1 / 24) {
        return fail(400, 'expiry_too_long', `The requested expiry exceeds the policy maximum of ${ctx.maxDays} days.`)
      }
      break
    }
    case 'reject':
      if (!ctx.canApprove) return fail(403, 'forbidden', 'Rejecting a waiver needs the security-reviewer, platform-engineer or platform-admin role.')
      if (!comment) return fail(400, 'missing_comment', 'Say why the request is rejected.')
      break
    case 'revoke':
      // Narrowing is always safe, so the requester may revoke their own waiver too.
      if (!ctx.canApprove && !self) return fail(403, 'forbidden', 'Only a reviewer or the requester can revoke a waiver.')
      if (!comment) return fail(400, 'missing_comment', 'Say why the waiver is revoked.')
      break
    case 'withdraw':
      if (!self) return fail(403, 'forbidden', 'Only the requester can withdraw a request.')
      break
    case 'expire':
    case 'supersede':
      break
    default:
      return fail(400, 'invalid_action', `Unknown action ${action}.`)
  }

  const next: WaiverRecord = {
    ...rec,
    status: to,
    history: [...rec.history, {
      at,
      by: ctx.actor,
      action,
      from: rec.status,
      to,
      ...(comment ? { comment } : {}),
      ...(selfApproved ? { selfApproveReason: ctx.selfApproveReason!.trim().slice(0, 1000) } : {}),
    }],
  }
  if (action === 'approve') {
    next.approvedBy = ctx.actor
    next.approvedAt = at
    next.decidedBy = ctx.actor
    next.decidedAt = at
    if (selfApproved) next.selfApproved = true
  } else if (action === 'reject' || action === 'revoke' || action === 'withdraw') {
    next.decidedBy = ctx.actor
    next.decidedAt = at
  }
  return { ok: true, value: next }
}

function pastTense(a: WaiverAction): string {
  return ({ approve: 'approved', reject: 'rejected', revoke: 'revoked', withdraw: 'withdrawn', expire: 'expired', supersede: 'superseded', extend: 'extended' } as Record<string, string>)[a] ?? a
}

/** A new request record, its first event included. */
export function newWaiver(id: string, fields: WaiverFields, actor: Actor, now: number, comment?: string): WaiverRecord {
  const at = new Date(now).toISOString()
  return {
    ...fields,
    id,
    requestedBy: actor,
    requestedAt: at,
    status: 'requested',
    history: [{ at, by: actor, action: 'request', to: 'requested', ...(comment?.trim() ? { comment: comment.trim().slice(0, 4000) } : {}) }],
  }
}

/* ─────────────────────────────── expiry ─────────────────────────────── */

export const isActive = (w: Pick<WaiverRecord, 'status' | 'expiresAt'>, now: number) =>
  w.status === 'approved' && Date.parse(w.expiresAt) > now

export const isExpiringSoon = (w: Pick<WaiverRecord, 'status' | 'expiresAt'>, now: number, days = EXPIRING_SOON_DAYS) =>
  isActive(w, now) && daysUntil(w.expiresAt, now) <= days

/**
 * The sweep: which waivers have passed their expiry (approved → expired, and a
 * request whose date passed before anyone reviewed it), and which active ones
 * should now get their single "expiring soon" notification.
 */
export function sweep(items: WaiverRecord[], now: number): { expire: WaiverRecord[]; warn: WaiverRecord[] } {
  const expire: WaiverRecord[] = []
  const warn: WaiverRecord[] = []
  for (const w of items) {
    if ((w.status === 'approved' || w.status === 'requested') && Date.parse(w.expiresAt) <= now) expire.push(w)
    else if (isExpiringSoon(w, now) && !w.expiryNotifiedAt) warn.push(w)
  }
  return { expire, warn }
}

/* ─────────────────────── rendering the ConfigMaps ─────────────────────── */

interface IgnoreEntry {
  id: string
  paths?: string[]
  purls?: string[]
  expired_at?: string
  statement: string
}

/** The Trivy ignore-file section a waiver kind belongs to. */
const SECTION: Record<WaiverKind, 'vulnerabilities' | 'licenses' | 'misconfigurations' | 'secrets'> = {
  vuln: 'vulnerabilities',
  license: 'licenses',
  misconfig: 'misconfigurations',
  secret: 'secrets',
}

/**
 * One waiver → one Trivy ignore entry. Scope narrows by what Trivy can match:
 * a package (purl) and/or a path. Licenses and misconfigurations match by id
 * and path only.
 */
export function ignoreEntry(w: WaiverRecord): IgnoreEntry {
  const e: IgnoreEntry = { id: w.findingId, statement: statementOf(w) }
  if (w.target.path) e.paths = [w.target.path]
  if (w.kind === 'vuln' && w.target.purl) e.purls = [w.target.purl]
  // Trivy honours expired_at itself, so an entry that outlives its waiver in a
  // ConfigMap nobody re-rendered still stops applying on time.
  e.expired_at = w.expiresAt.replace(/\.\d{3}Z$/, 'Z')
  return e
}

function statementOf(w: WaiverRecord): string {
  const who = w.approvedBy ? ` approved by ${w.approvedBy.label}` : ''
  const vex = w.vex.status === 'not_affected' && w.vex.justification ? ` [VEX not_affected: ${w.vex.justification}]` : ` [VEX ${w.vex.status}]`
  return `adhar waiver ${w.id} (${w.scope})${who}${vex}: ${w.justification}`.replace(/\s+/g, ' ').slice(0, 500)
}

/** Quote a scalar for YAML: JSON string syntax is valid YAML double-quoted style. */
const q = (s: string) => JSON.stringify(s)

/** Render a Trivy YAML ignore file. Deterministic (sorted) so re-renders are byte-identical. */
export function renderTrivyIgnore(waivers: WaiverRecord[]): string {
  const sections: Record<string, IgnoreEntry[]> = {}
  for (const w of [...waivers].sort(byStableKey)) (sections[SECTION[w.kind]] ??= []).push(ignoreEntry(w))
  const order = ['vulnerabilities', 'misconfigurations', 'secrets', 'licenses']
  const lines = ['# Managed by the Adhar console (Deliver → Scans → Waivers). Do not edit by hand —', '# changes are overwritten on the next review decision.']
  const present = order.filter((s) => sections[s]?.length)
  if (!present.length) return `${lines.join('\n')}\n{}\n`
  for (const s of present) {
    lines.push(`${s}:`)
    for (const e of sections[s]) {
      lines.push(`  - id: ${q(e.id)}`)
      if (e.paths) {
        lines.push('    paths:')
        for (const p of e.paths) lines.push(`      - ${q(p)}`)
      }
      if (e.purls) {
        lines.push('    purls:')
        for (const p of e.purls) lines.push(`      - ${q(p)}`)
      }
      // Unquoted so YAML resolves it as a timestamp (Trivy decodes a time.Time).
      if (e.expired_at) lines.push(`    expired_at: ${e.expired_at}`)
      lines.push(`    statement: ${q(e.statement)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function byStableKey(a: WaiverRecord, b: WaiverRecord): number {
  return a.kind.localeCompare(b.kind) || a.findingId.localeCompare(b.findingId) || a.id.localeCompare(b.id)
}

/** The `waivers.json` record shape of the contract. */
export function contractRecord(w: WaiverRecord) {
  return {
    id: w.id,
    kind: w.kind,
    scope: w.scope,
    target: w.target,
    findingId: w.findingId,
    severity: w.severity ?? 'unknown',
    justification: w.justification,
    vex: { status: w.vex.status, ...(w.vex.justification ? { justification: w.vex.justification } : {}), ...(w.vex.impact ? { impact: w.vex.impact } : {}) },
    requestedBy: w.requestedBy.label,
    approvedBy: w.approvedBy?.label ?? null,
    approvedAt: w.approvedAt ?? null,
    expiresAt: w.expiresAt,
    status: w.status,
  }
}

export interface RenderedConfigMap {
  namespace: string
  name: string
  data: Record<string, string>
  /** Number of active waivers rendered into it. */
  count: number
}

/**
 * Which ConfigMap(s) a set of records renders into, and their contents.
 * `project` → `scan-waivers` in `<project>`; `null` → the global one.
 * Only approved, unexpired waivers are included — in every key.
 */
export function renderWaiverConfigMap(all: WaiverRecord[], project: string | null, now: number): RenderedConfigMap {
  const active = all.filter((w) => isActive(w, now) && (project === null ? w.scope === 'platform' : w.scope !== 'platform' && w.target.project === project))
  const data: Record<string, string> = {}
  // Namespace-wide entries: project (or platform) scope.
  const wide = active.filter((w) => w.scope === 'project' || w.scope === 'platform')
  data[TRIVYIGNORE_KEY] = renderTrivyIgnore(wide)
  if (project !== null) {
    // Per-app files: the namespace-wide entries plus that app's own. Digest
    // scope is NOT rendered into an ignore file — Trivy cannot restrict an
    // entry to one image digest, and writing it app-wide would waive every
    // future build. It lives in waivers.json for the gate and the VEX.
    const apps = [...new Set(active.filter((w) => w.scope === 'app' && w.target.app).map((w) => w.target.app!))].sort()
    for (const app of apps) data[appIgnoreKey(app)] = renderTrivyIgnore([...wide, ...active.filter((w) => w.scope === 'app' && w.target.app === app)])
  }
  data[WAIVERS_JSON_KEY] = `${JSON.stringify({ version: 1, generatedBy: 'adhar-console', waivers: [...active].sort(byStableKey).map(contractRecord) }, null, 2)}\n`
  return project === null
    ? { namespace: PLATFORM_NAMESPACE, name: WAIVERS_GLOBAL_CM, data, count: active.length }
    : { namespace: project, name: WAIVERS_CM, data, count: active.length }
}

/**
 * Merge freshly-rendered keys into an existing ConfigMap's data: keys the
 * console owns are replaced (stale per-app files removed), anything else an
 * operator put there is kept. Returns whether anything changed — an unchanged
 * render is not written (idempotent).
 */
export function mergeConfigMapData(existing: Record<string, string> | undefined, rendered: Record<string, string>): { data: Record<string, string>; changed: boolean } {
  const data: Record<string, string> = {}
  for (const [k, v] of Object.entries(existing ?? {})) if (!OWNED_KEY.test(k)) data[k] = v
  for (const [k, v] of Object.entries(rendered)) data[k] = v
  const before = JSON.stringify(sortKeys(existing ?? {}))
  const after = JSON.stringify(sortKeys(data))
  return { data, changed: before !== after }
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

/** The project ConfigMaps (and/or the global one) a change to these waivers touches. */
export function affectedScopes(ws: Array<Pick<WaiverRecord, 'scope' | 'target'>>): { projects: string[]; global: boolean } {
  const projects = new Set<string>()
  let global = false
  for (const w of ws) {
    if (w.scope === 'platform') global = true
    else projects.add(w.target.project)
  }
  return { projects: [...projects].sort(), global }
}

/* ───────────────────────────── scan policy ───────────────────────────── */

export type PolicyMode = 'enforce' | 'warn'
export const SCANNERS = ['vuln', 'secret', 'misconfig', 'license'] as const

export interface ScanPolicy {
  /** Severities that fail the gate, upper-case as Trivy's `--severity` takes them. */
  failOnSeverity: string[]
  ignoreUnfixed: boolean
  licenseDeny: string[]
  licenseWarn: string[]
  scanners: string[]
  mode: PolicyMode
  manualApproval: boolean
  maxWaiverDays: number
}

export const DEFAULT_POLICY: ScanPolicy = {
  failOnSeverity: ['CRITICAL'],
  ignoreUnfixed: false,
  licenseDeny: [],
  licenseWarn: [],
  scanners: ['vuln', 'secret'],
  mode: 'warn',
  manualApproval: false,
  maxWaiverDays: DEFAULT_MAX_WAIVER_DAYS,
}

const SEV_UPPER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']
const list = (s: string | undefined) => (s ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
const bool = (s: string | undefined) => /^(true|yes|1|on)$/i.test((s ?? '').trim())

/** A `scan-policy` ConfigMap's data → a policy; absent keys fall back to `base`. */
export function parsePolicy(data: Record<string, string> | undefined, base: ScanPolicy = DEFAULT_POLICY): ScanPolicy {
  if (!data) return { ...base }
  const has = (k: string) => typeof data[k] === 'string'
  const sev = has('failOnSeverity') ? list(data.failOnSeverity).map((s) => s.toUpperCase()).filter((s) => SEV_UPPER.includes(s)) : base.failOnSeverity
  const mode = (data.mode ?? '').trim().toLowerCase()
  const days = Number.parseInt(data.maxWaiverDays ?? '', 10)
  return {
    failOnSeverity: sev,
    ignoreUnfixed: has('ignoreUnfixed') ? bool(data.ignoreUnfixed) : base.ignoreUnfixed,
    licenseDeny: has('licenseDeny') ? list(data.licenseDeny) : base.licenseDeny,
    licenseWarn: has('licenseWarn') ? list(data.licenseWarn) : base.licenseWarn,
    scanners: has('scanners') ? list(data.scanners).map((s) => s.toLowerCase()).filter((s) => (SCANNERS as readonly string[]).includes(s)) : base.scanners,
    mode: mode === 'enforce' || mode === 'warn' ? mode : base.mode,
    manualApproval: has('manualApproval') ? bool(data.manualApproval) : base.manualApproval,
    maxWaiverDays: Number.isFinite(days) && days > 0 ? Math.min(days, 365) : base.maxWaiverDays,
  }
}

/** Policy → ConfigMap string data. */
export function serializePolicy(p: ScanPolicy): Record<string, string> {
  return {
    failOnSeverity: p.failOnSeverity.join(','),
    ignoreUnfixed: String(p.ignoreUnfixed),
    licenseDeny: p.licenseDeny.join(','),
    licenseWarn: p.licenseWarn.join(','),
    scanners: p.scanners.join(','),
    mode: p.mode,
    manualApproval: String(p.manualApproval),
    maxWaiverDays: String(p.maxWaiverDays),
  }
}

/** Validate a policy body from the editor. */
export function validatePolicy(body: unknown): Result<ScanPolicy> {
  if (!body || typeof body !== 'object') return fail(400, 'invalid_policy', 'Expected a policy object.')
  const b = body as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : typeof v === 'string' ? list(v) : [])
  const sev = arr(b.failOnSeverity).map((s) => s.toUpperCase())
  if (sev.some((s) => !SEV_UPPER.includes(s))) return fail(400, 'invalid_policy', `failOnSeverity accepts ${SEV_UPPER.join(', ')}.`)
  const scanners = arr(b.scanners).map((s) => s.toLowerCase())
  if (scanners.some((s) => !(SCANNERS as readonly string[]).includes(s))) return fail(400, 'invalid_policy', `scanners accepts ${SCANNERS.join(', ')}.`)
  if (b.mode !== 'enforce' && b.mode !== 'warn') return fail(400, 'invalid_policy', 'mode must be enforce or warn.')
  const days = Number(b.maxWaiverDays ?? DEFAULT_MAX_WAIVER_DAYS)
  if (!Number.isInteger(days) || days < 1 || days > 365) return fail(400, 'invalid_policy', 'maxWaiverDays must be a whole number of days between 1 and 365.')
  const lic = (v: unknown) => arr(v).filter((x) => /^[A-Za-z0-9.+\-() ]{1,100}$/.test(x))
  return {
    ok: true,
    value: {
      failOnSeverity: [...new Set(sev)],
      ignoreUnfixed: b.ignoreUnfixed === true,
      licenseDeny: [...new Set(lic(b.licenseDeny))],
      licenseWarn: [...new Set(lic(b.licenseWarn))],
      scanners: [...new Set(scanners)],
      mode: b.mode,
      manualApproval: b.manualApproval === true,
      maxWaiverDays: days,
    },
  }
}

/* ───────────────────────────── the scan gate ───────────────────────────── */

export type GateState = 'awaiting' | 'approved' | 'rejected' | 'passed' | 'failed' | 'warned' | 'none'

export interface ScanSummary {
  critical?: number
  high?: number
  medium?: number
  low?: number
  unknown?: number
  fixable?: number
  licenses?: number
  secrets?: number
  misconfigs?: number
}

interface RunLike {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string>; labels?: Record<string, string>; creationTimestamp?: string }
  spec?: { params?: Array<{ name?: string; value?: unknown }>; pipelineRef?: { name?: string } }
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
    results?: Array<{ name?: string; value?: unknown }>
    pipelineResults?: Array<{ name?: string; value?: unknown }>
    childReferences?: Array<{ name?: string; pipelineTaskName?: string; kind?: string }>
    startTime?: string
    completionTime?: string
  }
}

export interface GateView {
  namespace: string
  name: string
  pipeline?: string
  app?: string
  image?: string
  digest?: string
  createdAt?: string
  done: boolean
  succeeded?: boolean
  state: GateState
  summary?: ScanSummary
  /** Finding ids the CI published (when it publishes them). */
  findings?: string[]
  decision?: { value: 'approved' | 'rejected'; by?: string; at?: string; comment?: string }
}

const GATE_TASK = /(^|[-_])scan[-_]?(approval|gate)($|[-_])/i
const SUMMARY_KEYS: Array<[keyof ScanSummary, RegExp]> = [
  ['critical', /^(vuln[-_])?critical([-_]count)?$/i],
  ['high', /^(vuln[-_])?high([-_]count)?$/i],
  ['medium', /^(vuln[-_])?medium([-_]count)?$/i],
  ['low', /^(vuln[-_])?low([-_]count)?$/i],
  ['unknown', /^(vuln[-_])?unknown([-_]count)?$/i],
  ['fixable', /^(vuln[-_])?fixable([-_]count)?$/i],
  ['licenses', /^licen[cs]e[-_]?(violations|count|denied)?$/i],
  ['secrets', /^secrets?([-_]count)?$/i],
  ['misconfigs', /^misconfig(uration)?s?([-_]count)?$/i],
]

const resultStr = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : v != null ? JSON.stringify(v) : '')

/** Read the CI's summary counts from a run's results (JSON `scan-summary`, or one result per count). */
export function readScanSummary(results: Array<{ name?: string; value?: unknown }>): { summary?: ScanSummary; gate?: string; findings?: string[]; image?: string; digest?: string } {
  const out: ScanSummary = {}
  let found = false
  let gate: string | undefined
  let findings: string[] | undefined
  let image: string | undefined
  let digest: string | undefined
  for (const r of results) {
    const name = (r.name ?? '').trim()
    const raw = resultStr(r.value).trim()
    if (!name) continue
    if (/^scan[-_]?summary$/i.test(name)) {
      try {
        const j = JSON.parse(raw) as Record<string, unknown>
        for (const [k] of SUMMARY_KEYS) {
          const n = Number(j[k] ?? j[k.toUpperCase()] ?? j[`vuln_${k}`])
          if (Number.isFinite(n)) {
            out[k] = n
            found = true
          }
        }
        if (typeof j.gate === 'string') gate = j.gate
      } catch { /* not JSON — ignore */ }
      continue
    }
    if (/^scan[-_]?gate$/i.test(name) || /^gate[-_]?result$/i.test(name)) {
      gate = raw.toLowerCase()
      continue
    }
    if (/^scan[-_]?findings$/i.test(name)) {
      try {
        const j = JSON.parse(raw)
        if (Array.isArray(j)) findings = j.filter((x): x is string => typeof x === 'string').slice(0, 500)
      } catch {
        findings = raw.split(/[,\s]+/).filter(Boolean).slice(0, 500)
      }
      continue
    }
    if (/^image[-_]?digest$/i.test(name) && /^sha256:[a-f0-9]{64}$/.test(raw)) digest = raw
    else if (/^(image[-_]?url|image)$/i.test(name) && raw) image = raw
    for (const [k, re] of SUMMARY_KEYS) {
      if (re.test(name)) {
        const n = Number(raw)
        if (Number.isFinite(n)) {
          out[k] = n
          found = true
        }
      }
    }
  }
  return { ...(found ? { summary: out } : {}), ...(gate ? { gate } : {}), ...(findings ? { findings } : {}), ...(image ? { image } : {}), ...(digest ? { digest } : {}) }
}

function appOf(run: RunLike): string | undefined {
  const l = run.metadata?.labels ?? {}
  const fromLabel = l['adhar.io/app'] ?? l['adhar.io/application'] ?? l['app.kubernetes.io/name'] ?? l['app.kubernetes.io/part-of']
  if (fromLabel) return fromLabel
  for (const p of run.spec?.params ?? []) {
    if (['app-name', 'app', 'application', 'appName'].includes(p.name ?? '') && typeof p.value === 'string' && p.value) return p.value
  }
  return undefined
}

/**
 * The scan-gate state of one PipelineRun, from whatever the platform published:
 * the decision annotation, the gate annotation, the run's results, and — for a
 * run that is still paused — a running pipeline task named like the gate.
 */
export function gateOf(run: RunLike): GateView {
  const ann = run.metadata?.annotations ?? {}
  const conds = run.status?.conditions ?? []
  const succ = conds.find((c) => c.type === 'Succeeded')
  const done = succ?.status === 'True' || succ?.status === 'False'
  const results = [...(run.status?.results ?? []), ...(run.status?.pipelineResults ?? [])]
  const { summary, gate, findings, image: resImage, digest } = readScanSummary(results)
  const decisionRaw = (ann[SCAN_APPROVAL_ANNOTATION] ?? '').toLowerCase()
  const decision = decisionRaw === 'approved' || decisionRaw === 'rejected'
    ? {
      value: decisionRaw as 'approved' | 'rejected',
      by: ann[SCAN_APPROVAL_BY_ANNOTATION],
      at: ann[SCAN_APPROVAL_AT_ANNOTATION],
      comment: ann[SCAN_APPROVAL_COMMENT_ANNOTATION],
    }
    : undefined
  const published = (ann[SCAN_GATE_ANNOTATION] ?? gate ?? '').toLowerCase()
  const gateTaskRunning = !done && (run.status?.childReferences ?? []).some((c) => GATE_TASK.test(c.pipelineTaskName ?? ''))

  let state: GateState = 'none'
  if (decision) state = decision.value
  else if (published === 'awaiting-approval' || published === 'awaiting' || published === 'pending-approval' || published === 'pending') state = done ? 'none' : 'awaiting'
  else if (gateTaskRunning) state = 'awaiting'
  else if (published === 'pass' || published === 'passed' || published === 'ok') state = 'passed'
  else if (published === 'fail' || published === 'failed' || published === 'blocked') state = 'failed'
  else if (published === 'warn' || published === 'warned' || published === 'warning') state = 'warned'
  else if (published === 'waived') state = 'passed'
  // A run that ended without the decision while awaiting was not decided here
  // (timed out or cancelled) — report the published state, never "awaiting".

  const imageParam = (run.spec?.params ?? []).find((p) => ['image', 'image-url', 'IMAGE'].includes(p.name ?? ''))
  const image = resImage ?? (typeof imageParam?.value === 'string' ? imageParam.value : undefined)
  return {
    namespace: run.metadata?.namespace ?? '',
    name: run.metadata?.name ?? '',
    pipeline: run.spec?.pipelineRef?.name ?? run.metadata?.labels?.['tekton.dev/pipeline'],
    app: appOf(run),
    ...(image ? { image } : {}),
    ...(digest ? { digest } : {}),
    createdAt: run.metadata?.creationTimestamp,
    done,
    ...(done ? { succeeded: succ?.status === 'True' } : {}),
    state,
    ...(summary ? { summary } : {}),
    ...(findings ? { findings } : {}),
    ...(decision ? { decision } : {}),
  }
}

/** True when a run carries any scan signal worth listing on the security pages. */
export const hasScanSignal = (g: GateView) => g.state !== 'none' || Boolean(g.summary) || Boolean(g.findings)

/** JSON merge patch that records a gate decision on the run. */
export function gateDecisionPatch(decision: 'approved' | 'rejected', by: string, at: string, comment?: string) {
  return {
    metadata: {
      annotations: {
        [SCAN_APPROVAL_ANNOTATION]: decision,
        [SCAN_APPROVAL_BY_ANNOTATION]: by.slice(0, 200),
        [SCAN_APPROVAL_AT_ANNOTATION]: at,
        ...(comment?.trim() ? { [SCAN_APPROVAL_COMMENT_ANNOTATION]: comment.trim().slice(0, 1000) } : {}),
      },
    },
  }
}
