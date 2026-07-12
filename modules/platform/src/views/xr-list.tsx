import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
  type Column,
} from '@adhar-console/shell-ui'
import { k8s } from '@adhar-console/api-clients'
import { cn } from '@adhar-console/utils'
import { client } from '../data/client.ts'
import { useGeneric } from '../data/hooks.ts'
import { age } from '../data/format.ts'

/**
 * Generic list + detail drawer for a Crossplane Composite Resource (XR).
 *
 * Every Adhar Platform abstraction (Application, Database, DataPipeline,
 * Pipeline, Route) resolves to an XR in the cluster with standard Crossplane
 * conventions:
 *
 *   status.conditions[type=Ready]
 *   status.conditions[type=Synced]
 *   spec.compositionRef.name     (which Composition shaped this XR)
 *   spec.compositionSelector     (label-based selector variant)
 *   status.resourceRefs[]        (all composed resources)
 *
 * This component leans on those conventions so we don't need 5 bespoke list
 * views — a per-kind config map supplies kind-specific extra columns and the
 * drawer's "Spec" renderer.
 */

export interface XrKindConfig {
  /** GVR used to query the kube-apiserver. */
  gvr: k8s.GVR
  /** Singular + plural human names. */
  singular: string
  plural: string
  /** One-line page subtitle. */
  description: string
  /**
   * Spec keys to surface in the detail drawer's "Spec" section. Drawer shows
   * `key → value` rows for each; anything not listed is folded into the YAML
   * view.
   */
  specFields?: Array<{ key: string; label: string; mono?: boolean }>
  /** Extra columns to insert between name and age. */
  extraColumns?: Column<XR>[]
  /** Upstream docs link surfaced when the XRD isn't installed. */
  docsHref?: string
}

export interface XR {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    uid?: string
  }
  spec?: Record<string, unknown>
  status?: {
    conditions?: Array<{
      type: string
      status: 'True' | 'False' | 'Unknown'
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
    resourceRefs?: Array<{
      apiVersion?: string
      kind?: string
      name?: string
      namespace?: string
    }>
    [k: string]: unknown
  }
}

export function XrList({
  config,
  namespace,
}: {
  config: XrKindConfig
  namespace?: string
}) {
  const q = useGeneric(config.gvr, config.gvr.namespaced ? namespace : undefined)
  const [selected, setSelected] = useState<XR | null>(null)

  const is404 = q.isError && (q.error as { status?: number })?.status === 404

  if (is404) {
    return (
      <EmptyState
        title={`${config.plural} not installed`}
        description={
          <>
            <code className="font-mono">{config.gvr.group}/{config.gvr.version}/{config.gvr.resource}</code>{' '}
            is not registered on this cluster. Install the Adhar Platform Crossplane stack to
            provision {config.plural.toLowerCase()}.
            {config.docsHref ? (
              <>
                {' '}
                <a
                  className="text-brand-700 underline hover:text-brand-800"
                  target="_blank"
                  rel="noreferrer"
                  href={config.docsHref}
                >
                  Upstream docs ↗
                </a>
              </>
            ) : null}
          </>
        }
      />
    )
  }

  if (q.isError) {
    return (
      <EmptyState
        title={`Couldn't list ${config.plural.toLowerCase()}`}
        description={(q.error as Error).message}
      />
    )
  }

  const rows = (q.data ?? []) as unknown as XR[]

  const columns: Column<XR>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (r) => (
        <div>
          <div className="font-medium text-content">{r.metadata.name}</div>
          {r.metadata.namespace ? (
            <div className="text-xs text-content-muted">{r.metadata.namespace}</div>
          ) : (
            <div className="text-xs text-content-subtle">cluster-scoped</div>
          )}
        </div>
      ),
    },
    {
      key: 'ready',
      header: 'Ready',
      cell: (r) => conditionBadge(r, 'Ready'),
    },
    {
      key: 'synced',
      header: 'Synced',
      cell: (r) => conditionBadge(r, 'Synced'),
    },
    {
      key: 'composition',
      header: 'Composition',
      cell: (r) => {
        const name = (r.spec?.compositionRef as { name?: string } | undefined)?.name
        if (name) return <code className="text-xs text-content-muted">{name}</code>
        const sel = r.spec?.compositionSelector as
          | { matchLabels?: Record<string, string> }
          | undefined
        if (sel?.matchLabels && Object.keys(sel.matchLabels).length) {
          return (
            <code className="text-xs text-content-muted">
              selector · {Object.entries(sel.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')}
            </code>
          )
        }
        return <span className="text-content-subtle">—</span>
      },
    },
    ...(config.extraColumns ?? []),
    { key: 'age', header: 'Age', cell: (r) => age(r.metadata.creationTimestamp) },
  ]

  return (
    <>
      <DataTable
        loading={q.isLoading}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.metadata.uid ?? `${r.metadata.namespace ?? '-'}/${r.metadata.name}`}
        onRowClick={(r) => setSelected(r)}
        empty={
          <EmptyState
            title={`No ${config.plural.toLowerCase()} yet`}
            description={`Claim a ${config.singular} via GitOps to populate this list.`}
          />
        }
      />
      {selected ? (
        <XrDrawer config={config} xr={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

/* ───── detail drawer ───── */

function XrDrawer({
  config,
  xr,
  onClose,
}: {
  config: XrKindConfig
  xr: XR
  onClose(): void
}) {
  // Live-refresh the single resource so the drawer reflects reconcile progress.
  const live = useQuery({
    queryKey: [
      'platform',
      'xr',
      config.gvr.group,
      config.gvr.version,
      config.gvr.resource,
      xr.metadata.namespace ?? '-',
      xr.metadata.name,
    ],
    queryFn: () =>
      client.getGeneric(undefined, config.gvr, xr.metadata.namespace, xr.metadata.name),
    refetchInterval: 10_000,
    initialData: xr as unknown as k8s.Generic,
    retry: false,
  })
  const current = ((live.data as unknown) ?? xr) as XR

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ready = findCondition(current, 'Ready')
  const synced = findCondition(current, 'Synced')

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              {config.singular} ·{' '}
              {current.metadata.namespace ? current.metadata.namespace : 'cluster'}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
              {current.metadata.name}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-mono text-content-muted">
              {current.apiVersion}/{current.kind}
              {live.isFetching ? (
                <span className="inline-flex items-center gap-1 text-content-subtle">
                  <Spinner size={12} /> refreshing
                </span>
              ) : null}
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
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* ─── Status ─── */}
          <section className="grid grid-cols-2 gap-3">
            <StatusTile
              label="Ready"
              badge={
                ready ? (
                  <StatusBadge kind={ready.status === 'True' ? 'healthy' : 'degraded'}>
                    {ready.status === 'True' ? 'Ready' : (ready.reason ?? 'Not ready')}
                  </StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">—</StatusBadge>
                )
              }
              message={ready?.message}
            />
            <StatusTile
              label="Synced"
              badge={
                synced ? (
                  <StatusBadge kind={synced.status === 'True' ? 'healthy' : 'degraded'}>
                    {synced.status === 'True' ? 'Synced' : (synced.reason ?? 'Out of sync')}
                  </StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">—</StatusBadge>
                )
              }
              message={synced?.message}
            />
          </section>

          {/* ─── Spec ─── */}
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Spec</div>
            </CardHeader>
            <CardBody className="divide-y divide-edge-subtle text-sm">
              <SpecRow
                label="Composition"
                value={
                  (current.spec?.compositionRef as { name?: string } | undefined)?.name ??
                  formatSelector(
                    current.spec?.compositionSelector as { matchLabels?: Record<string, string> } | undefined,
                  ) ??
                  '—'
                }
                mono
              />
              {(config.specFields ?? []).map((f) => (
                <SpecRow
                  key={f.key}
                  label={f.label}
                  value={formatSpecValue(current.spec?.[f.key])}
                  mono={f.mono}
                />
              ))}
            </CardBody>
          </Card>

          {/* ─── Composed resources ─── */}
          {current.status?.resourceRefs?.length ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-content">Composed resources</div>
                  <span className="text-xs text-content-subtle">
                    {current.status.resourceRefs.length}
                  </span>
                </div>
              </CardHeader>
              <CardBody>
                <ul className="divide-y divide-edge-subtle">
                  {current.status.resourceRefs.map((r, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-3 px-1 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-content">
                          {r.kind}/{r.name}
                        </div>
                        <div className="text-[11px] font-mono text-content-muted">
                          {r.apiVersion}
                          {r.namespace ? ` · ${r.namespace}` : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          {/* ─── All conditions ─── */}
          {current.status?.conditions?.length ? (
            <Card>
              <CardHeader>
                <div className="text-sm font-semibold text-content">Conditions</div>
              </CardHeader>
              <CardBody>
                <ul className="divide-y divide-edge-subtle">
                  {current.status.conditions.map((c) => (
                    <li key={c.type} className="flex items-start gap-3 px-1 py-2 text-sm">
                      <StatusBadge
                        kind={
                          c.status === 'True' && (c.type === 'Ready' || c.type === 'Synced')
                            ? 'healthy'
                            : c.status === 'False'
                              ? 'degraded'
                              : 'info'
                        }
                      >
                        {c.type}
                      </StatusBadge>
                      <div className="min-w-0 flex-1">
                        <div className="text-content">{c.reason ?? c.status}</div>
                        {c.message ? (
                          <div className="mt-0.5 text-xs text-content-muted">{c.message}</div>
                        ) : null}
                        {c.lastTransitionTime ? (
                          <div className="mt-0.5 text-[11px] text-content-subtle">
                            {age(c.lastTransitionTime)} ago
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          {/* ─── Metadata ─── */}
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Metadata</div>
            </CardHeader>
            <CardBody className="divide-y divide-edge-subtle text-sm">
              <SpecRow label="UID" value={current.metadata.uid ?? '—'} mono />
              <SpecRow label="Created" value={age(current.metadata.creationTimestamp)} />
              <SpecRow
                label="Labels"
                value={renderTags(current.metadata.labels)}
              />
              <SpecRow
                label="Annotations"
                value={renderTags(current.metadata.annotations, 3)}
              />
            </CardBody>
          </Card>

          {/* ─── Raw YAML ─── */}
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Raw object</div>
            </CardHeader>
            <CardBody>
              <pre
                className={cn(
                  'max-h-96 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100',
                )}
              >
                {JSON.stringify(current, null, 2)}
              </pre>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ───── helpers + atoms ───── */

function conditionBadge(xr: XR, type: 'Ready' | 'Synced') {
  const c = findCondition(xr, type)
  if (!c) return <StatusBadge kind="unknown">—</StatusBadge>
  const kind: StatusKind = c.status === 'True' ? 'healthy' : c.status === 'False' ? 'degraded' : 'info'
  return (
    <div title={c.message} className="inline-flex">
      <StatusBadge kind={kind}>{c.status === 'True' ? type : (c.reason ?? type)}</StatusBadge>
    </div>
  )
}

function findCondition(xr: XR, type: string) {
  return (xr.status?.conditions ?? []).find((c) => c.type === type)
}

function formatSelector(
  sel: { matchLabels?: Record<string, string> } | undefined,
): string | undefined {
  if (!sel?.matchLabels) return undefined
  const pairs = Object.entries(sel.matchLabels)
  if (!pairs.length) return undefined
  return pairs.map(([k, v]) => `${k}=${v}`).join(',')
}

function formatSpecValue(v: unknown): React.ReactNode {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  return (
    <code className="font-mono text-xs">{JSON.stringify(v)}</code>
  )
}

function renderTags(map: Record<string, string> | undefined, max = 6) {
  if (!map) return <span className="text-content-subtle">—</span>
  const entries = Object.entries(map)
  if (!entries.length) return <span className="text-content-subtle">—</span>
  const shown = entries.slice(0, max)
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {shown.map(([k, v]) => (
        <code
          key={k}
          title={`${k}=${v}`}
          className="max-w-[20rem] truncate rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted"
        >
          {k}={v}
        </code>
      ))}
      {entries.length > max ? (
        <span className="text-[11px] text-content-subtle">+{entries.length - max}</span>
      ) : null}
    </div>
  )
}

function StatusTile({
  label,
  badge,
  message,
}: {
  label: string
  badge: React.ReactNode
  message?: string
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">
          {label}
        </div>
        {badge}
      </div>
      {message ? (
        <div className="mt-2 line-clamp-3 text-xs text-content-muted">{message}</div>
      ) : null}
    </div>
  )
}

function SpecRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-content-subtle">
        {label}
      </span>
      <span className={cn('text-right text-sm text-content', mono && 'font-mono text-xs')}>
        {value}
      </span>
    </div>
  )
}

function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
