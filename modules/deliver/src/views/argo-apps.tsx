import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Spinner,
  StatusBadge,
  useToast,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import type { argocd } from '@adhar-console/api-clients'
import {
  useAppHistory,
  useApplications,
  useAppResources,
  useDeleteApplication,
  useRefreshApplication,
  useRollbackApplication,
  useSyncApplication,
  useTerminateOperation,
  type ResourceNode,
  type RevisionHistoryEntry,
  type SyncOptions,
} from '../data/delivery.ts'

const HEALTH_KIND: Record<string, StatusKind> = {
  Healthy: 'healthy',
  Degraded: 'degraded',
  Progressing: 'progressing',
  Suspended: 'paused',
  Missing: 'unknown',
  Unknown: 'unknown',
}
const SYNC_KIND: Record<string, StatusKind> = {
  Synced: 'healthy',
  OutOfSync: 'degraded',
  Unknown: 'unknown',
}

/**
 * Card palette. Sync and health are independent signals, so the card never
 * folds them into one colour: `warn` (amber) always means drift, `bad` (rose)
 * always means broken, `busy` (indigo) always means an operation in flight.
 */
type CardTone = 'ok' | 'warn' | 'bad' | 'busy' | 'idle'

/** Chip fill per tone — same palette as StatusBadge so cards and drawer agree. */
const TONE_CHIP: Record<CardTone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
  bad: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25',
  busy: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/25',
  idle: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/25',
}
/** Solid fill per tone — the accent rail and the resource-meter segments. */
const TONE_FILL: Record<CardTone, string> = {
  ok: 'bg-emerald-500 dark:bg-emerald-400',
  warn: 'bg-amber-500 dark:bg-amber-400',
  bad: 'bg-rose-500 dark:bg-rose-400',
  busy: 'bg-indigo-500 dark:bg-indigo-400',
  idle: 'bg-slate-300 dark:bg-slate-600',
}
const HEALTH_TONE: Record<string, CardTone> = {
  Healthy: 'ok',
  Progressing: 'busy',
  Degraded: 'bad',
  Missing: 'bad',
  Suspended: 'warn',
  Unknown: 'idle',
}
const SYNC_TONE: Record<string, CardTone> = { Synced: 'ok', OutOfSync: 'warn', Unknown: 'idle' }

type SyncFilter = 'all' | 'Synced' | 'OutOfSync' | 'Unknown'
type HealthFilter = 'all' | 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown'
type PolicyFilter = 'all' | 'auto' | 'manual'
type SortKey = 'attention' | 'name' | 'namespace' | 'reconciled'
type Layout = 'grid' | 'list'

interface Prefs {
  layout: Layout
  sort: SortKey
}
const PREFS_KEY = 'adhar.deliver.apps.prefs.v1'
function loadPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY)
    return raw ? { layout: 'grid', sort: 'attention', ...(JSON.parse(raw) as Partial<Prefs>) } : { layout: 'grid', sort: 'attention' }
  } catch {
    return { layout: 'grid', sort: 'attention' }
  }
}

/** Apps needing a human first: failed ops, degraded, drifting, progressing, then the rest. */
function attentionRank(a: argocd.Application): number {
  const op = a.status.operationState?.phase
  if (op === 'Failed' || op === 'Error') return 0
  if (a.status.health.status === 'Degraded' || a.status.health.status === 'Missing') return 1
  if (a.status.sync.status === 'OutOfSync') return 2
  if (op === 'Running') return 3
  if (a.status.health.status === 'Progressing') return 4
  if (a.status.health.status === 'Suspended') return 5
  return 6
}

/**
 * ArgoCD applications — the GitOps fleet at a glance.
 *
 * Stats strip (sync × health × policy counts that double as filters), search
 * with sync / health / auto-sync / project / namespace filters and sort, a
 * grid or list layout, bulk sync of the selected apps, and per-app actions:
 * sync (with options in the drawer), refresh / hard refresh, terminate a
 * running operation, and delete. Everything reads and writes ArgoCD through
 * the console's BFF proxy — no fabricated state.
 */
export function ArgoApps() {
  const q = useApplications()
  const sync = useSyncApplication()
  const refresh = useRefreshApplication()
  const terminate = useTerminateOperation()
  const toast = useToast()
  const [openName, setOpenName] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [syncF, setSyncF] = useState<SyncFilter>('all')
  const [healthF, setHealthF] = useState<HealthFilter>('all')
  const [policyF, setPolicyF] = useState<PolicyFilter>('all')
  const [projectF, setProjectF] = useState('all')
  const [namespaceF, setNamespaceF] = useState('all')
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch }
      try {
        globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })

  const all = useMemo(() => q.data ?? [], [q.data])
  const projects = useMemo(() => [...new Set(all.map((a) => a.spec.project))].sort(), [all])
  const namespaces = useMemo(() => [...new Set(all.map((a) => a.spec.destination.namespace).filter(Boolean))].sort(), [all])

  const stats = useMemo(() => {
    const s = { synced: 0, outOfSync: 0, healthy: 0, degraded: 0, progressing: 0, suspended: 0, auto: 0, running: 0, failed: 0 }
    for (const a of all) {
      if (a.status.sync.status === 'Synced') s.synced++
      if (a.status.sync.status === 'OutOfSync') s.outOfSync++
      if (a.status.health.status === 'Healthy') s.healthy++
      if (a.status.health.status === 'Degraded' || a.status.health.status === 'Missing') s.degraded++
      if (a.status.health.status === 'Progressing') s.progressing++
      if (a.status.health.status === 'Suspended') s.suspended++
      if (a.spec.syncPolicy.automated) s.auto++
      const op = a.status.operationState?.phase
      if (op === 'Running') s.running++
      if (op === 'Failed' || op === 'Error') s.failed++
    }
    return s
  }, [all])

  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    let out = all.filter((a) => {
      if (syncF !== 'all' && a.status.sync.status !== syncF) return false
      if (healthF !== 'all') {
        const h = a.status.health.status
        if (healthF === 'Degraded' ? !(h === 'Degraded' || h === 'Missing') : h !== healthF) return false
      }
      if (policyF === 'auto' && !a.spec.syncPolicy.automated) return false
      if (policyF === 'manual' && a.spec.syncPolicy.automated) return false
      if (projectF !== 'all' && a.spec.project !== projectF) return false
      if (namespaceF !== 'all' && a.spec.destination.namespace !== namespaceF) return false
      if (!f) return true
      return (
        a.metadata.name.toLowerCase().includes(f) ||
        a.spec.destination.namespace.toLowerCase().includes(f) ||
        a.spec.project.toLowerCase().includes(f) ||
        a.spec.source.repoURL.toLowerCase().includes(f) ||
        (a.spec.source.path ?? '').toLowerCase().includes(f) ||
        a.status.images.some((i) => i.toLowerCase().includes(f)) ||
        Object.entries(a.metadata.labels).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(f))
      )
    })
    out = [...out].sort((x, y) => {
      if (prefs.sort === 'attention') {
        const d = attentionRank(x) - attentionRank(y)
        if (d !== 0) return d
      }
      if (prefs.sort === 'namespace') {
        const d = x.spec.destination.namespace.localeCompare(y.spec.destination.namespace)
        if (d !== 0) return d
      }
      if (prefs.sort === 'reconciled') {
        return (y.status.reconciledAt ?? '').localeCompare(x.status.reconciledAt ?? '')
      }
      return x.metadata.name.localeCompare(y.metadata.name)
    })
    return out
  }, [all, search, syncF, healthF, policyF, projectF, namespaceF, prefs.sort])

  const open = all.find((a) => a.metadata.name === openName) ?? null
  const refining = syncF !== 'all' || healthF !== 'all' || policyF !== 'all' || projectF !== 'all' || namespaceF !== 'all' || !!search.trim()
  const clearFilters = () => {
    setSyncF('all')
    setHealthF('all')
    setPolicyF('all')
    setProjectF('all')
    setNamespaceF('all')
    setSearch('')
  }

  const toggleSelected = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const selectedVisible = list.filter((a) => selected.has(a.metadata.name))
  const bulkSync = async () => {
    const names = selectedVisible.map((a) => a.metadata.name)
    let ok = 0
    for (const name of names) {
      try {
        await sync.mutateAsync({ name })
        ok++
      } catch {
        /* surfaced below */
      }
    }
    if (ok === names.length) toast.success(`Sync requested for ${ok} application${ok === 1 ? '' : 's'}.`)
    else toast.warning(`Sync requested for ${ok} of ${names.length}; the rest failed.`)
    setSelected(new Set())
  }

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      toast.success(label)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : label + ' failed')
    }
  }

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading applications…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach ArgoCD"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* ── stats strip — every tile is also a filter ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <StatTile label="Applications" value={all.length} active={!refining} onClick={clearFilters} />
        <StatTile label="Synced" value={stats.synced} tone="healthy" active={syncF === 'Synced'} onClick={() => setSyncF(syncF === 'Synced' ? 'all' : 'Synced')} />
        <StatTile label="Out of sync" value={stats.outOfSync} tone={stats.outOfSync ? 'degraded' : undefined} active={syncF === 'OutOfSync'} onClick={() => setSyncF(syncF === 'OutOfSync' ? 'all' : 'OutOfSync')} />
        <StatTile label="Healthy" value={stats.healthy} tone="healthy" active={healthF === 'Healthy'} onClick={() => setHealthF(healthF === 'Healthy' ? 'all' : 'Healthy')} />
        <StatTile label="Degraded" value={stats.degraded} tone={stats.degraded ? 'failed' : undefined} active={healthF === 'Degraded'} onClick={() => setHealthF(healthF === 'Degraded' ? 'all' : 'Degraded')} />
        <StatTile label="Progressing" value={stats.progressing} tone={stats.progressing ? 'progressing' : undefined} active={healthF === 'Progressing'} onClick={() => setHealthF(healthF === 'Progressing' ? 'all' : 'Progressing')} />
        <StatTile label="Auto-sync" value={`${stats.auto}/${all.length}`} active={policyF === 'auto'} onClick={() => setPolicyF(policyF === 'auto' ? 'all' : 'auto')} hint={`${all.length - stats.auto} manual`} />
        <StatTile label="Operations" value={stats.running} hint={stats.failed ? `${stats.failed} failed` : 'running now'} tone={stats.failed ? 'failed' : stats.running ? 'progressing' : undefined} />
      </div>

      {/* ── search · filters · sort · layout ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm">
        <div className="min-w-56 flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, namespace, repo, path, image, label…" />
        </div>
        <Select value={syncF} onChange={(v) => setSyncF(v as SyncFilter)} title="Sync status" options={[['all', 'Sync: all'], ['Synced', 'Synced'], ['OutOfSync', 'Out of sync'], ['Unknown', 'Unknown']]} />
        <Select value={healthF} onChange={(v) => setHealthF(v as HealthFilter)} title="Health" options={[['all', 'Health: all'], ['Healthy', 'Healthy'], ['Progressing', 'Progressing'], ['Degraded', 'Degraded / missing'], ['Suspended', 'Suspended'], ['Unknown', 'Unknown']]} />
        <Select value={policyF} onChange={(v) => setPolicyF(v as PolicyFilter)} title="Sync policy" options={[['all', 'Policy: all'], ['auto', 'Auto-sync'], ['manual', 'Manual']]} />
        {projects.length > 1 ? (
          <Select value={projectF} onChange={setProjectF} title="Project" options={[['all', 'Project: all'], ...projects.map((p): [string, string] => [p, p])]} />
        ) : null}
        {namespaces.length > 1 ? (
          <Select value={namespaceF} onChange={setNamespaceF} title="Namespace" options={[['all', 'Namespace: all'], ...namespaces.map((n): [string, string] => [n, n])]} />
        ) : null}
        <Select value={prefs.sort} onChange={(v) => setPrefs({ sort: v as SortKey })} title="Sort" options={[['attention', 'Needs attention first'], ['name', 'Name'], ['namespace', 'Namespace'], ['reconciled', 'Recently reconciled']]} />
        <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5">
          <LayoutBtn on={prefs.layout === 'grid'} onClick={() => setPrefs({ layout: 'grid' })} title="Cards"><IconGrid /></LayoutBtn>
          <LayoutBtn on={prefs.layout === 'list'} onClick={() => setPrefs({ layout: 'list' })} title="List"><IconList /></LayoutBtn>
        </div>
        {refining ? (
          <button type="button" onClick={clearFilters} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
            Clear
          </button>
        ) : null}
      </div>

      {/* ── bulk bar ── */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-[12px] dark:border-brand-500/30 dark:bg-brand-500/10">
          <span className="font-medium text-content">{selected.size} selected</span>
          <Button size="sm" onClick={bulkSync} loading={sync.isPending} leading={<IconSync />}>
            Sync selected
          </Button>
          <button type="button" onClick={() => setSelected(new Set(list.map((a) => a.metadata.name)))} className="text-[11px] text-content-muted hover:text-content">select all visible</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-[11px] text-content-muted hover:text-content">clear</button>
        </div>
      ) : null}

      <div className="text-[11px] text-content-subtle">
        {list.length === all.length ? `${all.length} application${all.length === 1 ? '' : 's'}` : `${list.length} of ${all.length} applications`}
      </div>

      {list.length === 0 ? (
        <EmptyState title={all.length === 0 ? 'No applications' : 'No matches'} description={all.length === 0 ? 'ArgoCD has no Applications in this project yet.' : 'Relax the filters or the search.'} />
      ) : prefs.layout === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((a) => (
            <AppCard
              key={a.metadata.name}
              app={a}
              selected={selected.has(a.metadata.name)}
              onSelect={() => toggleSelected(a.metadata.name)}
              onOpen={() => setOpenName(a.metadata.name)}
              onSync={() => act(`Sync requested for ${a.metadata.name}.`, () => sync.mutateAsync({ name: a.metadata.name }))}
              onRefresh={(hard) => act(`${hard ? 'Hard refresh' : 'Refresh'} requested for ${a.metadata.name}.`, () => refresh.mutateAsync({ name: a.metadata.name, hard }))}
              onTerminate={() => act(`Operation on ${a.metadata.name} terminated.`, () => terminate.mutateAsync({ name: a.metadata.name }))}
              busy={(sync.isPending && sync.variables?.name === a.metadata.name) || (refresh.isPending && refresh.variables?.name === a.metadata.name)}
            />
          ))}
        </div>
      ) : (
        <AppTable
          apps={list}
          selected={selected}
          onSelect={toggleSelected}
          onOpen={setOpenName}
          onSync={(name) => act(`Sync requested for ${name}.`, () => sync.mutateAsync({ name }))}
          onRefresh={(name) => act(`Refresh requested for ${name}.`, () => refresh.mutateAsync({ name }))}
        />
      )}

      {open ? <AppDetail app={open} onClose={() => setOpenName(null)} /> : null}

      <style>
        {`
        /* The accent rail breathes while a sync is in flight, so a card that is
           actively changing is distinguishable from one that is merely broken. */
        @keyframes adhar-app-busy { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
        .adhar-app-busy { animation: adhar-app-busy 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .adhar-app-busy { animation: none !important; }
        }
      `}
      </style>
    </div>
  )
}

/* ─────────── stat tile ─────────── */

/** Status chip on the card, on the shared tone palette. */
function Chip({ tone, label, children }: { tone: CardTone; label: string; children: React.ReactNode }) {
  return (
    <span
      title={`${label}: ${typeof children === 'string' ? children : ''}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
        TONE_CHIP[tone],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_FILL[tone])} />
      {children}
    </span>
  )
}

/**
 * Proportional health of the app's managed resources.
 *
 * Argo CD reports totals, drift and unhealthy counts; the bar shows them as
 * shares of the whole so a card communicates "mostly fine, two broken" without
 * the reader doing arithmetic. Drift and unhealthy can overlap, so the healthy
 * segment is floored at zero rather than allowed to go negative.
 */
function ResourceMeter({ total, outOfSync, unhealthy }: { total: number; outOfSync: number; unhealthy: number }) {
  if (!total) return null
  const bad = Math.min(unhealthy, total)
  const drift = Math.min(Math.max(outOfSync - bad, 0), total - bad)
  const ok = Math.max(total - bad - drift, 0)
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <div className="mt-2.5">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="img"
        aria-label={`${ok} healthy, ${drift} out of sync, ${bad} unhealthy of ${total} resources`}>
        {ok ? <span className={cn('h-full', TONE_FILL.ok)} style={{ width: pct(ok) }} /> : null}
        {drift ? <span className={cn('h-full', TONE_FILL.warn)} style={{ width: pct(drift) }} /> : null}
        {bad ? <span className={cn('h-full', TONE_FILL.bad)} style={{ width: pct(bad) }} /> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[10px] text-content-subtle">
        <span className="tabular-nums">{total} resources</span>
        {drift ? <span className="text-amber-700 dark:text-amber-400">{drift} drifted</span> : null}
        {bad ? <span className="text-rose-700 dark:text-rose-400">{bad} unhealthy</span> : null}
      </div>
    </div>
  )
}

function StatTile({ label, value, hint, tone, active = false, onClick }: { label: string; value: number | string; hint?: string; tone?: StatusKind; active?: boolean; onClick?(): void }) {
  const toneText: Record<string, string> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    failed: 'text-rose-600 dark:text-rose-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
        active ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong',
        !onClick && 'cursor-default',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('text-xl font-semibold leading-none tabular-nums tracking-tight', tone ? toneText[tone] : 'text-content')}>{value}</span>
      {hint ? <span className="truncate text-[10.5px] text-content-subtle">{hint}</span> : null}
    </button>
  )
}

/* ─────────── card ─────────── */

function AppCard({
  app: a,
  selected,
  onSelect,
  onOpen,
  onSync,
  onRefresh,
  onTerminate,
  busy,
}: {
  app: argocd.Application
  selected: boolean
  onSelect(): void
  onOpen(): void
  onSync(): void
  onRefresh(hard: boolean): void
  onTerminate(): void
  busy: boolean
}) {
  const sync = a.status.sync.status
  const health = a.status.health.status
  const op = a.status.operationState
  const running = op?.phase === 'Running'
  const failedOp = op?.phase === 'Failed' || op?.phase === 'Error'
  const drift = sync === 'OutOfSync'
  const bad = health === 'Degraded' || health === 'Missing' || failedOp
  const auto = a.spec.syncPolicy.automated
  const repo = a.spec.source.repoURL.replace(/^https?:\/\//, '').replace(/\.git$/, '')
  const [menu, setMenu] = useState(false)

  return (
    <Card
      className={cn(
        'relative overflow-hidden border',
        bad ? 'border-rose-200/70 dark:border-rose-500/30' : drift ? 'border-amber-200/70 dark:border-amber-500/30' : 'border-edge-default',
        selected && 'ring-2 ring-brand-400/40',
      )}
      interactive
    >
      {/* Status rail. Runtime health picks the colour, except while an operation
          is in flight — a sync running on a degraded app is the more useful
          signal, because it says the problem is already being acted on. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          TONE_FILL[running ? 'busy' : (HEALTH_TONE[health] ?? 'idle')],
          running ? 'adhar-app-busy' : '',
        )}
      />
      <div className="flex items-start gap-3 p-4 pl-5">
        <Checkbox checked={selected} onChange={onSelect} aria-label={`Select ${a.metadata.name}`} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-content">{a.metadata.name}</span>
                {auto ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-content-muted" title={`Auto-sync${auto.prune ? ' · prune' : ''}${auto.selfHeal ? ' · self-heal' : ''}`}>
                    <IconBolt /> auto{auto.selfHeal ? ' · heal' : ''}{auto.prune ? ' · prune' : ''}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-content-subtle">manual</span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-content-subtle">
                {a.spec.destination.namespace || '—'} · {a.spec.project}
                {a.spec.destination.server && !/kubernetes\.default|in-cluster/.test(a.spec.destination.server) ? ` · ${a.spec.destination.name ?? a.spec.destination.server}` : ''}
              </div>
            </div>
            {/* Sync and health are independent — an app can be perfectly
                healthy and still have drifted from git — so they get two
                separate chips on a fixed palette rather than one blended
                colour that hides whichever problem came second. */}
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Chip tone={SYNC_TONE[sync] ?? 'idle'} label="Sync">
                {sync === 'OutOfSync' ? 'Out of sync' : sync}
              </Chip>
              <Chip tone={running ? 'busy' : (HEALTH_TONE[health] ?? 'idle')} label="Health">
                {running ? 'Syncing' : health}
              </Chip>
            </div>
          </div>

          {/* Managed-resource health, at a glance. A count of "42 res" says
              nothing about whether they are fine; the proportions do. */}
          <ResourceMeter
            total={a.status.resources.total}
            outOfSync={a.status.resources.outOfSync}
            unhealthy={a.status.resources.unhealthy}
          />

          <div className="mt-3 rounded-md border border-edge-subtle bg-surface-sunken/40 px-2.5 py-2 text-[11px]">
            <div className="truncate font-mono text-content-muted" title={a.spec.source.repoURL}>{repo || '—'}</div>
            <div className="truncate text-content-subtle">
              {a.spec.source.chart ? `chart ${a.spec.source.chart}` : a.spec.source.path ?? '—'} @ {a.spec.source.targetRevision ?? 'HEAD'}
              {a.spec.sources.length > 1 ? ` · +${a.spec.sources.length - 1} more source${a.spec.sources.length > 2 ? 's' : ''}` : ''}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-content-subtle">
            {a.status.sync.revision ? <span className="font-mono" title={a.status.sync.revision}>rev {a.status.sync.revision.slice(0, 8)}</span> : null}
            <span title="Managed resources">{a.status.resources.total} res{a.status.resources.outOfSync ? ` · ${a.status.resources.outOfSync} drift` : ''}{a.status.resources.unhealthy ? ` · ${a.status.resources.unhealthy} unhealthy` : ''}</span>
            {a.status.images.length ? <span title={a.status.images.join('\n')}>{a.status.images.length} image{a.status.images.length === 1 ? '' : 's'}</span> : null}
            {a.status.deployments ? <span>{a.status.deployments} deploy{a.status.deployments === 1 ? '' : 's'}</span> : null}
            {a.status.reconciledAt ? <span title={formatAbsolute(a.status.reconciledAt)}>reconciled {formatRelative(a.status.reconciledAt)}</span> : null}
          </div>

          {op ? (
            <div className={cn('mt-2 flex items-center gap-1.5 text-[11px]', failedOp ? 'text-rose-700 dark:text-rose-300' : running ? 'text-indigo-700 dark:text-indigo-300' : 'text-content-muted')}>
              {running ? <Spinner size={10} /> : null}
              <span className="font-medium">{op.phase}</span>
              {op.dryRun ? <span className="rounded bg-surface-sunken px-1 text-[9.5px]">dry-run</span> : null}
              {op.initiatedBy ? <span>by {op.initiatedBy}</span> : null}
              {op.finishedAt ?? op.startedAt ? <span>· {formatRelative(op.finishedAt ?? op.startedAt!)}</span> : null}
              {failedOp && op.message ? <span className="line-clamp-1" title={op.message}>— {op.message}</span> : null}
            </div>
          ) : null}
          {a.status.conditions.length ? (
            <div className="mt-1 line-clamp-1 text-[11px] text-rose-700 dark:text-rose-300" title={a.status.conditions.map((c) => `${c.type}: ${c.message ?? ''}`).join('\n')}>
              {a.status.conditions[0].type}{a.status.conditions[0].message ? `: ${a.status.conditions[0].message}` : ''}{a.status.conditions.length > 1 ? ` (+${a.status.conditions.length - 1})` : ''}
            </div>
          ) : a.status.health.message ? (
            <div className="mt-1 line-clamp-1 text-[11px] text-content-muted" title={a.status.health.message}>{a.status.health.message}</div>
          ) : null}
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-t border-edge-subtle bg-surface-raised/80 px-3 py-2">
        {running ? (
          <Button size="sm" variant="secondary" onClick={onTerminate} leading={<IconStop />}>Terminate</Button>
        ) : (
          <Button size="sm" onClick={onSync} loading={busy} disabled={sync === 'Synced' && !failedOp} leading={<IconSync />}>Sync</Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => onRefresh(false)} disabled={busy} leading={<IconRefresh />}>Refresh</Button>
        <div className="relative ml-auto">
          <button type="button" aria-label="More actions" onClick={() => setMenu((m) => !m)} className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
            <IconMore />
          </button>
          {menu ? (
            <>
              <div className="fixed inset-0 z-30" aria-hidden onClick={() => setMenu(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl">
                <MenuItem onClick={() => { setMenu(false); onRefresh(true) }}>Hard refresh</MenuItem>
                <MenuItem onClick={() => { setMenu(false); onOpen() }}>Sync with options…</MenuItem>
                <MenuItem onClick={() => { setMenu(false); onOpen() }}>Resources & history</MenuItem>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

/* ─────────── compact table layout ─────────── */

function AppTable({ apps, selected, onSelect, onOpen, onSync, onRefresh }: { apps: argocd.Application[]; selected: Set<string>; onSelect(name: string): void; onOpen(name: string): void; onSync(name: string): void; onRefresh(name: string): void }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
      <table className="w-full text-[12px]">
        <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 text-left">Application</th>
            <th className="px-3 py-2 text-left">Sync</th>
            <th className="px-3 py-2 text-left">Health</th>
            <th className="px-3 py-2 text-left">Policy</th>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2 text-left">Revision</th>
            <th className="px-3 py-2 text-left">Last operation</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {apps.map((a) => {
            const op = a.status.operationState
            return (
              <tr key={a.metadata.name} className="hover:bg-surface-sunken/40">
                <td className="px-3 py-2"><Checkbox checked={selected.has(a.metadata.name)} onChange={() => onSelect(a.metadata.name)} aria-label={`Select ${a.metadata.name}`} /></td>
                <td className="px-3 py-2">
                  <button type="button" onClick={() => onOpen(a.metadata.name)} className="text-left">
                    <div className="font-semibold text-content">{a.metadata.name}</div>
                    <div className="text-[11px] text-content-subtle">{a.spec.destination.namespace || '—'} · {a.spec.project}</div>
                  </button>
                </td>
                <td className="px-3 py-2"><StatusBadge kind={SYNC_KIND[a.status.sync.status] ?? 'unknown'}>{a.status.sync.status === 'OutOfSync' ? 'Out of sync' : a.status.sync.status}</StatusBadge></td>
                <td className="px-3 py-2"><StatusBadge kind={HEALTH_KIND[a.status.health.status] ?? 'unknown'}>{a.status.health.status}</StatusBadge></td>
                <td className="px-3 py-2 text-content-muted">{a.spec.syncPolicy.automated ? `auto${a.spec.syncPolicy.automated.selfHeal ? ' · heal' : ''}${a.spec.syncPolicy.automated.prune ? ' · prune' : ''}` : 'manual'}</td>
                <td className="max-w-64 px-3 py-2"><div className="truncate font-mono text-[11px] text-content-muted" title={a.spec.source.repoURL}>{a.spec.source.repoURL.replace(/^https?:\/\//, '')}</div><div className="truncate text-[11px] text-content-subtle">{a.spec.source.chart ?? a.spec.source.path ?? '—'} @ {a.spec.source.targetRevision ?? 'HEAD'}</div></td>
                <td className="px-3 py-2 font-mono text-[11px] text-content-subtle">{a.status.sync.revision?.slice(0, 8) ?? '—'}</td>
                <td className="px-3 py-2 text-[11px] text-content-muted">{op ? `${op.phase}${op.finishedAt ?? op.startedAt ? ` · ${formatRelative(op.finishedAt ?? op.startedAt!)}` : ''}` : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-1">
                    <Button size="sm" onClick={() => onSync(a.metadata.name)} disabled={a.status.sync.status === 'Synced'} leading={<IconSync />}>Sync</Button>
                    <Button size="sm" variant="secondary" onClick={() => onRefresh(a.metadata.name)} leading={<IconRefresh />}>Refresh</Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MenuItem({ onClick, children, danger = false }: { onClick(): void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-sunken', danger ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted hover:text-content')}>
      {children}
    </button>
  )
}

function LayoutBtn({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-pressed={on} onClick={onClick} className={cn('flex h-7 w-7 items-center justify-center rounded-md transition-colors', on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:text-content')}>
      {children}
    </button>
  )
}

function Select({ value, onChange, options, title }: { value: string; onChange(v: string): void; options: Array<[string, string]>; title: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title} aria-label={title} className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20">
      {options.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  )
}

function AppDetail({ app: a, onClose }: { app: argocd.Application; onClose(): void }) {
  const name = a.metadata.name
  const sync = useSyncApplication()
  const rollback = useRollbackApplication()
  const refresh = useRefreshApplication()
  const terminate = useTerminateOperation()
  const del = useDeleteApplication()
  const toast = useToast()
  const resources = useAppResources(name)
  const history = useAppHistory(name)
  const [opts, setOpts] = useState<SyncOptions>({ prune: false, dryRun: false, force: false })
  const [confirmDelete, setConfirmDelete] = useState<null | { cascade: boolean }>(null)
  const running = a.status.operationState?.phase === 'Running'
  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn()
      toast.success(label)
      after?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} failed`)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  const nodes = resources.data ?? []
  const outOfSync = countTree(nodes, (n) => n.syncStatus === 'OutOfSync')
  const unhealthy = countTree(nodes, (n) => n.health === 'Degraded' || n.health === 'Missing')

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                ArgoCD application · {a.spec.project}
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">
                {name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StatusBadge kind={SYNC_KIND[a.status.sync.status] ?? 'unknown'}>{a.status.sync.status === 'OutOfSync' ? 'Out of sync' : a.status.sync.status}</StatusBadge>
                <StatusBadge kind={HEALTH_KIND[a.status.health.status] ?? 'unknown'}>{a.status.health.status}</StatusBadge>
                <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-content-muted">
                  {a.spec.syncPolicy.automated ? `auto-sync${a.spec.syncPolicy.automated.selfHeal ? ' · self-heal' : ''}${a.spec.syncPolicy.automated.prune ? ' · prune' : ''}` : 'manual sync'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
          {/* actions — title/description left, buttons right */}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
            {running ? (
              <Button size="sm" variant="secondary" onClick={() => run('Operation terminated.', () => terminate.mutateAsync({ name }))} loading={terminate.isPending} leading={<IconStop />}>
                Terminate operation
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => run('Refresh requested.', () => refresh.mutateAsync({ name }))} loading={refresh.isPending && !refresh.variables?.hard} leading={<IconRefresh />}>
              Refresh
            </Button>
            <Button size="sm" variant="secondary" onClick={() => run('Hard refresh requested — manifest cache dropped.', () => refresh.mutateAsync({ name, hard: true }))} loading={refresh.isPending && !!refresh.variables?.hard}>
              Hard refresh
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmDelete({ cascade: true })} leading={<IconTrash />}>
              Delete
            </Button>
          </div>
          {confirmDelete ? (
            <div className="mt-3 rounded-xl border border-rose-200/70 bg-rose-50/40 p-3 text-[12px] dark:border-rose-500/30 dark:bg-rose-500/10">
              <div className="font-semibold text-rose-800 dark:text-rose-200">Delete {name}?</div>
              <p className="mt-0.5 text-content-muted">
                With cascade, ArgoCD also deletes the {a.status.resources.total} resources it manages in {a.spec.destination.namespace || 'the cluster'}. Without cascade the Application is removed and the resources stay (orphaned).
              </p>
              <label className="mt-2 flex items-center gap-2 text-content">
                <Checkbox checked={confirmDelete.cascade} onChange={() => setConfirmDelete({ cascade: !confirmDelete.cascade })} /> Cascade — delete managed resources too
              </label>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button size="sm" onClick={() => run(`Deleting ${name}…`, () => del.mutateAsync({ name, cascade: confirmDelete.cascade }), onClose)} loading={del.isPending}>
                  Delete application
                </Button>
              </div>
            </div>
          ) : null}
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Card>
            <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Sync" value={a.status.sync.status} />
              <Tile label="Health" value={a.status.health.status} />
              <Tile label="Out of sync" value={outOfSync} />
              <Tile label="Unhealthy" value={unhealthy} />
            </CardBody>
          </Card>

          {a.status.operationState ? (
            <Card className={cn(a.status.operationState.phase === 'Failed' || a.status.operationState.phase === 'Error' ? 'border-rose-200/60 bg-rose-50/30 dark:border-rose-500/30 dark:bg-rose-500/10' : '')}>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Last operation</div>
              </CardHeader>
              <CardBody className="space-y-1.5 text-[12px]">
                <Row label="Phase" value={a.status.operationState.phase} />
                {a.status.operationState.initiatedBy ? <Row label="Initiated by" value={a.status.operationState.initiatedBy} /> : null}
                {a.status.operationState.revision ? <Row label="Revision" value={a.status.operationState.revision} mono /> : null}
                {a.status.operationState.startedAt ? <Row label="Started" value={formatAbsolute(a.status.operationState.startedAt)} /> : null}
                {a.status.operationState.finishedAt ? <Row label="Finished" value={formatAbsolute(a.status.operationState.finishedAt)} /> : null}
                {a.status.operationState.message ? <p className="pt-1 text-content">{a.status.operationState.message}</p> : null}
              </CardBody>
            </Card>
          ) : null}

          {a.status.conditions.length ? (
            <Card className="border-rose-200/60 bg-rose-50/30 dark:border-rose-500/30 dark:bg-rose-500/10">
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-700 dark:text-rose-300">Conditions</div>
              </CardHeader>
              <CardBody className="space-y-2 text-[12px]">
                {a.status.conditions.map((c, i) => (
                  <div key={i}>
                    <div className="font-semibold text-content">{c.type}{c.lastTransitionTime ? <span className="ml-2 font-normal text-content-subtle">{formatRelative(c.lastTransitionTime)}</span> : null}</div>
                    {c.message ? <p className="break-words text-content-muted">{c.message}</p> : null}
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {a.status.images.length ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Images ({a.status.images.length})</div>
              </CardHeader>
              <CardBody>
                <ul className="space-y-1 font-mono text-[11px] text-content-muted">
                  {a.status.images.map((img) => (
                    <li key={img} className="truncate" title={img}>{img}</li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          {/* ── Sync with options ── */}
          <SyncPanel
            appSynced={a.status.sync.status === 'Synced'}
            opts={opts}
            onChange={setOpts}
            onSync={() => sync.mutate({ name, options: opts })}
            busy={sync.isPending}
            result={
              sync.isSuccess
                ? opts.dryRun
                  ? 'Dry-run completed — no changes applied.'
                  : 'Sync requested.'
                : sync.isError
                  ? 'Sync failed.'
                  : null
            }
          />

          {/* ── Managed resources tree ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                  Managed resources
                </div>
                {resources.data ? (
                  <span className="text-[11px] text-content-subtle">
                    {countTree(nodes, () => true)} resources
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardBody>
              {resources.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-content-muted">
                  <Spinner size={14} /> Loading resource tree…
                </div>
              ) : nodes.length === 0 ? (
                <EmptyState title="No managed resources" />
              ) : (
                <ul className="space-y-0.5">
                  {nodes.map((n) => (
                    <ResourceRow key={n.uid} node={n} depth={0} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* ── History + rollback ── */}
          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Deployment history
              </div>
            </CardHeader>
            <CardBody>
              {history.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-content-muted">
                  <Spinner size={14} /> Loading history…
                </div>
              ) : (history.data ?? []).length === 0 ? (
                <EmptyState title="No deployment history" />
              ) : (
                <ol className="space-y-2">
                  {(history.data ?? []).map((h) => (
                    <HistoryRow
                      key={h.id}
                      entry={h}
                      onRollback={() => rollback.mutate({ name, id: h.id })}
                      busy={rollback.isPending && rollback.variables?.id === h.id}
                      disabled={rollback.isPending}
                    />
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Source & destination
              </div>
            </CardHeader>
            <CardBody className="space-y-1.5 text-[12px]">
              <Row label="Repo" value={a.spec.source.repoURL} mono />
              <Row label="Path" value={a.spec.source.path ?? '—'} mono />
              <Row label="Revision" value={a.spec.source.targetRevision ?? 'HEAD'} mono />
              {a.status.sync.revision ? (
                <Row label="Resolved" value={a.status.sync.revision} mono />
              ) : null}
              <Row label="Cluster" value={a.spec.destination.server} mono />
              <Row label="Namespace" value={a.spec.destination.namespace} mono />
            </CardBody>
          </Card>

          {a.status.health.message ? (
            <Card className="border-rose-200/60 bg-rose-50/30">
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-700">
                  Health message
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-content">{a.status.health.message}</p>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ── Sync-with-options panel ── */
function SyncPanel({
  appSynced,
  opts,
  onChange,
  onSync,
  busy,
  result,
}: {
  appSynced: boolean
  opts: SyncOptions
  onChange(o: SyncOptions): void
  onSync(): void
  busy: boolean
  result: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
          Sync
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Checkbox
            label="Prune"
            description="Delete resources not in Git"
            checked={opts.prune}
            onChange={(e) => onChange({ ...opts, prune: e.target.checked })}
          />
          <Checkbox
            label="Dry-run"
            description="Preview, apply nothing"
            checked={opts.dryRun}
            onChange={(e) => onChange({ ...opts, dryRun: e.target.checked })}
          />
          <Checkbox
            label="Force"
            description="Replace instead of apply"
            checked={opts.force}
            onChange={(e) => onChange({ ...opts, force: e.target.checked })}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={onSync} loading={busy} leading={<IconSync />}>
            {opts.dryRun ? 'Dry-run sync' : 'Synchronize'}
          </Button>
          {appSynced && !opts.dryRun ? (
            <span className="text-[11px] text-content-subtle">
              App is already in sync — this re-applies the manifests.
            </span>
          ) : null}
          {result ? <span className="text-[11px] text-content-muted">{result}</span> : null}
        </div>
      </CardBody>
    </Card>
  )
}

/* ── One row of the managed-resource tree (recursive) ── */
function ResourceRow({ node, depth }: { node: ResourceNode; depth: number }) {
  return (
    <>
      <li
        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-sunken/60"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-sunken text-[9px] font-bold uppercase text-content-subtle">
          {kindAbbr(node.kind)}
        </span>
        <span className="truncate text-[12px] font-medium text-content">{node.name}</span>
        <span className="truncate text-[11px] text-content-subtle">{node.kind}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {node.syncStatus ? (
            <StatusBadge kind={SYNC_KIND[node.syncStatus] ?? 'unknown'}>
              {node.syncStatus}
            </StatusBadge>
          ) : null}
          <StatusBadge kind={HEALTH_KIND[node.health] ?? 'unknown'}>{node.health}</StatusBadge>
        </div>
      </li>
      {node.message ? (
        <li
          className="text-[11px] text-rose-700"
          style={{ paddingLeft: `${depth * 16 + 36}px` }}
        >
          {node.message}
        </li>
      ) : null}
      {node.children?.map((c) => (
        <ResourceRow key={c.uid} node={c} depth={depth + 1} />
      ))}
    </>
  )
}

/* ── One row of the deployment history with a rollback action ── */
function HistoryRow({
  entry: h,
  onRollback,
  busy,
  disabled,
}: {
  entry: RevisionHistoryEntry
  onRollback(): void
  busy: boolean
  disabled: boolean
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-md border p-2.5 ${
        h.current ? 'border-brand-300 bg-brand-50/40' : 'border-edge-subtle bg-surface-raised'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold text-content">
            {h.revision.slice(0, 10)}
          </span>
          {h.current ? (
            <StatusBadge kind="healthy">current</StatusBadge>
          ) : null}
        </div>
        <div className="truncate text-[12px] text-content">{h.message}</div>
        <div className="text-[11px] text-content-subtle">
          {h.author} · {formatRelative(h.deployedAt)} · {formatAbsolute(h.deployedAt)}
        </div>
      </div>
      <Button
        size="xs"
        variant="secondary"
        onClick={onRollback}
        loading={busy}
        disabled={disabled || h.current}
        leading={<IconRollback />}
      >
        Rollback
      </Button>
    </li>
  )
}

function countTree(nodes: ResourceNode[], pred: (n: ResourceNode) => boolean): number {
  let n = 0
  for (const node of nodes) {
    if (pred(node)) n++
    if (node.children) n += countTree(node.children, pred)
  }
  return n
}

function kindAbbr(kind: string): string {
  return kind.replace(/[a-z]/g, '').slice(0, 3) || kind.slice(0, 2).toUpperCase()
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="text-base font-semibold tabular-nums text-content">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-content-subtle">{label}</span>
      <span className={`min-w-0 truncate ${mono ? 'font-mono' : ''} text-content`}>{value}</span>
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
        className="block h-9 w-44 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
      />
    </div>
  )
}

function IconSync() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
function IconRollback() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7v6h6" />
      <path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" />
    </svg>
  )
}
function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}
function IconStop() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}
function IconMore() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  )
}
function IconBolt() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
    </svg>
  )
}
function IconGrid() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}
function IconList() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" />
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

export default ArgoApps
