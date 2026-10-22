import { type ReactNode, useMemo, useState } from 'react'
import { LogConsole, Spinner, StatusBadge, useLogStream, useToolPublicUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { CodeViewer } from './code-viewer.tsx'
import { ConditionsTable, FieldList, NodeSidePanel, RelatedList, StatusCallout } from './resource-graph.tsx'
import { useDiscovery, useLiveObject, useObjectEvents } from '~/data/catalog-composition.ts'
import { age, apiVersionOf, type CompNode, type CompositionGraph } from '~/data/catalog-composition-model.ts'
import { useManagedResources } from '~/data/catalog-resources.ts'
import { comparable, diffChunks, hostnamesOf, imagesOf, imageTag, lineDiff, podInfo, workloadReplicas } from '~/data/catalog-resources-model.ts'
import { toYaml } from '~/data/k8s-yaml.ts'

/**
 * The one detail panel every resource view in the catalog drawer opens —
 * composition graph, Argo CD tree, network, pods and list alike:
 * Summary (fields, status, containers, conditions, Argo CD info, relations),
 * Events, YAML (the live object), Diff (desired vs live, for out-of-sync
 * resources an Argo CD app manages) and Logs (Pods). Also the card extras the
 * graphs show (replicas, image tags, hostnames).
 */

export function cardExtra(n: CompNode): ReactNode {
  const r = workloadReplicas(n)
  const imgs = imagesOf(n)
  const pod = n.kind === 'Pod' ? podInfo(n) : undefined
  const parts: string[] = []
  if (r) parts.push(`${r.ready}/${r.desired} ready`)
  if (pod) parts.push(`${pod.ready} ready${pod.restarts ? ` · ${pod.restarts} restarts` : ''}`)
  if (imgs.length && n.kind !== 'Pod') parts.push(imgs.map(imageTag).join(', '))
  return parts.length ? parts.join(' · ') : null
}

export function networkExtra(n: CompNode): ReactNode {
  if (n.kind === 'Service') {
    const spec = (n.object?.spec ?? {}) as { type?: string; clusterIP?: string; ports?: Array<{ port?: number }> }
    return [spec.type, spec.ports?.map((p) => p.port).join(',')].filter(Boolean).join(' · ') || null
  }
  if (n.kind === 'Pod') return podInfo(n)?.reason ?? (n.object?.status as { podIP?: string } | undefined)?.podIP ?? null
  const hosts = hostnamesOf(n)
  return hosts.length ? hosts.join(', ') : null
}


/** Events for one object (see `useObjectEvents`), with honest empty/RBAC states. */
export function EventsList({ events, now }: { events: ReturnType<typeof useObjectEvents>; now: number }) {
  if (events.isLoading) return <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Loading events…</div>
  if (events.error) {
    return (
      <p className="text-xs text-content-muted">
        {(events.error as { status?: number }).status === 403 ? 'Your role cannot list events in this namespace.' : `Could not load events: ${events.error instanceof Error ? events.error.message : String(events.error)}`}
      </p>
    )
  }
  if (!events.data?.length) return <p className="text-xs text-content-muted">No recent events for this object. Kubernetes keeps events for about an hour.</p>
  return (
    <ul className="space-y-2">
      {events.data.map((e, i) => (
        <li key={i} className="rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind={e.type === 'Warning' ? 'degraded' : 'info'} pulse={false}>{e.type}</StatusBadge>
            <span className="font-medium text-content">{e.reason}</span>
            {e.count > 1 ? <span className="text-content-subtle">×{e.count}</span> : null}
            <span className="ml-auto text-content-subtle">{age(e.at, now)} ago</span>
          </div>
          <div className="wrap-break-word mt-1 whitespace-pre-wrap text-content-muted">{e.message}</div>
          {e.source ? <div className="mt-0.5 text-[11px] text-content-subtle">{e.source}</div> : null}
        </li>
      ))}
    </ul>
  )
}

/* ───────────────────────── detail panel ───────────────────────── */

type DetailTab = 'summary' | 'events' | 'manifest' | 'diff' | 'logs'

export function ResourceDetail({ graph, node, appRef, onClose, onSelect, now }: {
  graph: CompositionGraph
  node: CompNode
  /** The Argo CD app that manages the node, for the Diff tab and the Argo CD link. Defaults to `node.argoApp`. */
  appRef?: { name: string; namespace?: string }
  onClose(): void
  onSelect(id: string): void
  now: number
}) {
  const isPod = node.kind === 'Pod'
  // An Argo CD Application node is its own app; anything else is managed by
  // the app passed in, or the one the walk recorded on it.
  const isApp = node.group === 'argoproj.io' && node.kind === 'Application'
  const app = isApp ? { name: node.name, namespace: node.namespace } : appRef ?? node.argoApp
  const outOfSync = node.status.sync === 'OutOfSync' || Boolean(node.status.prune)
  const [tab, setTab] = useState<DetailTab>('summary')
  const ref = { group: node.group, version: node.version, kind: node.kind, name: node.name, namespace: node.namespace }
  const needLive = tab === 'manifest' && !node.object && !node.error
  const discovery = useDiscovery(needLive)
  const live = useLiveObject(discovery.data, ref, needLive)
  const events = useObjectEvents(ref, tab === 'events')
  const managed = useManagedResources(app, tab === 'diff' && Boolean(app))
  const argoBase = useToolPublicUrl('argocd')
  const argoUrl = argoBase && app
    ? `${argoBase.replace(/\/$/, '')}/applications/${app.namespace ?? 'argocd'}/${app.name}${isApp ? '' : `?resource=&node=${encodeURIComponent(`${node.group}/${node.kind}/${node.namespace ?? ''}/${node.name}/0`)}`}`
    : undefined
  const pod = isPod ? podInfo(node) : undefined
  const r = workloadReplicas(node)
  const imgs = imagesOf(node)

  const fields: Array<[string, ReactNode]> = [
    ['API version', apiVersionOf(node) ?? (node.group || 'v1')],
    ['Namespace', node.namespace ?? '— (cluster-scoped)'],
    ['Created', node.createdAt ? `${new Date(node.createdAt).toLocaleString()} (${age(node.createdAt, now)} ago)` : '—'],
    ['Health', node.status.health ?? node.status.label],
    ['Sync', node.status.prune ? 'OutOfSync (requires pruning)' : node.status.sync ?? '—'],
  ]
  if (node.uid) fields.push(['UID', node.uid])
  if (node.composition) fields.push(['Composition', node.composition])
  if (node.compositionRevision) fields.push(['Composition revision', node.compositionRevision])
  if (app && !isApp) fields.push(['Argo CD app', app.name])
  if (r) fields.push(['Replicas', `${r.ready} ready / ${r.desired} desired (${r.current} current)`])
  if (imgs.length && !isPod) fields.push(['Images', imgs.join('\n')])
  if (pod) {
    fields.push(['Node', pod.nodeName ?? '—'], ['Pod IP', pod.podIP ?? '—'], ['Ready', pod.ready], ['Restarts', String(pod.restarts)])
  }
  const hosts = hostnamesOf(node)
  if (hosts.length) fields.push(['Hostnames', hosts.join(', ')])

  const tabs: Array<{ value: DetailTab; label: string }> = [
    { value: 'summary', label: 'Summary' },
    { value: 'events', label: 'Events' },
    { value: 'manifest', label: 'YAML' },
  ]
  if (outOfSync && !isApp && app) tabs.push({ value: 'diff', label: 'Diff' })
  if (isPod) tabs.push({ value: 'logs', label: 'Logs' })

  return (
    <NodeSidePanel<DetailTab>
      node={node}
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      wide={tab === 'logs' || tab === 'diff'}
      actions={argoUrl ? <a href={argoUrl} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Argo CD ↗</a> : null}
    >
      {tab === 'summary' ? (
        <>
          <StatusCallout node={node} />
          {node.error ? (
            <p className="text-xs text-content-muted">
              {node.error.status === 403
                ? 'Your Kubernetes role cannot read this object, so its status is unknown.'
                : node.error.status === 404
                  ? 'This resource is referenced but does not exist (or its CRD is not installed).'
                  : `Could not read it: ${node.error.message}`}
            </p>
          ) : null}
          <FieldList fields={fields} />
          {pod?.containers.length ? <ContainersTable containers={pod.containers} /> : null}
          <ConditionsTable conditions={node.conditions} now={now} />
          {node.info?.length ? (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold text-content">Argo CD info</h4>
              <FieldList fields={node.info.map((i) => [i.name, i.value])} />
            </section>
          ) : null}
          <RelatedList title="Parents" ids={node.parents} graph={graph} onSelect={onSelect} />
          <RelatedList title="Children" ids={node.children} graph={graph} onSelect={onSelect} />
        </>
      ) : null}
      {tab === 'events' ? <EventsList events={events} now={now} /> : null}
      {tab === 'manifest' ? (
        node.object ?? live.data ? (
          <CodeViewer value={node.object ?? live.data} filename={`${node.kind.toLowerCase()}-${node.name}`} ariaLabel={`${node.kind} ${node.name} live manifest`} height="calc(100vh - 230px)" />
        ) : live.isLoading || discovery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Reading the live object…</div>
        ) : (
          <p className="text-xs text-content-muted">
            {node.error ? (node.error.status === 403 ? 'Your Kubernetes role cannot read this object.' : node.error.message) : (live.error as { status?: number } | null)?.status === 403 ? 'Your Kubernetes role cannot read this object.' : (live.error as { status?: number } | null)?.status === 404 ? 'It does not exist in the cluster (Missing).' : `Could not read it${live.error instanceof Error ? `: ${live.error.message}` : '.'}`}
          </p>
        )
      ) : null}
      {tab === 'diff' ? <DiffPane managed={managed} id={node.id} /> : null}
      {tab === 'logs' && pod ? <PodLogs namespace={node.namespace ?? ''} pod={node.name} containers={pod.containers.filter((c) => !c.init).map((c) => c.name)} /> : null}
    </NodeSidePanel>
  )
}

function ContainersTable({ containers }: { containers: NonNullable<ReturnType<typeof podInfo>>['containers'] }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold text-content">Containers</h4>
      <div className="overflow-x-auto rounded-md border border-edge-default">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-sunken text-[11px] text-content-subtle">
            <tr>
              <th className="px-2 py-1.5 font-medium">Name</th>
              <th className="px-2 py-1.5 font-medium">Image</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 text-right font-medium">Restarts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-default">
            {containers.map((c) => (
              <tr key={`${c.init ? 'i' : 'c'}-${c.name}`} className="align-top">
                <td className="px-2 py-1.5 font-mono text-content">
                  <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', c.ready ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden />
                  {c.name}
                  {c.init ? <span className="ml-1 text-[10px] text-content-subtle">init</span> : null}
                </td>
                <td className="max-w-60 truncate px-2 py-1.5 font-mono text-content-muted" title={c.image}>{c.image ?? '—'}</td>
                <td className="px-2 py-1.5 text-content-muted">{c.state}</td>
                <td className="px-2 py-1.5 text-right text-content">{c.restarts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DiffPane({ managed, id }: { managed: ReturnType<typeof useManagedResources>; id: string }) {
  const entry = managed.data?.get(id)
  const lines = useMemo(() => {
    if (!entry) return undefined
    const desired = entry.desired === undefined ? '' : toYaml(comparable(entry.desired))
    const liveText = entry.live === undefined ? '' : toYaml(comparable(entry.live))
    return lineDiff(desired, liveText)
  }, [entry])
  const chunks = useMemo(() => (lines ? diffChunks(lines, 3) : []), [lines])
  if (managed.isLoading) return <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Asking Argo CD for the desired and live manifests…</div>
  if (managed.error) {
    const status = (managed.error as { status?: number }).status
    return <p className="text-xs text-content-muted">{status === 403 || status === 401 ? 'Argo CD did not allow reading this application’s managed resources.' : `Argo CD did not return managed resources: ${managed.error instanceof Error ? managed.error.message : String(managed.error)}`}</p>
  }
  if (!entry || !lines) return <p className="text-xs text-content-muted">Argo CD has no desired/live pair for this resource (it is not one it manages directly).</p>
  const changed = lines.filter((l) => l.type !== 'same').length
  return (
    <div className="space-y-2">
      <p className="text-xs text-content-muted">
        {entry.desired === undefined ? 'Not in Git — Argo CD would prune it on the next sync.' : entry.live === undefined ? 'In Git but missing from the cluster.' : `${changed} changed line${changed === 1 ? '' : 's'}.`}{' '}
        <span className="text-rose-700 dark:text-rose-300">− desired (Git)</span> · <span className="text-emerald-700 dark:text-emerald-300">+ live (cluster)</span>
      </p>
      <div className="overflow-x-auto rounded-lg border border-edge-default bg-surface-sunken font-mono text-[12px] leading-5">
        {chunks.map((c, i) =>
          c.type === 'skip' ? (
            <div key={i} className="border-y border-edge-default bg-surface-raised px-3 py-0.5 text-[11px] text-content-subtle">⋯ {c.count} unchanged lines</div>
          ) : (
            c.lines.map((l, j) => (
              <div
                key={`${i}-${j}`}
                className={cn(
                  'flex whitespace-pre',
                  l.type === 'add' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
                  l.type === 'del' && 'bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
                  l.type === 'same' && 'text-content-muted',
                )}
              >
                <span className="w-10 shrink-0 select-none pr-2 text-right text-content-subtle">{l.a ?? ''}</span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-content-subtle">{l.b ?? ''}</span>
                <span className="w-4 shrink-0 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                <span className="pr-3">{l.text}</span>
              </div>
            ))
          )
        )}
      </div>
    </div>
  )
}

function PodLogs({ namespace, pod, containers }: { namespace: string; pod: string; containers: string[] }) {
  const main = containers.filter(Boolean)
  const [container, setContainer] = useState(main[0] ?? '')
  const [previous, setPrevious] = useState(false)
  const stream = useLogStream({
    namespace,
    sources: [{ pod, container: container || undefined, label: container || pod }],
    follow: !previous,
    previous,
    tailLines: 500,
  })
  return (
    <LogConsole
      lines={stream.lines}
      status={stream.status}
      error={stream.error}
      reconnect={stream.reconnect}
      live={!previous}
      filename={`${pod}${container ? `-${container}` : ''}`}
      height="h-[calc(100vh-240px)]"
      label={<span className="font-mono">{pod}</span>}
      toolbar={
        <>
          {main.length > 1 ? (
            <select value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container" className="rounded border border-white/10 bg-transparent px-1 py-0.5 text-[11px] text-slate-200">
              {main.map((c) => <option key={c} value={c} className="text-slate-900">{c}</option>)}
            </select>
          ) : null}
          <button type="button" onClick={() => setPrevious((p) => !p)} className={cn('rounded px-1.5 py-0.5 text-[11px]', previous ? 'bg-white/15 text-white' : 'text-slate-300 hover:text-white')} title="Logs of the previous (crashed) container">
            Previous
          </button>
        </>
      }
      emptyMessage={previous ? 'No previous container — it has not restarted.' : 'No log lines yet.'}
    />
  )
}

