import { useMemo } from 'react'
import { BarChart, Button } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { SecurityModel } from '../../data/security-model.ts'
import { isExpiringSoon, latestCiScans, SEVERITIES, type Severity, waiverCovers, weekOf } from '../../data/security-findings.ts'
import { useGates } from '../../data/security-api.ts'
import { useRegistryArtifacts } from '../../data/delivery.ts'
import { readArtifact } from '../../data/scan-rollup.ts'
import { useSetSecurityParams } from '../../data/security-nav.ts'
import { fmtDate, GateChip, Loading, ReportStateNotice, Section, SEV_TONE, SevChip, TableWrap, TD, Tile, TH } from './shared.tsx'

const WEEKS = 8

/**
 * Security overview: open findings in what runs (trivy-operator), what is
 * waived and until when, the latest CI scan per app, and a trend built from
 * the images pushed to Harbor — each figure from its own source, labelled.
 */
export function SecurityOverview({ model }: { model: SecurityModel }) {
  const { findings, statuses, totals, reports, waiverItems } = model
  const setParams = useSetSecurityParams()
  const gates = useGates()
  const registry = useRegistryArtifacts()
  const now = Date.now()

  const ci = useMemo(() => latestCiScans(gates.data?.items ?? []), [gates.data])
  const awaiting = (gates.data?.items ?? []).filter((g) => g.state === 'awaiting').length
  const pending = waiverItems.filter((w) => w.status === 'requested').length
  const expiring = waiverItems.filter((w) => isExpiringSoon(w, now)).length
  const active = waiverItems.filter((w) => w.status === 'approved' && Date.parse(w.expiresAt) > now).length

  // Trend: critical + high findings in the images pushed each week (Harbor's scans).
  const trend = useMemo(() => {
    const items = (registry.data?.items ?? []).map((i) => readArtifact(i.repo, i.artifact)).filter((a) => a.scanned && a.pushedAt)
    if (!items.length) return []
    const buckets = new Map<string, number>()
    const start = Date.now() - WEEKS * 7 * 86_400_000
    for (let i = WEEKS - 1; i >= 0; i--) buckets.set(weekOf(new Date(Date.now() - i * 7 * 86_400_000).toISOString()), 0)
    for (const a of items) {
      if (Date.parse(a.pushedAt!) < start) continue
      const w = weekOf(a.pushedAt!)
      if (buckets.has(w)) buckets.set(w, buckets.get(w)! + a.counts.critical + a.counts.high)
    }
    return [...buckets.entries()].map(([w, v]) => ({ label: w.slice(5), value: v }))
  }, [registry.data])

  const byPlace = useMemo(() => {
    const m = new Map<string, Record<Severity, number>>()
    const t = Date.now()
    for (const f of findings) {
      const active = statuses.get(f.key)?.active ?? []
      // Per occurrence: a waiver for one project must not hide the finding in another.
      const open = f.occurrences.filter((o) => !active.some((w) => waiverCovers(w, f, o, t)))
      for (const place of new Set(open.map((o) => `${o.project ?? o.namespace}${o.env ? ` / ${o.env}` : ''}`))) {
        const row = m.get(place) ?? { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
        row[f.severity]++
        m.set(place, row)
      }
    }
    return [...m.entries()].sort((a, b) => b[1].critical - a[1].critical || b[1].high - a[1].high || a[0].localeCompare(b[0])).slice(0, 12)
  }, [findings, statuses])

  const top = findings.filter((f) => statuses.get(f.key)?.coverage !== 'waived').slice(0, 8)
  const state = reports.data?.state
  // Runtime figures only exist when trivy-operator's reports were read; a
  // missing or unreadable source is "—", never a zero.
  const rt = (n: number): number | string => reports.isLoading ? '…' : reports.isError || (state && state !== 'ok') ? '—' : n

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label="Open critical" value={rt(totals.open.critical)} tone={totals.open.critical ? SEV_TONE.critical.text : undefined} hint="in running workloads" onClick={() => setParams({ tab: 'findings' })} />
        <Tile label="Open high" value={rt(totals.open.high)} tone={totals.open.high ? SEV_TONE.high.text : undefined} hint={`${totals.fixable} fixable overall`} onClick={() => setParams({ tab: 'findings' })} />
        <Tile label="Waived" value={totals.waived + totals.partial} hint={`${active} active waiver${active === 1 ? '' : 's'}`} onClick={() => setParams({ tab: 'waivers' })} />
        <Tile label="Expiring ≤ 7 days" value={expiring} tone={expiring ? 'text-amber-600 dark:text-amber-300' : undefined} hint="waivers" onClick={() => setParams({ tab: 'waivers' })} />
        <Tile label="Awaiting review" value={pending + awaiting} tone={pending + awaiting ? 'text-indigo-600 dark:text-indigo-300' : undefined} hint={`${pending} waiver · ${awaiting} gate`} onClick={() => setParams({ tab: 'review' })} />
        <Tile label="Workloads scanned" value={rt(totals.workloads)} hint={`${totals.images} image${totals.images === 1 ? '' : 's'}`} />
      </div>

      {reports.isLoading ? <Loading text="Reading trivy-operator reports…" /> : state && state !== 'ok' ? <ReportStateNotice state={state} detail={reports.data?.detail} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Top open findings" aside={top.length ? <Button size="xs" variant="ghost" onClick={() => setParams({ tab: 'findings' })}>All findings</Button> : undefined}>
          {top.length ? (
            <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
              {top.map((f) => (
                <li key={f.key}>
                  <button type="button" onClick={() => setParams({ tab: 'findings', finding: f.key }, { push: true })} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-sunken/50">
                    <SevChip severity={f.severity} />
                    <span className="font-mono text-[12px] font-medium text-content">{f.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-content-muted">{f.pkg}</span>
                    <span className="shrink-0 text-[11px] text-content-subtle">{f.occurrences.length}×{f.fixable ? ' · fixable' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-edge-default px-3 py-6 text-center text-[12px] text-content-subtle">
              {state === 'ok' ? 'No open findings in running workloads.' : 'No runtime findings to rank.'}
            </p>
          )}
        </Section>

        <Section title="Critical + high in images pushed per week" aside={<span className="text-[11px] text-content-subtle">Harbor scans</span>}>
          <div className="rounded-xl border border-edge-default bg-surface-raised p-4">
            {registry.isLoading ? (
              <p className="text-[12px] text-content-subtle">Reading the registry…</p>
            ) : registry.isError ? (
              <p className="text-[12px] text-content-subtle">Harbor could not be read, so there is no push history to chart.</p>
            ) : trend.length ? (
              <BarChart bars={trend} height={120} color="#f43f5e" />
            ) : (
              <p className="text-[12px] text-content-subtle">No scanned image pushes in the last {WEEKS} weeks.</p>
            )}
          </div>
        </Section>
      </div>

      {byPlace.length ? (
        <Section title="Open findings by project and environment">
          <TableWrap>
            <thead>
              <tr className="border-b border-edge-subtle">
                <th className={TH}>Project / environment</th>
                {SEVERITIES.slice(0, 4).map((s) => <th key={s} className={cn(TH, 'text-right')}>{s}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {byPlace.map(([place, c]) => (
                <tr key={place} className="cursor-pointer hover:bg-surface-sunken/50" onClick={() => setParams({ tab: 'findings', project: place.split(' / ')[0] })}>
                  <td className={TD}>{place}</td>
                  {SEVERITIES.slice(0, 4).map((s) => <td key={s} className={cn(TD, 'text-right tabular-nums', c[s] ? SEV_TONE[s].text : 'text-content-subtle')}>{c[s]}</td>)}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Section>
      ) : null}

      <Section title="Latest CI scan per app" aside={<span className="text-[11px] text-content-subtle">PipelineRun results</span>}>
        {gates.isLoading ? (
          <p className="text-[12px] text-content-subtle">Reading pipeline runs…</p>
        ) : gates.data?.state === 'absent' ? (
          <p className="text-[12px] text-content-subtle">Tekton is not installed, so there are no CI scans.</p>
        ) : gates.data?.state === 'forbidden' ? (
          <p className="text-[12px] text-content-subtle">Your account may not list PipelineRuns.</p>
        ) : gates.isError || gates.data?.state === 'error' ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-300">
            Couldn't read Tekton PipelineRuns{gates.error instanceof Error ? ` — ${gates.error.message}` : gates.data?.detail ? ` — ${gates.data.detail}` : ''}.{' '}
            <Button size="xs" variant="ghost" onClick={() => gates.refetch()}>Retry</Button>
          </p>
        ) : !ci.length ? (
          <p className="rounded-xl border border-dashed border-edge-default px-3 py-6 text-center text-[12px] text-content-subtle">
            No pipeline run has published scan results yet. Once the platform's CI publishes its scan summary, the latest one per app appears here.
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr className="border-b border-edge-subtle">
                <th className={TH}>App</th>
                <th className={TH}>Run</th>
                <th className={cn(TH, 'text-right')}>Critical</th>
                <th className={cn(TH, 'text-right')}>High</th>
                <th className={cn(TH, 'text-right')}>Fixable</th>
                <th className={TH}>Gate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {ci.slice(0, 20).map((g) => (
                <tr key={`${g.namespace}/${g.name}`}>
                  <td className={TD}>{g.app ?? g.pipeline ?? '—'}<div className="text-[11px] text-content-subtle">{g.namespace}</div></td>
                  <td className={TD}><span className="font-mono text-[11px]">{g.name}</span><div className="text-[11px] text-content-subtle">{g.createdAt ? formatRelative(g.createdAt) : ''}</div></td>
                  <td className={cn(TD, 'text-right tabular-nums', g.summary?.critical ? SEV_TONE.critical.text : '')}>{g.summary?.critical ?? '—'}</td>
                  <td className={cn(TD, 'text-right tabular-nums', g.summary?.high ? SEV_TONE.high.text : '')}>{g.summary?.high ?? '—'}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{g.summary?.fixable ?? '—'}</td>
                  <td className={TD}>
                    <GateChip state={g.state} />
                    {g.decision?.by ? <div className="mt-0.5 text-[10px] text-content-subtle">by {g.decision.by} · {fmtDate(g.decision.at)}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Section>
    </div>
  )
}
