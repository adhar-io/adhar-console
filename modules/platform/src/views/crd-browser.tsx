import { useMemo, useState } from 'react'
import { Button, DataTable, EmptyState, Input, Select, Spinner, StatusBadge, Tabs, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useGeneric } from '../data/hooks.ts'
import { age } from '../data/format.ts'
import { type CrHealth, crStatus, groupLabel, HEALTH_BADGE } from '../data/crd-status.ts'
import { DrawerSection, ResourceDrawer, Row } from './resource-drawer.tsx'
import { PodYamlPanel } from './pod-yaml.tsx'

interface Props {
  namespace?: string
}

/**
 * Custom Resources — the operator-managed objects the platform runs on.
 *
 * Top tabs, one per kind the Adhar stack ships an operator for (each with a
 * live count, so an empty or missing kind is visible before you click), and
 * an "All definitions" tab that lists every CustomResourceDefinition in the
 * cluster and opens any of them as a browsable list. Health is read the way
 * each operator reports it (`crd-status.ts`); nothing is inferred beyond that.
 */

interface KindDef {
  id: string
  label: string
  description: string
  gvr: { group: string; version: string; resource: string; namespaced: boolean }
}

const KINDS: KindDef[] = [
  { id: 'argocd-apps', label: 'Argo CD apps', description: 'GitOps applications and their sync / health state.', gvr: { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true } },
  { id: 'rollouts', label: 'Rollouts', description: 'Argo Rollouts — canary and blue-green deployments.', gvr: { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts', namespaced: true } },
  { id: 'kargo-stages', label: 'Kargo stages', description: 'Promotion stages and the freight they run.', gvr: { group: 'kargo.akuity.io', version: 'v1alpha1', resource: 'stages', namespaced: true } },
  { id: 'pipelineruns', label: 'Tekton runs', description: 'CI PipelineRuns and their outcome.', gvr: { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true } },
  { id: 'compositions', label: 'Compositions', description: 'Crossplane compositions behind every Adhar resource.', gvr: { group: 'apiextensions.crossplane.io', version: 'v1', resource: 'compositions', namespaced: false } },
  { id: 'kyverno', label: 'Kyverno policies', description: 'Cluster-wide admission and background policies.', gvr: { group: 'kyverno.io', version: 'v1', resource: 'clusterpolicies', namespaced: false } },
  { id: 'cilium', label: 'Cilium policies', description: 'CiliumNetworkPolicies — L3–L7 network rules.', gvr: { group: 'cilium.io', version: 'v2', resource: 'ciliumnetworkpolicies', namespaced: true } },
  { id: 'cnpg', label: 'Postgres clusters', description: 'CloudNativePG database clusters.', gvr: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'clusters', namespaced: true } },
  { id: 'certs', label: 'Certificates', description: 'cert-manager certificates and their readiness.', gvr: { group: 'cert-manager.io', version: 'v1', resource: 'certificates', namespaced: true } },
  { id: 'external-secrets', label: 'External secrets', description: 'Secrets synced from Vault / OpenBao.', gvr: { group: 'external-secrets.io', version: 'v1', resource: 'externalsecrets', namespaced: true } },
  { id: 'keda', label: 'KEDA scalers', description: 'Event-driven ScaledObjects.', gvr: { group: 'keda.sh', version: 'v1alpha1', resource: 'scaledobjects', namespaced: true } },
  { id: 'velero', label: 'Backups', description: 'Velero backups and their phase.', gvr: { group: 'velero.io', version: 'v1', resource: 'backups', namespaced: true } },
]

const CRD_GVR = { group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions', namespaced: false }
const TAB_KEY = 'adhar.platform.crds.tab'

type TabId = string

function readTab(): TabId {
  try {
    return localStorage.getItem(TAB_KEY) ?? KINDS[0].id
  } catch {
    return KINDS[0].id
  }
}

const is404 = (e: unknown) => (e as { status?: number } | null)?.status === 404

/** Live count for a tab badge — "–" when the CRD isn't installed. */
function KindCount({ gvr, namespace }: { gvr: KindDef['gvr']; namespace?: string }) {
  const q = useGeneric(gvr, gvr.namespaced ? namespace : undefined)
  if (q.isLoading) return <>…</>
  if (q.isError) return <span title={is404(q.error) ? 'Not installed' : 'Could not list'}>–</span>
  return <>{(q.data ?? []).length}</>
}

function CrdCount() {
  const q = useGeneric(CRD_GVR)
  return <>{q.isLoading ? '…' : (q.data ?? []).length || '–'}</>
}

export function CrdBrowser({ namespace }: Props) {
  const [tab, setTabState] = useState<TabId>(readTab)
  const setTab = (t: TabId) => {
    setTabState(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // private mode — the tab just isn't remembered
    }
  }
  const active = KINDS.find((k) => k.id === tab)
  return (
    <Tabs<TabId>
      tabs={[
        ...KINDS.map((k) => ({ id: k.id, label: k.label, badge: <KindCount gvr={k.gvr} namespace={namespace} /> })),
        { id: 'all', label: 'All definitions', badge: <CrdCount /> },
      ]}
      value={active || tab === 'all' ? tab : KINDS[0].id}
      onChange={setTab}
      ariaLabel="Custom resource kinds"
    >
      {(id) => {
        const k = KINDS.find((x) => x.id === id)
        return k ? <KindPanel key={k.id} kind={k} namespace={namespace} /> : <AllDefinitions namespace={namespace} />
      }}
    </Tabs>
  )
}

/* ═════════════════════ one kind ═════════════════════ */

const FILTERS: Array<{ id: 'all' | CrHealth; label: string; dot: string }> = [
  { id: 'all', label: 'All', dot: 'bg-content-subtle' },
  { id: 'healthy', label: 'Healthy', dot: 'bg-emerald-500' },
  { id: 'progressing', label: 'Progressing', dot: 'bg-sky-500' },
  { id: 'degraded', label: 'Degraded', dot: 'bg-rose-500' },
  { id: 'unknown', label: 'No status', dot: 'bg-slate-400' },
]

interface CrObject {
  apiVersion?: string
  kind?: string
  metadata: { name: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: Array<{ kind: string; name: string }> }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

function KindPanel({ kind, namespace, onBack }: { kind: KindDef; namespace?: string; onBack?(): void }) {
  const q = useGeneric(kind.gvr, kind.gvr.namespaced ? namespace : undefined)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | CrHealth>('all')
  const [selected, setSelected] = useState<string | null>(null)

  const all = useMemo(
    () => ((q.data ?? []) as CrObject[]).map((o) => ({ o, st: crStatus(o), key: `${o.metadata.namespace ?? ''}/${o.metadata.name}` })),
    [q.data],
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length }
    for (const r of all) c[r.st.health] = (c[r.st.health] ?? 0) + 1
    return c
  }, [all])
  const needle = search.trim().toLowerCase()
  const rows = useMemo(
    () =>
      all
        .filter((r) => filter === 'all' || r.st.health === filter)
        .filter((r) => !needle || r.o.metadata.name.toLowerCase().includes(needle) || (r.o.metadata.namespace ?? '').toLowerCase().includes(needle))
        .sort((a, b) => {
          const rank = { degraded: 0, progressing: 1, unknown: 2, healthy: 3 }
          return rank[a.st.health] - rank[b.st.health] || a.key.localeCompare(b.key)
        }),
    [all, filter, needle],
  )
  const sel = selected ? all.find((r) => r.key === selected) : undefined

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {onBack ? (
                <button type="button" onClick={onBack} className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                  ← All definitions
                </button>
              ) : null}
              <h3 className="text-base font-semibold text-content">{kind.label}</h3>
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted">
                {kind.gvr.namespaced ? (namespace ? `namespace ${namespace}` : 'all namespaces') : 'cluster-scoped'}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] text-content-muted">{kind.description}</p>
            <span className="mt-1.5 inline-block rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
              {kind.gvr.group}/{kind.gvr.version} · {kind.gvr.resource}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by name or namespace…" className="w-56" aria-label="Filter objects" />
            {/* House rule: a spinner, never "Refreshing…" text, while a refetch is in flight. */}
            <Button size="sm" variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching} aria-busy={q.isFetching}>
              {q.isFetching ? <Spinner size={13} /> : null} Refresh
            </Button>
          </div>
        </div>
        {!q.isError && all.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by health">
            {FILTERS.filter((f) => f.id === 'all' || counts[f.id]).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                  filter === f.id
                    ? 'border-brand-400 bg-brand-50 text-brand-800 dark:border-brand-500/50 dark:bg-brand-500/10 dark:text-brand-200'
                    : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', f.dot)} />
                {f.label}
                <span className="font-mono tabular-nums text-content-subtle">{counts[f.id] ?? 0}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {q.isError && is404(q.error) ? (
        <EmptyState
          title={`${kind.label} aren't installed on this cluster`}
          description={`The ${kind.gvr.group} API isn't registered. Install its operator and this tab fills in on its own.`}
        />
      ) : q.isError ? (
        <EmptyState title={`Couldn't list ${kind.label.toLowerCase()}`} description={(q.error as Error).message} />
      ) : (
        <DataTable
          loading={q.isLoading}
          rows={rows}
          rowKey={(r) => r.key}
          onRowClick={(r) => setSelected(r.key)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              value: (r) => r.o.metadata.name,
              cell: (r) => (
                <div className="min-w-0">
                  <div className="truncate font-medium text-content">{r.o.metadata.name}</div>
                  {r.o.metadata.namespace ? <div className="text-xs text-content-muted">{r.o.metadata.namespace}</div> : null}
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              value: (r) => r.st.health,
              cell: (r) => <StatusBadge kind={HEALTH_BADGE[r.st.health]}>{r.st.label}</StatusBadge>,
            },
            {
              key: 'message',
              header: 'Detail',
              minWidth: 220,
              cell: (r) =>
                r.st.message || r.st.note ? (
                  <span className="line-clamp-2 text-[12px] text-content-muted" title={r.st.message ?? r.st.note}>{r.st.message ?? r.st.note}</span>
                ) : (
                  <span className="text-content-subtle">—</span>
                ),
            },
            { key: 'age', header: 'Age', value: (r) => r.o.metadata.creationTimestamp ?? '', cell: (r) => age(r.o.metadata.creationTimestamp) },
          ]}
          empty={
            <EmptyState
              title={all.length ? 'Nothing matches the filter' : `No ${kind.label.toLowerCase()} yet`}
              description={all.length ? 'Clear the search or pick another health filter.' : undefined}
            />
          }
        />
      )}
      {sel ? <CrDrawer obj={sel.o} kind={kind} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}

function CrDrawer({ obj, kind, onClose }: { obj: CrObject; kind: KindDef; onClose(): void }) {
  const toast = useToast()
  const st = crStatus(obj)
  const [view, setView] = useState<'overview' | 'yaml'>('overview')
  const conditions = (Array.isArray(obj.status?.conditions) ? obj.status.conditions : []) as Array<{ type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string }>
  const labels = Object.entries(obj.metadata.labels ?? {})
  const kubectl = `kubectl get ${kind.gvr.resource}.${kind.gvr.group} ${obj.metadata.name}${obj.metadata.namespace ? ` -n ${obj.metadata.namespace}` : ''} -o yaml`
  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${what} copied`),
      () => toast.error('Clipboard is not available here'),
    )
  }
  return (
    <ResourceDrawer resource={obj} kindLabel={kind.label} statusBadge={<StatusBadge kind={HEALTH_BADGE[st.health]}>{st.label}</StatusBadge>} onClose={onClose}>
      <Tabs<'overview' | 'yaml'>
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'yaml', label: 'YAML' },
        ]}
        value={view}
        onChange={setView}
        ariaLabel="Object views"
        actions={
          <Button size="sm" variant="ghost" onClick={() => copy(kubectl, 'kubectl command')}>
            Copy kubectl
          </Button>
        }
      >
        {(v) =>
          v === 'yaml' ? (
            <PodYamlPanel pod={obj} gvr={kind.gvr} />
          ) : (
            <div className="space-y-4">
              {st.message ? (
                <div className={cn('rounded-lg border px-3 py-2 text-[12px]', st.health === 'degraded' ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200' : 'border-edge-default bg-surface-raised text-content-muted')}>
                  {st.message}
                </div>
              ) : null}
              <DrawerSection title="Object">
                <Row label="Name" value={obj.metadata.name} mono />
                {obj.metadata.namespace ? <Row label="Namespace" value={obj.metadata.namespace} mono /> : null}
                <Row label="API" value={`${obj.apiVersion ?? `${kind.gvr.group}/${kind.gvr.version}`} · ${obj.kind ?? kind.gvr.resource}`} mono />
                <Row label="Created" value={obj.metadata.creationTimestamp ? `${age(obj.metadata.creationTimestamp)} ago` : '—'} />
                {st.note ? <Row label="Sync" value={st.note} mono /> : null}
                {obj.metadata.ownerReferences?.length ? (
                  <Row label="Owned by" value={obj.metadata.ownerReferences.map((o) => `${o.kind}/${o.name}`).join(', ')} mono />
                ) : null}
              </DrawerSection>
              <DrawerSection title={`Conditions (${conditions.length})`}>
                {conditions.length ? (
                  <ul className="divide-y divide-edge-subtle">
                    {conditions.map((c, i) => (
                      <li key={`${c.type}-${i}`} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                        <StatusBadge kind={c.status === 'True' ? (/stall|degrad|error|fail/i.test(c.type ?? '') ? 'failed' : 'healthy') : c.status === 'False' ? 'failed' : 'progressing'}>
                          {c.type ?? '—'}
                        </StatusBadge>
                        <div className="min-w-0 flex-1 text-[12px]">
                          <div className="text-content">{c.reason ?? c.status}</div>
                          {c.message ? <div className="mt-0.5 wrap-break-word text-content-muted">{c.message}</div> : null}
                          {c.lastTransitionTime ? <div className="mt-0.5 text-[11px] text-content-subtle">{age(c.lastTransitionTime)} ago</div> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-content-subtle">This operator reports no conditions.</p>
                )}
              </DrawerSection>
              <DrawerSection title={`Labels (${labels.length})`}>
                {labels.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {labels.map(([k, v]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => copy(`${k}=${v}`, 'Label')}
                        title="Copy label"
                        className="max-w-full truncate rounded-md border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted hover:border-edge-strong hover:text-content"
                      >
                        {k}={v}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-content-subtle">No labels.</p>
                )}
              </DrawerSection>
            </div>
          )}
      </Tabs>
    </ResourceDrawer>
  )
}

/* ═════════════════════ all definitions ═════════════════════ */

interface CrdObject {
  metadata: { name: string; creationTimestamp?: string }
  spec?: {
    group?: string
    scope?: 'Namespaced' | 'Cluster'
    names?: { kind?: string; plural?: string; shortNames?: string[] }
    versions?: Array<{ name: string; served?: boolean; storage?: boolean }>
  }
  status?: { conditions?: Array<{ type?: string; status?: string }> }
}

function AllDefinitions({ namespace }: { namespace?: string }) {
  const q = useGeneric(CRD_GVR)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('')
  const [scope, setScope] = useState<'' | 'Namespaced' | 'Cluster'>('')
  const [browse, setBrowse] = useState<KindDef | null>(null)

  const crds = (q.data ?? []) as CrdObject[]
  const groups = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of crds) {
      const g = groupLabel(c.spec?.group ?? '')
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [crds])
  const needle = search.trim().toLowerCase()
  const rows = useMemo(
    () =>
      crds
        .filter((c) => !group || groupLabel(c.spec?.group ?? '') === group)
        .filter((c) => !scope || c.spec?.scope === scope)
        .filter((c) => {
          if (!needle) return true
          const n = c.spec?.names
          return [c.metadata.name, n?.kind, n?.plural, ...(n?.shortNames ?? [])].some((s) => s?.toLowerCase().includes(needle))
        })
        .sort((a, b) => (a.spec?.names?.kind ?? '').localeCompare(b.spec?.names?.kind ?? '')),
    [crds, group, scope, needle],
  )

  if (browse) return <KindPanel kind={browse} namespace={namespace} onBack={() => setBrowse(null)} />

  const open = (c: CrdObject) => {
    const v = c.spec?.versions?.find((x) => x.storage) ?? c.spec?.versions?.find((x) => x.served) ?? c.spec?.versions?.[0]
    if (!v || !c.spec?.group || !c.spec.names?.plural) return
    setBrowse({
      id: c.metadata.name,
      label: c.spec.names.kind ?? c.spec.names.plural,
      description: `${groupLabel(c.spec.group)} · ${c.metadata.name}`,
      gvr: { group: c.spec.group, version: v.name, resource: c.spec.names.plural, namespaced: c.spec.scope === 'Namespaced' },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm">
        <span className="mr-1 text-sm font-semibold text-content">Definitions</span>
        <span className="font-mono text-[11px] tabular-nums text-content-subtle">{rows.length === crds.length ? crds.length : `${rows.length} / ${crds.length}`}</span>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search kind, plural or short name…" className="w-64" aria-label="Search definitions" />
        <Select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="API group" className="w-48">
          <option value="">All groups ({groups.length})</option>
          {groups.map(([g, n]) => <option key={g} value={g}>{g} ({n})</option>)}
        </Select>
        <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Scope" className="w-40">
          <option value="">Any scope</option>
          <option value="Namespaced">Namespaced</option>
          <option value="Cluster">Cluster-scoped</option>
        </Select>
      </div>
      {q.isError ? (
        <EmptyState title="Couldn't list CustomResourceDefinitions" description={(q.error as Error).message} />
      ) : (
        <DataTable
          loading={q.isLoading}
          rows={rows}
          rowKey={(c) => c.metadata.name}
          onRowClick={open}
          columns={[
            {
              key: 'kind',
              header: 'Kind',
              value: (c) => c.spec?.names?.kind ?? '',
              cell: (c) => (
                <div className="min-w-0">
                  <div className="font-medium text-content">{c.spec?.names?.kind ?? c.metadata.name}</div>
                  <div className="font-mono text-[11px] text-content-muted">
                    {c.spec?.names?.plural}
                    {c.spec?.names?.shortNames?.length ? ` · ${c.spec.names.shortNames.join(', ')}` : ''}
                  </div>
                </div>
              ),
            },
            {
              key: 'group',
              header: 'Group',
              value: (c) => c.spec?.group ?? '',
              cell: (c) => (
                <div className="min-w-0">
                  <div className="text-content">{groupLabel(c.spec?.group ?? '')}</div>
                  <div className="truncate font-mono text-[11px] text-content-subtle">{c.spec?.group}</div>
                </div>
              ),
            },
            {
              key: 'versions',
              header: 'Versions',
              cell: (c) => (
                <div className="flex flex-wrap gap-1">
                  {(c.spec?.versions ?? []).filter((v) => v.served).map((v) => (
                    <span key={v.name} className={cn('rounded px-1.5 py-0.5 font-mono text-[10px]', v.storage ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'bg-surface-sunken text-content-muted')} title={v.storage ? 'Storage version' : 'Served'}>
                      {v.name}
                    </span>
                  ))}
                </div>
              ),
            },
            { key: 'scope', header: 'Scope', value: (c) => c.spec?.scope ?? '', cell: (c) => <span className="text-[12px] text-content-muted">{c.spec?.scope === 'Cluster' ? 'Cluster' : 'Namespaced'}</span> },
            {
              key: 'state',
              header: 'State',
              cell: (c) => {
                const est = c.status?.conditions?.find((x) => x.type === 'Established')?.status === 'True'
                return <StatusBadge kind={est ? 'healthy' : 'progressing'}>{est ? 'Established' : 'Pending'}</StatusBadge>
              },
            },
            { key: 'age', header: 'Age', value: (c) => c.metadata.creationTimestamp ?? '', cell: (c) => age(c.metadata.creationTimestamp) },
          ]}
          empty={<EmptyState title="No definitions match" description="Clear the search or change the group and scope filters." />}
        />
      )}
    </div>
  )
}

export default CrdBrowser
