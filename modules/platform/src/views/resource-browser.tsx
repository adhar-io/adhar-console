import { useEffect, useMemo, useState } from 'react'
import {
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type Column,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { kube } from '@adhar-console/api-clients/k8s'
import type { GatewayGVR as GVR, KubeObject, DiscoveredResource } from '@adhar-console/api-clients/k8s'
import { age } from '../data/format.ts'
import { useAccess, useDiscovery, useLiveList, type LiveStatus } from '../data/live.ts'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { ListShell, matchesSearch } from './list-shell.tsx'
import { ManifestEditor } from './manifest-editor.tsx'

/** GVR the live hook falls back to while nothing is selected (kept disabled). */
const IDLE_GVR: GVR = { group: '', version: 'v1', resource: 'namespaces', namespaced: false }

interface Props {
  namespace?: string
}

/**
 * Discovery-driven universal resource browser. The left rail lists every
 * listable, non-subresource kind grouped by API group; the main panel holds a
 * live watch-backed table plus an inline manifest editor.
 */
export function ResourceBrowser({ namespace: initialNamespace }: Props = {}) {
  const discovery = useDiscovery()
  const [railSearch, setRailSearch] = useState('')
  const [selKey, setSelKey] = useState<string | null>(null)
  const [namespace, setNamespace] = useState<string | undefined>(initialNamespace)
  const [labelSelector, setLabelSelector] = useState('')
  const [nameSearch, setNameSearch] = useState('')
  const [editing, setEditing] = useState<{ namespace?: string; name: string } | null>(null)

  // Listable, non-subresource kinds, deduped by group+resource (prefer first).
  const kinds = useMemo(() => {
    const seen = new Map<string, DiscoveredResource>()
    for (const r of discovery.data ?? []) {
      if (r.subresource || !r.verbs.includes('list')) continue
      const key = `${r.group}/${r.name}`
      if (!seen.has(key)) seen.set(key, r)
    }
    return [...seen.values()]
  }, [discovery.data])

  const keyOf = (r: DiscoveredResource) => `${r.group}/${r.version}/${r.name}`
  const selected = useMemo(() => kinds.find((r) => keyOf(r) === selKey) ?? null, [kinds, selKey])

  // Default to Pods (or the first kind) once discovery resolves.
  useEffect(() => {
    if (selKey || kinds.length === 0) return
    const pods = kinds.find((r) => r.group === '' && r.name === 'pods')
    setSelKey(keyOf(pods ?? kinds[0]))
  }, [kinds, selKey])

  // Reset per-kind filters + close the editor when the selection changes.
  useEffect(() => {
    setNameSearch('')
    setLabelSelector('')
    setEditing(null)
  }, [selKey])

  const groups = useMemo(() => {
    const byGroup = new Map<string, DiscoveredResource[]>()
    for (const r of kinds) {
      if (railSearch && !matchesSearch(r.kind, railSearch) && !matchesSearch(r.name, railSearch)) continue
      const g = r.group === '' ? 'core' : r.group
      const arr = byGroup.get(g) ?? []
      arr.push(r)
      byGroup.set(g, arr)
    }
    return [...byGroup.entries()]
      .map(([group, items]) => ({
        group,
        items: items.sort((a, b) => a.kind.localeCompare(b.kind)),
      }))
      .sort((a, b) => (a.group === 'core' ? -1 : b.group === 'core' ? 1 : a.group.localeCompare(b.group)))
  }, [kinds, railSearch])

  const gvr: GVR = selected
    ? { group: selected.group, version: selected.version, resource: selected.name, namespaced: selected.namespaced }
    : IDLE_GVR

  const live = useLiveList(gvr, {
    namespace: selected?.namespaced ? namespace : undefined,
    labelSelector: labelSelector.trim() || undefined,
    enabled: !!selected,
  })

  const all = live.data
  const rows = useMemo(() => {
    if (!nameSearch) return all
    return all.filter(
      (o) => matchesSearch(o.metadata.name, nameSearch) || matchesSearch(o.metadata.namespace, nameSearch),
    )
  }, [all, nameSearch])

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-2">
        <div className="relative">
          <input
            type="search"
            value={railSearch}
            onChange={(e) => setRailSearch(e.target.value)}
            placeholder="Filter kinds…"
            className={cn(
              'h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle',
              'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
            )}
          />
        </div>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          {discovery.isLoading ? (
            <div className="flex items-center gap-2 px-2 py-4 text-xs text-content-muted">
              <Spinner size={14} /> Discovering resources…
            </div>
          ) : discovery.isError ? (
            <div className="px-2 py-4 text-xs text-rose-700 dark:text-rose-300">{(discovery.error as Error)?.message ?? 'Discovery failed'}</div>
          ) : groups.length === 0 ? (
            <div className="px-2 py-4 text-xs text-content-subtle">No matching kinds.</div>
          ) : (
            groups.map(({ group, items }) => (
              <div key={group} className="space-y-0.5">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  {group}
                </div>
                {items.map((r) => {
                  const key = keyOf(r)
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelKey(key)}
                      title={`${r.group || 'core'}/${r.version}/${r.name}`}
                      className={cn(
                        'block w-full truncate rounded-md px-3 py-1.5 text-left text-sm transition-colors',
                        selKey === key
                          ? 'bg-brand-50 dark:bg-brand-500/10 font-medium text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-500/25'
                          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                      )}
                    >
                      {r.kind}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        {!selected ? (
          <EmptyState title="Pick a resource" description="Choose a kind from the left to browse live objects." />
        ) : (
          <>
            <ListShell
              title={selected.kind}
              total={all.length}
              visible={rows.length}
              loading={live.isLoading}
              search={nameSearch}
              onSearchChange={setNameSearch}
              onRefresh={() => live.refetch()}
              searchPlaceholder="Search by name…"
              caption={
                <code className="font-mono">
                  {gvr.group ? `${gvr.group}/` : ''}
                  {gvr.version}/{gvr.resource}
                </code>
              }
              filters={
                <div className="flex flex-wrap items-center gap-2">
                  <LiveDot status={live.status} />
                  {selected.namespaced ? <NamespacePicker value={namespace} onChange={setNamespace} /> : null}
                  <input
                    type="text"
                    value={labelSelector}
                    onChange={(e) => setLabelSelector(e.target.value)}
                    placeholder="label selector, e.g. app=nginx"
                    className={cn(
                      'h-8 w-56 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-xs text-content placeholder:text-content-subtle',
                      'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
                    )}
                  />
                </div>
              }
            >
              {live.isError ? (
                <EmptyState title="Couldn't list" description={(live.error as Error)?.message ?? 'Watch failed.'} />
              ) : (
                <DataTable<KubeObject>
                  loading={live.isLoading}
                  columns={buildColumns(gvr, selected.namespaced, {
                    onYaml: (o) => setEditing({ namespace: o.metadata.namespace, name: o.metadata.name }),
                  })}
                  rows={rows}
                  rowKey={(o) => o.metadata.uid ?? `${o.metadata.namespace ?? '-'}/${o.metadata.name}`}
                  empty={
                    <EmptyState
                      title={`No ${selected.kind}`}
                      description={
                        nameSearch || labelSelector
                          ? 'No objects match the active filters.'
                          : `No ${selected.name} found${namespace && selected.namespaced ? ` in ${namespace}` : ''}.`
                      }
                    />
                  }
                />
              )}
            </ListShell>

            {editing ? (
              <ManifestEditor
                gvr={gvr}
                namespace={selected.namespaced ? editing.namespace : undefined}
                name={editing.name}
                onClose={() => setEditing(null)}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function buildColumns(
  gvr: GVR,
  namespaced: boolean,
  handlers: { onYaml(o: KubeObject): void },
): Column<KubeObject>[] {
  const cols: Column<KubeObject>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (o) => <span className="font-medium text-content">{o.metadata.name}</span>,
    },
  ]
  if (namespaced) {
    cols.push({
      key: 'ns',
      header: 'Namespace',
      cell: (o) => o.metadata.namespace ?? <span className="text-content-subtle">—</span>,
    })
  }
  cols.push(
    {
      key: 'status',
      header: 'Status',
      cell: (o) => {
        const s = deriveStatus(o)
        return <StatusBadge kind={s.kind}>{s.text}</StatusBadge>
      },
    },
    { key: 'age', header: 'Age', cell: (o) => age(o.metadata.creationTimestamp) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: 'auto',
      cell: (o) => <RowActions gvr={gvr} obj={o} onYaml={handlers.onYaml} />,
    },
  )
  return cols
}

function RowActions({ gvr, obj, onYaml }: { gvr: GVR; obj: KubeObject; onYaml(o: KubeObject): void }) {
  const ns = obj.metadata.namespace
  const name = obj.metadata.name
  const canDelete = useAccess({ verb: 'delete', group: gvr.group, resource: gvr.resource, namespace: ns, name })
  const [deleting, setDeleting] = useState(false)

  async function onDelete() {
    const target = ns ? `${ns}/${name}` : name
    if (!window.confirm(`Delete ${gvr.resource} "${target}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await kube.delete(gvr, ns, name, { propagationPolicy: 'Foreground' })
    } catch (e) {
      window.alert(`Delete failed — ${(e as Error).message}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={() => onYaml(obj)}
        title="Edit manifest"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] font-medium text-content-muted transition-colors hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300"
      >
        YAML
      </button>
      {canDelete.data ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          title="Delete"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-edge-default bg-surface-raised text-content-muted transition-colors hover:border-rose-300 hover:text-rose-700 dark:hover:text-rose-300 disabled:opacity-50"
        >
          {deleting ? <Spinner size={12} /> : <TrashGlyph />}
        </button>
      ) : null}
    </div>
  )
}

/** Best-effort status derived from the common shapes across K8s objects. */
function deriveStatus(obj: KubeObject): { text: string; kind: StatusKind } {
  const st = obj.status as Record<string, unknown> | undefined
  if (st) {
    if (typeof st.phase === 'string') return { text: st.phase, kind: phaseKind(st.phase) }

    if (typeof st.readyReplicas === 'number' || typeof st.replicas === 'number') {
      const ready = (st.readyReplicas as number) ?? 0
      const total = (st.replicas as number) ?? 0
      return {
        text: `${ready}/${total}`,
        kind: total === 0 ? 'unknown' : ready >= total ? 'healthy' : 'progressing',
      }
    }

    const conds = st.conditions as Array<{ type: string; status: string; reason?: string }> | undefined
    if (Array.isArray(conds) && conds.length) {
      const c = conds[conds.length - 1]
      const text = c.reason || c.type
      const kind: StatusKind = c.status === 'True' ? 'healthy' : c.status === 'False' ? 'failed' : 'unknown'
      return { text, kind }
    }
  }
  return { text: '—', kind: 'unknown' }
}

function phaseKind(phase: string): StatusKind {
  if (['Running', 'Active', 'Succeeded', 'Bound', 'Available', 'Ready'].includes(phase)) return 'healthy'
  if (['Pending', 'Progressing', 'Provisioning', 'Terminating'].includes(phase)) return 'progressing'
  if (['Failed', 'Error', 'Lost', 'CrashLoopBackOff'].includes(phase)) return 'failed'
  return 'info'
}

function LiveDot({ status }: { status: LiveStatus }) {
  const tone =
    status === 'live'
      ? 'text-emerald-600'
      : status === 'error'
        ? 'text-rose-600'
        : 'text-amber-600'
  const label =
    status === 'live' ? 'live' : status === 'error' ? 'error' : status === 'reconnecting' ? 'reconnecting' : 'connecting'
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', tone)}>
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current', status !== 'live' && 'animate-pulse')} />
      {label}
    </span>
  )
}

function TrashGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export default ResourceBrowser
