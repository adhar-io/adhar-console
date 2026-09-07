import { useMemo, useState, type ReactNode } from 'react'
import { EmptyState, StatusBadge, Tabs, useAppConfig, useToast, type StatusKind, type TabDef } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { k8s } from '@adhar-console/api-clients'
import { useGeneric } from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { ListShell, StatusFilterPills, matchesSearch } from './list-shell.tsx'
import { DrawerSection, ResourceDrawer, Row } from './resource-drawer.tsx'
import { ManifestEditor } from './manifest-editor.tsx'

/**
 * Policy — Kyverno policies, live violations and exceptions, straight from the
 * cluster (kyverno.io + wgpolicyk8s.io CRDs). Every name shown is the real
 * ClusterPolicy / Policy / rule / resource; nothing is synthesised.
 *
 *   Policies    — every ClusterPolicy + namespaced Policy with mode (Enforce /
 *                 Audit), category, severity, rules, background scanning and
 *                 the pass / fail / warn counts aggregated from the reports.
 *                 Click → drawer with description, rules (what they match and
 *                 the validation message), status conditions, and actions:
 *                 Edit YAML (Monaco), Policy Reporter, Explore, Kyverno docs.
 *   Violations  — one row per failing / warning result: policy › rule, the
 *                 violating resource, the exact message, severity, namespace.
 *                 Filter by outcome, severity, policy; search; click → drawer
 *                 with the full result and links to the policy + resource.
 *   Exceptions  — PolicyExceptions (kyverno.io/v2): which policies/rules they
 *                 exempt, for which resources, and why.
 */

const GVR = {
  clusterPolicies: { group: 'kyverno.io', version: 'v1', resource: 'clusterpolicies', namespaced: false },
  policies: { group: 'kyverno.io', version: 'v1', resource: 'policies', namespaced: true },
  clusterReports: { group: 'wgpolicyk8s.io', version: 'v1alpha2', resource: 'clusterpolicyreports', namespaced: false },
  reports: { group: 'wgpolicyk8s.io', version: 'v1alpha2', resource: 'policyreports', namespaced: true },
  exceptions: { group: 'kyverno.io', version: 'v2', resource: 'policyexceptions', namespaced: true },
} as const satisfies Record<string, k8s.GVR>

type Sub = 'policies' | 'violations' | 'exceptions'
const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'policies', label: 'Policies' },
  { id: 'violations', label: 'Violations' },
  { id: 'exceptions', label: 'Exceptions' },
]

/* ─────────── raw shapes (Kyverno CRDs) ─────────── */

interface KyvernoRule {
  name: string
  match?: MatchBlock
  exclude?: MatchBlock
  validate?: { message?: string; pattern?: unknown; anyPattern?: unknown; deny?: unknown; cel?: unknown; podSecurity?: { level?: string; version?: string } }
  mutate?: unknown
  generate?: { kind?: string; name?: string; namespace?: string }
  verifyImages?: Array<{ imageReferences?: string[] }>
  skipBackgroundRequests?: boolean
}
interface MatchBlock {
  any?: Array<{ resources?: ResourceFilter }>
  all?: Array<{ resources?: ResourceFilter }>
  resources?: ResourceFilter
}
interface ResourceFilter {
  kinds?: string[]
  names?: string[]
  namespaces?: string[]
  selector?: { matchLabels?: Record<string, string> }
}
interface KyvernoPolicy extends k8s.Generic {
  spec?: {
    validationFailureAction?: 'Audit' | 'Enforce' | 'audit' | 'enforce'
    background?: boolean
    failurePolicy?: string
    admission?: boolean
    rules?: KyvernoRule[]
  }
  status?: { ready?: boolean; conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>; rulecount?: Record<string, number> }
}
interface ReportResult {
  policy: string
  rule?: string
  result: 'pass' | 'fail' | 'warn' | 'error' | 'skip'
  severity?: 'low' | 'medium' | 'high' | 'critical' | 'info'
  category?: string
  message?: string
  source?: string
  timestamp?: { seconds?: number; nanos?: number } | string
  resources?: Array<{ kind?: string; name?: string; namespace?: string; apiVersion?: string; uid?: string }>
  properties?: Record<string, string>
}
interface PolicyReport extends k8s.Generic {
  summary?: { pass?: number; fail?: number; warn?: number; error?: number; skip?: number }
  results?: ReportResult[]
  scope?: { kind?: string; name?: string; namespace?: string }
}
interface PolicyException extends k8s.Generic {
  spec?: {
    exceptions?: Array<{ policyName: string; ruleNames?: string[] }>
    match?: MatchBlock
    conditions?: unknown
  }
}

/** A flattened violation row: one per (result × resource). */
interface Violation {
  key: string
  policy: string
  rule: string
  result: ReportResult['result']
  severity: string
  category: string
  message: string
  kind: string
  name: string
  namespace: string
  apiVersion?: string
  at?: string
  reportName: string
  properties?: Record<string, string>
}

/* ─────────── helpers ─────────── */

const ANN = 'policies.kyverno.io/'
const ann = (p: k8s.Generic, key: string) => p.metadata.annotations?.[`${ANN}${key}`]

function policyMode(p: KyvernoPolicy): 'Enforce' | 'Audit' {
  return (p.spec?.validationFailureAction ?? 'Audit').toLowerCase() === 'enforce' ? 'Enforce' : 'Audit'
}
function policySeverity(p: KyvernoPolicy): string {
  return (ann(p, 'severity') ?? 'medium').toLowerCase()
}
function policyCategory(p: KyvernoPolicy): string {
  return ann(p, 'category') ?? 'Uncategorised'
}
function policyTitle(p: KyvernoPolicy): string {
  return ann(p, 'title') ?? p.metadata.name
}
function ruleAction(r: KyvernoRule): string {
  if (r.validate) return r.validate.podSecurity ? 'pod security' : r.validate.cel ? 'validate (CEL)' : 'validate'
  if (r.mutate) return 'mutate'
  if (r.generate) return 'generate'
  if (r.verifyImages) return 'verify images'
  return 'rule'
}
function matchKinds(m?: MatchBlock): string[] {
  const out = new Set<string>()
  const add = (f?: ResourceFilter) => f?.kinds?.forEach((k) => out.add(k))
  add(m?.resources)
  m?.any?.forEach((x) => add(x.resources))
  m?.all?.forEach((x) => add(x.resources))
  return [...out]
}
function matchNamespaces(m?: MatchBlock): string[] {
  const out = new Set<string>()
  const add = (f?: ResourceFilter) => f?.namespaces?.forEach((k) => out.add(k))
  add(m?.resources)
  m?.any?.forEach((x) => add(x.resources))
  m?.all?.forEach((x) => add(x.resources))
  return [...out]
}
function tsOf(t: ReportResult['timestamp']): string | undefined {
  if (!t) return undefined
  if (typeof t === 'string') return t
  return t.seconds ? new Date(t.seconds * 1000).toISOString() : undefined
}
function is404(q: { isError: boolean; error: unknown }): boolean {
  return q.isError && (q.error as { status?: number })?.status === 404
}

const SEV_TONE: Record<string, StatusKind> = { critical: 'failed', high: 'failed', medium: 'progressing', low: 'info', info: 'unknown' }
const RESULT_TONE: Record<string, StatusKind> = { fail: 'failed', warn: 'progressing', error: 'degraded', pass: 'healthy', skip: 'unknown' }
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

function flattenViolations(reports: PolicyReport[]): Violation[] {
  const out: Violation[] = []
  for (const r of reports) {
    for (const res of r.results ?? []) {
      if (res.result === 'pass' || res.result === 'skip') continue
      const targets = res.resources?.length ? res.resources : [{ kind: r.scope?.kind, name: r.scope?.name, namespace: r.scope?.namespace }]
      for (const t of targets) {
        out.push({
          key: `${r.metadata.namespace ?? ''}/${r.metadata.name}/${res.policy}/${res.rule ?? ''}/${t.kind ?? ''}/${t.namespace ?? ''}/${t.name ?? ''}`,
          policy: res.policy,
          rule: res.rule ?? '',
          result: res.result,
          severity: (res.severity ?? 'medium').toLowerCase(),
          category: res.category ?? '',
          message: res.message ?? '',
          kind: t.kind ?? r.scope?.kind ?? '',
          name: t.name ?? r.scope?.name ?? '',
          namespace: t.namespace ?? r.metadata.namespace ?? '',
          apiVersion: t.apiVersion,
          at: tsOf(res.timestamp),
          reportName: r.metadata.name,
          properties: res.properties,
        })
      }
    }
  }
  return out.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || a.policy.localeCompare(b.policy))
}

/* ─────────── page ─────────── */

export function PolicyView() {
  const cps = useGeneric(GVR.clusterPolicies)
  const nps = useGeneric(GVR.policies)
  const crs = useGeneric(GVR.clusterReports)
  const nrs = useGeneric(GVR.reports)
  const exs = useGeneric(GVR.exceptions)
  const config = useAppConfig()
  const reporterUrl = config.data?.tools?.['policy-reporter']?.url || ''

  const notInstalled = is404(cps) && is404(crs)
  if (notInstalled) {
    return (
      <EmptyState
        title="Policy engine not installed"
        description={
          <>
            No <code className="font-mono">kyverno.io</code> / <code className="font-mono">wgpolicyk8s.io</code> CRDs found. Enable{' '}
            <strong>Kyverno</strong> from the Marketplace (or follow the{' '}
            <a className="text-brand-700 underline dark:text-brand-300" href="https://kyverno.io/docs/installation/" target="_blank" rel="noreferrer">install guide</a>) to manage policies here.
          </>
        }
      />
    )
  }

  const policies = useMemo<KyvernoPolicy[]>(
    () => [...((cps.data ?? []) as KyvernoPolicy[]), ...((is404(nps) ? [] : nps.data ?? []) as KyvernoPolicy[])],
    [cps.data, nps.data, nps.isError, nps.error],
  )
  const reports = useMemo<PolicyReport[]>(
    () => [...((is404(crs) ? [] : crs.data ?? []) as PolicyReport[]), ...((is404(nrs) ? [] : nrs.data ?? []) as PolicyReport[])],
    [crs.data, nrs.data, crs.isError, nrs.isError, crs.error, nrs.error],
  )
  const exceptions = useMemo<PolicyException[]>(() => (is404(exs) ? [] : (exs.data ?? [])) as PolicyException[], [exs.data, exs.isError, exs.error])
  const violations = useMemo(() => flattenViolations(reports), [reports])

  // Per-policy tallies from the real report results.
  const tallies = useMemo(() => {
    const m = new Map<string, { pass: number; fail: number; warn: number; error: number }>()
    for (const r of reports) {
      for (const res of r.results ?? []) {
        const t = m.get(res.policy) ?? { pass: 0, fail: 0, warn: 0, error: 0 }
        if (res.result === 'pass') t.pass++
        else if (res.result === 'fail') t.fail++
        else if (res.result === 'warn') t.warn++
        else if (res.result === 'error') t.error++
        m.set(res.policy, t)
      }
    }
    return m
  }, [reports])

  const summary = useMemo(() => {
    const s = { pass: 0, fail: 0, warn: 0, error: 0 }
    for (const r of reports) {
      s.pass += r.summary?.pass ?? 0
      s.fail += r.summary?.fail ?? 0
      s.warn += r.summary?.warn ?? 0
      s.error += r.summary?.error ?? 0
    }
    return s
  }, [reports])
  const enforce = policies.filter((p) => policyMode(p) === 'Enforce').length

  const loading = cps.isLoading || crs.isLoading

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile tone="brand" label="Policies" value={loading ? '…' : policies.length} hint={`${enforce} enforce · ${policies.length - enforce} audit`} />
        <SummaryTile tone="emerald" label="Pass" value={summary.pass} />
        <SummaryTile tone="rose" label="Fail" value={summary.fail} hint={`${violations.filter((v) => v.result === 'fail').length} resources`} />
        <SummaryTile tone="amber" label="Warn" value={summary.warn} />
        <SummaryTile tone="slate" label="Error" value={summary.error} />
        <SummaryTile tone="violet" label="Exceptions" value={exceptions.length} />
      </div>

      <Tabs<Sub> tabs={SUB_TABS} defaultValue={violations.length ? 'violations' : 'policies'} ariaLabel="Policy view">
        {(active) => (
          <>
            {active === 'policies' && <PoliciesTable policies={policies} tallies={tallies} loading={loading} reporterUrl={reporterUrl} onRefresh={() => { cps.refetch(); nps.refetch(); crs.refetch(); nrs.refetch() }} fetching={cps.isFetching} />}
            {active === 'violations' && <ViolationsTable violations={violations} policies={policies} loading={crs.isLoading} reporterUrl={reporterUrl} onRefresh={() => { crs.refetch(); nrs.refetch() }} fetching={crs.isFetching || nrs.isFetching} />}
            {active === 'exceptions' && <ExceptionsTable exceptions={exceptions} loading={exs.isLoading} notInstalled={is404(exs)} />}
          </>
        )}
      </Tabs>
    </div>
  )
}

/* ─────────── policies ─────────── */

function PoliciesTable({
  policies,
  tallies,
  loading,
  fetching,
  reporterUrl,
  onRefresh,
}: {
  policies: KyvernoPolicy[]
  tallies: Map<string, { pass: number; fail: number; warn: number; error: number }>
  loading: boolean
  fetching: boolean
  reporterUrl: string
  onRefresh(): void
}) {
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'Enforce' | 'Audit' | 'all'>('all')
  const [selected, setSelected] = useState<KyvernoPolicy | null>(null)
  const [editing, setEditing] = useState<KyvernoPolicy | null>(null)

  const rows = useMemo(
    () =>
      policies
        .filter((p) => mode === 'all' || policyMode(p) === mode)
        .filter((p) => matchesSearch(p.metadata.name, search) || matchesSearch(policyTitle(p), search) || matchesSearch(policyCategory(p), search) || matchesSearch(ann(p, 'description'), search))
        .sort((a, b) => (tallies.get(b.metadata.name)?.fail ?? 0) - (tallies.get(a.metadata.name)?.fail ?? 0) || a.metadata.name.localeCompare(b.metadata.name)),
    [policies, mode, search, tallies],
  )

  return (
    <>
      <ListShell
        title="Policies"
        total={policies.length}
        visible={rows.length}
        loading={loading}
        isFetching={fetching}
        onRefresh={onRefresh}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search policies, categories…"
        caption="ClusterPolicies + namespaced Policies"
        filters={
          <StatusFilterPills<'Enforce' | 'Audit'>
            value={mode}
            onChange={setMode}
            pills={[
              { value: 'Enforce', label: 'Enforce', count: policies.filter((p) => policyMode(p) === 'Enforce').length, tone: 'rose' },
              { value: 'Audit', label: 'Audit', count: policies.filter((p) => policyMode(p) === 'Audit').length, tone: 'sky' },
            ]}
          />
        }
        actions={reporterUrl ? <ExtLink href={reporterUrl}>Policy Reporter</ExtLink> : null}
      >
        {!loading && rows.length === 0 ? (
          <EmptyState title={policies.length ? 'No policies match' : 'No policies yet'} description={policies.length ? 'Adjust the search or mode filter.' : 'Apply a Kyverno ClusterPolicy to start enforcing standards.'} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {rows.map((p) => {
              const t = tallies.get(p.metadata.name) ?? { pass: 0, fail: 0, warn: 0, error: 0 }
              const total = t.pass + t.fail + t.warn + t.error
              const sev = policySeverity(p)
              const md = policyMode(p)
              const ready = p.status?.ready ?? p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
              return (
                <button
                  key={`${p.metadata.namespace ?? ''}/${p.metadata.name}`}
                  type="button"
                  onClick={() => setSelected(p)}
                  className={cn(
                    'group flex flex-col gap-2.5 rounded-2xl border bg-surface-raised p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
                    t.fail ? 'border-rose-200 dark:border-rose-500/30' : 'border-edge-default hover:border-brand-200 dark:hover:border-brand-500/30',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold text-content">{policyTitle(p)}</div>
                      <code className="block truncate font-mono text-[11px] text-content-subtle">{p.metadata.namespace ? `${p.metadata.namespace}/` : ''}{p.metadata.name}</code>
                    </div>
                    <StatusBadge kind={md === 'Enforce' ? 'failed' : 'info'} dot={false}>{md}</StatusBadge>
                  </div>
                  <p className="line-clamp-2 min-h-[2.4rem] text-[12px] leading-relaxed text-content-muted">{ann(p, 'description') ?? 'No description annotation.'}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                    <Chip>{policyCategory(p)}</Chip>
                    <StatusBadge kind={SEV_TONE[sev] ?? 'unknown'} dot={false}>{sev}</StatusBadge>
                    <Chip>{(p.spec?.rules ?? []).length} rule{(p.spec?.rules ?? []).length === 1 ? '' : 's'}</Chip>
                    {p.spec?.background === false ? <Chip>admission only</Chip> : <Chip>background</Chip>}
                    {ready === false ? <StatusBadge kind="degraded" dot={false}>not ready</StatusBadge> : null}
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between font-mono text-[10.5px] tabular-nums text-content-subtle">
                      <span><span className="text-emerald-600 dark:text-emerald-300">{t.pass} pass</span> · <span className={t.fail ? 'text-rose-600 dark:text-rose-300' : ''}>{t.fail} fail</span> · <span className={t.warn ? 'text-amber-600 dark:text-amber-300' : ''}>{t.warn} warn</span></span>
                      <span>{total ? `${Math.round((t.pass / total) * 100)}%` : 'no results'}</span>
                    </div>
                    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                      {total ? (
                        <>
                          <span className="h-full bg-emerald-500" style={{ width: `${(t.pass / total) * 100}%` }} />
                          <span className="h-full bg-amber-400" style={{ width: `${(t.warn / total) * 100}%` }} />
                          <span className="h-full bg-rose-500" style={{ width: `${((t.fail + t.error) / total) * 100}%` }} />
                        </>
                      ) : null}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </ListShell>
      {selected ? (
        <PolicyDrawer
          policy={selected}
          tally={tallies.get(selected.metadata.name)}
          reporterUrl={reporterUrl}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditing(selected)
            setSelected(null)
          }}
        />
      ) : null}
      {editing ? (
        <ManifestEditor
          gvr={editing.metadata.namespace ? GVR.policies : GVR.clusterPolicies}
          namespace={editing.metadata.namespace}
          name={editing.metadata.name}
          onClose={() => {
            setEditing(null)
            onRefresh()
          }}
        />
      ) : null}
    </>
  )
}

function PolicyDrawer({
  policy,
  tally,
  reporterUrl,
  onClose,
  onEdit,
}: {
  policy: KyvernoPolicy
  tally?: { pass: number; fail: number; warn: number; error: number }
  reporterUrl: string
  onClose(): void
  onEdit(): void
}) {
  const toast = useToast()
  const rules = policy.spec?.rules ?? []
  const mode = policyMode(policy)
  const conditions = policy.status?.conditions ?? []
  return (
    <ResourceDrawer
      resource={{ ...policy, apiVersion: 'kyverno.io/v1', kind: policy.metadata.namespace ? 'Policy' : 'ClusterPolicy' }}
      kindLabel={policy.metadata.namespace ? 'Policy' : 'ClusterPolicy'}
      statusBadge={<StatusBadge kind={mode === 'Enforce' ? 'failed' : 'info'}>{mode}</StatusBadge>}
      onClose={onClose}
    >
      <DrawerSection
        title="Manage"
        actions={<span className="text-xs text-content-subtle">edit · report · explore</span>}
      >
        <div className="flex flex-wrap gap-2">
          <ActionBtn primary onClick={onEdit}>Edit YAML</ActionBtn>
          {reporterUrl ? <ActionBtn href={`${reporterUrl.replace(/\/$/, '')}/#/policies/${encodeURIComponent(policy.metadata.name)}`}>Open in Policy Reporter</ActionBtn> : null}
          <ActionBtn href={`/platform?section=explore`}>Browse in Explore</ActionBtn>
          <ActionBtn href={`https://kyverno.io/policies/?policytypes=${encodeURIComponent(policyCategory(policy))}`}>Kyverno policy library</ActionBtn>
          <ActionBtn onClick={() => { void navigator.clipboard?.writeText(`kubectl get ${policy.metadata.namespace ? `policy -n ${policy.metadata.namespace}` : 'clusterpolicy'} ${policy.metadata.name} -o yaml`); toast.success('kubectl command copied') }}>Copy kubectl</ActionBtn>
        </div>
        <p className="mt-2 text-[11px] text-content-subtle">
          Switching Audit ↔ Enforce is a one-line change to <code className="font-mono">spec.validationFailureAction</code> in the YAML editor — dry-run first; if the policy is GitOps-managed, land the change in its repo.
        </p>
      </DrawerSection>

      <DrawerSection title="About">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Title" value={policyTitle(policy)} />
          <Row label="Category" value={policyCategory(policy)} />
          <Row label="Severity" value={<StatusBadge kind={SEV_TONE[policySeverity(policy)] ?? 'unknown'}>{policySeverity(policy)}</StatusBadge>} />
          <Row label="Subject" value={ann(policy, 'subject') ?? '—'} />
          <Row label="Background scan" value={policy.spec?.background === false ? 'off (admission only)' : 'on'} />
          <Row label="Failure policy" value={policy.spec?.failurePolicy ?? 'Fail'} />
          <Row label="Age" value={age(policy.metadata.creationTimestamp)} />
        </div>
        {ann(policy, 'description') ? <p className="mt-3 text-[13px] leading-relaxed text-content-muted">{ann(policy, 'description')}</p> : null}
      </DrawerSection>

      <DrawerSection title="Results" actions={<span className="text-xs text-content-subtle">from PolicyReports</span>}>
        <div className="grid grid-cols-4 gap-2">
          {(['pass', 'fail', 'warn', 'error'] as const).map((k) => (
            <div key={k} className="rounded-lg border border-edge-subtle bg-surface-sunken/50 p-2 text-center">
              <div className={cn('text-lg font-semibold tabular-nums', k === 'pass' ? 'text-emerald-600 dark:text-emerald-300' : k === 'fail' ? 'text-rose-600 dark:text-rose-300' : k === 'warn' ? 'text-amber-600 dark:text-amber-300' : 'text-content')}>{tally?.[k] ?? 0}</div>
              <div className="text-[10px] uppercase tracking-wider text-content-subtle">{k}</div>
            </div>
          ))}
        </div>
      </DrawerSection>

      <DrawerSection title={`Rules · ${rules.length}`}>
        <div className="space-y-2">
          {rules.map((r) => {
            const kinds = matchKinds(r.match)
            const nss = matchNamespaces(r.match)
            return (
              <div key={r.name} className="rounded-xl border border-edge-default bg-surface-raised p-3">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[12px] font-semibold text-content">{r.name}</code>
                  <Chip>{ruleAction(r)}</Chip>
                  {r.validate?.podSecurity ? <Chip>PSS {r.validate.podSecurity.level}</Chip> : null}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1 text-[11px]">
                  <span className="text-content-subtle">matches</span>
                  {kinds.length ? kinds.map((k) => <Chip key={k}>{k}</Chip>) : <Chip>any</Chip>}
                  {nss.length ? <span className="text-content-subtle">in {nss.join(', ')}</span> : null}
                </div>
                {r.validate?.message ? <p className="mt-2 rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-[11px] text-content-muted">{r.validate.message}</p> : null}
                {r.generate ? <p className="mt-2 text-[11px] text-content-muted">generates {r.generate.kind} {r.generate.name ?? ''}</p> : null}
                {r.verifyImages ? <p className="mt-2 font-mono text-[11px] text-content-muted">images: {r.verifyImages.flatMap((v) => v.imageReferences ?? []).join(', ') || '*'}</p> : null}
              </div>
            )
          })}
          {rules.length === 0 ? <p className="text-[12px] text-content-subtle">No rules in spec.</p> : null}
        </div>
      </DrawerSection>

      {conditions.length ? (
        <DrawerSection title="Status">
          <div className="divide-y divide-edge-subtle text-sm">
            {conditions.map((c) => (
              <Row key={c.type} label={c.type} value={<span className={c.status === 'True' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>{c.status}{c.reason ? ` · ${c.reason}` : ''}{c.message ? ` — ${c.message}` : ''}</span>} />
            ))}
          </div>
        </DrawerSection>
      ) : null}
    </ResourceDrawer>
  )
}

/* ─────────── violations ─────────── */

function ViolationsTable({
  violations,
  policies,
  loading,
  fetching,
  reporterUrl,
  onRefresh,
}: {
  violations: Violation[]
  policies: KyvernoPolicy[]
  loading: boolean
  fetching: boolean
  reporterUrl: string
  onRefresh(): void
}) {
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<'fail' | 'warn' | 'error' | 'all'>('all')
  const [severity, setSeverity] = useState('all')
  const [policy, setPolicy] = useState('all')
  const [selected, setSelected] = useState<Violation | null>(null)

  const policyNames = useMemo(() => [...new Set(violations.map((v) => v.policy))].sort(), [violations])
  const rows = useMemo(
    () =>
      violations
        .filter((v) => result === 'all' || v.result === result)
        .filter((v) => severity === 'all' || v.severity === severity)
        .filter((v) => policy === 'all' || v.policy === policy)
        .filter((v) => matchesSearch(v.policy, search) || matchesSearch(v.rule, search) || matchesSearch(v.name, search) || matchesSearch(v.namespace, search) || matchesSearch(v.kind, search) || matchesSearch(v.message, search)),
    [violations, result, severity, policy, search],
  )
  const byPolicy = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of violations) m.set(v.policy, (m.get(v.policy) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [violations])

  return (
    <>
      {byPolicy.length ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">Top violating policies</span>
          {byPolicy.map(([name, n]) => (
            <button key={name} type="button" onClick={() => setPolicy(policy === name ? 'all' : name)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono transition-colors', policy === name ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content')}>
              {name}<span className="rounded-full bg-rose-500/10 px-1.5 text-[10px] font-semibold text-rose-600 dark:text-rose-300">{n}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ListShell
        title="Violations"
        total={violations.length}
        visible={rows.length}
        loading={loading}
        isFetching={fetching}
        onRefresh={onRefresh}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search policy, rule, resource, message…"
        caption="fail + warn + error results, one row per resource"
        filters={
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusFilterPills<'fail' | 'warn' | 'error'>
              value={result}
              onChange={setResult}
              pills={[
                { value: 'fail', label: 'Fail', count: violations.filter((v) => v.result === 'fail').length, tone: 'rose' },
                { value: 'warn', label: 'Warn', count: violations.filter((v) => v.result === 'warn').length, tone: 'amber' },
                { value: 'error', label: 'Error', count: violations.filter((v) => v.result === 'error').length, tone: 'slate' },
              ]}
            />
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted" aria-label="Severity">
              <option value="all">Any severity</option>
              {['critical', 'high', 'medium', 'low', 'info'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={policy} onChange={(e) => setPolicy(e.target.value)} className="h-8 max-w-56 rounded-lg border border-edge-default bg-surface-raised px-2 font-mono text-[11px] text-content-muted" aria-label="Policy">
              <option value="all">Any policy</option>
              {policyNames.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        }
        actions={reporterUrl ? <ExtLink href={reporterUrl}>Policy Reporter</ExtLink> : null}
      >
        {!loading && rows.length === 0 ? (
          <EmptyState title={violations.length ? 'No violations match' : 'No violations 🎉'} description={violations.length ? 'Adjust the filters.' : 'Every PolicyReport result is passing.'} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-edge-default">
            <table className="w-full text-[12.5px]">
              <thead className="bg-surface-sunken/70 text-[11px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Severity</th>
                  <th className="px-3 py-2 text-left font-semibold">Policy › rule</th>
                  <th className="px-3 py-2 text-left font-semibold">Resource</th>
                  <th className="px-3 py-2 text-left font-semibold">Message</th>
                  <th className="px-3 py-2 text-left font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {rows.map((v) => (
                  <tr key={v.key} onClick={() => setSelected(v)} className="cursor-pointer bg-surface-raised transition-colors hover:bg-brand-50/40 dark:hover:bg-brand-500/5">
                    <td className="px-3 py-2 align-top"><StatusBadge kind={SEV_TONE[v.severity] ?? 'unknown'} dot={false}>{v.severity}</StatusBadge></td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-mono text-[12px] font-semibold text-content">{v.policy}</div>
                      <div className="font-mono text-[11px] text-content-subtle">{v.rule}{v.category ? ` · ${v.category}` : ''}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="text-content">{v.kind} <span className="font-mono">{v.name}</span></div>
                      <div className="text-[11px] text-content-muted">{v.namespace || 'cluster-scoped'}</div>
                    </td>
                    <td className="max-w-md px-3 py-2 align-top text-[12px] leading-relaxed text-content-muted"><span className="line-clamp-2">{v.message || '—'}</span></td>
                    <td className="px-3 py-2 align-top"><StatusBadge kind={RESULT_TONE[v.result]}>{v.result}</StatusBadge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ListShell>
      {selected ? <ViolationDrawer v={selected} policy={policies.find((p) => p.metadata.name === selected.policy)} reporterUrl={reporterUrl} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function ViolationDrawer({ v, policy, reporterUrl, onClose }: { v: Violation; policy?: KyvernoPolicy; reporterUrl: string; onClose(): void }) {
  const toast = useToast()
  const rule = policy?.spec?.rules?.find((r) => r.name === v.rule)
  const kindPlural = v.kind ? `${v.kind.toLowerCase()}s` : ''
  const kubectl = `kubectl get ${kindPlural || 'resource'} ${v.name}${v.namespace ? ` -n ${v.namespace}` : ''} -o yaml`
  return (
    <ResourceDrawer
      resource={{ apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport result', metadata: { name: `${v.policy} › ${v.rule || 'rule'}`, namespace: v.namespace || undefined } }}
      kindLabel="Violation"
      statusBadge={<StatusBadge kind={RESULT_TONE[v.result]}>{v.result}</StatusBadge>}
      onClose={onClose}
    >
      <DrawerSection title="What failed">
        <p className="rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2.5 text-[13px] leading-relaxed text-rose-900 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-100">{v.message || 'No message recorded on the result.'}</p>
        <div className="mt-3 divide-y divide-edge-subtle text-sm">
          <Row label="Policy" value={<span className="font-mono">{v.policy}</span>} />
          <Row label="Rule" value={<span className="font-mono">{v.rule || '—'}</span>} />
          <Row label="Severity" value={<StatusBadge kind={SEV_TONE[v.severity] ?? 'unknown'}>{v.severity}</StatusBadge>} />
          <Row label="Category" value={v.category || '—'} />
          <Row label="Resource" value={<span>{v.kind} <span className="font-mono">{v.name}</span></span>} />
          <Row label="Namespace" value={v.namespace || 'cluster-scoped'} />
          <Row label="Reported" value={v.at ? `${age(v.at)} ago` : '—'} />
          <Row label="Report" value={<span className="font-mono">{v.reportName}</span>} />
        </div>
        {v.properties && Object.keys(v.properties).length ? (
          <div className="mt-3 rounded-lg bg-surface-sunken p-2 font-mono text-[11px] text-content-muted">
            {Object.entries(v.properties).map(([k, val]) => <div key={k}><span className="opacity-60">{k}=</span>{val}</div>)}
          </div>
        ) : null}
      </DrawerSection>

      {rule ? (
        <DrawerSection title="Rule definition">
          <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
            <div className="flex items-center gap-2"><code className="font-mono text-[12px] font-semibold text-content">{rule.name}</code><Chip>{ruleAction(rule)}</Chip></div>
            <div className="mt-1.5 flex flex-wrap gap-1 text-[11px]"><span className="text-content-subtle">matches</span>{matchKinds(rule.match).map((k) => <Chip key={k}>{k}</Chip>)}</div>
            {rule.validate?.message ? <p className="mt-2 rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-[11px] text-content-muted">{rule.validate.message}</p> : null}
            {rule.validate?.pattern ? <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] text-slate-100">{JSON.stringify(rule.validate.pattern, null, 2)}</pre> : null}
          </div>
        </DrawerSection>
      ) : null}

      <DrawerSection title="Fix it">
        <div className="flex flex-wrap gap-2">
          <ActionBtn primary href={`/platform?section=explore`}>Open resource in Explore</ActionBtn>
          {reporterUrl ? <ActionBtn href={`${reporterUrl.replace(/\/$/, '')}/#/policies/${encodeURIComponent(v.policy)}`}>Policy in Reporter</ActionBtn> : null}
          <ActionBtn onClick={() => { void navigator.clipboard?.writeText(kubectl); toast.success('kubectl command copied') }}>Copy kubectl get</ActionBtn>
          {policy ? <ActionBtn href={`https://kyverno.io/policies/?search=${encodeURIComponent(policy.metadata.name)}`}>Policy docs</ActionBtn> : null}
        </div>
        <p className="mt-2 text-[11px] text-content-subtle">
          {policy && policyMode(policy) === 'Enforce'
            ? 'This policy is enforced — new or updated resources that fail it are rejected at admission until the spec is fixed at the source (Git for GitOps-managed workloads).'
            : 'This policy audits only — the resource keeps running; fix the spec to clear the report, or add a PolicyException with a documented reason.'}
        </p>
      </DrawerSection>
    </ResourceDrawer>
  )
}

/* ─────────── exceptions ─────────── */

function ExceptionsTable({ exceptions, loading, notInstalled }: { exceptions: PolicyException[]; loading: boolean; notInstalled: boolean }) {
  const [search, setSearch] = useState('')
  const rows = useMemo(
    () => exceptions.filter((e) => matchesSearch(e.metadata.name, search) || matchesSearch(e.metadata.namespace, search) || (e.spec?.exceptions ?? []).some((x) => matchesSearch(x.policyName, search))),
    [exceptions, search],
  )
  if (notInstalled) {
    return <EmptyState title="PolicyExceptions not available" description="The kyverno.io/v2 PolicyException CRD isn't registered — exceptions need Kyverno 1.11+ with exceptions enabled." />
  }
  return (
    <ListShell title="Exceptions" total={exceptions.length} visible={rows.length} loading={loading} search={search} onSearchChange={setSearch} searchPlaceholder="Search exceptions, policies…" caption="PolicyExceptions — documented, scoped exemptions">
      {!loading && rows.length === 0 ? (
        <EmptyState title="No exceptions" description="Every policy applies everywhere it matches." />
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {rows.map((e) => (
            <div key={`${e.metadata.namespace ?? ''}/${e.metadata.name}`} className="rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm">
              <div className="font-semibold text-content">{e.metadata.name}</div>
              <div className="font-mono text-[11px] text-content-subtle">{e.metadata.namespace ?? 'cluster'} · {age(e.metadata.creationTimestamp)}</div>
              <div className="mt-2 space-y-1">
                {(e.spec?.exceptions ?? []).map((x, i) => (
                  <div key={i} className="text-[12px]"><span className="font-mono font-semibold text-content">{x.policyName}</span>{x.ruleNames?.length ? <span className="text-content-muted"> · {x.ruleNames.join(', ')}</span> : null}</div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                <span className="text-content-subtle">for</span>
                {matchKinds(e.spec?.match).map((k) => <Chip key={k}>{k}</Chip>)}
                {matchNamespaces(e.spec?.match).length ? <span className="text-content-subtle">in {matchNamespaces(e.spec?.match).join(', ')}</span> : null}
              </div>
              {e.metadata.annotations?.['adhar.io/reason'] ?? e.metadata.annotations?.['policies.kyverno.io/description'] ? (
                <p className="mt-2 text-[12px] text-content-muted">{e.metadata.annotations?.['adhar.io/reason'] ?? e.metadata.annotations?.['policies.kyverno.io/description']}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </ListShell>
  )
}

/* ─────────── bits ─────────── */

function SummaryTile({ tone, label, value, hint }: { tone: 'emerald' | 'rose' | 'amber' | 'slate' | 'brand' | 'violet'; label: string; value: number | string; hint?: string }) {
  const tones = {
    emerald: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 ring-emerald-200 dark:ring-emerald-500/25',
    rose: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 ring-rose-200 dark:ring-rose-500/25',
    amber: 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 ring-amber-200 dark:ring-amber-500/25',
    slate: 'text-content-muted bg-surface-sunken ring-edge-default',
    brand: 'text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-500/10 ring-brand-200 dark:ring-brand-500/25',
    violet: 'text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/10 ring-violet-200 dark:ring-violet-500/25',
  }
  return (
    <div className={`rounded-xl p-4 ring-1 ring-inset ${tones[tone]}`}>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide">{label}</div>
      {hint ? <div className="mt-0.5 truncate text-[10.5px] opacity-80">{hint}</div> : null}
    </div>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-content-muted">{children}</span>
}

function ActionBtn({ children, href, onClick, primary = false }: { children: ReactNode; href?: string; onClick?(): void; primary?: boolean }) {
  const cls = cn(
    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors',
    primary ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700' : 'border-edge-default bg-surface-raised text-content-muted hover:border-brand-300 hover:text-content',
  )
  if (href) {
    const ext = /^https?:/.test(href)
    return <a href={href} target={ext ? '_blank' : undefined} rel={ext ? 'noreferrer' : undefined} className={cls}>{children}{ext ? <IconExt /> : null}</a>
  }
  return <button type="button" onClick={onClick} className={cls}>{children}</button>
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[11px] font-medium text-content-muted hover:border-brand-300 hover:text-content">
      {children} <IconExt />
    </a>
  )
}

function IconExt() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7" /><path d="M8 7h9v9" />
    </svg>
  )
}
