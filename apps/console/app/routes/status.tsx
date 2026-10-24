import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AppShell, Button, PageHeader, Spinner, StatusBadge, type StatusKind } from '@adhar/shell-ui'
import type { ServiceHealth } from '@adhar/platform-info'
import { cn } from '@adhar/utils'
import { PENDING_USER, useOptionalSession } from '@adhar/auth'
import { getLayoutData } from '~/server/session.ts'
import type { ComponentStatus, Dependency, StatusSnapshot } from '~/server/status.ts'

/**
 * Platform status — live.
 *
 * Everything is read from the running system by `GET /api/status` (see
 * app/server/status.ts): the platform version is the image the Adhar
 * controller runs, the console version is the image of the console
 * Deployment, component health and versions come from their workloads, and
 * each dependency is probed with its latency. The page re-reads once a
 * minute; the server shares one snapshot between viewers and keeps an hour
 * of history and a log of status changes.
 */
export const Route = createFileRoute('/status')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Platform status · Adhar Console' }] }),
  component: StatusPage,
})

/** The BFF recomputes its shared snapshot at most every 30s and samples history per minute. */
const POLL_MS = 60_000

const KIND: Record<ServiceHealth, StatusKind> = {
  operational: 'healthy',
  degraded: 'degraded',
  'partial-outage': 'degraded',
  outage: 'failed',
  unknown: 'unknown',
}
const LABEL: Record<ServiceHealth, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  'partial-outage': 'Partial outage',
  outage: 'Outage',
  unknown: 'Unknown',
}
const BAR: Record<ServiceHealth, string> = {
  operational: 'bg-emerald-500',
  degraded: 'bg-amber-400',
  'partial-outage': 'bg-orange-500',
  outage: 'bg-rose-500',
  unknown: 'bg-slate-300 dark:bg-slate-600',
}
const BANNER: Record<ServiceHealth, string> = {
  operational: 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10',
  degraded: 'border-amber-200 bg-amber-50 dark:border-amber-500/25 dark:bg-amber-500/10',
  'partial-outage': 'border-orange-200 bg-orange-50 dark:border-orange-500/25 dark:bg-orange-500/10',
  outage: 'border-rose-200 bg-rose-50 dark:border-rose-500/25 dark:bg-rose-500/10',
  unknown: 'border-edge-default bg-surface-raised',
}
const DEP: Record<Dependency['status'], { kind: StatusKind; label: string }> = {
  ok: { kind: 'healthy', label: 'Reachable' },
  degraded: { kind: 'degraded', label: 'Slow' },
  down: { kind: 'failed', label: 'Unreachable' },
  unconfigured: { kind: 'unknown', label: 'Not configured' },
}

async function fetchStatus(): Promise<StatusSnapshot> {
  const res = await fetch('/api/status', { credentials: 'include', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`Status endpoint answered ${res.status}`)
  return (await res.json()) as StatusSnapshot
}

/** Re-render every second so "updated 3s ago" and uptimes keep moving. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`
}

function uptime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}

function StatusPage() {
  const { tenants, activeTenant } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  const now = useNow()
  const q = useQuery({
    queryKey: ['status', 'snapshot'],
    queryFn: fetchStatus,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  })
  const d = q.data

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Platform status' }]}
    >
      <PageHeader
        title="Platform status"
        actions={
          <div className="flex items-center gap-3">
            {d ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-content-subtle">
                <span className={cn('h-1.5 w-1.5 rounded-full', q.isError ? 'bg-rose-500' : 'animate-pulse bg-emerald-500')} />
                {q.isError ? 'Connection lost · showing last snapshot' : `Live · updated ${ago(d.generatedAt, now)}`}
              </span>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => q.refetch()} loading={q.isFetching}>
              Refresh
            </Button>
          </div>
        }
      />

      {!d ? (
        q.isError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200">
            Could not load status: {(q.error as Error).message}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-16 text-sm text-content-subtle">
            <Spinner size={14} /> Checking every component…
          </div>
        )
      ) : (
        <>
          <Overall d={d} />
          <Versions d={d} now={now} />
          <Dependencies deps={d.dependencies} />
          <Components d={d} />
          <Changes d={d} now={now} />
        </>
      )}
    </AppShell>
  )
}

/* ─────────── overall ─────────── */

function Overall({ d }: { d: StatusSnapshot }) {
  const buckets = d.history.buckets
  return (
    <section className={cn('mb-6 rounded-2xl border p-5', BANNER[d.overall])}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn('relative flex h-3 w-3')}>
            {d.overall !== 'operational' ? <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', BAR[d.overall])} /> : null}
            <span className={cn('relative inline-flex h-3 w-3 rounded-full', BAR[d.overall])} />
          </span>
          <div>
            <div className="text-lg font-semibold text-content">
              {LABEL[d.overall]}
            </div>
            <div className="text-[13px] text-content-muted">{d.summary}</div>
          </div>
        </div>
      </div>
      <HistoryBar buckets={buckets.map((b) => ({ t: b.t, h: b.overall }))} bucketMs={d.history.bucketMs} className="mt-4" tall />
    </section>
  )
}

function HistoryBar({
  buckets,
  bucketMs,
  className,
  tall = false,
}: {
  buckets: Array<{ t: number; h: ServiceHealth | undefined }>
  bucketMs: number
  className?: string
  tall?: boolean
}) {
  const SLOTS = 60
  const shown = buckets.slice(-SLOTS)
  const pad = SLOTS - shown.length
  const spanMin = Math.round((SLOTS * bucketMs) / 60_000)
  return (
    <div className={className}>
      <div className={cn('flex gap-0.5', tall ? 'h-7' : 'h-4')}>
        {Array.from({ length: pad }).map((_, i) => <span key={`p${i}`} className="flex-1 rounded-sm bg-edge-subtle" title="No data yet" />)}
        {shown.map((b) => (
          <span
            key={b.t}
            className={cn('flex-1 rounded-sm', BAR[b.h ?? 'unknown'])}
            title={`${new Date(b.t).toLocaleTimeString()} — ${LABEL[b.h ?? 'unknown']}`}
          />
        ))}
      </div>
      {tall ? (
        <div className="mt-1 flex justify-between text-[10px] text-content-subtle">
          <span>{spanMin} min ago</span>
          <span>now</span>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── versions ─────────── */

function Versions({ d, now }: { d: StatusSnapshot; now: number }) {
  const notReady = d.platform.conditions.filter((c) => c.status !== 'True')
  const consoleVersion = d.console.imageVersion ?? d.console.version
  const buildMismatch = d.console.imageVersion && d.console.version !== 'dev' && d.console.imageVersion.replace(/^v/, '') !== d.console.version.replace(/^v/, '')
  return (
    <section className="mb-6 grid gap-3 md:grid-cols-3">
      <VersionCard
        label="Adhar Platform"
        version={d.platform.version}
        missing="Controller not found"
        rows={[
          ['Controller', d.platform.ready ? `${d.platform.ready} ready` : '—'],
          ['Resource', d.platform.name ? `AdharPlatform/${d.platform.name}` : '—'],
          ['Conditions', d.platform.conditions.length ? (notReady.length ? `${notReady.length} not ready` : `${d.platform.conditions.length} all true`) : '—'],
        ]}
        footer={
          d.platform.conditions.length ? (
            <div className="flex flex-wrap gap-1">
              {d.platform.conditions.map((c) => (
                <span
                  key={c.type}
                  title={c.message ?? c.reason}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                    c.status === 'True'
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20'
                      : 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
                  )}
                >
                  {c.type}
                </span>
              ))}
            </div>
          ) : null
        }
        image={d.platform.image}
      />
      <VersionCard
        label="Adhar Console"
        version={consoleVersion === 'dev' ? 'dev build' : consoleVersion}
        rows={[
          ['Replicas', d.console.ready ? `${d.console.ready} ready` : 'not deployed here'],
          ['Up for', uptime(d.console.startedAt, now)],
          ['Built as', d.console.version === 'dev' ? 'dev' : `v${d.console.version.replace(/^v/, '')}`],
        ]}
        footer={buildMismatch ? <span className="text-[11px] text-amber-700 dark:text-amber-300">Running image and build version differ — a rollout may be in progress.</span> : <span className="text-[11px] text-content-subtle">{d.console.runtime}</span>}
        image={d.console.image}
      />
      <VersionCard
        label="Kubernetes"
        version={d.kubernetes.version}
        missing="API server unreachable"
        rows={[
          ['Nodes', d.kubernetes.nodesTotal !== undefined ? `${d.kubernetes.nodesReady}/${d.kubernetes.nodesTotal} ready` : '—'],
          ['API latency', d.dependencies.find((x) => x.id === 'apiserver')?.latencyMs !== undefined ? `${d.dependencies.find((x) => x.id === 'apiserver')!.latencyMs} ms` : '—'],
        ]}
      />
    </section>
  )
}

function VersionCard({
  label,
  version,
  missing = '—',
  rows,
  footer,
  image,
}: {
  label: string
  version?: string
  missing?: string
  rows: Array<[string, string]>
  footer?: React.ReactNode
  image?: string
}) {
  const v = version ? (/^\d/.test(version) ? `v${version}` : version) : undefined
  return (
    <div className="flex flex-col rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">{label}</div>
      <div className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', v ? 'text-content' : 'text-content-subtle text-base')}>{v ?? missing}</div>
      {image ? <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle" title={image}>{image}</div> : null}
      <dl className="mt-3 space-y-1 text-[12px]">
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-content-subtle">{k}</dt>
            <dd className="truncate text-content">{val}</dd>
          </div>
        ))}
      </dl>
      {footer ? <div className="mt-3 border-t border-edge-subtle pt-2">{footer}</div> : null}
    </div>
  )
}

/* ─────────── dependencies ─────────── */

function Dependencies({ deps }: { deps: Dependency[] }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-content-subtle">Console dependencies</h2>
      <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        <ul className="divide-y divide-edge-subtle">
          {deps.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-56 shrink-0 text-[13px] font-medium text-content">{x.name}</span>
              <StatusBadge kind={DEP[x.status].kind}>{DEP[x.status].label}</StatusBadge>
              <span className="w-20 font-mono text-[12px] tabular-nums text-content-muted">{x.latencyMs !== undefined ? `${x.latencyMs} ms` : ''}</span>
              <span className="font-mono text-[12px] text-content-muted">{x.version ?? ''}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[12px] text-content-subtle" title={x.detail}>{x.detail ?? ''}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/* ─────────── components ─────────── */

function Components({ d }: { d: StatusSnapshot }) {
  const [open, setOpen] = useState<string | null>(null)
  const [showMissing, setShowMissing] = useState(false)
  const installed = d.components.filter((c) => c.workloads.length > 0)
  const missing = d.components.filter((c) => c.workloads.length === 0)
  const order: Record<ServiceHealth, number> = { outage: 0, 'partial-outage': 1, degraded: 2, unknown: 3, operational: 4 }
  installed.sort((a, b) => order[a.health] - order[b.health] || a.name.localeCompare(b.name))
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">Platform components · {installed.length}</h2>
        <span className="text-[11px] text-content-subtle">Versions are read from the images each component runs</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        {installed.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-content-subtle">No components detected — the cluster could not be read.</p>
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {installed.map((c) => (
              <ComponentRow
                key={c.id}
                c={c}
                history={d.history.buckets.map((b) => ({ t: b.t, h: b.byId[c.id] }))}
                bucketMs={d.history.bucketMs}
                open={open === c.id}
                onToggle={() => setOpen(open === c.id ? null : c.id)}
              />
            ))}
          </ul>
        )}
      </div>
      {missing.length ? (
        <div className="mt-2">
          <button type="button" onClick={() => setShowMissing((v) => !v)} className="text-[12px] text-content-subtle hover:text-content">
            {showMissing ? 'Hide' : 'Show'} {missing.length} component{missing.length === 1 ? '' : 's'} not installed on this cluster
          </button>
          {showMissing ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {missing.map((c) => (
                <a key={c.id} href={c.homepage} target="_blank" rel="noreferrer" className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content-muted hover:text-content">
                  {c.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function ComponentRow({
  c,
  history,
  bucketMs,
  open,
  onToggle,
}: {
  c: ComponentStatus
  history: Array<{ t: number; h: ServiceHealth | undefined }>
  bucketMs: number
  open: boolean
  onToggle(): void
}) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="grid w-full grid-cols-[minmax(0,1.4fr)_auto_minmax(0,0.6fr)_minmax(0,1.2fr)] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-sunken/40">
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-content">{c.name}</span>
          <span className="block truncate text-[11px] text-content-subtle">{c.purpose}</span>
        </span>
        <StatusBadge kind={KIND[c.health]} pulse={c.health === 'degraded'}>
          {LABEL[c.health]} · {c.ready}/{c.desired}
        </StatusBadge>
        <span className="truncate font-mono text-[12px] text-content" title="Image tag the component runs">{c.version ?? '—'}</span>
        <HistoryBar buckets={history} bucketMs={bucketMs} />
      </button>
      {open ? (
        <div className="border-t border-edge-subtle bg-surface-sunken/30 px-4 py-2">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-content-subtle">
                <th className="py-1 font-semibold">Workload</th>
                <th className="py-1 font-semibold">Kind</th>
                <th className="py-1 font-semibold">Namespace</th>
                <th className="py-1 font-semibold">Ready</th>
                <th className="py-1 font-semibold">Version</th>
              </tr>
            </thead>
            <tbody>
              {c.workloads.map((w) => (
                <tr key={`${w.namespace}/${w.kind}/${w.name}`} className="border-t border-edge-subtle">
                  <td className="py-1 font-mono text-content">{w.name}</td>
                  <td className="py-1 text-content-muted">{w.kind}</td>
                  <td className="py-1 font-mono text-content-muted">{w.namespace ?? '—'}</td>
                  <td className={cn('py-1 font-mono tabular-nums', w.desired && w.ready < w.desired ? 'text-amber-700 dark:text-amber-300' : 'text-content')}>{w.ready}/{w.desired}</td>
                  <td className="py-1 font-mono text-content-muted">{w.version ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  )
}

/* ─────────── recent changes ─────────── */

function Changes({ d, now }: { d: StatusSnapshot; now: number }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-content-subtle">Recent status changes</h2>
      <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        {d.events.length === 0 ? (
          <p className="px-4 py-5 text-center text-[13px] text-content-subtle">No changes since this console started watching.</p>
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {d.events.map((e, i) => (
              <li key={`${e.t}-${e.id}-${i}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[12px]">
                <span className="w-24 shrink-0 text-content-subtle" title={new Date(e.t).toLocaleString()}>{ago(e.t, now)}</span>
                <span className="font-medium text-content">{e.name}</span>
                <StatusBadge kind={KIND[e.from]} className="px-1.5 py-0 text-[10px]" dot={false}>{LABEL[e.from]}</StatusBadge>
                <span className="text-content-subtle">→</span>
                <StatusBadge kind={KIND[e.to]} className="px-1.5 py-0 text-[10px]">{LABEL[e.to]}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
