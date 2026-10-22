import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Input,
  Select,
  StatusBadge,
  usePublicUrl,
  useToast,
  type Column,
  type StatusKind,
} from '@adhar/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar/utils'
import {
  chaosReportHtml,
  type ChaosRunReport,
  commitUrl,
  headline,
  historyOf,
  matchesCommit,
  reportFileName,
  runVerdict,
  shaQuery,
  shortSha,
  TRIGGER_LABEL,
  VERDICT_LABEL,
  type RunVerdict,
} from '../data/chaos-report.ts'
import { readChaosParams, useChaosReports, writeChaosParams } from '../data/chaos-report-hooks.ts'

/**
 * Run reports — one Chaos Engineering report per resilience run, per
 * application, tagged with the commit that was under test.
 *
 * The question this tab answers is the one a promotion asks: "what did chaos
 * prove about THIS change?". So the commit is the primary filter — paste a
 * full or short SHA and the list narrows to the runs of that build, in every
 * environment it reached — and Deliver's Kargo views link here with it set.
 *
 * The console's server records every run as it lands (the runner itself only
 * keeps the latest per application), so the history does not depend on anyone
 * having had this page open.
 */

const VERDICT_KIND: Record<RunVerdict, StatusKind> = { survived: 'healthy', failed: 'failed', inconclusive: 'degraded' }

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoke after the click has been handled, or some browsers cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** The report's link back into the console, and its public commit link. */
function useReportMeta() {
  const publicUrl = usePublicUrl()
  return useCallback((r: ChaosRunReport) => {
    const raw = commitUrl(r.repoUrl, r.commit)
    const origin = typeof location === 'undefined' ? '' : location.origin
    return {
      generatedAt: new Date().toISOString(),
      consoleUrl: `${origin}/deliver?section=chaos&tab=reports&report=${encodeURIComponent(r.id)}`,
      ...(raw ? { commitHref: publicUrl(raw, 'gitea') } : {}),
    }
  }, [publicUrl])
}

function useDownloads(all: ChaosRunReport[]) {
  const toast = useToast()
  const metaOf = useReportMeta()
  const [busy, setBusy] = useState<string | null>(null)
  const pdf = async (r: ChaosRunReport) => {
    setBusy(r.id)
    try {
      // Own chunk: the PDF writer costs nothing until someone downloads one.
      const { chaosReportPdf } = await import('../data/chaos-report-pdf.ts')
      const bytes = chaosReportPdf(r, historyOf(all, r), metaOf(r))
      download(reportFileName(r, 'pdf'), new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      toast.success(`Downloaded ${reportFileName(r, 'pdf')}`)
    } catch (e) {
      toast.error(`The PDF could not be built: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const html = (r: ChaosRunReport) => {
    download(reportFileName(r, 'html'), new Blob([chaosReportHtml(r, historyOf(all, r), metaOf(r))], { type: 'text/html;charset=utf-8' }))
    toast.success(`Downloaded ${reportFileName(r, 'html')}`)
  }
  return { pdf, html, busy }
}

export function ChaosReports({ namespace, onRunSuites }: { namespace?: string; onRunSuites(): void }) {
  const q = useChaosReports()
  const publicUrl = usePublicUrl()
  const initial = useMemo(() => readChaosParams(), [])
  const [commit, setCommit] = useState(initial.commit ?? '')
  const [app, setApp] = useState(initial.app ?? '')
  const [openId, setOpenId] = useState<string | null>(initial.report ?? null)

  useEffect(() => writeChaosParams({ commit: commit.trim() || undefined, app: app || undefined, report: openId ?? undefined }), [commit, app, openId])

  const all = useMemo(() => q.data?.items ?? [], [q.data])
  const scoped = useMemo(() => all.filter((r) => !namespace || r.namespace === namespace), [all, namespace])
  const apps = useMemo(() => [...new Set(scoped.map((r) => r.app))].sort(), [scoped])
  const sha = shaQuery(commit)
  const shaInvalid = commit.trim() !== '' && !sha
  const rows = scoped.filter((r) => (!app || r.app === app) && (!sha || matchesCommit(r, sha)))
  const open = openId ? all.find((r) => r.id === openId) : undefined
  const downloads = useDownloads(all)

  const columns: Column<ChaosRunReport>[] = [
    {
      key: 'app',
      header: 'Application',
      pinned: true,
      value: (r) => r.app,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{r.app}</div>
          <div className="truncate text-[11px] text-content-subtle">{r.environment} · {r.namespace}</div>
        </div>
      ),
    },
    {
      key: 'commit',
      header: 'Commit',
      value: (r) => r.commit ?? '',
      cell: (r) => {
        if (!r.commit) return <span className="text-[12px] text-content-subtle" title={r.commitNote}>unknown</span>
        const href = commitUrl(r.repoUrl, r.commit)
        const label = <code className="font-mono text-[12px]">{shortSha(r.commit)}</code>
        return href ? (
          <a href={publicUrl(href, 'gitea')} target="_blank" rel="noreferrer" title={r.commit} className="text-brand-700 hover:underline dark:text-brand-300">
            {label}
          </a>
        ) : (
          <span title={r.commit} className="text-content">{label}</span>
        )
      },
    },
    {
      key: 'verdict',
      header: 'Verdict',
      value: (r) => VERDICT_LABEL[runVerdict(r)],
      cell: (r) => {
        const v = runVerdict(r)
        const judged = r.experiments.filter((e) => e.status === 'passed' || e.status === 'failed')
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge kind={VERDICT_KIND[v]}>{VERDICT_LABEL[v]}</StatusBadge>
            <span className="text-[11px] tabular-nums text-content-subtle">
              {judged.filter((e) => e.status === 'passed').length}/{judged.length} faults
            </span>
          </div>
        )
      },
    },
    {
      key: 'trigger',
      header: 'Triggered by',
      value: (r) => r.trigger,
      cell: (r) => (
        <span className="text-[12px] text-content-muted" title={r.runId}>
          {TRIGGER_LABEL[r.trigger]}{r.triggeredByUser ? ` — ${r.triggeredByUser}` : ''}
        </span>
      ),
    },
    {
      key: 'finished',
      header: 'Run',
      value: (r) => r.finishedAt,
      cell: (r) => (
        <span title={formatAbsolute(r.finishedAt)} className="text-[12px] text-content-muted">{formatRelative(r.finishedAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="xs" onClick={() => setOpenId(r.id)}>View</Button>
          <Button variant="ghost" size="xs" disabled={downloads.busy === r.id} onClick={() => void downloads.pdf(r)}>PDF</Button>
        </div>
      ),
    },
  ]

  const empty = q.data && !q.data.configured ? (
    <EmptyState
      title="Run reports are not being kept"
      description={q.data.detail ?? 'The console database is not configured, so chaos runs cannot be recorded. Configure the console database and every run from then on gets a report.'}
    />
  ) : sha ? (
    <EmptyState
      title={`No chaos report for commit ${sha.slice(0, 12)}`}
      description="No recorded resilience run tested an image built from this commit. Runs happen when the build is promoted into an environment with a suite, hourly in test, or when you run a suite by hand."
      action={<Button variant="primary" onClick={onRunSuites}>Go to application suites</Button>}
    />
  ) : (
    <EmptyState
      title="No chaos runs recorded yet"
      description="A report is recorded every time the resilience runner tests an application — hourly, on promotion, or when you run a suite from Application suites."
      action={<Button variant="primary" onClick={onRunSuites}>Run a suite</Button>}
    />
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-content">Run reports</div>
            <div className="text-[12px] text-content-muted">
              One Chaos Engineering report per resilience run, tagged with the commit of the image that was tested.
              Paste a commit to see what chaos proved about that change.
            </div>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <div className="w-full sm:w-72">
              <Input
                value={commit}
                onChange={(e) => setCommit(e.target.value)}
                placeholder="Commit SHA (full or short)"
                aria-label="Filter by commit SHA"
                aria-invalid={shaInvalid || undefined}
              />
              {shaInvalid ? <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">A commit is 4–40 hexadecimal characters.</div> : null}
            </div>
            <div className="w-full sm:w-44">
              <Select
                value={app}
                onChange={(e) => setApp(e.target.value)}
                aria-label="Filter by application"
                options={[{ value: '', label: 'All applications' }, ...apps.map((a) => ({ value: a, label: a }))]}
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardBody className="p-0">
        {q.error ? (
          <div className="px-4 py-3 text-[12px] text-rose-600 dark:text-rose-400">Reports could not be read: {(q.error as Error).message}.</div>
        ) : null}
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          tableId="chaos-reports"
          features={{ search: true, columns: true, density: true }}
          defaultSort={{ key: 'finished', dir: 'desc' }}
          searchPlaceholder="Search reports…"
          empty={empty}
        />
      </CardBody>
      {open ? <ReportDrawer report={open} all={all} downloads={downloads} onClose={() => setOpenId(null)} /> : null}
    </Card>
  )
}

/* ─────────────────────────── drawer ─────────────────────────── */

function ReportDrawer({
  report: r,
  all,
  downloads,
  onClose,
}: {
  report: ChaosRunReport
  all: ChaosRunReport[]
  downloads: ReturnType<typeof useDownloads>
  onClose(): void
}) {
  const metaOf = useReportMeta()
  const html = useMemo(() => chaosReportHtml(r, historyOf(all, r), metaOf(r)), [r, all, metaOf])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`Chaos report for ${r.app}`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-4xl flex-col overflow-hidden border-l border-edge-default bg-surface-canvas shadow-2xl">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              Chaos report · {r.environment}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
              {r.app} {r.commit ? <code className="font-mono text-[14px] text-content-muted">@ {shortSha(r.commit)}</code> : null}
            </h2>
            <div className="mt-1 text-[12px] text-content-muted">{headline(r)}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => downloads.html(r)}>Download HTML</Button>
            <Button variant="primary" size="sm" disabled={downloads.busy === r.id} onClick={() => void downloads.pdf(r)}>
              Download PDF
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">Close</Button>
          </div>
        </header>
        {/* The report is a standalone document with its own styles; an iframe
            keeps them from leaking into the console and vice versa. */}
        <iframe title={`Chaos report for ${r.app}`} srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" className="min-h-0 w-full flex-1 bg-white" />
      </aside>
    </div>,
    document.body,
  )
}
