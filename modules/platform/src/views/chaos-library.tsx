import { useMemo, useState } from 'react'
import { Badge, Button, EmptyState, SearchInput } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { CHAOS_FAULTS, type ChaosFault, FAMILY_LABEL, type FaultFamily } from '../data/chaos-kinds.ts'
import { CATEGORY_BLURB, CATEGORY_LABEL, formatSeconds, type ScenarioCategory, SCENARIOS } from '../data/chaos-scenarios.ts'
import { BLAST_TONE } from './chaos-launch.tsx'

/**
 * The library: every fault the console knows how to run and every game-day
 * scenario, with what each does to a running system, how much of an outage
 * it resembles, and — for scenarios — the hypothesis it tests and why it is
 * worth rehearsing. "Run" starts the guided launcher with it picked.
 */

const BLAST_TEXT: Record<ChaosFault['blast'], string> = {
  low: 'Low — one pod or a slower path; real clusters survive this daily.',
  medium: 'Medium — degrades a service; callers notice if it is not handled.',
  high: 'High — resembles a real outage; confirmation required.',
}

const SIMULATES: Partial<Record<FaultFamily, string>> = {
  pod: 'Deploys, evictions and crashes',
  stress: 'Noisy neighbours and runaway work',
  network: 'Slow, lossy or partitioned networks',
  http: 'A misbehaving dependency',
  dns: 'Resolver outages and bad records',
  io: 'Slow or full disks',
  node: 'Upgrades, drains and lost machines',
}

export function ChaosLibrary({ installed, faultsLoading, faultsError, onRetryFaults, canLaunch, canGameDay, gameDaysMissing, onRunFault, onGameDay }: {
  installed: ChaosFault[]
  /** The cluster's fault definitions are still being read: say nothing about what is installed yet. */
  faultsLoading?: boolean
  /** They could not be read: every fault would otherwise read as "Not installed here". */
  faultsError?: Error
  onRetryFaults?(): void
  canLaunch: boolean
  canGameDay: boolean
  /** Argo Workflows is not installed, so no scenario can be run as a game day here. */
  gameDaysMissing?: boolean
  onRunFault(id: string): void
  onGameDay(scenarios: string[]): void
}) {
  const [view, setView] = useState<'faults' | 'scenarios'>('faults')
  const [q, setQ] = useState('')
  const [family, setFamily] = useState<FaultFamily | 'all'>('all')
  const [blast, setBlast] = useState<ChaosFault['blast'] | 'all'>('all')
  const ids = useMemo(() => new Set(installed.map((f) => f.id)), [installed])
  const needle = q.trim().toLowerCase()
  const faults = CHAOS_FAULTS.filter((f) => (family === 'all' || f.family === family) && (blast === 'all' || f.blast === blast) && (!needle || `${f.id} ${f.label} ${f.blurb}`.toLowerCase().includes(needle)))
  const scenarios = SCENARIOS.filter((s) => (blast === 'all' || s.blast === blast) && (!needle || `${s.id} ${s.title} ${s.hypothesis} ${s.rationale} ${s.fault}`.toLowerCase().includes(needle)))
  const categories = [...new Set(scenarios.map((s) => s.category))] as ScenarioCategory[]

  const known = !faultsLoading && !faultsError
  const chip = (on: boolean) => cn('min-h-8 rounded-full px-3 text-[11px] font-medium transition-colors sm:min-h-7', on ? 'bg-brand-600 text-white' : 'bg-surface-sunken text-content-muted hover:text-content')

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-surface-sunken p-0.5" role="tablist" aria-label="Library">
          {(['faults', 'scenarios'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('min-h-8 rounded-md px-3 text-[12px] font-medium', view === v ? 'bg-surface-raised text-content shadow-xs' : 'text-content-muted hover:text-content')}>
              {v === 'faults' ? `Faults (${CHAOS_FAULTS.length})` : `Game-day scenarios (${SCENARIOS.length})`}
            </button>
          ))}
        </div>
        <div className="w-full sm:ml-auto sm:w-64"><SearchInput value={q} onChange={setQ} placeholder="Search the library…" /></div>
      </div>
      <div className="flex flex-wrap gap-1">
        {view === 'faults' ? (
          <>
            {(['all', ...Object.keys(FAMILY_LABEL)] as Array<FaultFamily | 'all'>).map((f) => (
              <button key={f} type="button" aria-pressed={family === f} className={chip(family === f)} onClick={() => setFamily(f)}>{f === 'all' ? 'Every family' : FAMILY_LABEL[f]}</button>
            ))}
            <span className="mx-1 w-px self-stretch bg-edge-default" />
          </>
        ) : null}
        {(['all', 'low', 'medium', 'high'] as const).map((b) => (
          <button key={b} type="button" aria-pressed={blast === b} className={chip(blast === b)} onClick={() => setBlast(b)}>{b === 'all' ? 'Any blast radius' : `${b} blast`}</button>
        ))}
      </div>

      {faultsError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="min-w-0 flex-1">The fault definitions on this cluster could not be read ({faultsError.message}), so which faults can run here is unknown.</span>
          {onRetryFaults ? <Button size="sm" onClick={onRetryFaults}>Try again</Button> : null}
        </div>
      ) : null}

      {view === 'faults' ? (
        faults.length ? (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {faults.map((f) => {
              const present = ids.has(f.id)
              return (
                <article key={f.id} className={cn('flex flex-col rounded-xl border border-edge-default bg-surface-raised p-3.5', known && !present && 'opacity-70')}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[13px] font-semibold text-content">{f.label}</h3>
                      <span className="font-mono text-[10.5px] text-content-subtle">{f.id}</span>
                    </div>
                    <Badge tone={BLAST_TONE[f.blast]}>{f.blast}</Badge>
                  </div>
                  <p className="mt-1.5 text-[12px] text-content-muted">{f.blurb}</p>
                  <dl className="mt-2 space-y-1 text-[11px]">
                    <div className="flex gap-2"><dt className="w-20 shrink-0 text-content-subtle">Simulates</dt><dd className="m-0 text-content-muted">{SIMULATES[f.family] ?? FAMILY_LABEL[f.family]}</dd></div>
                    <div className="flex gap-2"><dt className="w-20 shrink-0 text-content-subtle">Blast radius</dt><dd className="m-0 text-content-muted">{f.node ? 'Every pod on the target node. ' : ''}{BLAST_TEXT[f.blast]}</dd></div>
                    <div className="flex gap-2"><dt className="w-20 shrink-0 text-content-subtle">Knobs</dt><dd className="m-0 text-content-muted">{f.knobs.map((k) => `${k.label} ${k.value || '—'}`).join(' · ')}</dd></div>
                  </dl>
                  <div className="mt-auto flex items-center justify-between pt-3">
                    <span className={cn('text-[11px]', present ? 'text-emerald-700 dark:text-emerald-400' : 'text-content-subtle')}>
                      {faultsLoading ? 'Checking this cluster…' : faultsError ? 'Unknown on this cluster' : present ? 'Installed on this cluster' : 'Not installed here'}
                    </span>
                    {canLaunch && present ? <Button size="sm" onClick={() => onRunFault(f.id)}>Run</Button> : null}
                  </div>
                </article>
              )
            })}
          </div>
        ) : <EmptyState compact title="No fault matches" description="Clear the search or the filters to see every fault." />
      ) : scenarios.length ? (
        <div className="space-y-4">
          {gameDaysMissing ? (
            <p className="text-[12px] text-content-muted">
              Game days run as Argo Workflows, an optional package that is not installed on this cluster — these scenarios can be read here, and started once argo-workflows is enabled. Each one&apos;s fault can still be run on its own from Faults.
            </p>
          ) : null}
          {categories.map((c) => (
            <div key={c}>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
                <h3 className="text-[12.5px] font-semibold text-content">{CATEGORY_LABEL[c]}</h3>
                <span className="text-[11px] text-content-muted">{CATEGORY_BLURB[c]}</span>
              </div>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                {scenarios.filter((s) => s.category === c).map((s) => (
                  <article key={s.id} className="flex flex-col rounded-xl border border-edge-default bg-surface-raised p-3.5">
                    <div className="flex items-start gap-2">
                      <h4 className="min-w-0 flex-1 text-[13px] font-semibold text-content">{s.title}</h4>
                      <Badge tone={BLAST_TONE[s.blast]}>{s.blast}</Badge>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-content-subtle"><span className="font-mono">{s.fault}</span> · {formatSeconds(s.seconds)}{!known || ids.has(s.fault) ? '' : ' · fault not installed here'}</div>
                    <p className="mt-1.5 text-[12px] text-content"><span className="font-medium text-content-subtle">Expect:</span> {s.hypothesis}</p>
                    <p className="mt-1 text-[11.5px] text-content-muted">{s.rationale}</p>
                    {canGameDay ? (
                      <div className="mt-auto flex justify-end pt-3">
                        <Button size="sm" onClick={() => onGameDay([s.id])}>Start a game day with it</Button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : <EmptyState compact title="No scenario matches" description="Clear the search or the blast-radius filter." />}
    </section>
  )
}
