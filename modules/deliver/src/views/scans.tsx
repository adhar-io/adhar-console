import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  SearchInput,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { harbor } from '@adhar/api-clients'
import {
  useArtifactVulnerabilities,
  useHarborScanners,
  useRegistryArtifacts,
  useScanArtifact,
} from '../data/delivery.ts'
import {
  byRisk,
  byVulnRisk,
  matchesVuln,
  readArtifact,
  SEVERITIES,
  summariseScans,
  vulnSeverity,
  type ScannedArtifact,
  type Severity,
} from '../data/scan-rollup.ts'

/**
 * Vulnerability Scans — what is in the images this platform ships.
 *
 * The page read a BFF route backed by seeded sample reports, so it showed four
 * zeros and "Trivy hasn't generated any matching reports yet" on a platform
 * whose registry has Trivy registered as its default scanner. It now reads
 * Harbor, which runs that scanner and holds a verdict per artifact.
 *
 * The distinction the page is built around: an artifact nobody has scanned and
 * an artifact scanned with nothing found are both zero on a summary row and
 * mean opposite things. Unscanned is reported as its own number, with the
 * button that fixes it.
 */

const SEV_TONE: Record<Severity, { chip: string; fill: string; text: string }> = {
  critical: {
    chip: 'bg-rose-100 text-rose-900 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200',
    fill: 'bg-rose-600',
    text: 'text-rose-700 dark:text-rose-300',
  },
  high: {
    chip: 'bg-orange-100 text-orange-900 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-200',
    fill: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-300',
  },
  medium: {
    chip: 'bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-200',
    fill: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
  },
  low: {
    chip: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-400/15 dark:text-slate-300',
    fill: 'bg-slate-400',
    text: 'text-content-muted',
  },
}

export function Scans() {
  const registry = useRegistryArtifacts()
  const scanners = useHarborScanners()
  const scan = useScanArtifact()

  const [search, setSearch] = useState('')
  const [severities, setSeverities] = useState<Severity[]>([])
  const [onlyUnscanned, setOnlyUnscanned] = useState(false)
  const [open, setOpen] = useState<ScannedArtifact | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const artifacts = useMemo(
    () => (registry.data?.items ?? []).map((i) => readArtifact(i.repo, i.artifact)).sort(byRisk),
    [registry.data],
  )
  const summary = useMemo(() => summariseScans(artifacts), [artifacts])

  const visible = artifacts.filter((a) => {
    if (onlyUnscanned && (a.scanned || a.failed || a.running)) return false
    if (severities.length && !(a.worst && severities.includes(a.worst))) return false
    const q = search.trim().toLowerCase()
    if (q && !`${a.repo} ${a.tags.join(' ')} ${a.digest}`.toLowerCase().includes(q)) return false
    return true
  })

  const unscanned = artifacts.filter((a) => !a.scanned && !a.failed && !a.running)

  const rescan = async (a: ScannedArtifact) => {
    setBusy(a.digest)
    try {
      await scan.mutateAsync({ repo: a.repo, ref: a.digest })
    } finally {
      setBusy(null)
    }
  }

  const scanAll = async () => {
    setBusy('all')
    try {
      // Sequential: a registry-wide rescan is a real load on one scanner pod.
      for (const a of unscanned) await scan.mutateAsync({ repo: a.repo, ref: a.digest })
    } finally {
      setBusy(null)
    }
  }

  if (registry.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Reading the registry…
      </div>
    )
  }
  if (registry.isError) {
    return (
      <EmptyState
        title="Couldn't reach Harbor"
        description={registry.error instanceof Error
          ? registry.error.message
          : 'Scan results come from the registry, which could not be read.'}
      />
    )
  }
  if (artifacts.length === 0) {
    return (
      <EmptyState
        title="Nothing in the registry to scan"
        description="Vulnerability scans are run against the images in Harbor. No artifacts have been pushed yet, so there is nothing to report."
      />
    )
  }

  const scanner = scanners.data?.find((s) => s.isDefault) ?? scanners.data?.[0]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {SEVERITIES.map((s) => (
          <SevStat
            key={s}
            severity={s}
            value={summary.counts[s]}
            active={severities.includes(s)}
            onClick={() =>
              setSeverities((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])}
          />
        ))}
        <Stat
          label="Fixable"
          value={summary.fixable}
          hint={summary.fixable ? 'a newer package exists' : 'nothing has a fix yet'}
          tone={summary.fixable ? 'progressing' : undefined}
        />
        <Stat
          label="Unscanned"
          value={summary.unscanned}
          hint={summary.unscanned ? 'never scanned' : `all ${summary.scanned} scanned`}
          tone={summary.unscanned ? 'degraded' : 'healthy'}
          active={onlyUnscanned}
          onClick={() => setOnlyUnscanned((v) => !v)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search repository, tag or digest…"
            label="Search artifacts"
          />
        </div>
        {summary.unscanned > 0 ? (
          <Button
            size="sm"
            onClick={scanAll}
            loading={busy === 'all'}
            disabled={busy !== null}
          >
            Scan {summary.unscanned} unscanned
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-subtle">
        <span>
          {summary.scanned} of {summary.artifacts} artifacts scanned
          {summary.clean ? ` · ${summary.clean} clean` : ''}
          {summary.atRisk ? ` · ${summary.atRisk} with critical or high` : ''}
        </span>
        {summary.running ? <span className="text-indigo-700 dark:text-indigo-300">{summary.running} scanning</span> : null}
        {summary.failed ? <span className="text-rose-700 dark:text-rose-300">{summary.failed} scan failed</span> : null}
        {scanner ? <span>scanner {scanner.name}{scanner.version ? ` ${scanner.version}` : ''}</span> : null}
        {registry.data?.truncated
          ? <span className="text-amber-700 dark:text-amber-400">showing the first 60 repositories</span>
          : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState compact title="No matching artifacts" description="Relax the filters or the search." />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-edge-subtle text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  <th className="px-4 py-2">Artifact</th>
                  <th className="px-4 py-2">Findings</th>
                  <th className="px-4 py-2">Scan</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {visible.map((a) => (
                  <ArtifactRow
                    key={`${a.repo}@${a.digest}`}
                    artifact={a}
                    busy={busy === a.digest}
                    disabled={busy !== null}
                    onOpen={() => setOpen(a)}
                    onScan={() => rescan(a)}
                  />
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {open ? <VulnDrawer artifact={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}

function ArtifactRow({
  artifact: a,
  busy,
  disabled,
  onOpen,
  onScan,
}: {
  artifact: ScannedArtifact
  busy: boolean
  disabled: boolean
  onOpen(): void
  onScan(): void
}) {
  return (
    <tr className="transition-colors hover:bg-surface-sunken/50">
      <td className="px-4 py-2.5">
        <button type="button" onClick={onOpen} className="block max-w-full text-left" disabled={!a.scanned}>
          <div className="truncate text-[13px] font-medium text-content">{a.repo}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {a.tags.length ? a.tags.join(', ') : a.label}
          </div>
        </button>
      </td>
      <td className="px-4 py-2.5">
        {a.scanned ? (
          a.total === 0 ? (
            <span className="text-[12px] text-emerald-700 dark:text-emerald-300">No findings</span>
          ) : (
            <SeverityBar counts={a.counts} total={a.total} fixable={a.fixable} />
          )
        ) : (
          <span className="text-[12px] text-content-subtle">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {/* Never scanned, scanning, failed and scanned-clean are four states
            and each says something different about what to do next. */}
        {a.running ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-indigo-700 dark:text-indigo-300">
            <Spinner size={11} /> scanning
          </span>
        ) : a.failed ? (
          <StatusBadge kind="failed">Scan failed</StatusBadge>
        ) : a.scanned ? (
          <span className="text-[12px] text-content-muted" title={a.scan?.endTime}>
            {a.scan?.endTime ? formatRelative(a.scan.endTime) : 'scanned'}
          </span>
        ) : (
          <StatusBadge kind="unknown">Never scanned</StatusBadge>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <Button size="sm" variant="secondary" onClick={onScan} loading={busy} disabled={disabled}>
          {a.scanned || a.failed ? 'Rescan' : 'Scan'}
        </Button>
      </td>
    </tr>
  )
}

function SeverityBar({
  counts,
  total,
  fixable,
}: {
  counts: Record<Severity, number>
  total: number
  fixable?: number
}) {
  return (
    <div className="min-w-[170px]">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        {SEVERITIES.map((s) =>
          counts[s] ? (
            <span
              key={s}
              className={cn('h-full', SEV_TONE[s].fill)}
              style={{ width: `${(counts[s] / total) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px]">
        {SEVERITIES.map((s) =>
          counts[s]
            ? (
              <span key={s} className={SEV_TONE[s].text}>
                {counts[s]} {s}
              </span>
            )
            : null
        )}
        {fixable ? <span className="text-content-subtle">· {fixable} fixable</span> : null}
      </div>
    </div>
  )
}

function SevStat({
  severity,
  value,
  active,
  onClick,
}: {
  severity: Severity
  value: number
  active: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-xl border px-3.5 py-3 text-left transition-colors',
        active
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10'
          : 'border-edge-default bg-surface-raised hover:border-edge-strong',
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {severity}
      </div>
      <div className={cn('mt-1 text-2xl font-semibold leading-none tabular-nums', value ? SEV_TONE[severity].text : 'text-content')}>
        {value}
      </div>
      <div className="mt-1 text-[11px] text-content-subtle">across scanned images</div>
    </button>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
  active?: boolean
  onClick?(): void
}) {
  const toneText: Partial<Record<StatusKind, string>> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      className={cn(
        'rounded-xl border px-3.5 py-3 text-left transition-colors',
        active
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10'
          : 'border-edge-default bg-surface-raised',
        onClick ? 'hover:border-edge-strong' : 'cursor-default',
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold leading-none tabular-nums', tone ? toneText[tone] ?? 'text-content' : 'text-content')}>
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </button>
  )
}

/* ─────────── the findings of one artifact ─────────── */

function VulnDrawer({ artifact: a, onClose }: { artifact: ScannedArtifact; onClose(): void }) {
  const vulns = useArtifactVulnerabilities(a.repo, a.digest)
  const [search, setSearch] = useState('')
  const [severities, setSeverities] = useState<Severity[]>([])
  const [fixableOnly, setFixableOnly] = useState(false)
  const [limit, setLimit] = useState(250)

  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  const all = vulns.data ?? []
  const list = all.filter((v) => matchesVuln(v, { severities, fixableOnly, search })).sort(byVulnRisk)
  // Until the report arrives, the artifact's own count is the honest figure —
  // deriving it from an empty list rendered "0 fixable" beside a row that had
  // just said 184.
  const fixableCount = vulns.data ? all.filter((v) => v.fixVersion).length : a.fixable ?? 0
  // A full report for a base image is thousands of findings and megabytes of
  // JSON; rendering every row at once is seconds of layout nobody asked for.
  const shown = list.slice(0, limit)

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                Image findings
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">{a.repo}</h2>
              <p className="mt-1 truncate font-mono text-[11px] text-content-subtle" title={a.digest}>
                {a.tags.join(', ') || a.label}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={severities.includes(s)}
                onClick={() =>
                  setSeverities((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-opacity',
                  SEV_TONE[s].chip,
                  severities.length && !severities.includes(s) && 'opacity-40',
                )}
              >
                {a.counts[s]} {s}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={fixableOnly}
              onClick={() => setFixableOnly((v) => !v)}
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors',
                fixableOnly
                  ? 'bg-brand-50 text-brand-800 ring-brand-600/25 dark:bg-brand-500/15 dark:text-brand-200'
                  : 'bg-surface-sunken text-content-muted ring-edge-subtle',
              )}
            >
              {fixableCount} fixable
            </button>
          </div>
          <div className="mt-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search CVE, package or version…"
              label="Search findings"
              shortcut={undefined}
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {vulns.isLoading ? (
            <div className="flex items-center gap-2 px-6 py-8 text-sm text-content-muted">
              <Spinner size={14} />
              {/* A base image's report is thousands of findings and several
                  megabytes, so say that rather than spin silently. */}
              Loading {a.total.toLocaleString()} findings…
              {a.total > 1000 ? <span className="text-content-subtle">this one is large</span> : null}
            </div>
          ) : vulns.isError ? (
            <div className="px-6 py-8">
              <EmptyState
                compact
                title="Couldn't read the report"
                description={vulns.error instanceof Error ? vulns.error.message : 'Harbor did not return the vulnerability report for this artifact.'}
              />
            </div>
          ) : list.length === 0 ? (
            <div className="px-6 py-8">
              <EmptyState
                compact
                title={all.length ? 'No matching findings' : 'No findings'}
                description={all.length
                  ? 'Relax the filters or the search.'
                  : 'The scanner found no known vulnerabilities in this image.'}
              />
            </div>
          ) : (
            <>
              <ul className="divide-y divide-edge-subtle">
                {shown.map((v) => <VulnRow key={`${v.id}:${v.package}:${v.version}`} vuln={v} />)}
              </ul>
              {list.length > shown.length ? (
                <div className="border-t border-edge-subtle px-6 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => setLimit((n) => n + 500)}
                    className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                  >
                    Show more — {(list.length - shown.length).toLocaleString()} further findings
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function VulnRow({ vuln: v }: { vuln: harbor.Vulnerability }) {
  const sev = vulnSeverity(v)
  const link = v.links?.[0]
  return (
    <li className="px-6 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset', SEV_TONE[sev].chip)}>
          {v.severity}
        </span>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            {v.id}
          </a>
        ) : (
          <span className="font-mono text-[13px] font-medium text-content">{v.id}</span>
        )}
        {v.cvssScore ? (
          <span className="text-[11px] tabular-nums text-content-subtle">CVSS {v.cvssScore}</span>
        ) : null}
        {/* The actionable half of a finding: what to upgrade to. */}
        {v.fixVersion ? (
          <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            fixed in {v.fixVersion}
          </span>
        ) : (
          <span className="ml-auto text-[11px] text-content-subtle">no fix available</span>
        )}
      </div>
      <div className="mt-1 text-[12px] text-content">
        <span className="font-medium">{v.package}</span>{' '}
        <span className="font-mono text-content-muted">{v.version}</span>
      </div>
      {v.description ? (
        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted" title={v.description}>
          {v.description}
        </p>
      ) : null}
    </li>
  )
}

export default Scans
