/**
 * Module-scoped, real Kyverno + Policy-Reporter reads for the Deliver → Policy
 * view.
 *
 * The shared `@adhar-console/api-clients` Kyverno client models a flattened
 * `Policy` / `PolicyReport` shape, but its `build()` casts raw CRD items to
 * those shapes verbatim — which does not actually hold for `kyverno.io`
 * ClusterPolicies (spec is nested, result counts live in separate
 * PolicyReports). Rather than expand the shared client, we read the CRDs
 * directly through the console's authenticated k8s gateway (`/api/k8s`, the
 * transparent apiserver proxy that serves every built-in resource AND CRD with
 * per-user RBAC) and map them into the exact shapes `policy.tsx` already
 * consumes.
 *
 * "Not installed" (the CRD is absent → apiserver 404) is treated as an honest
 * empty result, not an error; any other failure propagates to react-query.
 */

import type { kyverno } from '@adhar-console/api-clients'
import type { k8s } from '@adhar-console/api-clients'
import { client } from './k8s.ts'

type Generic = k8s.Generic
type GVR = k8s.GVR

const CLUSTER_POLICIES: GVR = {
  group: 'kyverno.io',
  version: 'v1',
  resource: 'clusterpolicies',
  namespaced: false,
}
const POLICIES: GVR = {
  group: 'kyverno.io',
  version: 'v1',
  resource: 'policies',
  namespaced: true,
}
const CLUSTER_POLICY_REPORTS: GVR = {
  group: 'wgpolicyk8s.io',
  version: 'v1alpha2',
  resource: 'clusterpolicyreports',
  namespaced: false,
}
const POLICY_REPORTS: GVR = {
  group: 'wgpolicyk8s.io',
  version: 'v1alpha2',
  resource: 'policyreports',
  namespaced: true,
}
const POLICY_EXCEPTIONS: GVR = {
  group: 'kyverno.io',
  version: 'v2',
  resource: 'policyexceptions',
  namespaced: true,
}

/* ─────────── safe accessors ─────────── */

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** True when a failure means "the CRD isn't installed" (apiserver 404). */
function isNotInstalled(err: unknown): boolean {
  const status = (err as { status?: number; code?: number })?.status ??
    (err as { status?: number; code?: number })?.code
  return status === 404
}

/** List a GVR, mapping "CRD not installed" to an empty set so the view can
 * render an honest not-installed state instead of a hard error. */
async function listOrEmpty(gvr: GVR): Promise<Generic[]> {
  try {
    return await client.listGeneric(undefined, gvr)
  } catch (err) {
    if (isNotInstalled(err)) return []
    throw err
  }
}

/* ─────────── policy mapping ─────────── */

const ANN = 'policies.kyverno.io'

function ruleAction(rule: Record<string, unknown>): kyverno.PolicyAction {
  if ('mutate' in rule) return 'mutate'
  if ('generate' in rule) return 'generate'
  if ('verifyImages' in rule) return 'verifyImages'
  return 'validate'
}

/** Gather kinds/namespaces from a Kyverno match block (legacy + any/all). */
function matchScope(match: unknown): { kinds: string[]; namespaces: string[] } {
  const kinds = new Set<string>()
  const namespaces = new Set<string>()
  const collect = (block: unknown) => {
    const resources = rec(rec(block).resources)
    for (const k of arr(resources.kinds)) if (str(k)) kinds.add(str(k)!)
    for (const n of arr(resources.namespaces)) if (str(n)) namespaces.add(str(n)!)
  }
  const m = rec(match)
  collect(m)
  for (const b of arr(m.any)) collect(b)
  for (const b of arr(m.all)) collect(b)
  return { kinds: [...kinds], namespaces: [...namespaces] }
}

function normalizeSeverity(v: unknown): kyverno.PolicySeverity | undefined {
  const s = str(v)?.toLowerCase()
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low' ? s : undefined
}

function enforcementMode(spec: Record<string, unknown>): 'Audit' | 'Enforce' {
  // spec.validationFailureAction (v1) or, in newer policies, per-rule
  // validate.failureAction. Kyverno accepts both cased + lower-cased values.
  const top = str(spec.validationFailureAction)
  const perRule = arr(spec.rules)
    .map((r) => str(rec(rec(r).validate).failureAction))
    .find(Boolean)
  const raw = (top ?? perRule ?? 'Audit').toLowerCase()
  return raw === 'enforce' ? 'Enforce' : 'Audit'
}

function isReady(status: Record<string, unknown>): boolean | undefined {
  if (typeof status.ready === 'boolean') return status.ready
  const conds = arr(status.conditions)
  const ready = conds.map(rec).find((c) => str(c.type) === 'Ready')
  if (ready) return str(ready.status) === 'True'
  return undefined
}

function mapPolicy(
  obj: Generic,
  counts: Map<string, { pass: number; fail: number; warn: number }>,
): kyverno.Policy {
  const spec = rec(obj.spec)
  const status = rec(obj.status)
  const ann = rec(obj.metadata.annotations)
  const rules: kyverno.PolicyRule[] = arr(spec.rules).map((r) => {
    const rule = rec(r)
    const scope = matchScope(rule.match)
    return {
      name: str(rule.name) ?? 'rule',
      action: ruleAction(rule),
      severity: normalizeSeverity(ann[`${ANN}/severity`]),
      match: {
        kinds: scope.kinds.length ? scope.kinds : undefined,
        namespaces: scope.namespaces.length ? scope.namespaces : undefined,
      },
      description: str(rec(rule.validate).message),
    }
  })
  const agg = counts.get(obj.metadata.name)
  return {
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    kind: obj.kind === 'Policy' ? 'Policy' : 'ClusterPolicy',
    validationFailureAction: enforcementMode(spec),
    background: typeof spec.background === 'boolean' ? spec.background : undefined,
    category: str(ann[`${ANN}/category`]),
    severity: normalizeSeverity(ann[`${ANN}/severity`]),
    description: str(ann[`${ANN}/description`]),
    ready: isReady(status),
    pass: agg?.pass,
    fail: agg?.fail,
    warn: agg?.warn,
    rules,
    created_at: obj.metadata.creationTimestamp,
  }
}

/* ─────────── report mapping ─────────── */

const RESULT_VALUES: readonly kyverno.PolicyResult[] = ['pass', 'fail', 'warn', 'error', 'skip']

function normalizeResult(v: unknown): kyverno.PolicyResult {
  const s = str(v)?.toLowerCase()
  return (RESULT_VALUES as readonly string[]).includes(s ?? '')
    ? (s as kyverno.PolicyResult)
    : 'skip'
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function mapReport(obj: Generic): kyverno.PolicyReport {
  const summary = rec(obj.status?.summary ?? (obj as { summary?: unknown }).summary)
  // wgpolicyk8s stores summary + results at the top level of the report object
  // (not under status); fall back to the object root.
  const root = obj as unknown as Record<string, unknown>
  const sum = Object.keys(summary).length ? summary : rec(root.summary)
  const rawResults = arr(root.results)
  const results = rawResults.map((r) => {
    const res = rec(r)
    return {
      policy: str(res.policy) ?? '',
      rule: str(res.rule) ?? '',
      result: normalizeResult(res.result),
      severity: normalizeSeverity(res.severity),
      category: str(res.category),
      message: str(res.message),
      timestamp: str(res.timestamp),
      resources: arr(res.resources).map((rr) => {
        const ref = rec(rr)
        return {
          kind: str(ref.kind) ?? '',
          name: str(ref.name) ?? '',
          namespace: str(ref.namespace),
        }
      }),
    }
  })
  return {
    metadata: {
      name: obj.metadata.name,
      namespace: obj.metadata.namespace,
      creationTimestamp: obj.metadata.creationTimestamp,
    },
    summary: {
      pass: num(sum.pass),
      fail: num(sum.fail),
      warn: num(sum.warn),
      error: num(sum.error),
      skip: num(sum.skip),
    },
    results: results.length ? results : undefined,
  }
}

/** Aggregate per-policy pass/fail/warn from report results (for the library). */
function aggregateCounts(
  reports: kyverno.PolicyReport[],
): Map<string, { pass: number; fail: number; warn: number }> {
  const out = new Map<string, { pass: number; fail: number; warn: number }>()
  for (const r of reports) {
    for (const f of r.results ?? []) {
      const cur = out.get(f.policy) ?? { pass: 0, fail: 0, warn: 0 }
      if (f.result === 'pass') cur.pass++
      else if (f.result === 'fail') cur.fail++
      else if (f.result === 'warn') cur.warn++
      out.set(f.policy, cur)
    }
  }
  return out
}

/* ─────────── exception mapping ─────────── */

function mapException(obj: Generic): kyverno.PolicyException {
  const spec = rec(obj.spec)
  const ann = rec(obj.metadata.annotations)
  const exceptions = arr(spec.exceptions).map(rec)
  const policyRef = str(exceptions[0]?.policyName) ?? str(spec.policyRef) ?? '—'
  const rules = exceptions.flatMap((e) => arr(e.ruleNames).map((n) => str(n) ?? '').filter(Boolean))
  const scope = matchScope(spec.match)
  const names = new Set<string>()
  const m = rec(spec.match)
  const collectNames = (b: unknown) => {
    for (const n of arr(rec(rec(b).resources).names)) if (str(n)) names.add(str(n)!)
  }
  collectNames(m)
  for (const b of arr(m.any)) collectNames(b)
  for (const b of arr(m.all)) collectNames(b)
  return {
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    policyRef,
    rules,
    match: {
      kinds: scope.kinds.length ? scope.kinds : undefined,
      namespaces: scope.namespaces.length ? scope.namespaces : undefined,
      names: names.size ? [...names] : undefined,
    },
    reason: str(spec.reason) ?? str(ann[`${ANN}/description`]),
    expires_at: str(spec.expiresAt),
    created_at: obj.metadata.creationTimestamp,
  }
}

/* ─────────── public API (shape-compatible with kyverno.KyvernoClient) ─────────── */

export async function listPolicyReports(): Promise<kyverno.PolicyReport[]> {
  const [cluster, namespaced] = await Promise.all([
    listOrEmpty(CLUSTER_POLICY_REPORTS),
    listOrEmpty(POLICY_REPORTS),
  ])
  return [...cluster, ...namespaced].map(mapReport)
}

export async function listPolicies(): Promise<kyverno.Policy[]> {
  const [cluster, namespaced, reports] = await Promise.all([
    listOrEmpty(CLUSTER_POLICIES),
    listOrEmpty(POLICIES),
    listPolicyReports(),
  ])
  const counts = aggregateCounts(reports)
  return [...cluster, ...namespaced].map((o) => mapPolicy(o, counts))
}

export async function listExceptions(): Promise<kyverno.PolicyException[]> {
  const items = await listOrEmpty(POLICY_EXCEPTIONS)
  return items.map(mapException)
}

export async function setEnforcementMode(
  name: string,
  mode: 'Audit' | 'Enforce',
  namespace?: string,
): Promise<void> {
  const gvr = namespace ? POLICIES : CLUSTER_POLICIES
  const current = await client.getGeneric(undefined, gvr, namespace, name)
  const spec = rec(current.spec)
  const next: Generic = {
    ...current,
    spec: { ...spec, validationFailureAction: mode },
  }
  await client.replaceGeneric(undefined, gvr, namespace, name, next)
}

/**
 * Object mirroring the subset of `kyverno.KyvernoClient` that `policy.tsx`
 * consumes, so the view swaps `KyvernoClient.stub()` for real CRD-backed reads
 * with a one-line change.
 */
export const kyvernoClient = {
  listPolicies,
  listPolicyReports,
  listExceptions,
  setEnforcementMode,
}
