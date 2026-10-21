import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AiButton,
  Button,
  EmptyState,
  Spinner,
  StatusBadge,
  Tabs,
  useOverlayDismiss,
  useToast,
  type TabDef,
  DrawerWidenButton,
  useDrawerWidth,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { kube, type DiscoveredResource, type GatewayGVR as GVR, type KubeObject } from '@adhar/api-clients/k8s'
import { clusterParam, useActiveCluster } from '../data/client.ts'
import { useAccess } from '../data/live.ts'
import { age } from '../data/format.ts'
import {
  apiVersionOf,
  cellText,
  conditionTimeline,
  deriveStatus,
  kindForObject,
  kubectlGet,
  type PrinterColumn,
  writePermFor,
} from '../data/explore.ts'
import { EventsTimeline } from './events-timeline.tsx'
import { PodYamlPanel } from './pod-yaml.tsx'

/**
 * Detail drawer for any object the Explore page lists. Overview shows what is
 * generic to every Kubernetes object — derived status, kubectl's printer
 * columns, metadata, owners (clickable, they open the owner in place), labels
 * (click one to filter the table by it), annotations, finalizers and the
 * condition timeline. YAML is the shared Monaco panel pointed at this kind's
 * GVR; Events is the live involved-object timeline.
 *
 * The object comes from the page's live watch when it is in the list, so the
 * drawer updates in place; a deep-linked object outside the current scope is
 * fetched once instead.
 */

type Sub = 'overview' | 'yaml' | 'events'

interface Props {
  kind: DiscoveredResource
  kinds: DiscoveredResource[]
  /** The live copy, when the watch has it. */
  live: KubeObject | undefined
  target: { namespace?: string; name: string }
  printer: { columns: PrinterColumn[]; cells?: unknown[] }
  onClose(): void
  onOpen(kind: DiscoveredResource, target: { namespace?: string; name: string }): void
  onFilterLabel(selector: string): void
}

export function ExploreDrawer({ kind, kinds, live, target, printer, onClose, onOpen, onFilterLabel }: Props) {
  const width = useDrawerWidth('platform.explore', { base: 'max-w-3xl' })
  const toast = useToast()
  const qc = useQueryClient()
  const { cluster } = useActiveCluster()
  const gvr: GVR & { namespaced: boolean } = { group: kind.group, version: kind.version, resource: kind.name, namespaced: kind.namespaced }
  const ns = kind.namespaced ? target.namespace : undefined

  const fetched = useQuery({
    queryKey: ['k8s', 'explore-object', gvr.group, gvr.version, gvr.resource, ns ?? '', target.name, cluster],
    queryFn: () => kube.get<KubeObject>(gvr, ns, target.name, { cluster: clusterParam(cluster) }),
    enabled: !live,
    retry: false,
  })
  // List and watch items carry no apiVersion/kind — restore them so the YAML
  // panel shows (and applies) a complete manifest.
  const raw = live ?? fetched.data
  const obj = useMemo(
    () => (raw ? ({ apiVersion: raw.apiVersion ?? apiVersionOf(kind), kind: raw.kind ?? kind.kind, ...raw } as KubeObject) : undefined),
    [raw, kind],
  )

  const canDelete = useAccess({ verb: 'delete', group: gvr.group, resource: gvr.resource, namespace: ns, name: target.name })
  const [confirming, setConfirming] = useState(false)
  const [revealSecret, setRevealSecret] = useState(false)
  const del = useMutation({
    mutationFn: () => kube.delete(gvr, ns, target.name, { propagationPolicy: 'Foreground', cluster: clusterParam(cluster) }),
    onSuccess: () => {
      toast.success(`${kind.kind} ${target.name} deleted`, {
        description: kind.namespaced && ns ? `in namespace ${ns}` : undefined,
      })
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error(`Couldn't delete ${target.name}`, { description: (e as Error).message }),
  })

  useOverlayDismiss(true, () => (confirming ? setConfirming(false) : onClose()))

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Copied ${what}`, { description: <span className="break-all font-mono text-[11px]">{text}</span> })
    } catch {
      toast.error('Clipboard unavailable', { description: 'Your browser blocked clipboard access.' })
    }
  }

  const status = obj ? deriveStatus(obj) : null
  const isSecret = kind.group === '' && kind.name === 'secrets'
  const isEvent = kind.kind === 'Event'
  const tabs: TabDef<Sub>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'yaml', label: 'YAML' },
    { id: 'events', label: 'Events', hidden: isEvent },
  ]
  const ai = {
    group: kind.group,
    version: kind.version,
    resource: kind.name,
    kind: kind.kind,
    namespace: ns,
    name: target.name,
  }
  const where = ns ? ` in namespace ${ns}` : ''

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${kind.kind} ${target.name}`}>
      <div className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside className={cn('relative flex h-full w-full flex-col border-l border-edge-default bg-surface-canvas shadow-2xl', width.className)}>
        <header className="border-b border-edge-default bg-surface-raised px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold uppercase tracking-wider text-content-subtle">
                {kind.kind}
                {ns ? ` · ${ns}` : kind.namespaced ? '' : ' · cluster-scoped'}
              </div>
              <h2 className="mt-0.5 break-all text-lg font-semibold leading-snug text-content">{target.name}</h2>
              <div className="mt-1 font-mono text-[11px] text-content-muted">
                {apiVersionOf(kind)}/{kind.kind}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {status ? (
                <span title={status.detail}>
                  <StatusBadge kind={status.tone}>{status.text}</StatusBadge>
                </span>
              ) : null}
              <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
              >
                <CloseGlyph />
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <AiButton
              agentId="sre"
              context={ai}
              label="Diagnose"
              title={`Diagnose ${target.name}`}
              prompt={`Diagnose the health of ${kind.kind} "${target.name}"${where}. Gather evidence first, explain the root cause of anything wrong, and propose a fix if there is one. If it is healthy, say so briefly.`}
            />
            <AiButton
              agentId="platform"
              context={ai}
              label="Explain"
              title={`Explain ${target.name}`}
              prompt={`Explain what ${kind.kind} "${target.name}"${where} is, what it does, its current state and anything notable an operator should know. Inspect it first.`}
            />
            <span className="mr-auto" />
            <Button size="sm" variant="secondary" leading={<CopyGlyph />} onClick={() => copy(target.name, 'name')}>
              Name
            </Button>
            <Button size="sm" variant="secondary" leading={<TerminalGlyph />} onClick={() => copy(kubectlGet(kind, target), 'kubectl command')}>
              kubectl
            </Button>
            {canDelete.data && obj ? (
              <Button size="sm" variant="danger" onClick={() => setConfirming(true)} disabled={confirming}>
                Delete
              </Button>
            ) : null}
          </div>
        </header>

        {confirming ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-rose-200 bg-rose-50/70 px-4 py-3 dark:border-rose-500/25 dark:bg-rose-500/10 sm:px-6" role="alert">
            <div className="min-w-0 flex-1 text-sm">
              <div className="break-all font-semibold text-rose-900 dark:text-rose-300">
                Delete {kind.kind} {target.name}?
              </div>
              <div className="text-[12px] text-content-muted">
                Foreground deletion — objects it owns are removed first. This cannot be undone.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={del.isPending}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" disabled={del.isPending} onClick={() => del.mutate()}>
                {del.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {!obj ? (
            fetched.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-content-muted">
                <Spinner size={16} /> Loading {kind.kind}…
              </div>
            ) : (
              <EmptyState
                title={`${kind.kind} not found`}
                description={
                  (fetched.error as Error | null)?.message ??
                  `${target.name} no longer exists${where}. It may have been deleted.`
                }
              />
            )
          ) : (
            <Tabs<Sub> tabs={tabs} defaultValue="overview" ariaLabel={`${kind.kind} sections`}>
              {(active) =>
                active === 'overview' ? (
                  <Overview obj={obj} kind={kind} kinds={kinds} printer={printer} onOpen={onOpen} onFilterLabel={onFilterLabel} onCopy={copy} />
                ) : active === 'yaml' ? (
                  isSecret && !revealSecret ? (
                    <EmptyState
                      title="Secret values are hidden"
                      description="The manifest carries every value of this Secret (base64-encoded, not encrypted). Reveal it only when you need to read or edit it."
                      action={
                        <Button size="sm" variant="secondary" onClick={() => setRevealSecret(true)}>
                          Reveal YAML
                        </Button>
                      }
                    />
                  ) : (
                    <PodYamlPanel pod={obj as never} gvr={gvr} writePerm={writePermFor(kind)} />
                  )
                ) : (
                  <EventsTimeline namespace={ns} name={target.name} kind={kind.kind} />
                )
              }
            </Tabs>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─── overview ──────────────────────────────────────────────────────────── */

function Overview({
  obj,
  kind,
  kinds,
  printer,
  onOpen,
  onFilterLabel,
  onCopy,
}: {
  obj: KubeObject
  kind: DiscoveredResource
  kinds: DiscoveredResource[]
  printer: Props['printer']
  onOpen: Props['onOpen']
  onFilterLabel: Props['onFilterLabel']
  onCopy(text: string, what: string): void
}) {
  const m = obj.metadata
  const status = deriveStatus(obj)
  const conditions = useMemo(() => conditionTimeline(obj), [obj])
  const finalizers = (m as { finalizers?: string[] }).finalizers ?? []
  const generation = (m as { generation?: number }).generation
  const printed = printer.cells
    ? printer.columns
        .map((c) => ({ c, v: printer.cells![c.index] }))
        .filter(({ v }) => cellText(v) !== '')
    : []
  const secretKeys = kind.group === '' && kind.name === 'secrets'
    ? Object.keys({ ...((obj as { data?: object }).data ?? {}), ...((obj as { stringData?: object }).stringData ?? {}) })
    : null

  return (
    <div className="space-y-4">
      {status?.detail ? (
        <section className={cn('rounded-xl border p-4 text-sm', TONE_PANEL[status.tone] ?? TONE_PANEL.info)}>
          <div className="mb-1 font-semibold">{status.text}</div>
          <p className="whitespace-pre-wrap break-words text-[13px] opacity-90">{status.detail}</p>
        </section>
      ) : null}

      {printed.length ? (
        <Panel title="Summary" hint="kubectl columns">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {printed.map(({ c, v }) => (
              <div key={c.name} className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-content-subtle" title={c.description}>
                  {c.name}
                </dt>
                <dd className="mt-0.5 break-words font-mono text-[12px] text-content">
                  {c.type === 'date' ? `${age(String(v))} ago` : cellText(v)}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      ) : null}

      <Panel title="Metadata">
        <dl className="divide-y divide-edge-subtle text-sm">
          <Meta label="Name">
            <span className="break-all">{m.name}</span>
          </Meta>
          {m.namespace ? <Meta label="Namespace">{m.namespace}</Meta> : null}
          <Meta label="Created">
            {m.creationTimestamp ? (
              <span title={new Date(m.creationTimestamp).toLocaleString()}>
                {age(m.creationTimestamp)} ago
                <span className="ml-1.5 text-[11px] text-content-subtle">{new Date(m.creationTimestamp).toLocaleString()}</span>
              </span>
            ) : (
              '—'
            )}
          </Meta>
          {m.deletionTimestamp ? (
            <Meta label="Deleting">
              <span className="text-rose-700 dark:text-rose-300">since {age(m.deletionTimestamp)} ago</span>
            </Meta>
          ) : null}
          {m.uid ? (
            <Meta label="UID">
              <button type="button" onClick={() => onCopy(m.uid!, 'UID')} className="break-all text-left font-mono text-[11px] hover:text-brand-700 dark:hover:text-brand-300" title="Copy UID">
                {m.uid}
              </button>
            </Meta>
          ) : null}
          {m.resourceVersion ? <Meta label="Resource version"><span className="font-mono text-[11px]">{m.resourceVersion}</span></Meta> : null}
          {generation !== undefined ? <Meta label="Generation"><span className="font-mono text-[11px]">{generation}</span></Meta> : null}
          {m.ownerReferences?.length ? (
            <Meta label="Owners">
              <div className="flex flex-wrap justify-end gap-1.5">
                {m.ownerReferences.map((o) => {
                  const ok = kindForObject(kinds, o.apiVersion, o.kind)
                  return ok ? (
                    <button
                      key={o.uid}
                      type="button"
                      onClick={() => onOpen(ok, { namespace: ok.namespaced ? m.namespace : undefined, name: o.name })}
                      className="inline-flex max-w-full items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 py-0.5 text-[12px] text-brand-700 transition-colors hover:border-brand-300 dark:text-brand-300"
                    >
                      <span className="text-content-subtle">{o.kind}</span>
                      <span className="truncate font-medium">{o.name}</span>
                      <ArrowGlyph />
                    </button>
                  ) : (
                    <span key={o.uid} className="rounded-md bg-surface-sunken px-2 py-0.5 text-[12px] text-content-muted">
                      {o.kind} {o.name}
                    </span>
                  )
                })}
              </div>
            </Meta>
          ) : null}
        </dl>
      </Panel>

      {secretKeys ? (
        <Panel title="Data" hint={`${secretKeys.length} key${secretKeys.length === 1 ? '' : 's'} · values hidden`}>
          {secretKeys.length ? (
            <div className="flex flex-wrap gap-1.5">
              {secretKeys.map((k) => (
                <span key={k} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">{k}</span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-content-subtle">No data keys.</p>
          )}
        </Panel>
      ) : null}

      <Panel title="Labels" hint={m.labels && Object.keys(m.labels).length ? 'click to filter the list' : undefined}>
        <Chips map={m.labels} onPick={(k, v) => onFilterLabel(`${k}=${v}`)} />
      </Panel>

      <Panel title="Annotations">
        <Chips map={m.annotations} max={8} />
      </Panel>

      {finalizers.length ? (
        <Panel title="Finalizers">
          <div className="flex flex-wrap gap-1.5">
            {finalizers.map((f) => (
              <span key={f} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">{f}</span>
            ))}
          </div>
        </Panel>
      ) : null}

      {conditions.length ? (
        <Panel title="Conditions" hint="newest first">
          <ol className="relative space-y-4 border-l border-edge-default pl-5">
            {conditions.map((c) => (
              <li key={c.type} className="relative">
                <span className={cn('absolute -left-[1.6rem] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-surface-raised', TONE_DOT[c.tone])} aria-hidden />
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-content">{c.type}</span>
                  <StatusBadge kind={c.tone} dot={false}>{c.status}</StatusBadge>
                  {c.reason ? <span className="font-mono text-[11px] text-content-muted">{c.reason}</span> : null}
                  {c.lastTransitionTime ? (
                    <span className="ml-auto text-[11px] text-content-subtle" title={new Date(c.lastTransitionTime).toLocaleString()}>
                      {age(c.lastTransitionTime)} ago
                    </span>
                  ) : null}
                </div>
                {c.message ? <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-content-muted">{c.message}</p> : null}
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
    </div>
  )
}

const TONE_DOT: Record<string, string> = {
  healthy: 'bg-emerald-500',
  progressing: 'bg-indigo-500',
  degraded: 'bg-amber-500',
  failed: 'bg-rose-500',
  paused: 'bg-amber-400',
  unknown: 'bg-slate-400',
  info: 'bg-sky-500',
}

const TONE_PANEL: Record<string, string> = {
  healthy: 'border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200',
  progressing: 'border-indigo-200 bg-indigo-50/60 text-indigo-900 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-200',
  degraded: 'border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200',
  failed: 'border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200',
  paused: 'border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200',
  unknown: 'border-edge-default bg-surface-raised text-content',
  info: 'border-sky-200 bg-sky-50/60 text-sky-900 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-200',
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-content">{title}</h3>
        {hint ? <span className="text-[11px] text-content-subtle">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-content">{children}</dd>
    </div>
  )
}

function Chips({ map, max = 12, onPick }: { map?: Record<string, string>; max?: number; onPick?(k: string, v: string): void }) {
  const [all, setAll] = useState(false)
  const entries = Object.entries(map ?? {})
  if (!entries.length) return <p className="text-sm text-content-subtle">None</p>
  const shown = all ? entries : entries.slice(0, max)
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map(([k, v]) => {
        const text = v.length > 120 ? `${v.slice(0, 120)}…` : v
        const cls = 'max-w-full truncate rounded-md border border-edge-default bg-surface-sunken px-1.5 py-0.5 text-left font-mono text-[11px] text-content-muted'
        return onPick ? (
          <button key={k} type="button" title={`Filter by ${k}=${v}`} onClick={() => onPick(k, v)} className={cn(cls, 'transition-colors hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300')}>
            <span className="text-content-subtle">{k}=</span>
            {text}
          </button>
        ) : (
          <span key={k} title={`${k}=${v}`} className={cls}>
            <span className="text-content-subtle">{k}=</span>
            {text}
          </span>
        )
      })}
      {entries.length > max ? (
        <button type="button" onClick={() => setAll((a) => !a)} className="px-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          {all ? 'Show fewer' : `+${entries.length - max} more`}
        </button>
      ) : null}
    </div>
  )
}

/* ─── glyphs ────────────────────────────────────────────────────────────── */

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

function TerminalGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </svg>
  )
}

function ArrowGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  )
}
