import { useEffect, useState } from 'react'
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
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar-console/utils'
import type { argocd } from '@adhar-console/api-clients'
import {
  useAppHistory,
  useApplications,
  useAppResources,
  useRollbackApplication,
  useSyncApplication,
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
              onSync={() => sync.mutate({ name: a.metadata.name })}
              syncing={sync.isPending && sync.variables?.name === a.metadata.name}
            />
          ))}
        </div>
      )}

      {open ? <AppDetail app={open} onClose={() => setOpenName(null)} /> : null}
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

function AppDetail({ app: a, onClose }: { app: argocd.Application; onClose(): void }) {
  const name = a.metadata.name
  const sync = useSyncApplication()
  const rollback = useRollbackApplication()
  const resources = useAppResources(name)
  const history = useAppHistory(name)
  const [opts, setOpts] = useState<SyncOptions>({ prune: false, dryRun: false, force: false })

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
              {name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
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
        h.current ? 'border-brand-300 bg-brand-50/40' : 'border-edge-subtle bg-white'
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
function IconRollback() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7v6h6" />
      <path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" />
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
