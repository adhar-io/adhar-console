import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  StatusBadge,
  Textarea,
} from '@adhar-console/shell-ui'
import { kube } from '@adhar-console/api-clients/k8s'
import { GVRS } from '../data/gvr.ts'
import { useDaemonSets, useDeployments, usePods, useStatefulSets } from '../data/hooks.ts'
import {
  groupByNamespace,
  quotaUsageRows,
  useLimitRanges,
  useNamespacesLive,
  useResourceQuotas,
  type LimitRange,
  type NamespaceObject,
  type ResourceQuota,
} from '../data/namespaces.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
import { age, formatBytes, formatCpu, parseQuantity } from '../data/format.ts'
import { ListShell, matchesSearch, StatusFilterPills } from './list-shell.tsx'

/**
 * Enterprise namespace inventory — live (watch-backed) namespace list with
 * per-namespace ResourceQuota usage, pod counts, a governance drawer
 * (quotas, LimitRanges, workload counts) and RBAC-gated create/delete.
 * Namespace lifecycle is deliberately gated on the platform-admin-only
 * `rbac.write` permission — creating or cascading-deleting a namespace is a
 * cluster-governance operation.
 */

type PhaseFilter = 'Active' | 'Terminating'

const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'default'])

export function NamespacesView() {
  const live = useNamespacesLive()
  const pods = usePods()
  const quotas = useResourceQuotas()
  const canManage = useHasK8sPermission('rbac.write')

  const [search, setSearch] = useState('')
  const [phase, setPhase] = useState<PhaseFilter | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const all = live.data
  const quotasByNs = useMemo(
    () => groupByNamespace((quotas.data ?? []) as ResourceQuota[]),
    [quotas.data],
  )
  const podCountByNs = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of pods.data ?? []) {
      const ns = p.metadata.namespace ?? ''
      counts.set(ns, (counts.get(ns) ?? 0) + 1)
    }
    return counts
  }, [pods.data])

  const rows = useMemo(
    () =>
      all.filter((ns) => {
        if (phase !== 'all' && ns.status?.phase !== phase) return false
        return (
          matchesSearch(ns.metadata.name, search) ||
          Object.entries(ns.metadata.labels ?? {}).some(([k, v]) => matchesSearch(`${k}=${v}`, search))
        )
      }),
    [all, phase, search],
  )

  if (live.isError) {
    return <EmptyState title="Couldn't list namespaces" description={live.error?.message} />
  }

  const activeCount = all.filter((n) => n.status?.phase === 'Active').length
  const terminatingCount = all.filter((n) => n.status?.phase === 'Terminating').length
  const selectedNs = selected ? all.find((n) => n.metadata.name === selected) : undefined

  return (
    <>
      <ListShell
        title="Namespaces"
        total={all.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={() => live.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by name or label…"
        filters={
          <StatusFilterPills<PhaseFilter>
            value={phase}
            onChange={setPhase}
            pills={[
              { value: 'Active', label: 'Active', count: activeCount, tone: 'emerald' },
              { value: 'Terminating', label: 'Terminating', count: terminatingCount, tone: 'amber' },
            ]}
          />
        }
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              Create namespace
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
              Create <K8sRolePill perm="rbac.write" />
            </span>
          )
        }
      >
        <DataTable
          loading={live.isLoading}
          onRowClick={(ns) => setSelected(ns.metadata.name)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (ns) => (
                <div>
                  <div className="font-medium text-content">{ns.metadata.name}</div>
                  <LabelChips labels={ns.metadata.labels} />
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (ns) => <NamespacePhaseBadge phase={ns.status?.phase} />,
            },
            {
              key: 'quota',
              header: 'Quota usage',
              cell: (ns) => (
                <QuotaSummary
                  quotas={quotasByNs.get(ns.metadata.name) ?? []}
                  loading={quotas.isLoading}
                />
              ),
            },
            {
              key: 'pods',
              header: 'Pods',
              numeric: true,
              cell: (ns) =>
                pods.isLoading ? (
                  <span className="text-content-subtle">…</span>
                ) : (
                  (podCountByNs.get(ns.metadata.name) ?? 0)
                ),
            },
            { key: 'age', header: 'Age', cell: (ns) => age(ns.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(ns) => ns.metadata.name}
          empty={
            <EmptyState
              title="No namespaces"
              description={search || phase !== 'all' ? 'No namespace matches the current filters.' : undefined}
            />
          }
        />
      </ListShell>

      {selectedNs ? (
        <NamespaceDrawer namespace={selectedNs} onClose={() => setSelected(null)} />
      ) : null}

      <CreateNamespaceModal open={creating} onClose={() => setCreating(false)} onCreated={() => live.refetch()} />
    </>
  )
}

/* ── shared bits ───────────────────────────────────────────────────────── */

function NamespacePhaseBadge({ phase }: { phase?: string }) {
  if (!phase) return <StatusBadge kind="unknown">Unknown</StatusBadge>
  return (
    <StatusBadge kind={phase === 'Active' ? 'healthy' : phase === 'Terminating' ? 'degraded' : 'unknown'}>
      {phase}
    </StatusBadge>
  )
}

function LabelChips({ labels, max = 2 }: { labels?: Record<string, string>; max?: number }) {
  const entries = Object.entries(labels ?? {}).filter(([k]) => k !== 'kubernetes.io/metadata.name')
  if (!entries.length) return null
  const shown = entries.slice(0, max)
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1">
      {shown.map(([k, v]) => (
        <span
          key={k}
          title={`${k}=${v}`}
          className="max-w-48 truncate rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
        >
          {k}={v}
        </span>
      ))}
      {entries.length > max ? (
        <span className="text-[10px] text-content-subtle">+{entries.length - max}</span>
      ) : null}
    </div>
  )
}

function formatQuotaValue(resource: string, value: string | undefined): string {
  if (value === undefined) return '—'
  if (/memory|storage/.test(resource)) return formatBytes(parseQuantity(value))
  if (/cpu/.test(resource)) return formatCpu(parseQuantity(value))
  return value
}

function quotaRatio(used?: string, hard?: string): number | null {
  const u = parseQuantity(used)
  const h = parseQuantity(hard)
  if (!Number.isFinite(u) || !Number.isFinite(h) || h <= 0) return null
  return u / h
}

/** Compact quota cell — the two most interesting resources, else a count. */
function QuotaSummary({ quotas, loading }: { quotas: ResourceQuota[]; loading: boolean }) {
  if (loading) return <span className="text-content-subtle">…</span>
  if (!quotas.length) return <span className="text-content-subtle">No quota</span>
  const rows = quotas.flatMap(quotaUsageRows)
  const interesting = [
    rows.find((r) => /cpu/.test(r.resource)),
    rows.find((r) => /memory/.test(r.resource)),
  ].filter((r): r is NonNullable<typeof r> => Boolean(r))
  const shown = interesting.length ? interesting : rows.slice(0, 2)
  return (
    <div className="space-y-0.5">
      {shown.map((r) => (
        <div key={r.resource} className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
          <span className="text-content-subtle">{r.resource.replace(/^requests\./, '')}</span>
          <span className="text-content">
            {formatQuotaValue(r.resource, r.used)}
            <span className="text-content-subtle"> / {formatQuotaValue(r.resource, r.hard)}</span>
          </span>
        </div>
      ))}
      {rows.length > shown.length ? (
        <div className="text-[10px] text-content-subtle">+{rows.length - shown.length} more</div>
      ) : null}
    </div>
  )
}

function QuotaBar({ row }: { row: { resource: string; used?: string; hard?: string } }) {
  const ratio = quotaRatio(row.used, row.hard)
  const pct = ratio === null ? 0 : Math.min(100, Math.round(ratio * 100))
  const tone =
    ratio === null
      ? 'bg-slate-400'
      : ratio >= 1
        ? 'bg-rose-500'
        : ratio >= 0.8
          ? 'bg-amber-500'
          : 'bg-emerald-500'
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-mono text-content-muted">{row.resource}</span>
        <span className="font-mono tabular-nums text-content">
          {formatQuotaValue(row.resource, row.used)}
          <span className="text-content-subtle"> / {formatQuotaValue(row.resource, row.hard)}</span>
          {ratio !== null ? <span className="ml-1.5 text-content-subtle">({pct}%)</span> : null}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/* ── drawer ────────────────────────────────────────────────────────────── */

function NamespaceDrawer({ namespace, onClose }: { namespace: NamespaceObject; onClose(): void }) {
  const name = namespace.metadata.name
  const quotas = useResourceQuotas(name)
  const limits = useLimitRanges(name)
  const pods = usePods(name)
  const deployments = useDeployments(name)
  const statefulsets = useStatefulSets(name)
  const daemonsets = useDaemonSets(name)
  const canManage = useHasK8sPermission('rbac.write')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const labels = Object.entries(namespace.metadata.labels ?? {})
  const annotations = Object.entries(namespace.metadata.annotations ?? {})
  const quotaList = (quotas.data ?? []) as ResourceQuota[]
  const limitList = (limits.data ?? []) as LimitRange[]

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-edge-default bg-surface-raised shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">Namespace</div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <NamespacePhaseBadge phase={namespace.status?.phase} />
            {canManage ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmingDelete(true)}
                disabled={namespace.status?.phase === 'Terminating'}
                title={
                  namespace.status?.phase === 'Terminating'
                    ? 'Already terminating'
                    : 'Delete this namespace and everything in it'
                }
              >
                Delete
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
                Delete <K8sRolePill perm="rbac.write" />
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-content-muted hover:bg-surface-sunken hover:text-content"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Overview</div>
            </CardHeader>
            <CardBody className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-content-muted">Age</span>
                <span className="text-content">{age(namespace.metadata.creationTimestamp)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-content-muted">Created</span>
                <span className="font-mono text-xs text-content">
                  {namespace.metadata.creationTimestamp ?? '—'}
                </span>
              </div>
              <div>
                <div className="mb-1 text-content-muted">Labels</div>
                {labels.length ? (
                  <div className="flex flex-wrap gap-1">
                    {labels.map(([k, v]) => (
                      <code key={k} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px]">
                        {k}={v}
                      </code>
                    ))}
                  </div>
                ) : (
                  <span className="text-content-subtle">None</span>
                )}
              </div>
              <div>
                <div className="mb-1 text-content-muted">Annotations</div>
                {annotations.length ? (
                  <div className="space-y-1">
                    {annotations.map(([k, v]) => (
                      <div key={k} className="truncate font-mono text-[11px] text-content-muted" title={`${k}=${v}`}>
                        {k}={v}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-content-subtle">None</span>
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Workloads</div>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <WorkloadCount label="Pods" loading={pods.isLoading} count={pods.data?.length} />
                <WorkloadCount label="Deployments" loading={deployments.isLoading} count={deployments.data?.length} />
                <WorkloadCount label="StatefulSets" loading={statefulsets.isLoading} count={statefulsets.data?.length} />
                <WorkloadCount label="DaemonSets" loading={daemonsets.isLoading} count={daemonsets.data?.length} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Resource quotas</div>
            </CardHeader>
            <CardBody>
              {quotas.isLoading ? (
                <div className="text-sm text-content-subtle">Loading quotas…</div>
              ) : quotas.isError ? (
                <div className="text-sm text-rose-600 dark:text-rose-400">
                  Couldn't load quotas: {(quotas.error as Error).message}
                </div>
              ) : quotaList.length === 0 ? (
                <EmptyState compact title="No ResourceQuota" description="This namespace has no usage limits enforced." />
              ) : (
                <div className="space-y-5">
                  {quotaList.map((q) => (
                    <div key={q.metadata.name}>
                      <div className="mb-2 font-mono text-xs text-content-muted">{q.metadata.name}</div>
                      <div className="space-y-3">
                        {quotaUsageRows(q).map((row) => (
                          <QuotaBar key={row.resource} row={row} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Limit ranges</div>
            </CardHeader>
            <CardBody>
              {limits.isLoading ? (
                <div className="text-sm text-content-subtle">Loading limit ranges…</div>
              ) : limits.isError ? (
                <div className="text-sm text-rose-600 dark:text-rose-400">
                  Couldn't load limit ranges: {(limits.error as Error).message}
                </div>
              ) : limitList.length === 0 ? (
                <EmptyState compact title="No LimitRange" description="No per-container defaults or bounds are set." />
              ) : (
                <div className="space-y-4">
                  {limitList.map((lr) => (
                    <LimitRangeTable key={lr.metadata.name} limitRange={lr} />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {confirmingDelete ? (
          <DeleteNamespaceBar
            name={name}
            onCancel={() => setConfirmingDelete(false)}
            onDeleted={onClose}
          />
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}

function WorkloadCount({ label, loading, count }: { label: string; loading: boolean; count?: number }) {
  return (
    <div className="rounded-lg border border-edge-default bg-surface-sunken/50 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-lg tabular-nums text-content">{loading ? '…' : (count ?? 0)}</div>
    </div>
  )
}

function LimitRangeTable({ limitRange }: { limitRange: LimitRange }) {
  const items = limitRange.spec?.limits ?? []
  return (
    <div>
      <div className="mb-1.5 font-mono text-xs text-content-muted">{limitRange.metadata.name}</div>
      <div className="overflow-x-auto rounded-lg border border-edge-default">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge-default bg-surface-sunken text-left">
              {['Type', 'Resource', 'Min', 'Max', 'Default request', 'Default limit'].map((h) => (
                <th key={h} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-content-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {items.flatMap((item, i) => {
              const resources = [
                ...new Set([
                  ...Object.keys(item.max ?? {}),
                  ...Object.keys(item.min ?? {}),
                  ...Object.keys(item.default ?? {}),
                  ...Object.keys(item.defaultRequest ?? {}),
                ]),
              ].sort()
              return resources.map((res) => (
                <tr key={`${i}-${res}`}>
                  <td className="px-3 py-1.5 text-content-muted">{item.type ?? '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{res}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{item.min?.[res] ?? '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{item.max?.[res] ?? '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{item.defaultRequest?.[res] ?? '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{item.default?.[res] ?? '—'}</td>
                </tr>
              ))
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── delete (typed confirm) ────────────────────────────────────────────── */

function DeleteNamespaceBar({
  name,
  onCancel,
  onDeleted,
}: {
  name: string
  onCancel(): void
  onDeleted(): void
}) {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const mut = useMutation({
    mutationFn: () => kube.delete(GVRS.namespaces, undefined, name, { propagationPolicy: 'Background' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onDeleted()
    },
  })
  const isSystem = SYSTEM_NAMESPACES.has(name)
  return (
    <div
      className="border-t border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-4"
      role="alert"
    >
      <div className="text-sm font-semibold text-rose-900 dark:text-rose-300">
        Delete namespace {name}?
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
        This <strong>cascades</strong> — every pod, workload, Secret, ConfigMap, PVC and other resource
        inside <code className="font-mono">{name}</code> is deleted with it. This cannot be undone.
        {isSystem ? (
          <span className="mt-1 block font-semibold text-rose-700 dark:text-rose-300">
            {name} is a system namespace — deleting it can break the cluster.
          </span>
        ) : null}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type "${name}" to confirm`}
          className="h-8 max-w-64 font-mono text-xs"
          aria-label="Type the namespace name to confirm deletion"
        />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={mut.isPending}>
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={typed !== name || mut.isPending}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? 'Deleting…' : 'Delete namespace'}
        </Button>
      </div>
      {mut.isError ? (
        <div className="mt-2 text-xs text-rose-700 dark:text-rose-300">{(mut.error as Error).message}</div>
      ) : null}
    </div>
  )
}

/* ── create modal ──────────────────────────────────────────────────────── */

const NS_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function parseLabelLines(text: string): { labels: Record<string, string>; error?: string } {
  const labels: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return { labels, error: `"${trimmed}" isn't key=value` }
    labels[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return { labels }
}

function CreateNamespaceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose(): void
  onCreated(): void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [labelText, setLabelText] = useState('')
  const [quotaCpu, setQuotaCpu] = useState('')
  const [quotaMemory, setQuotaMemory] = useState('')
  const [quotaPods, setQuotaPods] = useState('')

  const nameError = name && !NS_NAME_RE.test(name) ? 'Lowercase alphanumerics and dashes only (RFC 1123).' : undefined
  const { labels, error: labelError } = parseLabelLines(labelText)

  const mut = useMutation({
    mutationFn: async () => {
      await kube.apply({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name, ...(Object.keys(labels).length ? { labels } : {}) },
      })
      const hard: Record<string, string> = {}
      if (quotaCpu.trim()) hard['requests.cpu'] = quotaCpu.trim()
      if (quotaMemory.trim()) hard['requests.memory'] = quotaMemory.trim()
      if (quotaPods.trim()) hard.pods = quotaPods.trim()
      if (Object.keys(hard).length) {
        await kube.apply({
          apiVersion: 'v1',
          kind: 'ResourceQuota',
          metadata: { name: `${name}-quota`, namespace: name },
          spec: { hard },
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onCreated()
      setName('')
      setLabelText('')
      setQuotaCpu('')
      setQuotaMemory('')
      setQuotaPods('')
      onClose()
    },
  })

  const canSubmit = Boolean(name) && !nameError && !labelError && !mut.isPending

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create namespace"
      description="Creates the namespace on the cluster; optionally seeds a ResourceQuota alongside it."
      branded
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required error={nameError}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="team-payments"
            invalid={Boolean(nameError)}
            autoFocus
          />
        </Field>
        <Field label="Labels" hint="one key=value per line" error={labelError}>
          <Textarea
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            rows={3}
            placeholder={'team=payments\nenv=staging'}
            className="font-mono text-xs"
            invalid={Boolean(labelError)}
          />
        </Field>
        <div>
          <div className="mb-2 text-sm font-medium text-content">
            Resource quota <span className="text-xs font-normal text-content-subtle">(optional)</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="CPU requests" hint="e.g. 4">
              <Input value={quotaCpu} onChange={(e) => setQuotaCpu(e.target.value)} placeholder="4" />
            </Field>
            <Field label="Memory requests" hint="e.g. 8Gi">
              <Input value={quotaMemory} onChange={(e) => setQuotaMemory(e.target.value)} placeholder="8Gi" />
            </Field>
            <Field label="Max pods" hint="e.g. 50">
              <Input value={quotaPods} onChange={(e) => setQuotaPods(e.target.value)} placeholder="50" />
            </Field>
          </div>
        </div>
        {mut.isError ? (
          <div className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {(mut.error as Error).message}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
