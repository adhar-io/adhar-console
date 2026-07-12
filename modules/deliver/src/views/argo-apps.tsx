import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { argocd } from '@adhar-console/api-clients'
import { useApplications, useSyncApplication } from '../data/delivery.ts'

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
 * ArgoCD applications. Card grid with sync × health pills, inline sync
 * action, and a detail drawer that shows source, destination, revision,
 * and the latest operation state.
 */
export function ArgoApps() {
  const q = useApplications()
  const sync = useSyncApplication()
  const [openName, setOpenName] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
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

  const all = q.data ?? []
  const f = search.trim().toLowerCase()
  const list = f
    ? all.filter(
        (a) =>
          a.metadata.name.toLowerCase().includes(f) ||
          a.spec.destination.namespace.toLowerCase().includes(f) ||
          a.spec.project.toLowerCase().includes(f),
      )
    : all
  const open = all.find((a) => a.metadata.name === openName) ?? null

  const synced = all.filter((a) => a.status.sync.status === 'Synced').length
  const drift = all.filter((a) => a.status.sync.status === 'OutOfSync').length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">
          {all.length} application{all.length === 1 ? '' : 's'} · {synced} synced · {drift} drifting
        </div>
        <div className="ml-auto">
          <SearchInput value={search} onChange={setSearch} placeholder="Search apps…" />
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState title={all.length === 0 ? 'No applications' : 'No matches'} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <AppCard
              key={a.metadata.name}
              app={a}
              onOpen={() => setOpenName(a.metadata.name)}
              onSync={() => sync.mutate(a.metadata.name)}
              syncing={sync.isPending && sync.variables === a.metadata.name}
            />
          ))}
        </div>
      )}

      {open ? (
        <AppDetail
          app={open}
          onClose={() => setOpenName(null)}
          onSync={() => sync.mutate(open.metadata.name)}
          syncing={sync.isPending && sync.variables === open.metadata.name}
        />
      ) : null}
    </div>
  )
}

function AppCard({
  app: a,
  onOpen,
  onSync,
  syncing,
}: {
  app: argocd.Application
  onOpen(): void
  onSync(): void
  syncing: boolean
}) {
  const sync = a.status.sync.status
  const health = a.status.health.status
  const drift = sync === 'OutOfSync'
  const tone = drift ? 'border-amber-200/60 bg-amber-50/30' : health === 'Degraded' ? 'border-rose-200/60 bg-rose-50/30' : 'border-edge-default'

  return (
    <Card className={`${tone} border`} interactive>
      <button type="button" onClick={onOpen} className="block w-full p-5 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white ${syncBg(sync)}`}>
                {a.metadata.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="truncate text-sm font-semibold text-content">{a.metadata.name}</span>
            </div>
            <div className="mt-1 text-[11px] text-content-subtle">
              {a.spec.destination.namespace} · {a.spec.project}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusBadge kind={SYNC_KIND[sync] ?? 'unknown'}>{sync}</StatusBadge>
            <StatusBadge kind={HEALTH_KIND[health] ?? 'unknown'}>{health}</StatusBadge>
          </div>
        </div>

        <div className="mt-3 rounded-md border border-edge-subtle bg-white p-2 text-[11px]">
          <div className="truncate font-mono text-content-muted">
            {a.spec.source.repoURL.replace(/^https?:\/\//, '')}
          </div>
          <div className="text-content-subtle">
            {a.spec.source.path ?? '—'} @ {a.spec.source.targetRevision ?? 'HEAD'}
          </div>
        </div>

        {a.status.sync.revision ? (
          <div className="mt-2 font-mono text-[10px] text-content-subtle">
            rev {a.status.sync.revision.slice(0, 12)}
          </div>
        ) : null}
      </button>
      <div className="border-t border-edge-subtle bg-white/80 px-4 py-2">
        <Button
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            onSync()
          }}
          loading={syncing}
          disabled={sync === 'Synced'}
          leading={<IconSync />}
        >
          Sync
        </Button>
        {a.status.health.message ? (
          <span className="ml-2 line-clamp-1 text-[11px] text-content-muted">
            {a.status.health.message}
          </span>
        ) : null}
      </div>
    </Card>
  )
}

function syncBg(s: string) {
  return s === 'Synced' ? 'bg-emerald-500' : s === 'OutOfSync' ? 'bg-amber-500' : 'bg-slate-500'
}

function AppDetail({
  app: a,
  onClose,
  onSync,
  syncing,
}: {
  app: argocd.Application
  onClose(): void
  onSync(): void
  syncing: boolean
}) {
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
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              ArgoCD application · {a.spec.project}
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">
              {a.metadata.name}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              onClick={onSync}
              loading={syncing}
              disabled={a.status.sync.status === 'Synced'}
              leading={<IconSync />}
            >
              Sync
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
              <Tile label="Sync" value={a.status.sync.status} />
              <Tile label="Health" value={a.status.health.status} />
              <Tile
                label="Last op"
                value={a.status.operationState?.phase ?? '—'}
              />
              <Tile
                label="Finished"
                value={
                  a.status.operationState?.finishedAt
                    ? formatRelative(a.status.operationState.finishedAt)
                    : '—'
                }
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Source
              </div>
            </CardHeader>
            <CardBody className="space-y-1.5 text-[12px]">
              <Row label="Repo" value={a.spec.source.repoURL} mono />
              <Row label="Path" value={a.spec.source.path ?? '—'} mono />
              <Row label="Revision" value={a.spec.source.targetRevision ?? 'HEAD'} mono />
              {a.status.sync.revision ? (
                <Row label="Resolved" value={a.status.sync.revision} mono />
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Destination
              </div>
            </CardHeader>
            <CardBody className="space-y-1.5 text-[12px]">
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
        className="block h-9 w-44 rounded-lg border border-edge-default bg-white pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
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
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export default ArgoApps
