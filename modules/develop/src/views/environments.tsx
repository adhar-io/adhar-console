import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { coder } from '@adhar-console/api-clients'
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useStartWorkspace,
  useStopWorkspace,
  useTemplates,
  useWorkspaces,
} from '../data/coder.ts'

const STATUS_KIND: Record<coder.WorkspaceStatus, StatusKind> = {
  running: 'healthy',
  starting: 'progressing',
  pending: 'progressing',
  stopping: 'paused',
  stopped: 'paused',
  canceling: 'paused',
  canceled: 'unknown',
  deleting: 'paused',
  deleted: 'unknown',
  failed: 'failed',
}

const TPL_GRADIENT: Record<string, string> = {
  'node-ts': 'from-emerald-100 to-emerald-50',
  'go-dev': 'from-sky-100 to-sky-50',
  python: 'from-amber-100 to-amber-50',
  'fullstack-tilt': 'from-violet-100 to-violet-50',
}

/**
 * Coder cloud development environments.
 *
 * Hero shows a workspace card per dev environment with start/stop/IDE/SSH
 * actions. Filter by status. Open the detail drawer to see resources,
 * agents, app shortcuts, TTL/schedule, and a "delete" affordance.
 */
export function Environments() {
  const q = useWorkspaces()
  const tplsQ = useTemplates()
  const create = useCreateWorkspace()
  const start = useStartWorkspace()
  const stop = useStopWorkspace()
  const remove = useDeleteWorkspace()

  const [filter, setFilter] = useState<'all' | 'running' | 'stopped' | 'failed'>('all')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading environments…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Coder"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }

  const all = q.data ?? []
  const f = search.trim().toLowerCase()
  const list = all
    .filter((w) => {
      if (filter === 'all') return true
      if (filter === 'running') return w.latest_build.status === 'running' || w.latest_build.status === 'starting'
      if (filter === 'stopped') return w.latest_build.status === 'stopped' || w.latest_build.status === 'stopping'
      if (filter === 'failed') return w.latest_build.status === 'failed'
      return true
    })
    .filter(
      (w) =>
        !f ||
        w.name.toLowerCase().includes(f) ||
        w.template_name.toLowerCase().includes(f) ||
        w.owner_name.toLowerCase().includes(f),
    )

  const counts = {
    all: all.length,
    running: all.filter((w) => w.latest_build.status === 'running').length,
    stopped: all.filter((w) => w.latest_build.status === 'stopped').length,
    failed: all.filter((w) => w.latest_build.status === 'failed').length,
  }

  const open = all.find((w) => w.id === openId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterTabs filter={filter} setFilter={setFilter} counts={counts} />
        <div className="ml-auto flex items-center gap-2">
          <SearchInput value={search} onChange={setSearch} />
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New env
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title={all.length === 0 ? 'No envs yet' : 'No matches'}
          description={
            all.length === 0
              ? 'Spin up the first cloud development environment from a template.'
              : 'Try a different status or search term.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((w) => (
            <WorkspaceCard
              key={w.id}
              workspace={w}
              onOpen={() => setOpenId(w.id)}
              onStart={() => start.mutate(w.id)}
              onStop={() => stop.mutate(w.id)}
              busy={
                (start.isPending && start.variables === w.id) ||
                (stop.isPending && stop.variables === w.id)
              }
            />
          ))}
        </div>
      )}

      <CreateWorkspaceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        templates={tplsQ.data ?? []}
        loading={create.isPending}
        onCreate={(input) => create.mutate(input)}
      />

      {open ? (
        <WorkspaceDetail
          workspace={open}
          onClose={() => setOpenId(null)}
          onStart={() => start.mutate(open.id)}
          onStop={() => stop.mutate(open.id)}
          onDelete={() => {
            if (!confirm(`Delete workspace "${open.name}"? Data on the workspace is lost.`)) return
            remove.mutate(open.id)
            setOpenId(null)
          }}
        />
      ) : null}
    </div>
  )
}

function FilterTabs({
  filter,
  setFilter,
  counts,
}: {
  filter: 'all' | 'running' | 'stopped' | 'failed'
  setFilter(f: 'all' | 'running' | 'stopped' | 'failed'): void
  counts: { all: number; running: number; stopped: number; failed: number }
}) {
  const tabs = [
    { id: 'all' as const, label: 'All' },
    { id: 'running' as const, label: 'Running' },
    { id: 'stopped' as const, label: 'Stopped' },
    { id: 'failed' as const, label: 'Failed' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
      {tabs.map((t) => {
        const on = filter === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setFilter(t.id)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {t.label}
            <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
              {counts[t.id]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function WorkspaceCard({
  workspace: w,
  onOpen,
  onStart,
  onStop,
  busy,
}: {
  workspace: coder.Workspace
  onOpen(): void
  onStart(): void
  onStop(): void
  busy: boolean
}) {
  const tone = STATUS_KIND[w.latest_build.status]
  const tplBg = TPL_GRADIENT[w.template_name] ?? 'from-slate-100 to-slate-50'
  const agent = w.latest_build.resources?.[0]?.agents?.[0]
  const apps = agent?.apps ?? []
  const codeApp = apps.find((a) => a.slug === 'code-server')
  const isRunning = w.latest_build.status === 'running'
  const isStopped = w.latest_build.status === 'stopped' || w.latest_build.status === 'failed' || w.latest_build.status === 'canceled'

  return (
    <Card interactive className={`relative overflow-hidden bg-linear-to-br ${tplBg} ring-1 ring-inset ring-edge-subtle`}>
      <button type="button" onClick={onOpen} className="block w-full p-5 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              {w.template_name}
            </div>
            <div className="mt-0.5 truncate text-base font-semibold text-content">{w.name}</div>
            <div className="mt-0.5 text-[11px] text-content-muted">
              owner · {w.owner_name}
            </div>
          </div>
          <StatusBadge kind={tone}>{w.latest_build.status}</StatusBadge>
        </div>

        <div className="mt-4 space-y-1.5">
          <Stat label="Last used" value={w.last_used_at ? formatRelative(w.last_used_at) : '—'} />
          <Stat
            label="Build"
            value={
              w.latest_build.started_at
                ? `${w.latest_build.transition} · ${formatRelative(w.latest_build.started_at)}`
                : w.latest_build.transition
            }
          />
          <Stat
            label="TTL"
            value={w.ttl_ms ? `${Math.round((w.ttl_ms ?? 0) / 3_600_000)}h` : '—'}
          />
        </div>

        {apps.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {apps.map((a) => (
              <span
                key={a.slug}
                className="inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-content ring-1 ring-edge-subtle"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {a.display_name}
              </span>
            ))}
          </div>
        ) : null}

        {w.outdated ? (
          <div className="mt-3 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-amber-200">
            template outdated — restart to update
          </div>
        ) : null}
      </button>

      <div className="border-t border-edge-subtle bg-white/80 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {isRunning ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                onStop()
              }}
              loading={busy}
              leading={<IconStop />}
            >
              Stop
            </Button>
          ) : isStopped ? (
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onStart()
              }}
              loading={busy}
              leading={<IconStart />}
            >
              Start
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled loading>
              {w.latest_build.status}
            </Button>
          )}
          {codeApp?.url ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                window.open(codeApp.url, '_blank', 'noopener')
              }}
              leading={<IconCode />}
            >
              Open IDE
            </Button>
          ) : null}
          <span className="ml-auto text-[10px] text-content-subtle">
            agent: {agent?.status ?? 'none'}
          </span>
        </div>
      </div>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-content-subtle">{label}</span>
      <span className="text-content">{value}</span>
    </div>
  )
}

function WorkspaceDetail({
  workspace: w,
  onClose,
  onStart,
  onStop,
  onDelete,
}: {
  workspace: coder.Workspace
  onClose(): void
  onStart(): void
  onStop(): void
  onDelete(): void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  const tone = STATUS_KIND[w.latest_build.status]
  const isRunning = w.latest_build.status === 'running'
  const isStopped = w.latest_build.status === 'stopped' || w.latest_build.status === 'failed'

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
              Cloud env · {w.template_name}
            </div>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-content">{w.name}</h2>
            <div className="mt-1 text-[11px] text-content-muted">
              owner · {w.owner_name} · created {formatRelative(w.created_at)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge kind={tone}>{w.latest_build.status}</StatusBadge>
            {isRunning ? (
              <Button size="sm" variant="secondary" onClick={onStop} leading={<IconStop />}>
                Stop
              </Button>
            ) : isStopped ? (
              <Button size="sm" onClick={onStart} leading={<IconStart />}>
                Start
              </Button>
            ) : null}
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
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
              <Tile label="Status" value={w.latest_build.status} />
              <Tile label="Transition" value={w.latest_build.transition} />
              <Tile
                label="TTL"
                value={w.ttl_ms ? `${Math.round(w.ttl_ms / 3_600_000)}h` : '—'}
              />
              <Tile label="Outdated" value={w.outdated ? 'yes' : 'no'} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Resources</div>
              <div className="text-[11px] text-content-subtle">
                Pods, agents, and app endpoints from the latest build
              </div>
            </CardHeader>
            <CardBody>
              {w.latest_build.resources?.length ? (
                <div className="space-y-3">
                  {w.latest_build.resources.map((r) => (
                    <div key={r.name} className="rounded-lg border border-edge-subtle p-3">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                          {r.type}
                        </span>
                        <span className="text-sm font-medium text-content">{r.name}</span>
                      </div>
                      {r.agents?.length ? (
                        <ul className="mt-2 space-y-2">
                          {r.agents.map((a) => (
                            <li key={a.name} className="rounded-md bg-surface-sunken/40 p-2">
                              <div className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="font-medium text-content">{a.name}</span>
                                <StatusBadge
                                  kind={
                                    a.status === 'connected'
                                      ? 'healthy'
                                      : a.status === 'connecting'
                                        ? 'progressing'
                                        : 'failed'
                                  }
                                >
                                  {a.status}
                                </StatusBadge>
                              </div>
                              <div className="mt-1 text-[10px] text-content-subtle">
                                {a.operating_system} / {a.architecture}
                              </div>
                              {a.apps?.length ? (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {a.apps.map((app) => (
                                    <a
                                      key={app.slug}
                                      href={app.url ?? '#'}
                                      target="_blank"
                                      rel="noopener"
                                      className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-medium text-brand-700 ring-1 ring-edge-subtle hover:bg-brand-50"
                                    >
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                      {app.display_name}
                                    </a>
                                  ))}
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState compact title="No resources yet" />
              )}
            </CardBody>
          </Card>

          {w.autostart_schedule ? (
            <Card>
              <CardHeader>
                <div className="text-sm font-semibold text-content">Schedule</div>
              </CardHeader>
              <CardBody>
                <code className="block rounded-md bg-surface-sunken px-2 py-1 font-mono text-[11px] text-content">
                  {w.autostart_schedule}
                </code>
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

function CreateWorkspaceModal({
  open,
  onClose,
  templates,
  loading,
  onCreate,
}: {
  open: boolean
  onClose(): void
  templates: coder.Template[]
  loading: boolean
  onCreate(input: { name: string; template_id: string }): void
}) {
  const [name, setName] = useState('')
  const [tplId, setTplId] = useState<string>('')

  useEffect(() => {
    if (!open) return
    setName('')
    setTplId(templates[0]?.id ?? '')
  }, [open, templates])

  const submit = () => {
    if (!name.trim() || !tplId) return
    onCreate({ name: name.trim().toLowerCase().replace(/\s+/g, '-'), template_id: tplId })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New cloud environment"
      description="Pick a template — Coder provisions the workspace and connects an agent."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim() || !tplId} loading={loading}>
            Create env
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-feature-branch"
            className="mt-1.5 block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </label>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Template
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {templates.map((t) => {
              const on = tplId === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTplId(t.id)}
                  className={
                    on
                      ? 'rounded-lg border border-brand-400 bg-brand-50 p-3 text-left ring-2 ring-brand-400/20'
                      : 'rounded-lg border border-edge-default bg-white p-3 text-left hover:border-edge-strong'
                  }
                >
                  <div className="text-sm font-semibold text-content">
                    {t.display_name ?? t.name}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-content-muted">
                    {t.description}
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-content-subtle">
                    <span>{t.active_user_count ?? 0} active users</span>
                    {t.build_time_stats?.start?.p50 ? (
                      <span>· p50 boot {Math.round(t.build_time_stats.start.p50 / 1000)}s</span>
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function SearchInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
        <IconSearch />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search envs…"
        className="block h-9 w-44 rounded-lg border border-edge-default bg-white pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
      />
    </div>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconStart() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5 4l14 8-14 8z" />
    </svg>
  )
}
function IconStop() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}
function IconCode() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
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
