import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { kyverno } from '@adhar-console/api-clients'
import {
  packCoverage,
  POLICY_PACKS,
  useEnabledPacks,
  useTogglePack,
  type ControlCoverage,
  type ControlStatus,
  type PackCoverage,
  type PackFramework,
  type PolicyPack as CompliancePack,
} from '../data/policy-packs.ts'

const client = kyverno.KyvernoClient.stub()

const RESULT_TONE: Record<kyverno.PolicyResult, StatusKind> = {
  pass: 'healthy',
  fail: 'failed',
  warn: 'progressing',
  error: 'failed',
  skip: 'unknown',
}

const SEVERITY_TONE: Record<kyverno.PolicySeverity, StatusKind> = {
  critical: 'failed',
  high: 'failed',
  medium: 'progressing',
  low: 'info',
}

const ACTION_COLOR: Record<kyverno.PolicyAction, string> = {
  validate: 'bg-brand-50 text-brand-700',
  mutate: 'bg-amber-50 text-amber-700',
  generate: 'bg-emerald-50 text-emerald-700',
  verifyImages: 'bg-violet-50 text-violet-700',
}

/**
 * Full-fledged Kyverno dashboard. Four tabs:
 *
 *   1. **Library** — every Policy / ClusterPolicy with action chips,
 *      enforcement mode toggle (Audit ↔ Enforce), and a detail drawer.
 *   2. **Findings** — flat list of policy-report results with severity,
 *      result, resource, and message; filter by severity / result.
 *   3. **Exceptions** — PolicyException resources with match scopes and
 *      expiry.
 *   4. **Compliance packs** — opt-in CIS / SOC 2 profiles delivered as
 *      Kyverno ClusterPolicy bundles; per-control coverage is derived
 *      from the live findings via `packCoverage`.
 */
type TabId = 'library' | 'findings' | 'exceptions' | 'packs'

export function Policy() {
  const [tab, setTab] = useState<TabId>('library')

  const policies = useQuery({
    queryKey: ['kyverno', 'policies'],
    queryFn: () => client.listPolicies(),
    staleTime: 30_000,
  })
  const reports = useQuery({
    queryKey: ['kyverno', 'reports'],
    queryFn: () => client.listPolicyReports(),
    refetchInterval: 30_000,
  })
  const exceptions = useQuery({
    queryKey: ['kyverno', 'exceptions'],
    queryFn: () => client.listExceptions(),
    staleTime: 60_000,
  })

  const reportList = reports.data ?? []
  const totals = sumSummaries(reportList)
  const enforced = (policies.data ?? []).filter((p) => p.validationFailureAction === 'Enforce').length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Tile label="Policies" value={policies.data?.length ?? 0} hint={`${enforced} enforce`} />
        <Tile label="Pass" value={totals.pass} accent="emerald" />
        <Tile label="Fail" value={totals.fail} accent={totals.fail > 0 ? 'rose' : 'slate'} />
        <Tile label="Warn" value={totals.warn} accent={totals.warn > 0 ? 'amber' : 'slate'} />
        <Tile label="Skip" value={totals.skip} accent="slate" />
        <Tile label="Exceptions" value={exceptions.data?.length ?? 0} accent="violet" />
      </div>

      <Tabs
        tab={tab}
        setTab={setTab}
        counts={{
          library: policies.data?.length ?? 0,
          findings: countFindings(reportList),
          exceptions: exceptions.data?.length ?? 0,
          packs: POLICY_PACKS.length,
        }}
      />

      {tab === 'library' ? (
        <Library policies={policies.data ?? []} loading={policies.isLoading} />
      ) : tab === 'findings' ? (
        <Findings reports={reportList} loading={reports.isLoading} />
      ) : tab === 'exceptions' ? (
        <Exceptions list={exceptions.data ?? []} loading={exceptions.isLoading} />
      ) : (
        <Packs
          reports={reportList}
          exceptions={exceptions.data ?? []}
          loading={reports.isLoading || exceptions.isLoading}
        />
      )}
    </div>
  )
}

function Tabs({
  tab,
  setTab,
  counts,
}: {
  tab: TabId
  setTab(t: TabId): void
  counts: Record<TabId, number>
}) {
  const items: { id: TabId; label: string }[] = [
    { id: 'library', label: 'Policy library' },
    { id: 'findings', label: 'Findings' },
    { id: 'exceptions', label: 'Exceptions' },
    { id: 'packs', label: 'Compliance packs' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {items.map((i) => {
        const on = tab === i.id
        return (
          <button
            key={i.id}
            type="button"
            onClick={() => setTab(i.id)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {i.label}
            <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
              {counts[i.id]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ─────────── Library ─────────── */

function Library({ policies, loading }: { policies: kyverno.Policy[]; loading: boolean }) {
  const qc = useQueryClient()
  const setMode = useMutation({
    mutationFn: ({ name, mode, namespace }: { name: string; mode: 'Audit' | 'Enforce'; namespace?: string }) =>
      client.setEnforcementMode(name, mode, namespace),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kyverno', 'policies'] }),
  })
  const [openName, setOpenName] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState<'all' | kyverno.PolicyAction>('all')

  if (loading) return <Loading label="Loading policies…" />

  const f = search.trim().toLowerCase()
  const list = policies.filter((p) => {
    if (f && !(p.name.toLowerCase().includes(f) || (p.category ?? '').toLowerCase().includes(f))) return false
    if (actionFilter !== 'all' && !p.rules.some((r) => r.action === actionFilter)) return false
    return true
  })
  const open = policies.find((p) => p.name === openName) ?? null
  const counts = countByAction(policies)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ActionFilter value={actionFilter} onChange={setActionFilter} counts={counts} />
        <div className="ml-auto">
          <SearchInput value={search} onChange={setSearch} placeholder="Search policies…" />
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No matching policies" />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {list.map((p) => (
            <PolicyCard
              key={`${p.namespace ?? 'cluster'}/${p.name}`}
              policy={p}
              onOpen={() => setOpenName(p.name)}
              onToggleMode={() =>
                setMode.mutate({
                  name: p.name,
                  namespace: p.namespace,
                  mode: p.validationFailureAction === 'Enforce' ? 'Audit' : 'Enforce',
                })
              }
              busy={setMode.isPending && setMode.variables?.name === p.name}
            />
          ))}
        </div>
      )}

      {open ? <PolicyDetail policy={open} onClose={() => setOpenName(null)} /> : null}
    </div>
  )
}

function PolicyCard({
  policy: p,
  onOpen,
  onToggleMode,
  busy,
}: {
  policy: kyverno.Policy
  onOpen(): void
  onToggleMode(): void
  busy: boolean
}) {
  const enforce = p.validationFailureAction === 'Enforce'
  const total = (p.pass ?? 0) + (p.fail ?? 0) + (p.warn ?? 0)
  const pct = total > 0 ? ((p.pass ?? 0) / total) * 100 : 100
  const tone = (p.fail ?? 0) > 0 ? 'failed' : (p.warn ?? 0) > 0 ? 'progressing' : 'healthy'
  return (
    <Card interactive>
      <button type="button" onClick={onOpen} className="block w-full p-4 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-content">{p.name}</span>
              <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                {p.kind === 'ClusterPolicy' ? 'cluster' : p.namespace}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-content-subtle">
              {p.category ?? '—'}
              {p.severity ? ` · severity ${p.severity}` : ''}
            </div>
            {p.description ? (
              <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-content-muted">{p.description}</p>
            ) : null}
          </div>
          <StatusBadge kind={tone}>{tone === 'failed' ? `${p.fail} fail` : tone === 'progressing' ? `${p.warn} warn` : 'all pass'}</StatusBadge>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {p.rules.map((r) => (
            <span
              key={r.name}
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${ACTION_COLOR[r.action]}`}
            >
              {r.action}
            </span>
          ))}
        </div>

        {total > 0 ? (
          <div className="mt-3">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
              <div className="h-full bg-rose-500" style={{ width: `${((p.fail ?? 0) / total) * 100}%` }} />
              <div className="h-full bg-amber-500" style={{ width: `${((p.warn ?? 0) / total) * 100}%` }} />
            </div>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-content-muted">
              <span>✓ {p.pass ?? 0}</span>
              <span>✗ {p.fail ?? 0}</span>
              <span>! {p.warn ?? 0}</span>
              <span className="ml-auto font-mono">{pct.toFixed(0)}% pass</span>
            </div>
          </div>
        ) : null}
      </button>
      <div className="border-t border-edge-subtle bg-surface-raised/80 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-content-muted">enforcement</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleMode()
            }}
            disabled={busy}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
              enforce
                ? 'border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300'
                : 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${enforce ? 'bg-rose-500' : 'bg-amber-500'}`} />
            {p.validationFailureAction}
          </button>
          <span className="ml-auto text-[10px] font-mono text-content-subtle">
            {p.created_at ? `created ${formatRelative(p.created_at)}` : ''}
          </span>
        </div>
      </div>
    </Card>
  )
}

function ActionFilter({
  value,
  onChange,
  counts,
}: {
  value: 'all' | kyverno.PolicyAction
  onChange(v: 'all' | kyverno.PolicyAction): void
  counts: Record<kyverno.PolicyAction | 'all', number>
}) {
  const items: ('all' | kyverno.PolicyAction)[] = ['all', 'validate', 'mutate', 'generate', 'verifyImages']
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {items.map((i) => {
        const on = value === i
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {i === 'all' ? 'All' : i}
            <span className="ml-1.5 font-mono text-[9px] tabular-nums opacity-60">{counts[i] ?? 0}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ─────────── Findings ─────────── */

function Findings({ reports, loading }: { reports: kyverno.PolicyReport[]; loading: boolean }) {
  const [severity, setSeverity] = useState<'all' | kyverno.PolicySeverity>('all')
  const [result, setResult] = useState<'all' | kyverno.PolicyResult>('fail')

  if (loading) return <Loading label="Loading findings…" />

  const flat = useMemo(() => {
    const out: Array<{ report: kyverno.PolicyReport; finding: NonNullable<kyverno.PolicyReport['results']>[number] }> = []
    for (const r of reports) {
      for (const f of r.results ?? []) out.push({ report: r, finding: f })
    }
    return out
  }, [reports])

  const list = useMemo(() => {
    return flat
      .filter(({ finding }) => result === 'all' || finding.result === result)
      .filter(({ finding }) => severity === 'all' || finding.severity === severity)
      .sort((a, b) => sevRank(a.finding.severity) - sevRank(b.finding.severity))
  }, [flat, result, severity])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ResultFilter value={result} onChange={setResult} />
        <SeverityFilter value={severity} onChange={setSeverity} />
        <span className="ml-auto text-[11px] text-content-muted">{list.length} findings</span>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No findings" description="Try a different filter — or relax 🎉" />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {list.map(({ report, finding }, i) => (
                <FindingRow key={i} report={report} finding={finding} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function ResultFilter({
  value,
  onChange,
}: {
  value: 'all' | kyverno.PolicyResult
  onChange(v: 'all' | kyverno.PolicyResult): void
}) {
  const items: ('all' | kyverno.PolicyResult)[] = ['fail', 'warn', 'pass', 'skip', 'all']
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {items.map((i) => {
        const on = value === i
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {i === 'all' ? 'All' : i}
          </button>
        )
      })}
    </div>
  )
}

function SeverityFilter({
  value,
  onChange,
}: {
  value: 'all' | kyverno.PolicySeverity
  onChange(v: 'all' | kyverno.PolicySeverity): void
}) {
  const items: ('all' | kyverno.PolicySeverity)[] = ['all', 'critical', 'high', 'medium', 'low']
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {items.map((i) => {
        const on = value === i
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            className={
              on
                ? 'rounded-md bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700'
                : 'rounded-md px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {i === 'all' ? 'Any sev' : i}
          </button>
        )
      })}
    </div>
  )
}

function FindingRow({
  report,
  finding,
}: {
  report: kyverno.PolicyReport
  finding: NonNullable<kyverno.PolicyReport['results']>[number]
}) {
  return (
    <li className="px-5 py-3 transition-colors hover:bg-brand-50/40">
      <div className="flex items-center gap-2">
        <StatusBadge kind={RESULT_TONE[finding.result]}>{finding.result}</StatusBadge>
        {finding.severity ? (
          <StatusBadge kind={SEVERITY_TONE[finding.severity]}>{finding.severity}</StatusBadge>
        ) : null}
        <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content">
          {finding.policy} · {finding.rule}
        </code>
        <span className="ml-auto shrink-0 text-[11px] text-content-muted">
          {report.metadata.namespace ?? 'cluster'}
        </span>
      </div>
      {finding.message ? (
        <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-content">
          {finding.message}
        </div>
      ) : null}
      {finding.resources?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] font-mono text-content-subtle">
          {finding.resources.map((r, i) => (
            <span key={i} className="rounded bg-surface-sunken px-1.5 py-0.5">
              {r.kind}/{r.name}
              {r.namespace ? ` @ ${r.namespace}` : ''}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  )
}

/* ─────────── Exceptions ─────────── */

function Exceptions({ list, loading }: { list: kyverno.PolicyException[]; loading: boolean }) {
  if (loading) return <Loading label="Loading exceptions…" />
  if (list.length === 0) return <EmptyState title="No exceptions" description="Define a PolicyException to suppress a specific rule for a workload." />

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {list.map((e) => (
        <Card key={`${e.namespace ?? 'cluster'}/${e.name}`}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content">{e.name}</div>
                <div className="text-[11px] text-content-subtle">
                  {e.namespace ?? 'cluster scope'} · waives {e.rules.length} rule{e.rules.length === 1 ? '' : 's'} on {e.policyRef}
                </div>
              </div>
              {e.expires_at ? (
                <StatusBadge kind="info">expires {formatRelative(e.expires_at)}</StatusBadge>
              ) : (
                <StatusBadge kind="unknown">no expiry</StatusBadge>
              )}
            </div>
          </CardHeader>
          <CardBody className="space-y-2 text-[12px]">
            {e.reason ? <p className="text-content">{e.reason}</p> : null}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                Match
              </div>
              <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10px]">
                {(e.match.kinds ?? []).map((k) => (
                  <span key={k} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted">
                    kind <span className="text-content">{k}</span>
                  </span>
                ))}
                {(e.match.namespaces ?? []).map((n) => (
                  <span key={n} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted">
                    namespace <span className="text-content">{n}</span>
                  </span>
                ))}
                {(e.match.names ?? []).map((n) => (
                  <span key={n} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted">
                    name <span className="text-content">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

/* ─────────── Compliance packs ─────────── */

const CONTROL_TONE: Record<ControlStatus, StatusKind> = {
  pass: 'healthy',
  fail: 'failed',
  exempt: 'info',
  unknown: 'unknown',
}

const CONTROL_LABEL: Record<ControlStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  exempt: 'exempt',
  unknown: 'no data',
}

const FRAMEWORK_TONE: Record<PackFramework, string> = {
  CIS: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25',
  SOC2: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25',
  PSS: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25',
  'NSA-CISA': 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25',
}

function Packs({
  reports,
  exceptions,
  loading,
}: {
  reports: kyverno.PolicyReport[]
  exceptions: kyverno.PolicyException[]
  loading: boolean
}) {
  const enabled = useEnabledPacks()
  const toggle = useTogglePack()
  const [openId, setOpenId] = useState<string | null>(null)

  const coverages = useMemo(() => {
    const out = new Map<string, PackCoverage>()
    for (const pack of POLICY_PACKS) out.set(pack.id, packCoverage(pack, reports, exceptions))
    return out
  }, [reports, exceptions])

  if (loading) return <Loading label="Loading compliance packs…" />

  const enabledIds = enabled.data ?? []
  const open = POLICY_PACKS.find((p) => p.id === openId) ?? null

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-edge-default bg-surface-raised px-4 py-3 text-[12px] leading-relaxed text-content-muted shadow-sm">
        Compliance packs are <span className="font-semibold text-content">opt-in</span> Kyverno
        ClusterPolicy bundles that ship in audit mode. Enabling a pack tracks it in this console —
        nothing changes on the cluster until you download the bundle and{' '}
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[10px]">kubectl apply</code>{' '}
        it. Coverage below is computed from the live PolicyReport findings.
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {POLICY_PACKS.map((pack) => (
          <PackCard
            key={pack.id}
            pack={pack}
            coverage={coverages.get(pack.id)!}
            enabled={enabledIds.includes(pack.id)}
            busy={toggle.isPending && toggle.variables?.packId === pack.id}
            onToggle={(next) => toggle.mutate({ packId: pack.id, enabled: next })}
            onOpen={() => setOpenId(pack.id)}
          />
        ))}
      </div>

      {open ? (
        <PackDetail
          pack={open}
          coverage={coverages.get(open.id)!}
          enabled={enabledIds.includes(open.id)}
          onToggle={(next) => toggle.mutate({ packId: open.id, enabled: next })}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  )
}

function PackCard({
  pack,
  coverage,
  enabled,
  busy,
  onToggle,
  onOpen,
}: {
  pack: CompliancePack
  coverage: PackCoverage
  enabled: boolean
  busy: boolean
  onToggle(next: boolean): void
  onOpen(): void
}) {
  return (
    <Card interactive>
      <button type="button" onClick={onOpen} className="block w-full p-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <FrameworkBadge framework={pack.framework} />
              <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                {pack.version}
              </span>
            </div>
            <div className="mt-1.5 truncate text-sm font-semibold text-content">{pack.name}</div>
            <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-content-muted">
              {pack.description}
            </p>
          </div>
          <ComplianceRing pct={coverage.compliancePct} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-content-muted">
          <span>
            <span className="font-semibold tabular-nums text-content">{pack.controls.length}</span>{' '}
            controls
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">✓ {coverage.passed}</span>
          <span className="text-rose-600 dark:text-rose-400">✗ {coverage.failed}</span>
          {coverage.exempt > 0 ? (
            <span className="text-violet-600 dark:text-violet-400">◌ {coverage.exempt} exempt</span>
          ) : null}
          <span className="text-content-subtle">{coverage.unknown} no data</span>
        </div>
      </button>
      <div className="border-t border-edge-subtle bg-surface-sunken/40 px-4 py-2">
        <div className="flex items-center gap-2">
          <PackToggle enabled={enabled} busy={busy} onToggle={onToggle} />
          <span className="text-[11px] text-content-muted">
            {enabled ? 'enabled — tracked in this console' : 'disabled'}
          </span>
          <span className="ml-auto font-mono text-[10px] text-content-subtle">
            {pack.kyvernoPolicies.length} policies · audit mode
          </span>
        </div>
      </div>
    </Card>
  )
}

function PackToggle({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean
  busy: boolean
  onToggle(next: boolean): void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? 'Disable pack' : 'Enable pack'}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(!enabled)
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
        enabled
          ? 'bg-emerald-500 dark:bg-emerald-600'
          : 'bg-surface-sunken ring-1 ring-inset ring-edge-default'
      }`}
    >
      <span
        className={`h-3.5 w-3.5 transform rounded-full bg-surface-raised shadow transition-transform ${
          enabled ? 'translate-x-[18px]' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function FrameworkBadge({ framework }: { framework: PackFramework }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ${FRAMEWORK_TONE[framework]}`}
    >
      {framework}
    </span>
  )
}

function ComplianceRing({ pct }: { pct: number | null }) {
  const r = 15.5
  const c = 2 * Math.PI * r
  const arc =
    pct === null
      ? 'text-slate-300 dark:text-slate-600'
      : pct >= 90
        ? 'text-emerald-500 dark:text-emerald-400'
        : pct >= 60
          ? 'text-amber-500 dark:text-amber-400'
          : 'text-rose-500 dark:text-rose-400'
  return (
    <div
      className="relative h-12 w-12 shrink-0"
      role="img"
      aria-label={pct === null ? 'Compliance: no data yet' : `Compliance: ${pct}%`}
    >
      <svg viewBox="0 0 40 40" className="h-12 w-12 -rotate-90">
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="4.5"
          stroke="currentColor"
          className="text-surface-sunken"
        />
        {pct !== null ? (
          <circle
            cx="20"
            cy="20"
            r={r}
            fill="none"
            strokeWidth="4.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${(pct / 100) * c} ${c}`}
            className={arc}
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums text-content">
        {pct === null ? '—' : `${pct}%`}
      </span>
    </div>
  )
}

/* ─────────── pack detail drawer ─────────── */

function PackDetail({
  pack,
  coverage,
  enabled,
  onToggle,
  onClose,
}: {
  pack: CompliancePack
  coverage: PackCoverage
  enabled: boolean
  onToggle(next: boolean): void
  onClose(): void
}) {
  const [showYaml, setShowYaml] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  const copyYaml = async () => {
    try {
      await navigator.clipboard.writeText(pack.bundleYaml)
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } catch {
      /* clipboard unavailable — the YAML stays visible for manual copy */
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] text-content-subtle">
              <FrameworkBadge framework={pack.framework} />
              <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono">{pack.version}</span>
              <span>{pack.controls.length} controls</span>
              <span>{pack.kyvernoPolicies.length} policies</span>
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">
              {pack.name}
            </h2>
            <p className="mt-1 max-w-2xl text-xs text-content-muted">{pack.description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <DetailTile
                label="Compliance"
                value={coverage.compliancePct === null ? 'no data' : `${coverage.compliancePct}%`}
              />
              <DetailTile label="Passing" value={`${coverage.passed}`} />
              <DetailTile label="Failing" value={`${coverage.failed}`} />
              <DetailTile label="No data" value={`${coverage.unknown}`} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700 dark:text-brand-300">
                Apply this pack
              </div>
            </CardHeader>
            <CardBody className="space-y-3 text-[12px] leading-relaxed text-content-muted">
              <p>
                Packs are opt-in and <span className="font-semibold text-content">audit-first</span>:
                every bundled ClusterPolicy ships with{' '}
                <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[10px]">
                  validationFailureAction: Audit
                </code>
                , so applying it only surfaces findings — nothing is blocked at admission. The
                toggle here tracks the pack in this console; the cluster is changed only when you
                apply the bundle yourself. Promote individual policies to Enforce from the Policy
                library once their findings are clean.
              </p>
              <pre className="overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[11px] text-content">
                {`kubectl apply -f ${pack.bundleFile}`}
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadBundle(pack)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600"
                >
                  Download {pack.bundleFile}
                </button>
                <button
                  type="button"
                  onClick={() => setShowYaml((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1.5 text-[11px] font-semibold text-content hover:bg-surface-sunken"
                >
                  {showYaml ? 'Hide bundle YAML' : 'View bundle YAML'}
                </button>
                <div className="ml-auto flex items-center gap-2">
                  <PackToggle enabled={enabled} busy={false} onToggle={onToggle} />
                  <span className="text-[11px] text-content-muted">
                    {enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
              </div>
            </CardBody>
          </Card>

          {showYaml ? (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700 dark:text-brand-300">
                  {pack.bundleFile}
                </div>
                <button
                  type="button"
                  onClick={copyYaml}
                  className="rounded-md border border-edge-default bg-surface-raised px-2 py-0.5 text-[10px] font-semibold text-content-muted hover:bg-surface-sunken hover:text-content"
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
              </CardHeader>
              <CardBody className="p-0!">
                <pre className="max-h-96 overflow-auto px-5 py-4 font-mono text-[10px] leading-relaxed text-content">
                  {pack.bundleYaml}
                </pre>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700 dark:text-brand-300">
                Controls
              </div>
            </CardHeader>
            <CardBody className="p-0!">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-edge-subtle text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                      <th className="px-5 py-2.5">Control</th>
                      <th className="px-3 py-2.5">Title</th>
                      <th className="px-3 py-2.5">Severity</th>
                      <th className="px-3 py-2.5">Kyverno policy</th>
                      <th className="px-5 py-2.5 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge-subtle">
                    {coverage.controls.map((c) => (
                      <ControlRow key={`${c.control.id}-${c.control.kyvernoPolicy}`} coverage={c} />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function ControlRow({ coverage: c }: { coverage: ControlCoverage }) {
  return (
    <tr className="align-top transition-colors hover:bg-brand-50/40 dark:hover:bg-brand-500/5">
      <td className="px-5 py-3">
        <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content">
          {c.control.id}
        </code>
      </td>
      <td className="px-3 py-3">
        <div className="font-medium text-content">{c.control.title}</div>
        <div className="mt-0.5 text-[10px] text-content-subtle">{c.control.category}</div>
        {c.failingResources.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[10px] text-content-subtle">
            {c.failingResources.map((r, i) => (
              <span key={i} className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                {r.kind}/{r.name}
                {r.namespace ? ` @ ${r.namespace}` : ''}
              </span>
            ))}
          </div>
        ) : null}
        {c.exceptionNames.length > 0 ? (
          <div className="mt-1 text-[10px] text-violet-600 dark:text-violet-400">
            waived by {c.exceptionNames.join(', ')}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-3">
        <StatusBadge kind={SEVERITY_TONE[c.control.severity]}>{c.control.severity}</StatusBadge>
      </td>
      <td className="px-3 py-3">
        <code className="font-mono text-[11px] text-content-muted">{c.control.kyvernoPolicy}</code>
      </td>
      <td className="px-5 py-3 text-right">
        <StatusBadge kind={CONTROL_TONE[c.status]}>{CONTROL_LABEL[c.status]}</StatusBadge>
        {c.status === 'fail' ? (
          <div className="mt-1 font-mono text-[10px] tabular-nums text-content-subtle">
            {c.fail} fail{c.warn > 0 ? ` · ${c.warn} warn` : ''}
          </div>
        ) : null}
      </td>
    </tr>
  )
}

function downloadBundle(pack: CompliancePack) {
  const blob = new Blob([pack.bundleYaml], { type: 'application/yaml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = pack.bundleFile
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/* ─────────── policy detail drawer ─────────── */

function PolicyDetail({ policy: p, onClose }: { policy: kyverno.Policy; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] text-content-subtle">
              <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono">{p.kind}</span>
              {p.namespace ? <span>{p.namespace}</span> : <span>cluster scope</span>}
              {p.severity ? <StatusBadge kind={SEVERITY_TONE[p.severity]}>{p.severity}</StatusBadge> : null}
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">{p.name}</h2>
            {p.description ? (
              <p className="mt-1 max-w-2xl text-xs text-content-muted">{p.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <DetailTile label="Mode" value={p.validationFailureAction} />
              <DetailTile label="Background" value={p.background ? 'on' : 'off'} />
              <DetailTile label="Category" value={p.category ?? '—'} />
              <DetailTile label="Ready" value={p.ready ? 'yes' : 'no'} />
            </CardBody>
          </Card>

          {((p.pass ?? 0) + (p.fail ?? 0) + (p.warn ?? 0)) > 0 ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Result distribution</div>
              </CardHeader>
              <CardBody className="space-y-2">
                <ResultBar pass={p.pass ?? 0} fail={p.fail ?? 0} warn={p.warn ?? 0} />
                <div className="flex items-center gap-3 text-[11px] text-content-muted">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    pass {p.pass ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                    fail {p.fail ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    warn {p.warn ?? 0}
                  </span>
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Rules</div>
            </CardHeader>
            <CardBody className="p-0!">
              <ul className="divide-y divide-edge-subtle">
                {p.rules.map((r) => (
                  <li key={r.name} className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${ACTION_COLOR[r.action]}`}>
                        {r.action}
                      </span>
                      <span className="font-mono text-[12px] text-content">{r.name}</span>
                      {r.severity ? <StatusBadge kind={SEVERITY_TONE[r.severity]}>{r.severity}</StatusBadge> : null}
                    </div>
                    {r.description ? (
                      <p className="mt-1 text-[11px] leading-relaxed text-content-muted">{r.description}</p>
                    ) : null}
                    {r.match ? (
                      <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] font-mono text-content-subtle">
                        {(r.match.kinds ?? []).map((k) => (
                          <span key={k} className="rounded bg-surface-sunken px-1.5 py-0.5">
                            kind <span className="text-content">{k}</span>
                          </span>
                        ))}
                        {(r.match.namespaces ?? []).map((n) => (
                          <span key={n} className="rounded bg-surface-sunken px-1.5 py-0.5">
                            ns <span className="text-content">{n}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function ResultBar({ pass, fail, warn }: { pass: number; fail: number; warn: number }) {
  const total = pass + fail + warn || 1
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
      <div className="h-full bg-emerald-500" style={{ width: `${(pass / total) * 100}%` }} />
      <div className="h-full bg-rose-500" style={{ width: `${(fail / total) * 100}%` }} />
      <div className="h-full bg-amber-500" style={{ width: `${(warn / total) * 100}%` }} />
    </div>
  )
}

/* ─────────── helpers / atoms ─────────── */

function Tile({
  label,
  value,
  hint,
  accent = 'slate',
}: {
  label: string
  value: number | string
  hint?: string
  accent?: 'slate' | 'emerald' | 'rose' | 'amber' | 'violet'
}) {
  const cls = {
    slate: 'from-slate-50 to-surface-raised text-content',
    emerald: 'from-emerald-50 dark:from-emerald-500/10 to-surface-raised text-emerald-700 dark:text-emerald-300',
    rose: 'from-rose-50 dark:from-rose-500/10 to-surface-raised text-rose-700 dark:text-rose-300',
    amber: 'from-amber-50 dark:from-amber-500/10 to-surface-raised text-amber-700 dark:text-amber-300',
    violet: 'from-violet-50 dark:from-violet-500/10 to-surface-raised text-violet-700 dark:text-violet-300',
  }[accent]
  return (
    <Card className={`bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="space-y-1 p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
        {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  )
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="text-base font-semibold text-content">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange(v: string): void
  placeholder: string
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="block h-9 w-44 rounded-lg border border-edge-default bg-surface-raised px-3 py-1 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
    />
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
      <Spinner size={14} /> {label}
    </div>
  )
}

function sumSummaries(reports: kyverno.PolicyReport[]) {
  return reports.reduce(
    (acc, r) => ({
      pass: acc.pass + r.summary.pass,
      fail: acc.fail + r.summary.fail,
      warn: acc.warn + r.summary.warn,
      error: acc.error + r.summary.error,
      skip: acc.skip + r.summary.skip,
    }),
    { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 },
  )
}

function countFindings(reports: kyverno.PolicyReport[]): number {
  return reports.reduce((acc, r) => acc + (r.results?.length ?? 0), 0)
}

function countByAction(policies: kyverno.Policy[]): Record<kyverno.PolicyAction | 'all', number> {
  const out: Record<string, number> = { all: policies.length }
  for (const p of policies) {
    for (const r of p.rules) out[r.action] = (out[r.action] ?? 0) + 1
  }
  return out as Record<kyverno.PolicyAction | 'all', number>
}

function sevRank(s?: kyverno.PolicySeverity): number {
  return s === 'critical' ? 0 : s === 'high' ? 1 : s === 'medium' ? 2 : s === 'low' ? 3 : 4
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export default Policy
