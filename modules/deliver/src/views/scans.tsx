import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { trivy } from '@adhar-console/api-clients'
import { useRescan, useScans } from '../data/delivery.ts'

const TARGET_LABEL: Record<trivy.ScanTarget, string> = {
  image: 'Image',
  config: 'Config',
  secret: 'Secrets',
  rbac: 'RBAC',
  compliance: 'Compliance',
}

const TARGET_TONE: Record<trivy.ScanTarget, 'brand' | 'amber' | 'rose' | 'sky' | 'emerald'> = {
  image: 'brand',
  config: 'amber',
  secret: 'rose',
  rbac: 'sky',
  compliance: 'emerald',
}

/**
 * Trivy vulnerability + audit reports across the cluster.
 *
 * The list is filterable by target (image / config / secret / rbac /
 * compliance) and severity. Clicking a row opens a drawer with the full
 * vulnerability table, fix-version metadata, and a rescan trigger.
 */
export function Scans() {
  const [target, setTarget] = useState<'all' | trivy.ScanTarget>('all')
  const [severity, setSeverity] = useState<'all' | 'critical' | 'high'>('all')
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const q = useScans()
  const rescan = useRescan()

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading scan reports…
      </div>
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't reach Trivy operator" />
  }

  const all = q.data ?? []
  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    return all
      .filter((r) => target === 'all' || r.target === target)
      .filter((r) => {
        if (severity === 'all') return true
        if (severity === 'critical') return r.summary.critical > 0
        if (severity === 'high') return r.summary.high > 0
        return true
      })
      .filter(
        (r) =>
          !f ||
          r.artifact.toLowerCase().includes(f) ||
          (r.workload ?? '').toLowerCase().includes(f) ||
          (r.namespace ?? '').toLowerCase().includes(f),
      )
      .sort(rankReports)
  }, [all, target, severity, search])

  const counts = countByTarget(all)
  const totals = sumSummaries(all)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SevTile label="Critical" value={totals.critical} tone="rose" />
        <SevTile label="High" value={totals.high} tone="amber" />
        <SevTile label="Medium" value={totals.medium} tone="sky" />
        <SevTile label="Low" value={totals.low} tone="slate" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TargetTabs target={target} setTarget={setTarget} counts={counts} />
        <SeverityTabs severity={severity} setSeverity={setSeverity} />
        <div className="ml-auto">
          <SearchInput value={search} onChange={setSearch} placeholder="Search artifact / namespace…" />
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState title="No reports" description="Trivy hasn't generated any matching reports yet." />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {list.map((r) => (
                <ReportRow key={r.id} report={r} onOpen={() => setOpenId(r.id)} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {openId ? (
        <ReportDetail
          report={all.find((r) => r.id === openId)!}
          onClose={() => setOpenId(null)}
          onRescan={() => rescan.mutate(openId)}
          rescanning={rescan.isPending && rescan.variables === openId}
        />
      ) : null}
    </div>
  )
}

function rankReports(a: trivy.ScanReport, b: trivy.ScanReport) {
  return (
    b.summary.critical * 1000 +
    b.summary.high * 50 -
    (a.summary.critical * 1000 + a.summary.high * 50)
  )
}

function countByTarget(all: trivy.ScanReport[]) {
  const out: Record<string, number> = { all: all.length }
  for (const r of all) out[r.target] = (out[r.target] ?? 0) + 1
  return out
}

function sumSummaries(all: trivy.ScanReport[]) {
  return all.reduce(
    (acc, r) => ({
      critical: acc.critical + (r.summary.critical ?? 0),
      high: acc.high + (r.summary.high ?? 0),
      medium: acc.medium + (r.summary.medium ?? 0),
      low: acc.low + (r.summary.low ?? 0),
    }),
    { critical: 0, high: 0, medium: 0, low: 0 },
  )
}

/* ─────────── filter bars ─────────── */

function TargetTabs({
  target,
  setTarget,
  counts,
}: {
  target: 'all' | trivy.ScanTarget
  setTarget(t: 'all' | trivy.ScanTarget): void
  counts: Record<string, number>
}) {
  const tabs: ('all' | trivy.ScanTarget)[] = ['all', 'image', 'config', 'secret', 'rbac', 'compliance']
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {tabs.map((t) => {
        const on = target === t
        const label = t === 'all' ? 'All' : TARGET_LABEL[t]
        return (
          <button
            key={t}
            type="button"
            onClick={() => setTarget(t)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {label}
            <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
              {counts[t] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function SeverityTabs({
  severity,
  setSeverity,
}: {
  severity: 'all' | 'critical' | 'high'
  setSeverity(s: 'all' | 'critical' | 'high'): void
}) {
  const tabs: { id: 'all' | 'critical' | 'high'; label: string }[] = [
    { id: 'all', label: 'Any sev' },
    { id: 'critical', label: 'Critical+' },
    { id: 'high', label: 'High+' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {tabs.map((t) => {
        const on = severity === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setSeverity(t.id)}
            className={
              on
                ? 'rounded-md bg-rose-50 px-2.5 py-1 text-[12px] font-semibold text-rose-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {t.label}
          </button>
        )
      })}
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
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
        <IconSearch />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="block h-9 w-44 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-64"
      />
    </div>
  )
}

/* ─────────── rows ─────────── */

function ReportRow({ report: r, onOpen }: { report: trivy.ScanReport; onOpen(): void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-brand-50/40"
      >
        <TargetChip target={r.target} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm text-content">{r.artifact}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-content-subtle">
            {r.workload ?? '—'}
            {r.namespace ? ` · ${r.namespace}` : ''} · scanned {formatRelative(r.scanned_at)} ·{' '}
            {r.scanner}
          </div>
        </div>
        <SevBlocks summary={r.summary} />
      </button>
    </li>
  )
}

function TargetChip({ target }: { target: trivy.ScanTarget }) {
  const tone = TARGET_TONE[target]
  const cls = {
    brand: 'bg-brand-50 text-brand-700 border-brand-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  }[tone]
  return (
    <span
      className={`inline-flex h-7 w-16 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {TARGET_LABEL[target]}
    </span>
  )
}

function SevBlocks({ summary: s }: { summary: trivy.ScanReport['summary'] }) {
  return (
    <div className="hidden items-center gap-1 sm:flex">
      <SevPill value={s.critical} tone="rose" label="C" />
      <SevPill value={s.high} tone="amber" label="H" />
      <SevPill value={s.medium} tone="sky" label="M" />
      <SevPill value={s.low} tone="slate" label="L" />
    </div>
  )
}

function SevPill({
  value,
  tone,
  label,
}: {
  value: number
  tone: 'rose' | 'amber' | 'sky' | 'slate'
  label: string
}) {
  const empty = value === 0
  const cls = empty
    ? 'bg-surface-sunken text-content-subtle'
    : {
        rose: 'bg-rose-100 text-rose-700',
        amber: 'bg-amber-100 text-amber-700',
        sky: 'bg-sky-100 text-sky-700',
        slate: 'bg-surface-sunken text-content-muted',
      }[tone]
  return (
    <span className={`inline-flex min-w-[34px] items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] font-mono font-semibold ${cls}`}>
      <span className="mr-1 opacity-60">{label}</span>
      {value}
    </span>
  )
}

/* ─────────── severity tile ─────────── */

function SevTile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'rose' | 'amber' | 'sky' | 'slate'
}) {
  const cls = {
    rose: 'from-rose-50 dark:from-rose-500/10 to-surface-raised text-rose-700 dark:text-rose-300',
    amber: 'from-amber-50 dark:from-amber-500/10 to-surface-raised text-amber-700 dark:text-amber-300',
    sky: 'from-sky-50 dark:from-sky-500/10 to-surface-raised text-sky-700 dark:text-sky-300',
    slate: 'from-slate-50 to-surface-raised text-content-muted',
  }[tone]
  return (
    <Card className={`bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
      </CardBody>
    </Card>
  )
}

/* ─────────── detail drawer ─────────── */

function ReportDetail({
  report: r,
  onClose,
  onRescan,
  rescanning,
}: {
  report: trivy.ScanReport
  onClose(): void
  onRescan(): void
  rescanning: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  const vulns = (r.vulnerabilities ?? []).slice().sort((a, b) => sevRank(a.severity) - sevRank(b.severity))

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <TargetChip target={r.target} />
              <span className="text-[11px] text-content-subtle">{r.scanner}</span>
            </div>
            <h2 className="mt-1 truncate font-mono text-base font-semibold tracking-tight text-content">
              {r.artifact}
            </h2>
            <div className="mt-1 text-[11px] text-content-muted">
              {r.workload ?? '—'}
              {r.namespace ? ` · ${r.namespace}` : ''} · scanned {formatRelative(r.scanned_at)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={onRescan} loading={rescanning} leading={<IconRefresh />}>
              Rescan
            </Button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Card>
            <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SevTile label="Critical" value={r.summary.critical} tone="rose" />
              <SevTile label="High" value={r.summary.high} tone="amber" />
              <SevTile label="Medium" value={r.summary.medium} tone="sky" />
              <SevTile label="Low" value={r.summary.low} tone="slate" />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Findings</div>
              <div className="text-[11px] text-content-subtle">
                Sorted by severity. Showing {vulns.length} of {sumSummaries([r]).critical + sumSummaries([r]).high + sumSummaries([r]).medium + sumSummaries([r]).low}.
              </div>
            </CardHeader>
            <CardBody className="p-0!">
              {vulns.length === 0 ? (
                <EmptyState compact title="No findings exposed" description="Detailed list not available for this report." />
              ) : (
                <ul className="divide-y divide-edge-subtle">
                  {vulns.map((v) => (
                    <li key={v.vulnerability_id} className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <SevBadge severity={v.severity} />
                        <code className="font-mono text-[11px] text-content-muted">
                          {v.vulnerability_id}
                        </code>
                        {v.cvss_score != null ? (
                          <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-mono text-content-muted">
                            CVSS {v.cvss_score.toFixed(1)}
                          </span>
                        ) : null}
                        <span className="ml-auto truncate text-[11px] text-content-subtle">
                          {v.resource}
                          {v.installed_version ? ` @ ${v.installed_version}` : ''}
                        </span>
                      </div>
                      <div className="mt-1 text-sm font-medium text-content">{v.title}</div>
                      {v.description ? (
                        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-content-muted">
                          {v.description}
                        </p>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-content-muted">
                        {v.fixed_version ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                            fix in {v.fixed_version}
                          </span>
                        ) : (
                          <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700">
                            no fix yet
                          </span>
                        )}
                        {v.published_date ? (
                          <span>published {formatRelative(v.published_date)}</span>
                        ) : null}
                        {v.primary_link ? (
                          <a
                            href={v.primary_link}
                            target="_blank"
                            rel="noopener"
                            className="text-brand-700 hover:underline"
                          >
                            advisory ↗
                          </a>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function SevBadge({ severity: s }: { severity: trivy.Severity }) {
  const cls =
    s === 'CRITICAL'
      ? 'bg-rose-500 text-white'
      : s === 'HIGH'
        ? 'bg-amber-500 text-white'
        : s === 'MEDIUM'
          ? 'bg-sky-500 text-white'
          : 'bg-slate-400 text-white'
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {s.toLowerCase()}
    </span>
  )
}

function sevRank(s: trivy.Severity): number {
  return s === 'CRITICAL' ? 0 : s === 'HIGH' ? 1 : s === 'MEDIUM' ? 2 : s === 'LOW' ? 3 : 4
}

/* ─────────── icons ─────────── */

function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
