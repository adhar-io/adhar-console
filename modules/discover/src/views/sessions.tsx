import { useMemo, useState } from 'react'
import { EmptyState } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  type DateRangeId,
  filterRecordings,
  formatSeconds,
  type Recording,
  sessionEventsHogQL,
  useHogQL,
  useRecordings,
} from '../data/posthog.ts'
import { patchParams, readParam } from '../data/discover-nav.ts'
import { Drawer, KvTable, SectionLabel, StatTile } from './discover-ui.tsx'
import { Loading, NoData } from './viz.tsx'
import { fmtNum, OpenInPostHog, PostHogState, RangePicker, usePostHogUrl } from './posthog-ui.tsx'
import { LoadingCard } from './states.tsx'

/**
 * Sessions — PostHog session recordings.
 *
 * The latest recordings in the range from `/session_recordings/`, filtered in
 * the browser by person, duration, console errors, start URL and "not yet
 * watched". A recording opens a drawer with its metadata, a link to the
 * replay in PostHog, and the session's own event timeline (HogQL over
 * `$session_id`) with exceptions called out.
 */

const DURATIONS: Array<[string, string]> = [['0', 'Any length'], ['10', '≥ 10 s'], ['60', '≥ 1 min'], ['300', '≥ 5 min'], ['900', '≥ 15 min']]

export function Sessions() {
  const [range, setRange] = useState<DateRangeId>('-7d')
  const [person, setPerson] = useState('')
  const [url, setUrl] = useState('')
  const [minDur, setMinDur] = useState('0')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [unwatched, setUnwatched] = useState(false)
  const [openId, setOpenId] = useState<string | null>(() => readParam('session') ?? null)
  const q = useRecordings({ range, limit: 200 })

  const all = q.data?.list ?? []
  const list = useMemo(
    () => filterRecordings(all, { person, url, minDurationS: Number(minDur), errorsOnly, unwatched }),
    [all, person, url, minDur, errorsOnly, unwatched],
  )
  const open = (id: string | null) => {
    setOpenId(id)
    patchParams({ session: id ?? undefined })
  }

  if (q.isLoading) return <LoadingCard label="Loading session recordings…" />
  if (q.isError) return <PostHogState error={q.error} onRetry={() => q.refetch()} />

  const withErrors = list.filter((r) => r.consoleErrors > 0).length
  const avgDur = list.length ? list.reduce((a, r) => a + r.durationS, 0) / list.length : null
  const activeShare = list.reduce((a, r) => a + r.durationS, 0) > 0 ? (list.reduce((a, r) => a + r.activeS, 0) / list.reduce((a, r) => a + r.durationS, 0)) * 100 : null
  const selected = all.find((r) => r.id === openId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker value={range} onChange={setRange} ranges={['-24h', '-7d', '-14d', '-30d']} />
        <input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Person, email or id" className="h-8 w-48 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" aria-label="Person" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Start URL contains" className="h-8 w-44 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content" aria-label="URL" />
        <select aria-label="Minimum duration" value={minDur} onChange={(e) => setMinDur(e.target.value)} className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content">
          {DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <Toggle label="Console errors" on={errorsOnly} onChange={setErrorsOnly} />
        <Toggle label="Not watched" on={unwatched} onChange={setUnwatched} />
        <div className="ml-auto"><OpenInPostHog path="/replay/recent" label="Open replays" /></div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Recordings" value={fmtNum(list.length)} hint={list.length === all.length ? `latest ${all.length}${q.data?.hasNext ? '+' : ''} in range` : `of ${all.length} loaded`} />
        <StatTile label="With console errors" value={fmtNum(withErrors)} hint={list.length ? `${((withErrors / list.length) * 100).toFixed(0)}% of shown` : undefined} />
        <StatTile label="Avg duration" value={avgDur == null ? '—' : formatSeconds(avgDur)} />
        <StatTile label="Active time" value={activeShare == null ? '—' : `${activeShare.toFixed(0)}%`} hint="share of recorded time with input" />
      </div>

      {all.length === 0 ? (
        <EmptyState title="No recordings in this range" description="Session replay must be enabled in the PostHog project and the snippet must record sessions on your apps." />
      ) : list.length === 0 ? (
        <EmptyState compact title="No recording matches these filters" />
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {list.map((r) => <RecordingRow key={r.id} r={r} onOpen={() => open(r.id)} />)}
        </ul>
      )}
      {selected ? <SessionDrawer r={selected} onClose={() => open(null)} /> : null}
    </div>
  )
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange(v: boolean): void }) {
  return (
    <label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content-muted">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-3 w-3" />
      {label}
    </label>
  )
}

function RecordingRow({ r, onOpen }: { r: Recording; onOpen(): void }) {
  const activePct = r.durationS > 0 ? Math.min(100, (r.activeS / r.durationS) * 100) : 0
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-sunken">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', r.viewed ? 'bg-transparent ring-1 ring-edge-default' : 'bg-brand-500')} title={r.viewed ? 'Watched' : 'Not watched yet'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium text-content">{r.personName}</span>
            {r.ongoing ? <span className="text-[10px] font-medium text-brand-700 dark:text-brand-300">● live</span> : null}
            {r.consoleErrors > 0 ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 dark:text-rose-300">■ {r.consoleErrors} console error{r.consoleErrors === 1 ? '' : 's'}</span>
            ) : null}
            <span className="ml-auto text-[11px] text-content-subtle">{r.start ? formatRelative(r.start) : ''}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-content-muted">
            <span className="font-mono tabular-nums">{formatSeconds(r.durationS)}</span>
            <span className="inline-flex items-center gap-1" title={`${activePct.toFixed(0)}% active`}>
              <span className="inline-block h-1 w-12 overflow-hidden rounded-full bg-surface-sunken">
                <span className="block h-full bg-(--viz-1,var(--color-brand-500))" style={{ width: `${activePct}%` }} />
              </span>
              {activePct.toFixed(0)}% active
            </span>
            <span>{fmtNum(r.clicks)} clicks</span>
            {[r.browser, r.os, r.device, r.country].filter(Boolean).length ? <span>{[r.browser, r.os, r.device, r.country].filter(Boolean).join(' · ')}</span> : null}
            {r.startUrl ? <span className="max-w-md truncate font-mono text-[10px] text-content-subtle">{r.startUrl}</span> : null}
          </div>
        </div>
      </button>
    </li>
  )
}

function SessionDrawer({ r, onClose }: { r: Recording; onClose(): void }) {
  const base = usePostHogUrl()
  const events = useHogQL<{ uuid: string; event: string; timestamp: string; url?: string; path?: string; exception?: string; el_text?: string }>(['session-events', r.id], sessionEventsHogQL(r.id))
  const t0 = r.start ? new Date(r.start).getTime() : 0
  return (
    <Drawer
      widthId="discover.session"
      open
      onClose={onClose}
      title={r.personName}
      subtitle={`${r.start ? new Date(r.start).toLocaleString() : ''} · ${formatSeconds(r.durationS)}`}
      actions={base ? (
        <a href={`${base}/replay/${encodeURIComponent(r.id)}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-600 px-3 text-xs font-medium text-white hover:bg-brand-700">
          ▶ Watch replay in PostHog
        </a>
      ) : null}
    >
      <div className="space-y-6 p-5">
        <section>
          <SectionLabel>Recording</SectionLabel>
          <KvTable
            rows={[
              ['Session id', <code key="s" className="font-mono text-[11px]">{r.id}</code>],
              ['Person', r.personEmail ?? r.distinctId],
              ['Duration', `${formatSeconds(r.durationS)} (${formatSeconds(r.activeS)} active)`],
              ['Clicks · keys', `${fmtNum(r.clicks)} · ${fmtNum(r.keypresses)}`],
              ['Console', `${r.consoleErrors} errors · ${r.consoleWarns} warnings`],
              ['Start URL', r.startUrl ?? '—'],
              ['Client', [r.browser, r.os, r.device].filter(Boolean).join(' · ') || '—'],
              ['Country', r.country ?? '—'],
              ['Watched', r.viewed ? 'yes' : 'no'],
            ]}
          />
        </section>
        <section>
          <SectionLabel right={events.data ? <span className="text-[11px] text-content-subtle">{events.data.length} events</span> : null}>Event timeline</SectionLabel>
          {events.isLoading ? <Loading height={100} /> : events.isError ? <PostHogState compact error={events.error} onRetry={() => events.refetch()} /> : !events.data?.length ? (
            <NoData title="No events carry this session id" hint="Events are linked to a recording through $session_id; older SDKs may not send it." />
          ) : (
            <ol className="relative space-y-0.5 border-l border-edge-default pl-4">
              {events.data.map((e) => {
                const at = new Date(e.timestamp).getTime()
                const bad = e.event === '$exception' || !!e.exception
                return (
                  <li key={e.uuid} className="relative py-1">
                    <span className={cn('absolute -left-5.25 top-2 h-2 w-2 rounded-full ring-2 ring-surface-raised', bad ? 'bg-rose-500' : e.event === '$pageview' ? 'bg-(--viz-1,var(--color-brand-500))' : 'bg-edge-strong')} />
                    <div className="flex items-baseline gap-2 text-[12px]">
                      <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-content-subtle">+{formatSeconds(Math.max(0, (at - t0) / 1000))}</span>
                      <code className="font-mono text-[11px] text-content">{e.event}</code>
                      {bad ? <span className="text-[10px] font-medium text-rose-700 dark:text-rose-300">■ exception</span> : null}
                      <span className="min-w-0 truncate text-[11px] text-content-muted">{e.exception ?? e.el_text ?? e.path ?? e.url ?? ''}</span>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      </div>
    </Drawer>
  )
}
