import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { cn, formatRelative } from '@adhar-console/utils'
import {
  NOTIFICATION_KIND_LABEL,
  NOTIFICATION_SOURCE_LABEL,
  notificationTone,
  useNotificationFeed,
  useNotifications,
  type Notification,
  type NotificationKind,
  type NotificationSource,
} from './notifications.ts'
import { useAi } from './ai-assistant.tsx'
import { useToast } from './toast.tsx'
import { EmptyState } from './empty-state.tsx'

/**
 * Notification Center — the full page (`/notifications`).
 *
 * Everything the platform tells you, in one inbox: workspace operations,
 * platform insights (events, GitOps drift, policy, certificates), Adhar Assist
 * outcomes and your own notices. Filters by kind / source / unread, search,
 * paging, bulk mark-read / dismiss, insight cards with **Ask Assist**, and a
 * one-click **Scan for insights** that reads the cluster with your RBAC.
 */

const KINDS: Array<{ id: NotificationKind | ''; label: string }> = [
  { id: '', label: 'All kinds' },
  { id: 'insight', label: 'Insights' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'success', label: 'Success' },
  { id: 'info', label: 'Info' },
]
const SOURCES: Array<{ id: NotificationSource | ''; label: string }> = [
  { id: '', label: 'All sources' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'platform', label: 'Platform' },
  { id: 'gitops', label: 'GitOps' },
  { id: 'policy', label: 'Policy' },
  { id: 'security', label: 'Security' },
  { id: 'ai', label: 'Adhar Assist' },
  { id: 'user', label: 'You' },
]
const PAGE_SIZE = 25

export function NotificationCenter() {
  const api = useNotifications()
  const ai = useAi()
  const toast = useToast()
  const [kind, setKind] = useState<NotificationKind | ''>('')
  const [source, setSource] = useState<NotificationSource | ''>('')
  const [unread, setUnread] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    const id = globalThis.setTimeout(() => setDebounced(q), 250)
    return () => globalThis.clearTimeout(id)
  }, [q])
  useEffect(() => setPage(0), [kind, source, unread, debounced])

  const feed = useNotificationFeed({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, kind, source, unread, q: debounced })
  const items = feed.data?.items ?? []
  const total = feed.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const live = feed.data?.persisted !== false && !feed.isError

  const grouped = useMemo(() => {
    const out = new Map<string, Notification[]>()
    for (const n of items) {
      const d = new Date(n.at)
      const today = new Date()
      const key = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
      out.set(key, [...(out.get(key) ?? []), n])
    }
    return [...out.entries()]
  }, [items])

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const bulk = (what: 'read' | 'dismiss') => {
    const ids = [...selected]
    if (!ids.length) return
    if (what === 'read') ids.forEach((id) => api.markRead(id))
    else ids.forEach((id) => api.dismiss(id))
    toast.success(what === 'read' ? `Marked ${ids.length} as read` : `Dismissed ${ids.length}`)
    setSelected(new Set())
  }

  const runScan = async () => {
    const n = await api.scan(true)
    if (n === null) toast.error('Insights scan unavailable', { description: 'The console needs a database and cluster access to generate insights.' })
    else if (n === 0) toast.info('Scan complete — nothing new', { description: 'No new warnings, drift, policy failures or expiring certificates since the last scan.' })
    else toast.success(`${n} new insight${n === 1 ? '' : 's'}`, { description: 'Generated from Warning events, Argo CD, Kyverno and cert-manager with your permissions.' })
    feed.refetch()
  }

  return (
    <div className="space-y-4">
      {/* header row: title left · actions right */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-content">Notifications</h1>
          <p className="mt-1 text-[13px] text-content-muted">Every operation, insight and Assist outcome across the platform — {api.unreadCount ? <span className="font-medium text-content">{api.unreadCount} unread</span> : 'all caught up'}{total ? ` · ${total.toLocaleString()} matching` : ''}.</p>
        </div>
        <div className="flex items-center gap-2">
          <ActionBtn onClick={runScan} disabled={api.scanning || !live}>{api.scanning ? <Spinner /> : <IconRadar />} Scan for insights</ActionBtn>
          <ActionBtn onClick={() => { api.markAllRead(); toast.success('All notifications marked as read') }} disabled={!api.unreadCount}><IconCheck /> Mark all read</ActionBtn>
          <ActionBtn onClick={() => ai.open()} primary><IconSpark /> Ask Assist</ActionBtn>
        </div>
      </div>

      {!live ? (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50/70 px-4 py-3 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          The notification feed needs the console database (<code className="font-mono">DATABASE_URL</code>). Until then only the built-in seed is shown.
        </div>
      ) : null}

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Unread" value={api.unreadCount} tone={api.unreadCount ? 'brand' : undefined} onClick={() => setUnread((u) => !u)} active={unread} />
        <Stat label="Insights" value={api.items.filter((n) => n.kind === 'insight').length} tone="violet" onClick={() => setKind(kind === 'insight' ? '' : 'insight')} active={kind === 'insight'} hint="from the latest 50" />
        <Stat label="Errors & warnings" value={api.items.filter((n) => n.kind === 'error' || n.kind === 'warning').length} tone="rose" onClick={() => setKind(kind === 'error' ? '' : 'error')} active={kind === 'error'} hint="from the latest 50" />
        <Stat label="Sources" value={new Set(api.items.map((n) => n.source ?? 'system')).size} hint="active producers" />
      </div>

      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-edge-default bg-surface-raised px-3 py-2.5 shadow-sm">
        <div className="relative flex min-w-56 flex-1 items-center">
          <span className="pointer-events-none absolute left-3 text-content-subtle"><IconSearch /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, descriptions, targets…" className="h-9 w-full rounded-lg border border-edge-default bg-surface-app pl-9 pr-3 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20" />
        </div>
        <Select value={kind} onChange={(v) => setKind(v as NotificationKind | '')} options={KINDS.map((k) => [k.id, k.label])} />
        <Select value={source} onChange={(v) => setSource(v as NotificationSource | '')} options={SOURCES.map((k) => [k.id, k.label])} />
        <button type="button" aria-pressed={unread} onClick={() => setUnread((u) => !u)} className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors', unread ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:text-content')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', unread ? 'bg-brand-500' : 'bg-slate-400')} /> Unread only
        </button>
        {selected.size ? (
          <div className="ml-auto flex items-center gap-1.5 text-[12px]">
            <span className="text-content-muted">{selected.size} selected</span>
            <ActionBtn onClick={() => bulk('read')}>Mark read</ActionBtn>
            <ActionBtn onClick={() => bulk('dismiss')}>Dismiss</ActionBtn>
            <button type="button" onClick={() => setSelected(new Set())} className="text-content-subtle hover:text-content">clear</button>
          </div>
        ) : null}
      </div>

      {/* list */}
      <div className="overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
        {feed.isLoading && !items.length ? (
          <div className="divide-y divide-edge-subtle">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex animate-pulse gap-3 px-4 py-3"><div className="h-8 w-8 rounded-lg bg-surface-sunken" /><div className="flex-1 space-y-1.5"><div className="h-3 w-1/2 rounded bg-surface-sunken" /><div className="h-2.5 w-3/4 rounded bg-surface-sunken" /></div></div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="p-10">
            <EmptyState title={q || kind || source || unread ? 'Nothing matches' : "You're all caught up"} description={q || kind || source || unread ? 'Try loosening the filters.' : 'Operations, insights and Assist outcomes will show up here as they happen. Run a scan to look for insights now.'} action={<ActionBtn onClick={runScan} disabled={api.scanning || !live}><IconRadar /> Scan for insights</ActionBtn>} />
          </div>
        ) : (
          grouped.map(([day, list]) => (
            <section key={day}>
              <div className="sticky top-0 z-10 border-b border-edge-subtle bg-surface-sunken/80 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle backdrop-blur">{day}</div>
              <ul className="divide-y divide-edge-subtle">
                {list.map((n) => (
                  <NotificationCard
                    key={n.id}
                    n={n}
                    selected={selected.has(n.id)}
                    onSelect={() => toggle(n.id)}
                    onRead={() => api.markRead(n.id)}
                    onDismiss={() => api.dismiss(n.id)}
                    onAsk={n.prompt ? () => { api.markRead(n.id); ai.ask({ prompt: n.prompt, title: n.title }) } : undefined}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t border-edge-subtle bg-surface-sunken/50 px-4 py-2 text-[12px] text-content-muted">
            <span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}</span>
            <div className="flex items-center gap-1">
              <ActionBtn onClick={() => setPage((p) => p - 1)} disabled={page === 0}>Previous</ActionBtn>
              <span className="px-2 font-mono text-[11px]">{page + 1} / {pageCount}</span>
              <ActionBtn onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount}>Next</ActionBtn>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ─────────── card ─────────── */

export function NotificationCard({
  n,
  selected,
  onSelect,
  onRead,
  onDismiss,
  onAsk,
  compact = false,
}: {
  n: Notification
  selected?: boolean
  onSelect?(): void
  onRead(): void
  onDismiss(): void
  onAsk?(): void
  compact?: boolean
}) {
  const tone = notificationTone(n.kind)
  const external = n.href?.startsWith('http')
  return (
    <li className={cn('group relative flex gap-3 px-4 transition-colors hover:bg-surface-sunken/60', compact ? 'py-2.5' : 'py-3', !n.read && 'bg-brand-50/30 dark:bg-brand-500/5')}>
      {onSelect ? (
        <input type="checkbox" checked={!!selected} onChange={onSelect} aria-label="Select notification" className="mt-2 h-4 w-4 shrink-0 accent-brand-600" />
      ) : null}
      <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', tone.bg, tone.text)}><KindIcon kind={n.kind} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className={cn('min-w-0 flex-1 text-[13.5px] leading-snug', n.read ? 'text-content-muted' : 'font-semibold text-content')}>
            {n.href ? (
              external ? <a href={n.href} target="_blank" rel="noreferrer" onClick={onRead} className="hover:underline">{n.title} ↗</a> : <Link to={n.href as never} onClick={onRead} className="hover:underline">{n.title}</Link>
            ) : (
              <button type="button" onClick={onRead} className="text-left">{n.title}</button>
            )}
          </div>
          {!n.read ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" /> : null}
        </div>
        {n.description ? <p className={cn('mt-0.5 text-[12px] leading-relaxed text-content-muted', compact ? 'line-clamp-1' : 'line-clamp-2')}>{n.description}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content-subtle">
          <span>{formatRelative(n.at)}</span>
          {n.source ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{NOTIFICATION_SOURCE_LABEL[n.source] ?? n.source}</span> : null}
          <span className={cn('rounded px-1.5 py-0.5', tone.bg, tone.text)}>{NOTIFICATION_KIND_LABEL[n.kind]}</span>
          {n.severity && (n.severity === 'high' || n.severity === 'critical') ? <span className="rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{n.severity}</span> : null}
          {n.target ? <span className="truncate font-mono">{n.target.type}/{n.target.label}</span> : null}
          {n.actor && n.source === 'workspace' ? <span>by {n.actor.label}</span> : null}
          {onAsk ? (
            <button type="button" onClick={onAsk} className="ml-auto inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/15"><IconSpark /> Ask Assist</button>
          ) : null}
        </div>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-raised hover:text-content group-hover:opacity-100"><IconX /></button>
    </li>
  )
}

/* ─────────── bits ─────────── */

function Stat({ label, value, hint, tone, onClick, active = false }: { label: string; value: number | string; hint?: string; tone?: 'brand' | 'violet' | 'rose'; onClick?(): void; active?: boolean }) {
  const cls = tone === 'brand' ? 'text-brand-700 dark:text-brand-300' : tone === 'violet' ? 'text-violet-700 dark:text-violet-300' : tone === 'rose' ? 'text-rose-700 dark:text-rose-300' : 'text-content'
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} aria-pressed={onClick ? active : undefined} className={cn('rounded-xl border bg-surface-raised p-4 text-left shadow-sm transition-colors', active ? 'border-brand-300 dark:border-brand-500/40' : 'border-edge-default', onClick && 'hover:border-edge-strong')}>
      <div className={cn('text-2xl font-semibold tabular-nums', cls)}>{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      {hint ? <div className="mt-0.5 text-[10.5px] text-content-subtle">{hint}</div> : null}
    </Tag>
  )
}

function ActionBtn({ children, onClick, disabled = false, primary = false }: { children: ReactNode; onClick(): void; disabled?: boolean; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50', primary ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content')}>
      {children}
    </button>
  )
}

function Select({ value, onChange, options }: { value: string; onChange(v: string): void; options: Array<[string, string]> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content-muted focus:border-brand-400 focus:outline-none">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

export function KindIcon({ kind }: { kind: NotificationKind }) {
  const p = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (kind) {
    case 'success': return <svg {...p}><path d="M20 6 9 17l-5-5" /></svg>
    case 'error': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
    case 'warning': return <svg {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4M12 17h.01" /></svg>
    case 'insight': return <svg {...p} fill="currentColor" stroke="none"><path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" /></svg>
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
  }
}

const I = ({ children, size = 13 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">{children}</svg>
)
const IconSearch = () => <I><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></I>
const IconCheck = () => <I><path d="M20 6 9 17l-5-5" /></I>
const IconX = () => <I size={12}><path d="M18 6 6 18M6 6l12 12" /></I>
const IconRadar = () => <I><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4" /><path d="M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2" /></I>
const IconSpark = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0"><path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" /></svg>
const Spinner = () => <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
