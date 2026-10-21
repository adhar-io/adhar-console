import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  Tabs,
  useOverlayDismiss,
  useToast,
  DrawerWidenButton,
  useDrawerWidth,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { kube } from '@adhar/api-clients/k8s'
import { GVRS } from '../data/gvr.ts'
import { useAccess, useLiveList } from '../data/live.ts'
import { age } from '../data/format.ts'
import { groupByNamespace, type LimitRange, type LimitRangeItem, type ResourceQuota, useNamespacesLive } from '../data/namespaces.ts'
import {
  buildLimitRange,
  buildQuota,
  type ContainerLimits,
  containerLimits,
  EMPTY_LIMITS,
  HIGH_AT,
  limitRangeErrors,
  LIMIT_PRESET,
  nameError,
  type Pressure,
  QUOTA_KEYS,
  QUOTA_PRESETS,
  quantityError,
  quotaLines,
  quotaReconciled,
  resourceLabel,
  topLine,
} from '../data/quotas.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'
import { ManifestEditor } from './manifest-editor.tsx'

/**
 * Quota & Limits — every ResourceQuota and LimitRange in the cluster, live.
 *
 * Quotas cap what a namespace may consume in total; LimitRanges set the
 * per-container defaults and bounds that make those totals enforceable (a
 * pod without requests can't be admitted into a namespace with a CPU quota
 * unless a LimitRange fills them in). The page shows both side by side with
 * live usage from the quota controller, a coverage view of namespaces left
 * ungoverned, and create / edit / delete gated by the user's own RBAC
 * (SelfSubjectAccessReview — never assumed from a role name).
 */

type Tab = 'quotas' | 'limits' | 'coverage'

const SYSTEM_NS = /^(kube-|default$|local-path)/

const PRESSURE_TONE: Record<Pressure, { bar: string; text: string; badge: 'healthy' | 'progressing' | 'degraded' | 'failed' | 'unknown'; label: string }> = {
  ok: { bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', badge: 'healthy', label: 'Healthy' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', badge: 'progressing', label: 'Filling up' },
  high: { bar: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-300', badge: 'degraded', label: 'Near limit' },
  full: { bar: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-300', badge: 'failed', label: 'At limit' },
  unbounded: { bar: 'bg-slate-400', text: 'text-content-muted', badge: 'unknown', label: '—' },
}

const key = (o: { metadata: { namespace?: string; name: string } }) => `${o.metadata.namespace ?? ''}/${o.metadata.name}`

/* ═════════════════════════ page ═════════════════════════ */

export function QuotasView({ namespace }: { namespace?: string }) {
  const quotas = useLiveList<ResourceQuota>(GVRS.resourcequotas, { namespace })
  const limits = useLiveList<LimitRange>(GVRS.limitranges, { namespace })
  const nss = useNamespacesLive()
  const canQuota = useAccess({ verb: 'create', resource: 'resourcequotas', namespace })
  const canLimit = useAccess({ verb: 'create', resource: 'limitranges', namespace })

  const [tab, setTab] = useState<Tab>('quotas')
  const [creating, setCreating] = useState<{ kind: 'quota' | 'limits'; namespace?: string } | null>(null)

  const quotaList = quotas.data
  const limitList = limits.data
  const namespaces = useMemo(
    () => (nss.data ?? []).map((n) => n.metadata.name).filter((n) => !namespace || n === namespace).sort(),
    [nss.data, namespace],
  )
  const quotaByNs = useMemo(() => groupByNamespace(quotaList), [quotaList])
  const limitByNs = useMemo(() => groupByNamespace(limitList), [limitList])

  const tenantNs = namespaces.filter((n) => !SYSTEM_NS.test(n))
  const covered = tenantNs.filter((n) => quotaByNs.has(n)).length
  const pressured = quotaList.flatMap(quotaLines).filter((l) => (l.pct ?? 0) >= HIGH_AT).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile label="Resource quotas" value={quotaList.length} hint={`across ${quotaByNs.size} namespace${quotaByNs.size === 1 ? '' : 's'}`} />
        <SummaryTile
          label="Quota coverage"
          value={tenantNs.length ? `${covered}/${tenantNs.length}` : '—'}
          hint="workload namespaces with a quota"
          tone={tenantNs.length && covered < tenantNs.length ? 'amber' : 'emerald'}
        />
        <SummaryTile label="Near limit" value={pressured} hint={`resources at ≥${HIGH_AT}% of quota`} tone={pressured ? 'rose' : 'emerald'} />
        <SummaryTile label="Limit ranges" value={limitList.length} hint={`across ${limitByNs.size} namespace${limitByNs.size === 1 ? '' : 's'}`} />
      </div>

      <Tabs<Tab>
        tabs={[
          { id: 'quotas', label: 'Resource quotas', badge: quotaList.length },
          { id: 'limits', label: 'Limit ranges', badge: limitList.length },
          { id: 'coverage', label: 'Namespace coverage', badge: tenantNs.length - covered || undefined },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel="Quota and limits"
        actions={
          <div className="flex items-center gap-2">
            {canLimit.data ? (
              <Button size="sm" variant="secondary" onClick={() => setCreating({ kind: 'limits', namespace })}>
                New limit range
              </Button>
            ) : null}
            {canQuota.data ? (
              <Button size="sm" variant="primary" onClick={() => setCreating({ kind: 'quota', namespace })}>
                New quota
              </Button>
            ) : null}
          </div>
        }
      >
        {(active) =>
          active === 'quotas' ? (
            <QuotaTable live={quotas} />
          ) : active === 'limits' ? (
            <LimitTable live={limits} />
          ) : (
            <CoverageTable
              namespaces={namespaces}
              loading={nss.isLoading}
              quotaByNs={quotaByNs}
              limitByNs={limitByNs}
              canQuota={!!canQuota.data}
              canLimit={!!canLimit.data}
              onCreate={setCreating}
            />
          )}
      </Tabs>

      {creating?.kind === 'quota' ? (
        <CreateQuotaModal namespaces={namespaces} initialNamespace={creating.namespace} existing={quotaList} onClose={() => setCreating(null)} />
      ) : null}
      {creating?.kind === 'limits' ? (
        <CreateLimitRangeModal namespaces={namespaces} initialNamespace={creating.namespace} existing={limitList} onClose={() => setCreating(null)} />
      ) : null}
    </div>
  )
}

function SummaryTile({ label, value, hint, tone = 'slate' }: { label: string; value: number | string; hint: string; tone?: 'slate' | 'emerald' | 'amber' | 'rose' }) {
  const text = { slate: 'text-content', emerald: 'text-emerald-700 dark:text-emerald-300', amber: 'text-amber-700 dark:text-amber-300', rose: 'text-rose-700 dark:text-rose-300' }[tone]
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised px-4 py-3 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', text)}>{value}</div>
      <div className="mt-0.5 text-[11px] text-content-muted">{hint}</div>
    </div>
  )
}

function UsageBar({ pct, pressure, className }: { pct: number | null; pressure: Pressure; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', PRESSURE_TONE[pressure].bar)}
        style={{ width: `${pct == null ? 0 : Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }}
      />
    </div>
  )
}

/* ═════════════════════════ quotas ═════════════════════════ */

function QuotaTable({ live }: { live: ReturnType<typeof useLiveList<ResourceQuota>> }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const rows = useMemo(
    () =>
      live.data
        .filter((q) => matchesSearch(q.metadata.name, search) || matchesSearch(q.metadata.namespace, search))
        .sort((a, b) => (topLine(b)?.pct ?? -1) - (topLine(a)?.pct ?? -1)),
    [live.data, search],
  )
  if (live.isError) return <EmptyState title="Couldn't list ResourceQuotas" description={live.error?.message} />
  const sel = selected ? live.data.find((q) => key(q) === selected) : undefined
  return (
    <>
      <ListShell
        title="ResourceQuotas"
        total={live.data.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={live.refetch}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by name or namespace…"
      >
        <DataTable
          loading={live.isLoading}
          rows={rows}
          rowKey={(o) => key(o)}
          onRowClick={(q) => setSelected(key(q))}
          columns={[
            {
              key: 'name',
              header: 'Quota',
              cell: (q) => (
                <div>
                  <div className="font-medium text-content">{q.metadata.name}</div>
                  <div className="text-xs text-content-muted">{q.metadata.namespace}</div>
                </div>
              ),
            },
            {
              key: 'tightest',
              header: 'Tightest resource',
              minWidth: 220,
              cell: (q) => {
                const l = topLine(q)
                if (!l) return <span className="text-content-subtle">No limits set</span>
                return (
                  <div className="min-w-[12rem]">
                    <div className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-content-muted">{resourceLabel(l.resource)}</span>
                      <span className={cn('font-mono tabular-nums', PRESSURE_TONE[l.pressure].text)}>
                        {l.used ?? '0'} / {l.hard}
                      </span>
                    </div>
                    <UsageBar pct={l.pct} pressure={l.pressure} className="mt-1" />
                  </div>
                )
              },
            },
            {
              key: 'resources',
              header: 'Limits',
              numeric: true,
              cell: (q) => Object.keys(q.spec?.hard ?? {}).length,
            },
            {
              key: 'scopes',
              header: 'Scopes',
              cell: (q) =>
                q.spec?.scopes?.length ? (
                  <span className="font-mono text-[11px] text-content-muted">{q.spec.scopes.join(', ')}</span>
                ) : (
                  <span className="text-content-subtle">All pods</span>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (q) => {
                if (!quotaReconciled(q)) return <StatusBadge kind="unknown">Pending</StatusBadge>
                const p = topLine(q)?.pressure ?? 'ok'
                return <StatusBadge kind={PRESSURE_TONE[p].badge}>{PRESSURE_TONE[p].label === '—' ? 'Healthy' : PRESSURE_TONE[p].label}</StatusBadge>
              },
            },
            { key: 'age', header: 'Age', cell: (q) => age(q.metadata.creationTimestamp) },
          ]}
          empty={
            <EmptyState
              title="No ResourceQuotas"
              description="Without a quota a namespace can consume the whole cluster. Create one from the button above or from Namespace coverage."
            />
          }
        />
      </ListShell>
      {sel ? <QuotaDrawer quota={sel} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function QuotaDrawer({ quota, onClose }: { quota: ResourceQuota; onClose(): void }) {
  const ns = quota.metadata.namespace
  const canUpdate = useAccess({ verb: 'update', resource: 'resourcequotas', namespace: ns, name: quota.metadata.name })
  const canDelete = useAccess({ verb: 'delete', resource: 'resourcequotas', namespace: ns, name: quota.metadata.name })
  const lines = quotaLines(quota)
  const [editing, setEditing] = useState(false)
  return (
    <DrawerFrame
      kind="ResourceQuota"
      name={quota.metadata.name}
      namespace={ns}
      onClose={onClose}
      badge={
        quotaReconciled(quota)
          ? <StatusBadge kind={PRESSURE_TONE[lines[0]?.pressure ?? 'ok'].badge}>{lines[0] && lines[0].pressure !== 'unbounded' ? PRESSURE_TONE[lines[0].pressure].label : 'Healthy'}</StatusBadge>
          : <StatusBadge kind="unknown">Pending</StatusBadge>
      }
      canEdit={!!canUpdate.data}
      onEdit={() => setEditing(true)}
      canDelete={!!canDelete.data}
      deleteGvr={GVRS.resourcequotas}
      deleteNote="Pods already running keep running; new pods in this namespace are no longer capped."
    >
      <section className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-content">Usage</h3>
          <span className="text-[11px] text-content-subtle">live from the quota controller</span>
        </div>
        {lines.length === 0 ? (
          <EmptyState compact title="This quota sets no limits" />
        ) : (
          <ul className="space-y-3">
            {lines.map((l) => (
              <li key={l.resource}>
                <div className="flex items-baseline justify-between gap-3 text-[12px]">
                  <span className="text-content">
                    {resourceLabel(l.resource)} <code className="ml-1 font-mono text-[10px] text-content-subtle">{l.resource}</code>
                  </span>
                  <span className={cn('font-mono tabular-nums', PRESSURE_TONE[l.pressure].text)}>
                    {l.used ?? '0'} / {l.hard}
                    {l.pct != null ? <span className="ml-1.5 text-content-subtle">{l.pct.toFixed(0)}%</span> : null}
                  </span>
                </div>
                <UsageBar pct={l.pct} pressure={l.pressure} className="mt-1.5" />
              </li>
            ))}
          </ul>
        )}
        {!quotaReconciled(quota) ? (
          <p className="mt-3 text-[11px] text-content-subtle">The quota controller hasn't reported usage yet — it normally does within seconds.</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-content">Applies to</h3>
        <p className="text-[12px] text-content-muted">
          {quota.spec?.scopes?.length ? (
            <>Only pods matching the scopes <code className="font-mono">{quota.spec.scopes.join(', ')}</code>.</>
          ) : (
            <>Every pod and object in <code className="font-mono">{ns}</code>.</>
          )}{' '}
          A request that would exceed any limit is rejected at admission, so pods in this namespace must declare requests
          and limits for the resources capped here — a LimitRange can supply defaults.
        </p>
      </section>
      {editing ? <ManifestEditor gvr={GVRS.resourcequotas} namespace={ns} name={quota.metadata.name} onClose={() => setEditing(false)} /> : null}
    </DrawerFrame>
  )
}

/* ═════════════════════════ limit ranges ═════════════════════════ */

const fmtPair = (v?: Record<string, string>) =>
  v && Object.keys(v).length ? Object.entries(v).map(([k, x]) => `${k} ${x}`).join(' · ') : null

function LimitTable({ live }: { live: ReturnType<typeof useLiveList<LimitRange>> }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const rows = useMemo(
    () => live.data.filter((l) => matchesSearch(l.metadata.name, search) || matchesSearch(l.metadata.namespace, search)),
    [live.data, search],
  )
  if (live.isError) return <EmptyState title="Couldn't list LimitRanges" description={live.error?.message} />
  const sel = selected ? live.data.find((l) => key(l) === selected) : undefined
  const cell = (v?: Record<string, string>) => {
    const s = fmtPair(v)
    return s ? <span className="font-mono text-[11px] text-content">{s}</span> : <span className="text-content-subtle">—</span>
  }
  return (
    <>
      <ListShell
        title="LimitRanges"
        total={live.data.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={live.refetch}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by name or namespace…"
      >
        <DataTable
          loading={live.isLoading}
          rows={rows}
          rowKey={(o) => key(o)}
          onRowClick={(l) => setSelected(key(l))}
          columns={[
            {
              key: 'name',
              header: 'Limit range',
              cell: (l) => (
                <div>
                  <div className="font-medium text-content">{l.metadata.name}</div>
                  <div className="text-xs text-content-muted">{l.metadata.namespace}</div>
                </div>
              ),
            },
            { key: 'req', header: 'Default request', cell: (l) => cell(containerLimits(l)?.defaultRequest) },
            { key: 'lim', header: 'Default limit', cell: (l) => cell(containerLimits(l)?.default) },
            { key: 'max', header: 'Max per container', cell: (l) => cell(containerLimits(l)?.max) },
            {
              key: 'types',
              header: 'Covers',
              cell: (l) => (
                <div className="flex flex-wrap gap-1">
                  {(l.spec?.limits ?? []).map((x, i) => (
                    <span key={i} className="rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted">{x.type}</span>
                  ))}
                </div>
              ),
            },
            { key: 'age', header: 'Age', cell: (l) => age(l.metadata.creationTimestamp) },
          ]}
          empty={
            <EmptyState
              title="No LimitRanges"
              description="A LimitRange gives containers default requests and limits so quotas can admit them."
            />
          }
        />
      </ListShell>
      {sel ? <LimitDrawer lr={sel} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function LimitDrawer({ lr, onClose }: { lr: LimitRange; onClose(): void }) {
  const ns = lr.metadata.namespace
  const canUpdate = useAccess({ verb: 'update', resource: 'limitranges', namespace: ns, name: lr.metadata.name })
  const canDelete = useAccess({ verb: 'delete', resource: 'limitranges', namespace: ns, name: lr.metadata.name })
  const [editing, setEditing] = useState(false)
  const cols: Array<[string, Exclude<keyof LimitRangeItem, 'type'>]> = [
    ['Min', 'min'],
    ['Default request', 'defaultRequest'],
    ['Default limit', 'default'],
    ['Max', 'max'],
    ['Max limit/request', 'maxLimitRequestRatio'],
  ]
  return (
    <DrawerFrame
      kind="LimitRange"
      name={lr.metadata.name}
      namespace={ns}
      onClose={onClose}
      canEdit={!!canUpdate.data}
      onEdit={() => setEditing(true)}
      canDelete={!!canDelete.data}
      deleteGvr={GVRS.limitranges}
      deleteNote="Existing pods are unaffected; new containers stop receiving default requests and limits."
    >
      {(lr.spec?.limits ?? []).length === 0 ? (
        <EmptyState compact title="This LimitRange sets no limits" />
      ) : (
        (lr.spec?.limits ?? []).map((item, i) => (
          <section key={i} className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-content">{item.type ?? 'Limit'}</h3>
            <div className="overflow-x-auto rounded-lg border border-edge-default">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-edge-default bg-surface-sunken text-left">
                    {['', ...new Set(cols.flatMap(([, k]) => Object.keys(item[k] ?? {})))].map((h) => (
                      <th key={h || 'kind'} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-content-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {cols
                    .filter(([, k]) => item[k] && Object.keys(item[k]!).length)
                    .map(([label, k]) => (
                      <tr key={k}>
                        <td className="px-3 py-1.5 text-content-muted">{label}</td>
                        {[...new Set(cols.flatMap(([, kk]) => Object.keys(item[kk] ?? {})))].map((res) => (
                          <td key={res} className="px-3 py-1.5 font-mono text-xs tabular-nums text-content">{item[k]?.[res] ?? '—'}</td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      <p className="text-[11px] leading-relaxed text-content-subtle">
        Defaults are written into containers that don't set their own requests or limits when they are admitted; min and
        max reject containers outside the bounds.
      </p>
      {editing ? <ManifestEditor gvr={GVRS.limitranges} namespace={ns} name={lr.metadata.name} onClose={() => setEditing(false)} /> : null}
    </DrawerFrame>
  )
}

/* ═════════════════════════ coverage ═════════════════════════ */

function CoverageTable({
  namespaces,
  loading,
  quotaByNs,
  limitByNs,
  canQuota,
  canLimit,
  onCreate,
}: {
  namespaces: string[]
  loading: boolean
  quotaByNs: Map<string, ResourceQuota[]>
  limitByNs: Map<string, LimitRange[]>
  canQuota: boolean
  canLimit: boolean
  onCreate(c: { kind: 'quota' | 'limits'; namespace?: string }): void
}) {
  const [search, setSearch] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const rows = useMemo(
    () =>
      namespaces
        .filter((n) => showSystem || !SYSTEM_NS.test(n))
        .filter((n) => matchesSearch(n, search))
        .map((n) => {
          const qs = quotaByNs.get(n) ?? []
          const tight = qs.map(topLine).filter(Boolean).sort((a, b) => (b!.pct ?? -1) - (a!.pct ?? -1))[0]
          return { ns: n, quotas: qs, limits: limitByNs.get(n) ?? [], tight }
        })
        .sort((a, b) => Number(!!a.quotas.length) - Number(!!b.quotas.length) || a.ns.localeCompare(b.ns)),
    [namespaces, quotaByNs, limitByNs, search, showSystem],
  )
  return (
    <ListShell
      title="Namespaces"
      total={rows.length}
      loading={loading}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search namespaces…"
      filters={
        <label className="inline-flex items-center gap-1.5 text-[12px] text-content-muted">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} className="accent-brand-600" />
          Include system namespaces
        </label>
      }
    >
      <DataTable
        loading={loading}
        rows={rows}
        rowKey={(r) => r.ns}
        columns={[
          { key: 'ns', header: 'Namespace', cell: (r) => <span className="font-medium text-content">{r.ns}</span> },
          {
            key: 'quota',
            header: 'Quota',
            cell: (r) =>
              r.quotas.length ? (
                <span className="font-mono text-[11px] text-content">{r.quotas.map((q) => q.metadata.name).join(', ')}</span>
              ) : (
                <StatusBadge kind="degraded">None</StatusBadge>
              ),
          },
          {
            key: 'tight',
            header: 'Tightest usage',
            minWidth: 180,
            cell: (r) =>
              r.tight ? (
                <div className="min-w-[10rem]">
                  <div className="flex justify-between gap-2 text-[11px]">
                    <span className="text-content-muted">{resourceLabel(r.tight.resource)}</span>
                    <span className={cn('font-mono tabular-nums', PRESSURE_TONE[r.tight.pressure].text)}>{r.tight.pct == null ? '—' : `${r.tight.pct.toFixed(0)}%`}</span>
                  </div>
                  <UsageBar pct={r.tight.pct} pressure={r.tight.pressure} className="mt-1" />
                </div>
              ) : (
                <span className="text-content-subtle">—</span>
              ),
          },
          {
            key: 'limits',
            header: 'Limit range',
            cell: (r) =>
              r.limits.length ? (
                <span className="font-mono text-[11px] text-content">{r.limits.map((l) => l.metadata.name).join(', ')}</span>
              ) : (
                <StatusBadge kind="progressing">None</StatusBadge>
              ),
          },
          {
            key: 'act',
            header: '',
            align: 'right',
            cell: (r) => (
              <div className="flex justify-end gap-1.5">
                {!r.quotas.length && canQuota ? (
                  <Button size="sm" variant="secondary" onClick={() => onCreate({ kind: 'quota', namespace: r.ns })}>Add quota</Button>
                ) : null}
                {!r.limits.length && canLimit ? (
                  <Button size="sm" variant="ghost" onClick={() => onCreate({ kind: 'limits', namespace: r.ns })}>Add limits</Button>
                ) : null}
              </div>
            ),
          },
        ]}
        empty={<EmptyState title="No namespaces" />}
      />
    </ListShell>
  )
}

/* ═════════════════════════ shared drawer ═════════════════════════ */

function DrawerFrame({
  kind,
  name,
  namespace,
  badge,
  onClose,
  canEdit,
  onEdit,
  canDelete,
  deleteGvr,
  deleteNote,
  children,
}: {
  kind: string
  name: string
  namespace?: string
  badge?: React.ReactNode
  onClose(): void
  canEdit: boolean
  onEdit(): void
  canDelete: boolean
  deleteGvr: typeof GVRS.resourcequotas
  deleteNote: string
  children: React.ReactNode
}) {
  const width = useDrawerWidth('platform.quota', { base: 'max-w-2xl' })
  const qc = useQueryClient()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const del = useMutation({
    mutationFn: () => kube.delete(deleteGvr, namespace, name),
    onSuccess: () => {
      toast.success(`${kind} ${name} deleted`)
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })
  useOverlayDismiss(true, onClose)
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside className={cn('relative flex h-full w-full flex-col border-l border-edge-default bg-surface-canvas shadow-2xl', width.className)}>
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">{kind}</div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{name}</h2>
            <div className="mt-0.5 text-xs text-content-muted">namespace {namespace}</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {badge}
            {canEdit ? <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button> : null}
            {canDelete ? <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>Delete</Button> : null}
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <button type="button" onClick={onClose} className="rounded-md p-1 text-content-muted hover:bg-surface-sunken hover:text-content" aria-label="Close">✕</button>
          </div>
        </header>
        {confirming ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-rose-200 bg-rose-50/70 px-6 py-3 dark:border-rose-500/25 dark:bg-rose-500/10" role="alert">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-rose-900 dark:text-rose-300">Delete {kind} {name}?</div>
              <div className="text-[12px] text-content-muted">{deleteNote}</div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={del.isPending}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Deleting…' : 'Delete'}</Button>
            </div>
          </div>
        ) : null}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}

/* ═════════════════════════ create ═════════════════════════ */

function NamespaceField({ namespaces, value, onChange }: { namespaces: string[]; value: string; onChange(v: string): void }) {
  return (
    <Field label="Namespace" required>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>Select a namespace</option>
        {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
      </Select>
    </Field>
  )
}

const SCOPES = ['Terminating', 'NotTerminating', 'BestEffort', 'NotBestEffort'] as const

function CreateQuotaModal({
  namespaces,
  initialNamespace,
  existing,
  onClose,
}: {
  namespaces: string[]
  initialNamespace?: string
  existing: ResourceQuota[]
  onClose(): void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [ns, setNs] = useState(initialNamespace ?? '')
  const [name, setName] = useState(initialNamespace ? `${initialNamespace}-quota` : '')
  const [hard, setHard] = useState<Record<string, string>>({ ...QUOTA_PRESETS[0].hard })
  const preset = QUOTA_PRESETS.find((p) => QUOTA_KEYS.every((k) => (p.hard[k] ?? '') === (hard[k] ?? '')))?.id
  const [scopes, setScopes] = useState<string[]>([])
  const [extra, setExtra] = useState<Array<{ k: string; v: string }>>([])

  const all = { ...hard, ...Object.fromEntries(extra.map((e) => [e.k, e.v])) }
  const errors = Object.entries(all).map(([k, v]) => (v ? quantityError(v) && `${k}: ${quantityError(v)}` : undefined)).filter(Boolean) as string[]
  const nErr = nameError(name)
  const clash = existing.some((q) => q.metadata.namespace === ns && q.metadata.name === name)
  const empty = Object.values(all).every((v) => !v.trim())

  const mut = useMutation({
    mutationFn: () => kube.apply(buildQuota(ns, name, all, scopes)),
    onSuccess: () => {
      toast.success(`Quota ${name} created in ${ns}`)
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      branded
      title="New resource quota"
      description="Caps what a namespace may consume in total. Leave a field empty for no limit on it."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={mut.isPending}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!ns || !!nErr || clash || empty || errors.length > 0 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Creating…' : 'Create quota'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <NamespaceField namespaces={namespaces} value={ns} onChange={(v) => { setNs(v); if (!name || name.endsWith('-quota')) setName(`${v}-quota`) }} />
          <Field label="Name" required error={name ? nErr ?? (clash ? 'A quota with this name already exists in the namespace.' : undefined) : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="team-quota" invalid={!!name && (!!nErr || clash)} />
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-content">Start from</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {QUOTA_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setHard({ ...p.hard })}
                aria-pressed={preset === p.id}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left transition-colors',
                  preset === p.id
                    ? 'border-brand-400 bg-brand-50 ring-1 ring-brand-400 dark:border-brand-500/60 dark:bg-brand-500/10 dark:ring-brand-500/60'
                    : 'border-edge-default bg-surface-raised hover:border-brand-300',
                )}
              >
                <div className="text-[12px] font-semibold text-content">{p.label}</div>
                <div className="text-[11px] text-content-muted">{p.hint}</div>
                <div className="mt-1 font-mono text-[10px] text-content-subtle">{p.hard['requests.cpu']} CPU · {p.hard['requests.memory']} · {p.hard.pods} pods</div>
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {QUOTA_KEYS.map((k) => (
            <Field key={k} label={resourceLabel(k)} hint={k}>
              <Input
                value={hard[k] ?? ''}
                onChange={(e) => setHard((h) => ({ ...h, [k]: e.target.value }))}
                placeholder="no limit"
                invalid={!!quantityError(hard[k] ?? '')}
              />
            </Field>
          ))}
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] font-medium text-content">Other resources</span>
            <button type="button" className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setExtra((x) => [...x, { k: '', v: '' }])}>+ Add</button>
          </div>
          {extra.length ? (
            <div className="space-y-2">
              {extra.map((e, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2">
                  <Input value={e.k} placeholder="count/statefulsets.apps" onChange={(ev) => setExtra((x) => x.map((y, j) => (j === i ? { ...y, k: ev.target.value } : y)))} />
                  <Input value={e.v} placeholder="10" onChange={(ev) => setExtra((x) => x.map((y, j) => (j === i ? { ...y, v: ev.target.value } : y)))} />
                  <Button size="sm" variant="ghost" onClick={() => setExtra((x) => x.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-content-subtle">Any quota key, e.g. a storage class: <code className="font-mono">gold.storageclass.storage.k8s.io/requests.storage</code>.</p>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-content">Scopes <span className="font-normal text-content-subtle">(optional — limit which pods count)</span></div>
          <div className="flex flex-wrap gap-3">
            {SCOPES.map((s) => (
              <label key={s} className="inline-flex items-center gap-1.5 text-[12px] text-content-muted">
                <input type="checkbox" className="accent-brand-600" checked={scopes.includes(s)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} />
                {s}
              </label>
            ))}
          </div>
        </div>
        {errors.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-rose-700 dark:text-rose-300">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        ) : null}
      </div>
    </Modal>
  )
}

function CreateLimitRangeModal({
  namespaces,
  initialNamespace,
  existing,
  onClose,
}: {
  namespaces: string[]
  initialNamespace?: string
  existing: LimitRange[]
  onClose(): void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [ns, setNs] = useState(initialNamespace ?? '')
  const [name, setName] = useState(initialNamespace ? `${initialNamespace}-limits` : '')
  const [l, setL] = useState<ContainerLimits>({ ...LIMIT_PRESET })
  const errors = limitRangeErrors(l)
  const nErr = nameError(name)
  const clash = existing.some((x) => x.metadata.namespace === ns && x.metadata.name === name)
  const manifest = buildLimitRange(ns, name, l)

  const mut = useMutation({
    mutationFn: () => kube.apply(manifest),
    onSuccess: () => {
      toast.success(`Limit range ${name} created in ${ns}`)
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const f = (k: keyof ContainerLimits, label: string, placeholder: string) => (
    <Field label={label}>
      <Input value={l[k]} placeholder={placeholder} invalid={!!quantityError(l[k])} onChange={(e) => setL((x) => ({ ...x, [k]: e.target.value }))} />
    </Field>
  )

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      branded
      title="New limit range"
      description="Per-container defaults and bounds. Defaults fill in requests and limits a container leaves out, so quotas can admit it."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={mut.isPending}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!ns || !!nErr || clash || errors.length > 0 || manifest.spec.limits.length === 0 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Creating…' : 'Create limit range'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <NamespaceField namespaces={namespaces} value={ns} onChange={(v) => { setNs(v); if (!name || name.endsWith('-limits')) setName(`${v}-limits`) }} />
          <Field label="Name" required error={name ? nErr ?? (clash ? 'A limit range with this name already exists in the namespace.' : undefined) : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="team-limits" invalid={!!name && (!!nErr || clash)} />
          </Field>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-content">Container</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setL({ ...LIMIT_PRESET })}>Recommended</Button>
            <Button size="sm" variant="ghost" onClick={() => setL({ ...EMPTY_LIMITS })}>Clear</Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {f('defaultRequestCpu', 'Default CPU request', '100m')}
          {f('defaultRequestMemory', 'Default memory request', '128Mi')}
          {f('defaultCpu', 'Default CPU limit', '500m')}
          {f('defaultMemory', 'Default memory limit', '512Mi')}
          {f('minCpu', 'Min CPU', '10m')}
          {f('minMemory', 'Min memory', '16Mi')}
          {f('maxCpu', 'Max CPU', '2')}
          {f('maxMemory', 'Max memory', '4Gi')}
        </div>
        <div className="text-[12px] font-medium text-content">Persistent volume claims</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {f('pvcMin', 'Min size', '1Gi')}
          {f('pvcMax', 'Max size', '100Gi')}
        </div>
        {errors.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-rose-700 dark:text-rose-300">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        ) : null}
      </div>
    </Modal>
  )
}
