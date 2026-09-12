import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
  useToast,
  type StatusKind,
  LogConsole,
  type LogLine,
  detectSeverity,
  type Severity,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import { coder } from '@adhar-console/api-clients'
import {
  useBuildLogs,
  useBuilds,
  useCancelBuild,
  useCoderInfo,
  useCreateWorkspace,
  useDeleteWorkspace,
  useOrganizations,
  useRestartWorkspace,
  useSetFavorite,
  useStartWorkspace,
  useStopWorkspace,
  useTemplateParameters,
  useTemplates,
  useUpdateTtl,
  useWorkspaceOwner,
  useWorkspaces,
} from '../data/coder.ts'
import { IconClose, IconExternal, IconGrid, IconList, IconMore, IconPlus, IconRefresh, IconSearch } from '../components/repo-bits.tsx'

/**
 * Cloud Dev Environments — Coder workspaces for the whole org.
 *
 * Stats strip (filters), search, owner / status / template filters, grid or
 * table layout, template catalogue with one-click create, and a workspace
 * drawer with agents, apps, build history and live provisioner logs. Every
 * action toasts; the list polls so state transitions show up on their own.
 */

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
const BUSY = new Set<coder.WorkspaceStatus>(['pending', 'starting', 'stopping', 'canceling', 'deleting'])
const STARTABLE = new Set<coder.WorkspaceStatus>(['stopped', 'failed', 'canceled'])

type StatusFilter = 'all' | 'running' | 'stopped' | 'building' | 'failed' | 'outdated'
type Layout = 'grid' | 'table'
type Sort = 'used' | 'name' | 'created' | 'status'

const PREFS_KEY = 'adhar.develop.envs.prefs.v1'
function loadPrefs(): { layout: Layout; sort: Sort; mine: boolean } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null
    if (raw) return { layout: 'grid', sort: 'used', mine: false, ...(JSON.parse(raw) as object) }
  } catch { /* ignore */ }
  return { layout: 'grid', sort: 'used', mine: false }
}

function status(w: coder.Workspace): coder.WorkspaceStatus {
  return w.latest_build.status
}
function primaryAgent(w: coder.Workspace): { agent?: coder.WorkspaceAgent; resource?: string } {
  for (const r of w.latest_build.resources ?? []) {
    const a = r.agents?.[0]
    if (a) return { agent: a, resource: r.name }
  }
  return {}
}
function codeApp(agent?: coder.WorkspaceAgent) {
  return agent?.apps?.find((a) => /code-server|vscode|code/i.test(a.slug))
}

export function Environments() {
  const q = useWorkspaces()
  const tpls = useTemplates()
  const info = useCoderInfo()
  const owner = useWorkspaceOwner()
  const toast = useToast()
  const start = useStartWorkspace()
  const stop = useStopWorkspace()
  const restart = useRestartWorkspace()
  const remove = useDeleteWorkspace()
  const favorite = useSetFavorite()

  const [prefs, setPrefs] = useState(loadPrefs)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [template, setTemplate] = useState('all')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState<null | { templateId?: string }>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<coder.Workspace | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch { /* ignore */ }
  }, [prefs])

  const all = useMemo(() => q.data ?? [], [q.data])
  const dashboard = info.data?.dashboard_url ?? ''
  const myOwner = owner.data?.matched ? owner.data.owner : undefined

  const stats = useMemo(() => ({
    total: all.length,
    running: all.filter((w) => status(w) === 'running').length,
    stopped: all.filter((w) => status(w) === 'stopped').length,
    building: all.filter((w) => BUSY.has(status(w))).length,
    failed: all.filter((w) => status(w) === 'failed').length,
    outdated: all.filter((w) => w.outdated).length,
    unhealthy: all.filter((w) => w.health && !w.health.healthy).length,
    owners: new Set(all.map((w) => w.owner_name)).size,
  }), [all])

  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    const out = all.filter((w) => {
      const s = status(w)
      if (prefs.mine && myOwner && w.owner_name !== myOwner) return false
      if (statusFilter === 'running' && s !== 'running') return false
      if (statusFilter === 'stopped' && s !== 'stopped') return false
      if (statusFilter === 'building' && !BUSY.has(s)) return false
      if (statusFilter === 'failed' && s !== 'failed') return false
      if (statusFilter === 'outdated' && !w.outdated) return false
      if (template !== 'all' && w.template_name !== template) return false
      if (f && !(w.name.toLowerCase().includes(f) || w.owner_name.toLowerCase().includes(f) || w.template_name.toLowerCase().includes(f))) return false
      return true
    })
    out.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
      switch (prefs.sort) {
        case 'name':
          return a.name.localeCompare(b.name)
        case 'created':
          return b.created_at.localeCompare(a.created_at)
        case 'status':
          return status(a).localeCompare(status(b)) || a.name.localeCompare(b.name)
        default:
          return (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '')
      }
    })
    return out
  }, [all, search, prefs.mine, prefs.sort, myOwner, statusFilter, template])

  const open = all.find((w) => w.id === openId) ?? null

  const act = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn()
      toast.success(label)
      after?.()
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : String(e) })
    }
  }
  const actions = (w: coder.Workspace) => ({
    start: () => act(`Starting ${w.name}`, () => start.mutateAsync({ id: w.id })),
    stop: () => act(`Stopping ${w.name}`, () => stop.mutateAsync(w.id)),
    restart: () => act(`Restarting ${w.name}`, () => restart.mutateAsync({ id: w.id })),
    update: () => act(`Updating ${w.name} to the latest template`, () => (status(w) === 'running' ? restart.mutateAsync({ id: w.id, templateVersionId: w.template_active_version_id }) : start.mutateAsync({ id: w.id, templateVersionId: w.template_active_version_id }))),
    favorite: () => act(w.favorite ? 'Removed from favourites' : 'Added to favourites', () => favorite.mutateAsync({ id: w.id, on: !w.favorite })),
    delete: () => setConfirmDelete(w),
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading environments…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Coder"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
        action={<Button size="sm" variant="secondary" onClick={() => q.refetch()}>Retry</Button>}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* ── stats strip (click to filter) ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <StatTile label="Environments" value={stats.total} hint={`${stats.owners} owner${stats.owners === 1 ? '' : 's'}`} on={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
        <StatTile label="Running" value={stats.running} tone="emerald" on={statusFilter === 'running'} onClick={() => setStatusFilter(statusFilter === 'running' ? 'all' : 'running')} />
        <StatTile label="Stopped" value={stats.stopped} on={statusFilter === 'stopped'} onClick={() => setStatusFilter(statusFilter === 'stopped' ? 'all' : 'stopped')} />
        <StatTile label="Building" value={stats.building} tone="brand" on={statusFilter === 'building'} onClick={() => setStatusFilter(statusFilter === 'building' ? 'all' : 'building')} />
        <StatTile label="Failed" value={stats.failed} tone={stats.failed ? 'rose' : 'slate'} on={statusFilter === 'failed'} onClick={() => setStatusFilter(statusFilter === 'failed' ? 'all' : 'failed')} />
        <StatTile label="Outdated" value={stats.outdated} tone={stats.outdated ? 'amber' : 'slate'} hint={stats.unhealthy ? `${stats.unhealthy} unhealthy` : undefined} on={statusFilter === 'outdated'} onClick={() => setStatusFilter(statusFilter === 'outdated' ? 'all' : 'outdated')} />
        <StatTile label="Templates" value={tpls.data?.length ?? '—'} tone="violet" hint={tpls.data?.length ? 'scroll down to browse' : 'none published yet'} />
        <StatTile label="Coder" value={info.data?.version?.replace(/\+.*$/, '') ?? '—'} hint={dashboard ? dashboard.replace(/^https?:\/\//, '') : undefined} mono />
      </div>

      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle"><IconSearch /></span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, owner, template…"
            className="block h-8 w-56 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-72"
          />
        </div>
        {myOwner ? (
          <div className="flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5 text-[11px]">
            <button type="button" aria-pressed={prefs.mine} onClick={() => setPrefs((p) => ({ ...p, mine: true }))} className={cn('rounded-md px-2 py-0.5', prefs.mine ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:text-content')}>Mine</button>
            <button type="button" aria-pressed={!prefs.mine} onClick={() => setPrefs((p) => ({ ...p, mine: false }))} className={cn('rounded-md px-2 py-0.5', !prefs.mine ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:text-content')}>Everyone</button>
          </div>
        ) : null}
        <FilterSelect value={statusFilter} onChange={(v) => setStatusFilter(v as StatusFilter)} title="Status" options={[['all', 'Any status'], ['running', 'Running'], ['stopped', 'Stopped'], ['building', 'Building'], ['failed', 'Failed'], ['outdated', 'Outdated']]} />
        {tpls.data?.length ? (
          <FilterSelect value={template} onChange={setTemplate} title="Template" options={[['all', 'Any template'], ...tpls.data.map((t) => [t.name, t.display_name || t.name] as [string, string])]} />
        ) : null}
        <FilterSelect value={prefs.sort} onChange={(v) => setPrefs((p) => ({ ...p, sort: v as Sort }))} title="Sort" options={[['used', 'Recently used'], ['created', 'Newest'], ['name', 'Name A→Z'], ['status', 'Status']]} />
        <span className="text-[11px] text-content-subtle">{list.length === all.length ? `${all.length} envs` : `${list.length} of ${all.length}`}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5">
            <LayoutBtn on={prefs.layout === 'grid'} onClick={() => setPrefs((p) => ({ ...p, layout: 'grid' }))} title="Grid"><IconGrid /></LayoutBtn>
            <LayoutBtn on={prefs.layout === 'table'} onClick={() => setPrefs((p) => ({ ...p, layout: 'table' }))} title="Table"><IconList /></LayoutBtn>
          </div>
          {dashboard ? (
            <a href={dashboard} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700">Coder <IconExternal /></a>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => { q.refetch(); tpls.refetch() }} title="Refresh"><IconRefresh /></Button>
          <Button size="sm" onClick={() => setCreateOpen({})} disabled={!tpls.data?.length} title={tpls.data?.length ? undefined : 'Publish a template in Coder first'}>
            <IconPlus /> New environment
          </Button>
        </div>
      </div>

      {/* ── workspaces ── */}
      {list.length === 0 ? (
        <EmptyState
          title={all.length === 0 ? 'No environments yet' : 'No matches'}
          description={all.length === 0
            ? (tpls.data?.length ? 'Create the first cloud development environment from a template below.' : 'No templates are published in Coder yet — the platform seeds a Kubernetes starter on the next sync, or push one with `coder templates push`.')
            : 'Try a different status, template or search term.'}
          action={all.length === 0 && tpls.data?.length ? <Button size="sm" onClick={() => setCreateOpen({})}><IconPlus /> New environment</Button> : undefined}
        />
      ) : prefs.layout === 'grid' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((w) => (
            <WorkspaceCard key={w.id} workspace={w} dashboard={dashboard} onOpen={() => setOpenId(w.id)} actions={actions(w)} pending={isPending(w, start, stop, restart)} />
          ))}
        </div>
      ) : (
        <WorkspaceTable rows={list} dashboard={dashboard} onOpen={(w) => setOpenId(w.id)} actions={actions} />
      )}

      {/* ── templates ── */}
      <TemplatesSection templates={tpls.data ?? []} loading={tpls.isLoading} workspaces={all} dashboard={dashboard} onCreate={(id) => setCreateOpen({ templateId: id })} />

      <CreateWorkspaceModal
        open={!!createOpen}
        initialTemplateId={createOpen?.templateId}
        onClose={() => setCreateOpen(null)}
        templates={tpls.data ?? []}
        onCreated={(w) => { setCreateOpen(null); setOpenId(w.id) }}
      />

      {open ? (
        <WorkspaceDrawer workspace={open} dashboard={dashboard} onClose={() => setOpenId(null)} actions={actions(open)} />
      ) : null}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        description="Coder tears down the pod and its persistent volume. Anything not pushed to git is lost."
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => act(`Deleting ${confirmDelete!.name}`, () => remove.mutateAsync({ id: confirmDelete!.id }), () => { setConfirmDelete(null); if (openId === confirmDelete?.id) setOpenId(null) })}>
              {remove.isPending ? <Spinner size={12} /> : null} Delete environment
            </Button>
          </div>
        }
      >
        <p className="text-xs text-content-muted">Owner <span className="font-medium text-content">{confirmDelete?.owner_name}</span> · template <span className="font-medium text-content">{confirmDelete?.template_name}</span></p>
      </Modal>
    </div>
  )
}

function isPending(w: coder.Workspace, ...ms: Array<{ isPending: boolean; variables?: unknown }>) {
  return ms.some((m) => m.isPending && (m.variables === w.id || (typeof m.variables === 'object' && m.variables && (m.variables as { id?: string }).id === w.id)))
}

type Actions = { start(): void; stop(): void; restart(): void; update(): void; favorite(): void; delete(): void }

/* ─────────── cards / table ─────────── */

function WorkspaceCard({ workspace: w, dashboard, onOpen, actions, pending }: { workspace: coder.Workspace; dashboard: string; onOpen(): void; actions: Actions; pending: boolean }) {
  const s = status(w)
  const { agent } = primaryAgent(w)
  const code = codeApp(agent)
  const busy = BUSY.has(s) || pending
  const [menu, setMenu] = useState(false)
  const unhealthy = w.health && !w.health.healthy
  return (
    <Card className={cn('relative overflow-hidden border', s === 'failed' || unhealthy ? 'border-rose-200/70 dark:border-rose-500/30' : w.outdated ? 'border-amber-200/70 dark:border-amber-500/30' : 'border-edge-default')} interactive>
      <div className={cn('absolute inset-y-0 left-0 w-1', s === 'running' ? 'bg-emerald-500' : s === 'failed' ? 'bg-rose-500' : BUSY.has(s) ? 'bg-brand-500 animate-pulse' : 'bg-edge-default')} aria-hidden />
      <div className="p-4 pl-5">
        <div className="flex items-start gap-2">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-content">{w.favorite ? '★ ' : ''}{w.name}</span>
              <StatusBadge kind={STATUS_KIND[s]}>{s}</StatusBadge>
              {w.outdated ? <StatusBadge kind="degraded">outdated</StatusBadge> : null}
              {unhealthy ? <StatusBadge kind="failed">unhealthy</StatusBadge> : null}
            </div>
            <div className="mt-0.5 text-[11px] text-content-muted">
              <span className="font-medium text-content">{w.owner_name}</span> · {w.template_display_name || w.template_name}
              {w.latest_build.template_version_name ? <span className="text-content-subtle"> · {w.latest_build.template_version_name}</span> : null}
            </div>
          </button>
          <div className="relative shrink-0">
            <button type="button" aria-label="Environment actions" onClick={() => setMenu((m) => !m)} className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"><IconMore /></button>
            {menu ? (
              <>
                <div className="fixed inset-0 z-30" aria-hidden onClick={() => setMenu(false)} />
                <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl">
                  <MenuItem onClick={() => { setMenu(false); onOpen() }}>Details & logs</MenuItem>
                  {s === 'running' ? <MenuItem onClick={() => { setMenu(false); actions.restart() }}>Restart</MenuItem> : null}
                  {w.outdated ? <MenuItem onClick={() => { setMenu(false); actions.update() }}>Update to latest template</MenuItem> : null}
                  <MenuItem onClick={() => { setMenu(false); actions.favorite() }}>{w.favorite ? 'Unfavourite' : 'Favourite'}</MenuItem>
                  {dashboard ? <MenuItem onClick={() => { setMenu(false); window.open(coder.workspaceUrl(dashboard, w), '_blank', 'noopener') }}>Open in Coder ↗</MenuItem> : null}
                  <div className="my-1 border-t border-edge-subtle" />
                  <MenuItem danger onClick={() => { setMenu(false); actions.delete() }}>Delete…</MenuItem>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-1.5 text-[11px]">
          <Mini label="Last used" value={w.last_used_at ? formatRelative(w.last_used_at) : '—'} />
          <Mini label="Build" value={w.latest_build.created_at ? `#${w.latest_build.build_number ?? '?'} · ${formatRelative(w.latest_build.created_at)}` : w.latest_build.transition} />
          <Mini label="TTL" value={w.ttl_ms ? `${Math.round(w.ttl_ms / 3_600_000)}h` : 'none'} />
        </div>

        {agent?.apps?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {agent.apps.map((a) => {
              const url = coder.appUrl(dashboard, w, agent.name, a)
              const ok = a.health === 'healthy' || a.health === 'disabled' || !a.health
              return (
                <a key={a.slug} href={url ?? '#'} target="_blank" rel="noopener" onClick={(e) => { if (!url || s !== 'running') e.preventDefault() }} className={cn('inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium ring-1 ring-edge-subtle', s === 'running' && url ? 'text-content hover:ring-brand-400' : 'text-content-subtle')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', s === 'running' ? (ok ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-edge-default')} />
                  {a.display_name || a.slug}
                </a>
              )
            })}
          </div>
        ) : null}

        {w.latest_build.job?.error ? <p className="mt-2 line-clamp-2 text-[11px] text-rose-700 dark:text-rose-300">{w.latest_build.job.error}</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-edge-subtle bg-surface-sunken/40 px-4 py-2">
        {s === 'running' ? (
          <Button size="xs" variant="secondary" onClick={actions.stop} loading={pending} disabled={busy && !pending}>Stop</Button>
        ) : STARTABLE.has(s) ? (
          <Button size="xs" onClick={actions.start} loading={pending}>Start</Button>
        ) : (
          <Button size="xs" variant="ghost" disabled loading>{s}</Button>
        )}
        {s === 'running' && agent && code ? (
          <Button size="xs" variant="ghost" onClick={() => window.open(coder.appUrl(dashboard, w, agent.name, code), '_blank', 'noopener')}>Open IDE</Button>
        ) : null}
        {s === 'running' && agent && dashboard ? (
          <Button size="xs" variant="ghost" onClick={() => window.open(coder.terminalUrl(dashboard, w, agent.name), '_blank', 'noopener')}>Terminal</Button>
        ) : null}
        <span className="ml-auto text-[10px] text-content-subtle">agent {agent?.status ?? 'none'}{agent?.lifecycle_state && agent.lifecycle_state !== 'ready' ? ` · ${agent.lifecycle_state}` : ''}</span>
      </div>
    </Card>
  )
}

function WorkspaceTable({ rows, dashboard, onOpen, actions }: { rows: coder.Workspace[]; dashboard: string; onOpen(w: coder.Workspace): void; actions(w: coder.Workspace): Actions }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-sunken/60 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          <tr>
            <th className="px-3 py-2">Environment</th>
            <th className="px-3 py-2">Owner</th>
            <th className="px-3 py-2">Template</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Agent</th>
            <th className="px-3 py-2">Last used</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {rows.map((w) => {
            const s = status(w)
            const { agent } = primaryAgent(w)
            const a = actions(w)
            return (
              <tr key={w.id} className="hover:bg-surface-sunken/40">
                <td className="px-3 py-2"><button type="button" onClick={() => onOpen(w)} className="font-semibold text-content hover:text-brand-700 dark:hover:text-brand-300">{w.favorite ? '★ ' : ''}{w.name}</button></td>
                <td className="px-3 py-2 text-content-muted">{w.owner_name}</td>
                <td className="px-3 py-2 text-content-muted">{w.template_display_name || w.template_name}{w.outdated ? <span className="ml-1 text-amber-700 dark:text-amber-300">· outdated</span> : null}</td>
                <td className="px-3 py-2"><StatusBadge kind={STATUS_KIND[s]}>{s}</StatusBadge></td>
                <td className="px-3 py-2 text-content-muted">{agent?.status ?? '—'}</td>
                <td className="px-3 py-2 text-content-muted">{w.last_used_at ? formatRelative(w.last_used_at) : '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    {s === 'running' ? <Button size="xs" variant="ghost" onClick={a.stop}>Stop</Button> : STARTABLE.has(s) ? <Button size="xs" variant="ghost" onClick={a.start}>Start</Button> : null}
                    {s === 'running' && agent && dashboard ? <Button size="xs" variant="ghost" onClick={() => window.open(coder.terminalUrl(dashboard, w, agent.name), '_blank', 'noopener')}>Terminal</Button> : null}
                    <Button size="xs" variant="ghost" onClick={() => onOpen(w)}>Open</Button>
                    <Button size="xs" variant="ghost" className="text-rose-700 dark:text-rose-300" onClick={a.delete}>Delete</Button>
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

/* ─────────── templates ─────────── */

function TemplatesSection({ templates, loading, workspaces, dashboard, onCreate }: { templates: coder.Template[]; loading: boolean; workspaces: coder.Workspace[]; dashboard: string; onCreate(templateId: string): void }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const w of workspaces) m.set(w.template_id, (m.get(w.template_id) ?? 0) + 1)
    return m
  }, [workspaces])
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-content">Templates <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">{templates.length}</span>{loading ? <Spinner size={10} /> : null}</div>
          {dashboard ? <a href={`${dashboard}/templates`} target="_blank" rel="noopener" className="text-[11px] text-brand-700 hover:underline dark:text-brand-300">Manage in Coder ↗</a> : null}
        </div>
      </CardHeader>
      <CardBody>
        {templates.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {templates.map((t) => (
              <div key={t.id} className={cn('flex flex-col rounded-xl border p-3', t.deprecated ? 'border-edge-subtle opacity-70' : 'border-edge-default')}>
                <div className="flex items-start gap-2">
                  {t.icon && dashboard ? <img src={t.icon.startsWith('http') ? t.icon : `${dashboard}${t.icon}`} alt="" className="h-7 w-7 rounded-md bg-surface-sunken object-contain p-0.5" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-content">{t.display_name || t.name}</span>
                      {t.deprecated ? <StatusBadge kind="degraded">deprecated</StatusBadge> : null}
                    </div>
                    <div className="text-[10.5px] font-mono text-content-subtle">{t.name}{t.organization_name ? ` · ${t.organization_name}` : ''}</div>
                  </div>
                </div>
                <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-content-muted">{t.description || 'No description.'}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-content-subtle">
                  <span>{counts.get(t.id) ?? 0} env{(counts.get(t.id) ?? 0) === 1 ? '' : 's'}</span>
                  <span>{t.active_user_count ?? 0} active user{(t.active_user_count ?? 0) === 1 ? '' : 's'}</span>
                  {t.build_time_stats?.start?.p50 ? <span>boot p50 {Math.round(t.build_time_stats.start.p50 / 1000)}s</span> : null}
                  {t.default_ttl_ms ? <span>TTL {Math.round(t.default_ttl_ms / 3_600_000)}h</span> : null}
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  <Button size="xs" onClick={() => onCreate(t.id)} disabled={t.deprecated}><IconPlus size={12} /> Create</Button>
                  {dashboard ? <a href={`${dashboard}/templates/${t.organization_name ?? 'default'}/${t.name}`} target="_blank" rel="noopener" className="text-[11px] text-content-muted hover:text-content">Details ↗</a> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState compact title="No templates" description="The platform seeds a Kubernetes starter template on the next Coder sync; you can also push one with the coder CLI." />
        )}
      </CardBody>
    </Card>
  )
}

/* ─────────── create ─────────── */

function CreateWorkspaceModal({ open, initialTemplateId, onClose, templates, onCreated }: { open: boolean; initialTemplateId?: string; onClose(): void; templates: coder.Template[]; onCreated(w: coder.Workspace): void }) {
  const create = useCreateWorkspace()
  const orgs = useOrganizations()
  const owner = useWorkspaceOwner()
  const toast = useToast()
  const [name, setName] = useState('')
  const [tplId, setTplId] = useState('')
  const [ttlHours, setTtlHours] = useState(8)
  const [autoUpdate, setAutoUpdate] = useState(true)
  const [values, setValues] = useState<Record<string, string>>({})
  const tpl = templates.find((t) => t.id === tplId)
  const params = useTemplateParameters(tpl?.active_version_id)

  useEffect(() => {
    if (!open) return
    setName('')
    const first = templates.find((t) => t.id === initialTemplateId) ?? templates.find((t) => !t.deprecated) ?? templates[0]
    setTplId(first?.id ?? '')
    setTtlHours(first?.default_ttl_ms ? Math.max(1, Math.round(first.default_ttl_ms / 3_600_000)) : 8)
    setValues({})
  }, [open, templates, initialTemplateId])

  useEffect(() => {
    if (!params.data) return
    setValues((v) => {
      const next = { ...v }
      for (const p of params.data) if (next[p.name] === undefined && p.default_value !== undefined) next[p.name] = p.default_value
      return next
    })
  }, [params.data])

  const valid = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(name) && !!tpl && (params.data ?? []).every((p) => !p.required || (values[p.name] ?? '') !== '')
  const orgId = tpl?.organization_id ?? orgs.data?.find((o) => o.is_default)?.id ?? orgs.data?.[0]?.id

  const submit = async () => {
    if (!valid || !tpl || !orgId) return
    try {
      const w = await create.mutateAsync({
        orgId,
        owner: owner.data?.owner ?? 'me',
        body: {
          name,
          template_version_id: tpl.active_version_id,
          ...(tpl.active_version_id ? {} : { template_id: tpl.id }),
          rich_parameter_values: (params.data ?? []).filter((p) => values[p.name] !== undefined).map((p) => ({ name: p.name, value: values[p.name] })),
          ttl_ms: ttlHours > 0 ? ttlHours * 3_600_000 : undefined,
          automatic_updates: autoUpdate ? 'always' : 'never',
        },
      })
      toast.success(`Creating ${w.name}`, { description: `Owned by ${w.owner_name} · ${tpl.display_name || tpl.name}` })
      onCreated(w)
    } catch (e) {
      toast.error('Could not create the environment', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New cloud environment"
      description="Coder provisions a workspace from the template and connects an agent with code-server and a terminal."
      branded
      width="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-content-subtle">
            {owner.data ? (owner.data.matched ? `Owner: ${owner.data.owner}` : `Owner: ${owner.data.owner} (sign in to Coder once to own environments yourself)`) : 'Resolving owner…'}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!valid || !orgId || create.isPending} loading={create.isPending}>Create environment</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <Field label="Name" required error={name && !/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(name) ? 'lowercase letters, digits and dashes (max 32)' : undefined}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="my-feature" onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Field label="Auto-stop after" hint="hours">
            <Input type="number" min={0} max={168} value={ttlHours} onChange={(e) => setTtlHours(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
        </div>
        <div>
          <div className="text-sm font-medium text-content">Template</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {templates.map((t) => {
              const on = tplId === t.id
              return (
                <button key={t.id} type="button" onClick={() => { setTplId(t.id); setValues({}); if (t.default_ttl_ms) setTtlHours(Math.max(1, Math.round(t.default_ttl_ms / 3_600_000))) }} disabled={t.deprecated} className={cn('rounded-lg border p-3 text-left', on ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong', t.deprecated && 'opacity-50')}>
                  <div className="text-sm font-semibold text-content">{t.display_name || t.name}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">{t.description || t.name}</div>
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-content-subtle">
                    <span>{t.active_user_count ?? 0} active users</span>
                    {t.build_time_stats?.start?.p50 ? <span>· p50 boot {Math.round(t.build_time_stats.start.p50 / 1000)}s</span> : null}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
        {params.isLoading ? <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={12} /> Loading template parameters…</div> : null}
        {params.data?.filter((p) => !p.ephemeral).length ? (
          <div>
            <div className="text-sm font-medium text-content">Parameters</div>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {params.data.filter((p) => !p.ephemeral).map((p) => (
                <Field key={p.name} label={p.display_name || p.name} required={p.required} hint={p.description}>
                  {p.options?.length ? (
                    <Select value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} options={p.options.map((o) => ({ value: o.value, label: o.name }))} />
                  ) : p.type === 'bool' ? (
                    <Checkbox label={values[p.name] === 'true' ? 'Enabled' : 'Disabled'} checked={values[p.name] === 'true'} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.checked ? 'true' : 'false' }))} />
                  ) : (
                    <Input type={p.type === 'number' ? 'number' : 'text'} min={p.validation_min ?? undefined} max={p.validation_max ?? undefined} value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
                  )}
                </Field>
              ))}
            </div>
          </div>
        ) : null}
        <Checkbox label="Update automatically" description="Rebuild on the newest template version whenever the environment starts." checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} />
      </div>
    </Modal>
  )
}

/* ─────────── drawer ─────────── */

function WorkspaceDrawer({ workspace: w, dashboard, onClose, actions }: { workspace: coder.Workspace; dashboard: string; onClose(): void; actions: Actions }) {
  const s = status(w)
  const builds = useBuilds(w.id)
  const cancel = useCancelBuild()
  const ttl = useUpdateTtl()
  const toast = useToast()
  const [tab, setTab] = useState<'overview' | 'logs' | 'builds' | 'settings'>('overview')
  const [ttlHours, setTtlHours] = useState(w.ttl_ms ? Math.round(w.ttl_ms / 3_600_000) : 0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  const { agent } = primaryAgent(w)
  const code = codeApp(agent)
  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      toast.success(label)
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-lg font-semibold tracking-tight text-content">{w.name}</h2>
              <StatusBadge kind={STATUS_KIND[s]}>{s}</StatusBadge>
              {w.outdated ? <StatusBadge kind="degraded">outdated</StatusBadge> : null}
              {w.health && !w.health.healthy ? <StatusBadge kind="failed">unhealthy</StatusBadge> : null}
            </div>
            <div className="mt-0.5 text-[11px] text-content-muted">
              {w.owner_name} · {w.template_display_name || w.template_name} · created {formatRelative(w.created_at)}{w.last_used_at ? ` · used ${formatRelative(w.last_used_at)}` : ''}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {s === 'running' ? <Button size="sm" variant="secondary" onClick={actions.stop}>Stop</Button> : STARTABLE.has(s) ? <Button size="sm" onClick={actions.start}>Start</Button> : BUSY.has(s) ? <Button size="sm" variant="secondary" disabled={cancel.isPending} onClick={() => act('Cancelling build', () => cancel.mutateAsync(w.latest_build.id))}>Cancel build</Button> : null}
            {s === 'running' && agent && code ? <Button size="sm" onClick={() => window.open(coder.appUrl(dashboard, w, agent.name, code), '_blank', 'noopener')}>Open IDE</Button> : null}
            {dashboard ? <a href={coder.workspaceUrl(dashboard, w)} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700">Coder <IconExternal /></a> : null}
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"><IconClose /></button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <Tabs
            ariaLabel="Environment"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'logs', label: 'Build logs', badge: BUSY.has(s) ? { kind: 'progressing', value: 'live' } : undefined },
              { id: 'builds', label: 'Builds', badge: builds.data?.length ? { kind: 'unknown', value: builds.data.length } : undefined },
              { id: 'settings', label: 'Settings' },
            ]}
          >
            {(active) => (
              <div className="space-y-4 pt-4">
                {active === 'overview' ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Tile label="Build" value={`#${w.latest_build.build_number ?? '?'} ${w.latest_build.transition}`} />
                      <Tile label="Job" value={w.latest_build.job?.status ?? '—'} />
                      <Tile label="TTL" value={w.ttl_ms ? `${Math.round(w.ttl_ms / 3_600_000)}h` : 'none'} />
                      <Tile label="Deadline" value={w.latest_build.deadline && !w.latest_build.deadline.startsWith('0001') ? formatRelative(w.latest_build.deadline) : '—'} />
                    </div>
                    {w.latest_build.job?.error ? <div className="rounded-lg border border-rose-200/70 bg-rose-50/60 p-3 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">{w.latest_build.job.error}</div> : null}
                    <Card>
                      <CardHeader><div className="text-sm font-semibold text-content">Resources & agents</div></CardHeader>
                      <CardBody>
                        {w.latest_build.resources?.length ? (
                          <div className="space-y-3">
                            {w.latest_build.resources.map((r) => (
                              <div key={`${r.type}/${r.name}`} className="rounded-lg border border-edge-subtle p-3">
                                <div className="flex items-center gap-2">
                                  <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">{r.type}</span>
                                  <span className="text-sm font-medium text-content">{r.name}</span>
                                </div>
                                {r.agents?.length ? (
                                  <ul className="mt-2 space-y-2">
                                    {r.agents.map((a) => (
                                      <li key={a.name} className="rounded-md bg-surface-sunken/40 p-2">
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                          <span className="font-medium text-content">{a.name}</span>
                                          <div className="flex items-center gap-1.5">
                                            {a.lifecycle_state ? <StatusBadge kind={a.lifecycle_state === 'ready' ? 'healthy' : /error|timeout/.test(a.lifecycle_state) ? 'failed' : 'progressing'}>{a.lifecycle_state}</StatusBadge> : null}
                                            <StatusBadge kind={a.status === 'connected' ? 'healthy' : a.status === 'connecting' ? 'progressing' : 'failed'}>{a.status}</StatusBadge>
                                          </div>
                                        </div>
                                        <div className="mt-1 text-[10px] text-content-subtle">{a.operating_system} / {a.architecture}{a.version ? ` · agent ${a.version}` : ''}{a.last_connected_at ? ` · seen ${formatRelative(a.last_connected_at)}` : ''}</div>
                                        {a.apps?.length ? (
                                          <div className="mt-2 flex flex-wrap gap-1.5">
                                            {a.apps.map((app) => {
                                              const url = coder.appUrl(dashboard, w, a.name, app)
                                              return (
                                                <a key={app.slug} href={url ?? '#'} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-md bg-surface-raised px-2 py-1 text-[11px] font-medium text-brand-700 ring-1 ring-edge-subtle hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10">
                                                  <span className={cn('h-1.5 w-1.5 rounded-full', app.health === 'unhealthy' ? 'bg-rose-500' : app.health === 'initializing' ? 'bg-amber-500' : 'bg-emerald-500')} />
                                                  {app.display_name || app.slug}
                                                </a>
                                              )
                                            })}
                                            {dashboard ? <a href={coder.terminalUrl(dashboard, w, a.name)} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-md bg-surface-raised px-2 py-1 text-[11px] font-medium text-content ring-1 ring-edge-subtle hover:bg-surface-sunken">Terminal</a> : null}
                                          </div>
                                        ) : null}
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : <EmptyState compact title="No resources yet" description={BUSY.has(s) ? 'Provisioning — watch the build logs.' : 'Start the environment to provision its pod.'} />}
                      </CardBody>
                    </Card>
                  </>
                ) : null}
                {active === 'logs' ? <BuildLogs buildId={w.latest_build.id} live={BUSY.has(s)} /> : null}
                {active === 'builds' ? (
                  <Card>
                    <CardHeader><div className="text-sm font-semibold text-content">Build history</div></CardHeader>
                    <CardBody>
                      {builds.data?.length ? (
                        <ul className="divide-y divide-edge-subtle">
                          {builds.data.map((b) => (
                            <li key={b.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                              <code className="font-mono text-[10px] text-content-subtle">#{b.build_number ?? '?'}</code>
                              <span className="font-medium capitalize text-content">{b.transition}</span>
                              <StatusBadge kind={STATUS_KIND[b.status]}>{b.status}</StatusBadge>
                              {b.template_version_name ? <span className="font-mono text-[10px] text-content-subtle">{b.template_version_name}</span> : null}
                              {b.reason ? <span className="text-content-subtle">{b.reason}</span> : null}
                              <span className="ml-auto text-content-subtle">{b.initiator_name ? `${b.initiator_name} · ` : ''}{b.created_at ? formatRelative(b.created_at) : ''}</span>
                            </li>
                          ))}
                        </ul>
                      ) : <EmptyState compact title="No builds" />}
                    </CardBody>
                  </Card>
                ) : null}
                {active === 'settings' ? (
                  <>
                    <Card>
                      <CardHeader><div className="text-sm font-semibold text-content">Auto-stop</div></CardHeader>
                      <CardBody>
                        <div className="flex flex-wrap items-end gap-2">
                          <Field label="Stop after" hint="hours of inactivity · 0 = never" className="w-40">
                            <Input type="number" min={0} max={168} value={ttlHours} onChange={(e) => setTtlHours(Math.max(0, Number(e.target.value) || 0))} />
                          </Field>
                          <Button size="sm" disabled={ttl.isPending} onClick={() => act('Auto-stop updated', () => ttl.mutateAsync({ id: w.id, ttlMs: ttlHours > 0 ? ttlHours * 3_600_000 : null }))}>Save</Button>
                        </div>
                        {w.autostart_schedule ? <p className="mt-3 text-[11px] text-content-muted">Autostart: <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono">{w.autostart_schedule}</code></p> : null}
                      </CardBody>
                    </Card>
                    <Card>
                      <CardHeader><div className="text-sm font-semibold text-content">Template</div></CardHeader>
                      <CardBody className="space-y-2 text-xs text-content-muted">
                        <div>Version <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10.5px]">{w.latest_build.template_version_name ?? w.latest_build.template_version_id ?? '—'}</code>{w.outdated ? <span className="ml-2 text-amber-700 dark:text-amber-300">a newer version is active</span> : null}</div>
                        <div>Automatic updates: <span className="font-medium text-content">{w.automatic_updates ?? 'never'}</span></div>
                        {w.outdated ? <Button size="sm" variant="secondary" onClick={actions.update}>Update to latest version</Button> : null}
                      </CardBody>
                    </Card>
                    <Card className="border-rose-200/70 dark:border-rose-500/30">
                      <CardHeader><div className="text-sm font-semibold text-rose-700 dark:text-rose-300">Danger zone</div></CardHeader>
                      <CardBody>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-content">Delete environment</div>
                            <div className="text-xs text-content-muted">Tears down the pod and the home volume.</div>
                          </div>
                          <Button size="sm" variant="danger" onClick={actions.delete}>Delete…</Button>
                        </div>
                      </CardBody>
                    </Card>
                  </>
                ) : null}
              </div>
            )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/** Coder's own log levels, mapped onto the console's severity scale. */
const CODER_LEVEL: Record<string, Severity> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'debug',
}

function BuildLogs({ buildId, live }: { buildId: string; live: boolean }) {
  const logs = useBuildLogs(buildId, live)

  /* Provisioner logs arrive as structured records over Coder's API rather than
     as a byte stream, so they are mapped onto the same `LogLine` shape the
     Kubernetes transport produces — and render through the very same console as
     the CI/CD run logs, with search, wrap, timestamps, copy, download and
     fullscreen for free. The build stage becomes the gutter prefix. */
  const lines = useMemo<LogLine[]>(
    () =>
      (logs.data ?? []).map((l) => ({
        ts: l.created_at,
        text: l.output ?? '',
        source: l.stage,
        severity: CODER_LEVEL[l.log_level ?? ''] ?? detectSeverity(l.output ?? ''),
      })),
    [logs.data],
  )

  const status = logs.isLoading
    ? 'connecting'
    : logs.isError
    ? 'error'
    : live
    ? 'streaming'
    : lines.length
    ? 'paused'
    : 'empty'

  return (
    <LogConsole
      lines={lines}
      status={status}
      error={logs.error instanceof Error ? logs.error.message : undefined}
      label="Provisioner"
      live={live}
      filename={`build-${buildId.slice(0, 8)}`}
      height="h-[60vh]"
      emptyMessage={live ? 'Waiting for provisioner output…' : 'This build produced no logs.'}
    />
  )
}

/* ─────────── bits ─────────── */

type Tone = 'slate' | 'brand' | 'amber' | 'emerald' | 'rose' | 'violet'
function StatTile({ label, value, hint, tone = 'slate', on = false, onClick, mono = false }: { label: string; value: number | string; hint?: string; tone?: Tone; on?: boolean; onClick?(): void; mono?: boolean }) {
  const color = { slate: 'text-content', brand: 'text-brand-700 dark:text-brand-300', amber: 'text-amber-700 dark:text-amber-300', emerald: 'text-emerald-700 dark:text-emerald-300', rose: 'text-rose-700 dark:text-rose-300', violet: 'text-violet-700 dark:text-violet-300' }[tone]
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} aria-pressed={onClick ? on : undefined} className={cn('flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors', on ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised', onClick && 'hover:border-brand-300')}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('truncate text-lg font-semibold leading-none tracking-tight tabular-nums', mono && 'font-mono text-[13px] leading-5', color)}>{value}</span>
      {hint ? <span className="truncate text-[10.5px] text-content-subtle">{hint}</span> : <span className="text-[10.5px]">&nbsp;</span>}
    </Tag>
  )
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-2 py-1">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className="truncate text-content" title={value}>{value}</div>
    </div>
  )
}
function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="truncate text-base font-semibold tabular-nums text-content">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
    </div>
  )
}
function FilterSelect({ value, onChange, options, title }: { value: string; onChange(v: string): void; options: Array<[string, string]>; title: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title} aria-label={title} className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20">
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  )
}
function LayoutBtn({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-pressed={on} onClick={onClick} className={cn('flex h-7 w-7 items-center justify-center rounded-md transition-colors', on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:text-content')}>{children}</button>
  )
}
function MenuItem({ onClick, children, danger = false }: { onClick(): void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-sunken', danger ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted hover:text-content')}>{children}</button>
  )
}

export default Environments
