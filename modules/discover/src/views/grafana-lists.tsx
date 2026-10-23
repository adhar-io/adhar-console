import { Spinner } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { type GrafanaPanel, writeBoardUrl } from '../data/grafana-board.ts'
import { useAlertRules, useAnnotations, useDashSearch } from '../data/grafana.ts'
import {
  type AlertListOptions,
  type AlertState,
  annotationsPath,
  type AnnoListOptions,
  dashSearchPath,
  type DashListOptions,
  filterAlertItems,
} from '../data/grafana-lists.ts'
import { discoverHref } from '../data/discover-links.ts'
import { DLink } from './viz.tsx'

/**
 * Grafana list panels drawn natively: alert list (Grafana-managed +
 * Prometheus rules), dashboard list (starred / search; Grafana keeps
 * "recently viewed" in its own browser storage, so that section is not
 * available here) and annotation list. Items open in the console.
 */

const STATE: Record<AlertState, { label: string; icon: string; cls: string }> = {
  firing: { label: 'Firing', icon: '■', cls: 'text-rose-700 dark:text-rose-300' },
  pending: { label: 'Pending', icon: '▲', cls: 'text-amber-700 dark:text-amber-300' },
  error: { label: 'Error', icon: '⚠', cls: 'text-rose-700 dark:text-rose-300' },
  nodata: { label: 'No data', icon: '○', cls: 'text-content-subtle' },
  recovering: { label: 'Recovering', icon: '◐', cls: 'text-sky-700 dark:text-sky-300' },
  normal: { label: 'Normal', icon: '●', cls: 'text-emerald-700 dark:text-emerald-300' },
}

/** `42m`, `3h 5m`, `2d 4h` — how long a rule has been in its state. */
function forDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

const Empty = ({ text }: { text: string }) => <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">{text}</div>
const Loading = () => <div className="flex h-full items-center justify-center"><Spinner size={12} /></div>

export function AlertListViz({ panel, dashboardUid, enabled, tick }: { panel: GrafanaPanel; dashboardUid: string; enabled: boolean; tick: number }) {
  const q = useAlertRules(enabled, tick)
  const o = (panel.options ?? {}) as AlertListOptions
  if (!enabled || q.isLoading) return <Loading />
  if (q.isError) return <Empty text={`Alert rules could not be read: ${(q.error as Error).message}`} />
  const items = filterAlertItems(q.data?.items ?? [], o, dashboardUid)
  if (o.viewMode === 'stat') {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="text-3xl font-semibold tabular-nums text-content">{items.length}</div>
        <div className="text-[11px] text-content-subtle">matching alert rule{items.length === 1 ? '' : 's'}</div>
      </div>
    )
  }
  if (!items.length) return <Empty text="No alert rules match this panel’s filters" />
  return (
    <ul className="h-full space-y-1 overflow-auto pr-1" aria-label="Alert rules">
      {items.map((i) => {
        const s = STATE[i.state]
        return (
          <li key={i.key} className="flex items-start gap-2 rounded-md border border-edge-subtle px-2 py-1 text-[11px]">
            <span className={cn('mt-px inline-flex shrink-0 items-center gap-1 font-medium', s.cls)}>
              <span aria-hidden>{s.icon}</span>
              {s.label}
            </span>
            <div className="min-w-0 flex-1">
              <DLink href={discoverHref('alerts', { service: i.labels.service, namespace: i.labels.namespace, severity: i.labels.severity })} className="block truncate font-medium text-content hover:underline" title={i.summary ?? i.name}>
                {i.name}
              </DLink>
              <div className="truncate text-[10px] text-content-subtle">
                {i.source}
                {i.group ? ` · ${i.group}` : ''}
                {i.instances.length ? ` · ${i.instances.length} instance${i.instances.length === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            {i.activeAt ? <span className="shrink-0 text-[10px] text-content-subtle" title={new Date(i.activeAt).toLocaleString()}>for {forDuration(Date.now() - i.activeAt)}</span> : null}
          </li>
        )
      })}
      {q.data?.failed.length ? <li className="text-[10px] text-content-subtle">Not shown: {q.data.failed.join(', ')} (no answer)</li> : null}
    </ul>
  )
}

export function DashListViz({ panel, enabled, from, to }: { panel: GrafanaPanel; enabled: boolean; from: string; to: string }) {
  const o = (panel.options ?? {}) as DashListOptions
  const showStarred = o.showStarred ?? true
  const showSearch = o.showSearch ?? false
  const starred = useDashSearch(showStarred ? `/api/search?type=dash-db&starred=true&limit=${Math.max(1, o.maxItems ?? 10)}` : null, enabled)
  const search = useDashSearch(showSearch ? dashSearchPath(o) : null, enabled)
  const href = (uid: string) => {
    const search0 = typeof location !== 'undefined' ? location.search : ''
    const pathname = typeof location !== 'undefined' ? location.pathname : ''
    return `${pathname}${writeBoardUrl(search0, { board: uid, ...(o.keepTime ? { from, to } : {}), vars: {} })}`
  }
  if (!enabled || starred.isLoading || search.isLoading) return <Loading />
  const sections: Array<{ title: string; items: Array<{ uid: string; title: string; folderTitle: string; isStarred: boolean }> }> = []
  if (showStarred) sections.push({ title: 'Starred dashboards', items: starred.data ?? [] })
  if (showSearch) sections.push({ title: 'Search', items: search.data ?? [] })
  if (!sections.length || sections.every((s) => !s.items.length)) {
    return <Empty text={showStarred && !showSearch ? 'No starred dashboards for the console’s Grafana account' : 'No dashboards match'} />
  }
  return (
    <div className="h-full space-y-2 overflow-auto pr-1">
      {sections.map((s) => (
        <section key={s.title}>
          {o.showHeadings !== false ? <h4 className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{s.title}</h4> : null}
          {s.items.length ? (
            <ul>
              {s.items.map((d) => (
                <li key={d.uid}>
                  <DLink href={href(d.uid)} className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] text-content hover:bg-surface-sunken">
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    <span className="shrink-0 truncate text-[10px] text-content-subtle">{d.folderTitle}</span>
                    {d.isStarred ? <span className="text-amber-500" aria-label="Starred">★</span> : null}
                  </DLink>
                </li>
              ))}
            </ul>
          ) : <div className="px-1.5 text-[11px] text-content-subtle">None</div>}
        </section>
      ))}
    </div>
  )
}

export function AnnoListViz({ panel, dashboardUid, range, enabled, tick }: { panel: GrafanaPanel; dashboardUid: string; range: { start: number; end: number }; enabled: boolean; tick: number }) {
  const o = (panel.options ?? {}) as AnnoListOptions
  const q = useAnnotations(annotationsPath(o, dashboardUid, range), enabled, tick)
  if (!enabled || q.isLoading) return <Loading />
  if (q.isError) return <Empty text={`Annotations could not be read: ${(q.error as Error).message}`} />
  const list = q.data ?? []
  if (!list.length) return <Empty text="No annotations" />
  return (
    <ul className="h-full space-y-1 overflow-auto pr-1" aria-label="Annotations">
      {list.map((a) => (
        <li key={a.id} className="rounded-md border border-edge-subtle px-2 py-1 text-[11px]">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-content" title={a.text}>{(a.text ?? '').replace(/<[^>]+>/g, '') || (a.newState ? `State: ${a.newState}` : 'Annotation')}</span>
            {o.showTime !== false ? <span className="shrink-0 text-[10px] text-content-subtle" title={new Date(a.time).toLocaleString()}>{formatRelative(new Date(a.time).toISOString())}</span> : null}
          </div>
          {(o.showUser !== false && a.login) || (o.showTags !== false && a.tags?.length) ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-content-subtle">
              {o.showUser !== false && a.login ? <span>{a.login}</span> : null}
              {o.showTags !== false ? (a.tags ?? []).map((t) => <span key={t} className="rounded-full bg-surface-sunken px-1.5 font-mono">{t}</span>) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
