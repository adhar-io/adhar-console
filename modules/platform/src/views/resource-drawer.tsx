import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AiButton,
  Card,
  CardBody,
  CardHeader,
  StatusBadge,
  type AiContext,
  type StatusKind,
} from '@adhar-console/shell-ui'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { cn } from '@adhar-console/utils'
import { age } from '../data/format.ts'
import { EventsTimeline } from './events-timeline.tsx'
import { Topology } from './topology.tsx'

/** Best-effort plural resource name from a Kind (for the AI context). */
function pluralize(kind: string): string {
  const k = kind.toLowerCase()
  if (k.endsWith('s')) return `${k}es`
  if (k.endsWith('y')) return `${k.slice(0, -1)}ies`
  return `${k}s`
}

function aiContextOf(resource: Resource): AiContext | undefined {
  if (!resource.kind) return undefined
  const [group, version] = (resource.apiVersion ?? 'v1').includes('/')
    ? (resource.apiVersion ?? 'v1').split('/')
    : ['', resource.apiVersion ?? 'v1']
  return {
    group,
    version,
    resource: pluralize(resource.kind),
    kind: resource.kind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name,
  }
}

/**
 * Headlamp-style detail drawer used by Deployment / Service / Ingress and
 * other primary K8s resources. Each caller supplies a renderer for the
 * resource-specific sections; this component owns the shell (slide-in
 * overlay, header, ESC handling, metadata/labels/annotations/YAML).
 */

export interface ResourceMeta {
  name: string
  namespace?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  uid?: string
}

export interface Resource {
  apiVersion?: string
  kind?: string
  metadata: ResourceMeta
}

export function ResourceDrawer<T extends Resource>({
  resource,
  kindLabel,
  statusBadge,
  children,
  onClose,
}: {
  resource: T
  kindLabel: string
  statusBadge?: ReactNode
  children: ReactNode
  onClose(): void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ai = aiContextOf(resource)

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
              {kindLabel}
              {resource.metadata.namespace ? ` · ${resource.metadata.namespace}` : ''}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
              {resource.metadata.name}
            </h2>
            {resource.apiVersion && resource.kind ? (
              <div className="mt-1 text-[11px] font-mono text-content-muted">
                {resource.apiVersion}/{resource.kind}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {ai ? (
              <>
                <AiButton mode="diagnose" context={ai} label="Diagnose" title={`Diagnose ${resource.metadata.name}`} />
                <AiButton mode="explain" context={ai} label="Explain" title={`Explain ${resource.metadata.name}`} />
              </>
            ) : null}
            {statusBadge}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {children}

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Topology</div>
            </CardHeader>
            <CardBody>
              <Topology object={resource as unknown as KubeObject} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Related events</div>
            </CardHeader>
            <CardBody>
              <EventsTimeline
                namespace={resource.metadata.namespace}
                name={resource.metadata.name}
                kind={resource.kind}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Metadata</div>
            </CardHeader>
            <CardBody className="divide-y divide-edge-subtle text-sm">
              <Row label="UID" value={resource.metadata.uid ?? '—'} mono />
              <Row label="Created" value={age(resource.metadata.creationTimestamp)} />
              <Row label="Labels" value={tagCloud(resource.metadata.labels)} />
              <Row label="Annotations" value={tagCloud(resource.metadata.annotations, 3)} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Raw object</div>
            </CardHeader>
            <CardBody>
              <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
                {JSON.stringify(resource, null, 2)}
              </pre>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

export function DrawerSection({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-content">{title}</div>
          {actions}
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  )
}

export function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: ReactNode
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

export function DrawerStatusTile({
  label,
  kind,
  value,
  sub,
}: {
  label: string
  kind: StatusKind
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">
          {label}
        </div>
        <StatusBadge kind={kind}>{value}</StatusBadge>
      </div>
      {sub ? <div className="mt-2 text-xs text-content-muted">{sub}</div> : null}
    </div>
  )
}

function tagCloud(map: Record<string, string> | undefined, max = 6) {
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
