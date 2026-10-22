import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, EmptyState, Field, Input, Modal, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import {
  metabaseClient,
  useAlerts,
  useCards,
  useChannelSpecs,
  useDashboardIndex,
  useInvalidateBi,
  useMbProperties,
  useMbUsers,
  useSubscriptions,
} from '../data/bi.ts'
import { useBiParams, useGoBi, useSetBiParams } from '../data/bi-nav.ts'
import {
  DAY_LABEL,
  DAYS,
  type Day,
  DEFAULT_SCHEDULE,
  describeSchedule,
  formatHour,
  type Frame,
  fromChannel,
  nextRun,
  type Schedule,
  toChannelSchedule,
} from '../data/bi-schedule.ts'
import { ConfirmDialog, displayIcon, ensureBiStyles, Icon, IconButton, Segmented } from '../components/bi-kit.tsx'
import { BiSkeletonRows, classifyMbError, errorToast, InlineError, MetabaseUnavailable } from './bi-states.tsx'

/**
 * Subscriptions & alerts. Metabase 0.51 sends dashboards on a schedule as
 * *dashboard subscriptions* (still served by `/api/pulse`) and watches saved
 * questions with *alerts* (`/api/alert`). Both are listed with their schedule
 * in words, the next send time (computed in Metabase's report timezone),
 * channels and recipients; both can be created, edited, sent now (subscriptions)
 * and deleted. Channels are only offered when Metabase has them configured.
 *
 * Deep link: `?section=pulses&view=alerts`.
 */

type View = 'subscriptions' | 'alerts'

export function Pulses() {
  ensureBiStyles()
  const params = useBiParams()
  const setParams = useSetBiParams()
  const view: View = params.view === 'alerts' ? 'alerts' : 'subscriptions'
  const subs = useSubscriptions()
  const alerts = useAlerts()
  const specs = useChannelSpecs()
  const props = useMbProperties()
  const tz = (props.data?.['report-timezone-long'] as string | undefined) || undefined
  const [editSub, setEditSub] = useState<metabase.MbPulse | 'new' | null>(null)
  const [editAlert, setEditAlert] = useState<metabase.MbAlert | 'new' | null>(null)

  const email = specs.data?.channels?.email
  const slack = specs.data?.channels?.slack
  const noChannels = specs.isSuccess && !email?.configured && !slack?.configured

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<View>
          ariaLabel="Kind"
          value={view}
          onChange={(v) => setParams({ view: v === 'subscriptions' ? undefined : v })}
          options={[
            { value: 'subscriptions', label: <><Icon name="mail" size={13} /> Dashboard subscriptions {subs.data ? subs.data.length : ''}</> },
            { value: 'alerts', label: <><Icon name="bell" size={13} /> Question alerts {alerts.data ? alerts.data.length : ''}</> },
          ]}
        />
        <span className="text-[12px] text-content-muted">
          Times in {tz ?? 'Metabase’s report timezone'}
          {tz ? '' : ' (not reported)'}
        </span>
        <div className="ml-auto">
          <Button variant="primary" size="sm" leading={<Icon name="plus" size={14} />} onClick={() => (view === 'alerts' ? setEditAlert('new') : setEditSub('new'))}>
            {view === 'alerts' ? 'New alert' : 'New subscription'}
          </Button>
        </div>
      </div>

      {noChannels ? (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/70 p-3 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <Icon name="warning" size={15} className="mt-0.5" />
          <span>Neither email (SMTP) nor Slack is set up in Metabase, so nothing can be delivered yet. A Metabase admin can configure them under Admin → Settings → Notification channels.</span>
        </div>
      ) : null}

      {view === 'subscriptions' ? (
        <SubscriptionList query={subs} tz={tz} onEdit={setEditSub} />
      ) : (
        <AlertList query={alerts} tz={tz} onEdit={setEditAlert} />
      )}

      {editSub ? <SubscriptionEditor initial={editSub === 'new' ? null : editSub} specs={specs.data} tz={tz} onClose={() => setEditSub(null)} /> : null}
      {editAlert ? <AlertEditor initial={editAlert === 'new' ? null : editAlert} specs={specs.data} tz={tz} onClose={() => setEditAlert(null)} /> : null}
    </div>
  )
}

/* ─────────── shared bits ─────────── */

function NextRun({ ch, tz }: { ch?: metabase.MbChannel; tz?: string }) {
  if (!ch) return null
  const t = nextRun(fromChannel(ch), Date.now(), tz)
  if (!Number.isFinite(t)) return null
  return (
    <span title={new Date(t).toLocaleString()} className="text-[12px] text-content-muted">
      Next {formatRelative(new Date(t))}
    </span>
  )
}

function ChannelSummary({ channels }: { channels: metabase.MbChannel[] }) {
  const on = channels.filter((c) => c.enabled !== false)
  if (!on.length) return <span className="text-[12px] text-content-subtle">No active channel</span>
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {on.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1 text-[12px] text-content-muted" title={(c.recipients ?? []).map((r) => r.email).join(', ')}>
          <Icon name={c.channel_type === 'slack' ? 'slack' : 'mail'} size={13} className="text-content-subtle" />
          {c.channel_type === 'slack' ? c.details?.channel ?? 'Slack' : `${(c.recipients ?? []).length} recipient${(c.recipients ?? []).length === 1 ? '' : 's'}`}
        </span>
      ))}
    </span>
  )
}

/* ─────────── subscriptions ─────────── */

function SubscriptionList({ query, tz, onEdit }: { query: ReturnType<typeof useSubscriptions>; tz?: string; onEdit(p: metabase.MbPulse): void }) {
  const toast = useToast()
  const go = useGoBi()
  const invalidate = useInvalidateBi()
  const [del, setDel] = useState<metabase.MbPulse | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const dashboards = useDashboardIndex()
  const dashName = (id?: number | null) => dashboards.data?.find((d) => d.id === id)?.name

  if (query.isLoading) return <BiSkeletonRows rows={4} />
  if (query.isError) return <MetabaseUnavailable resource="subscriptions" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />
  const list = query.data ?? []
  if (!list.length) {
    return (
      <EmptyState
        icon={<Icon name="mail" size={22} />}
        title="No dashboard subscriptions"
        description="Send a dashboard to email or Slack on a schedule — hourly, daily, weekly or monthly."
      />
    )
  }

  const sendNow = async (p: metabase.MbPulse) => {
    setBusy(p.id)
    try {
      await metabaseClient.testSubscription({ name: p.name, cards: p.cards, channels: p.channels, dashboard_id: p.dashboard_id, skip_if_empty: false, parameters: p.parameters })
      toast.success(`Sent “${p.name}”`, { description: 'Delivered once now to every recipient.' })
    } catch (e) {
      toast.error('Couldn’t send it', { description: errorToast(e) })
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!del) return
    setBusy(del.id)
    try {
      await metabaseClient.updateSubscription(del.id, { archived: true })
      invalidate(['subscriptions'])
      toast.success(`Deleted “${del.name}”`)
      setDel(null)
    } catch (e) {
      toast.error('Couldn’t delete it', { description: errorToast(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        {list.map((p) => {
          const ch = p.channels.find((c) => c.enabled !== false) ?? p.channels[0]
          return (
            <li key={p.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Icon name="dashboard" size={15} className="text-content-subtle" />
                  <span className="truncate text-[13.5px] font-medium text-content">{p.name}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {p.dashboard_id ? (
                    <button type="button" onClick={() => go('dashboards', { dashboard: String(p.dashboard_id) })} className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                      {dashName(p.dashboard_id) ?? `Dashboard ${p.dashboard_id}`}
                    </button>
                  ) : null}
                  {ch ? <span className="inline-flex items-center gap-1 text-[12px] text-content"><Icon name="clock" size={13} className="text-content-subtle" />{describeSchedule(fromChannel(ch))}</span> : null}
                  <NextRun ch={ch} tz={tz} />
                  <ChannelSummary channels={p.channels} />
                  {p.skip_if_empty ? <span className="text-[11px] text-content-subtle">skips empty</span> : null}
                  {p.creator?.common_name ? <span className="text-[11px] text-content-subtle">by {p.creator.common_name}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="xs" leading={<Icon name="send" size={12} />} loading={busy === p.id} onClick={() => sendNow(p)}>
                  Send now
                </Button>
                <Button size="xs" onClick={() => onEdit(p)}>Edit</Button>
                <IconButton icon="trash" label={`Delete ${p.name}`} onClick={() => setDel(p)} />
              </div>
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={!!del}
        title="Delete subscription?"
        body={<>“{del?.name}” stops sending. Recipients aren’t notified.</>}
        confirmLabel="Delete"
        danger
        busy={busy === del?.id}
        onConfirm={remove}
        onClose={() => setDel(null)}
      />
    </>
  )
}

/* ─────────── alerts ─────────── */

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function alertCondition(a: metabase.MbAlert): string {
  if (a.alert_condition === 'rows') return 'When the question returns any rows'
  return a.alert_above_goal ? 'When it goes above the goal' : 'When it goes below the goal'
}

function AlertList({ query, tz, onEdit }: { query: ReturnType<typeof useAlerts>; tz?: string; onEdit(a: metabase.MbAlert): void }) {
  const toast = useToast()
  const go = useGoBi()
  const invalidate = useInvalidateBi()
  const [del, setDel] = useState<metabase.MbAlert | null>(null)
  const [busy, setBusy] = useState(false)
  if (query.isLoading) return <BiSkeletonRows rows={4} />
  if (query.isError) return <MetabaseUnavailable resource="alerts" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />
  const list = query.data ?? []
  if (!list.length) {
    return (
      <EmptyState
        icon={<Icon name="bell" size={22} />}
        title="No question alerts"
        description="Get notified when a saved question returns rows, or when a number crosses its goal."
      />
    )
  }
  const remove = async () => {
    if (!del) return
    setBusy(true)
    try {
      await metabaseClient.updateAlert(del.id, { archived: true })
      invalidate(['alerts'])
      toast.success('Alert deleted')
      setDel(null)
    } catch (e) {
      toast.error('Couldn’t delete the alert', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        {list.map((a) => {
          const ch = a.channels.find((c) => c.enabled !== false) ?? a.channels[0]
          return (
            <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Icon name={displayIcon(a.card.display)} size={15} className="text-content-subtle" />
                  <button type="button" onClick={() => go('questions', { question: String(a.card.id) })} className="truncate text-left text-[13.5px] font-medium text-content hover:text-brand-700 dark:hover:text-brand-300">
                    {a.card.name ?? `Question ${a.card.id}`}
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1 text-[12px] text-content"><Icon name="bell" size={13} className="text-content-subtle" />{alertCondition(a)}{a.alert_first_only ? ' · first time only' : ''}</span>
                  {ch ? <span className="text-[12px] text-content-muted">Checked {lowerFirst(describeSchedule(fromChannel(ch)))}</span> : null}
                  <NextRun ch={ch} tz={tz} />
                  <ChannelSummary channels={a.channels} />
                  {a.creator?.common_name ? <span className="text-[11px] text-content-subtle">by {a.creator.common_name}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="xs" onClick={() => onEdit(a)}>Edit</Button>
                <IconButton icon="trash" label="Delete alert" onClick={() => setDel(a)} />
              </div>
            </li>
          )
        })}
      </ul>
      <ConfirmDialog open={!!del} title="Delete alert?" body={<>The alert on “{del?.card.name}” stops checking.</>} confirmLabel="Delete" danger busy={busy} onConfirm={remove} onClose={() => setDel(null)} />
    </>
  )
}

/* ─────────── editors ─────────── */

export function ScheduleBuilder({ value, onChange, tz, label = 'Send' }: { value: Schedule; onChange(s: Schedule): void; tz?: string; label?: string }) {
  const next = nextRun(value, Date.now(), tz)
  const sel = 'h-9 rounded-md border border-edge-default bg-surface-raised px-2 text-[13px] text-content'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-content-muted">{label}</span>
        <select aria-label="Frequency" value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as Schedule['type'], day: e.target.value === 'weekly' ? (value.day ?? 'mon') : value.day })} className={sel}>
          <option value="hourly">hourly</option>
          <option value="daily">daily</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
        </select>
        {value.type === 'monthly' ? (
          <>
            <span className="text-[13px] text-content-muted">on the</span>
            <select aria-label="Week of month" value={value.frame} onChange={(e) => onChange({ ...value, frame: e.target.value as Frame })} className={sel}>
              <option value="first">first</option>
              <option value="mid">15th</option>
              <option value="last">last</option>
            </select>
            {value.frame !== 'mid' ? (
              <select aria-label="Day" value={value.day ?? ''} onChange={(e) => onChange({ ...value, day: (e.target.value || null) as Day | null })} className={sel}>
                <option value="">day of the month</option>
                {DAYS.map((d) => <option key={d} value={d}>{DAY_LABEL[d]}</option>)}
              </select>
            ) : null}
          </>
        ) : null}
        {value.type === 'weekly' ? (
          <>
            <span className="text-[13px] text-content-muted">on</span>
            <select aria-label="Weekday" value={value.day ?? 'mon'} onChange={(e) => onChange({ ...value, day: e.target.value as Day })} className={sel}>
              {DAYS.map((d) => <option key={d} value={d}>{DAY_LABEL[d]}</option>)}
            </select>
          </>
        ) : null}
        {value.type !== 'hourly' ? (
          <>
            <span className="text-[13px] text-content-muted">at</span>
            <select aria-label="Hour" value={value.hour} onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })} className={sel}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
            </select>
          </>
        ) : null}
      </div>
      <div className="text-[12px] text-content-muted">
        {describeSchedule(value)}
        {Number.isFinite(next) ? <> · next {new Date(next).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} your time</> : null}
        {tz ? <span className="text-content-subtle"> · scheduled in {tz}</span> : null}
      </div>
    </div>
  )
}

interface ChannelDraft {
  email: boolean
  recipients: metabase.MbRecipient[]
  slack: boolean
  slackChannel: string
}

function draftFrom(channels: metabase.MbChannel[] | undefined): ChannelDraft {
  const e = channels?.find((c) => c.channel_type === 'email')
  const s = channels?.find((c) => c.channel_type === 'slack')
  return { email: e ? e.enabled !== false : true, recipients: e?.recipients ?? [], slack: !!s && s.enabled !== false, slackChannel: s?.details?.channel ?? '' }
}

function channelsFrom(d: ChannelDraft, s: Schedule, specs?: metabase.MbPulseFormInput): metabase.MbChannel[] {
  const sched = toChannelSchedule(s)
  const out: metabase.MbChannel[] = []
  if (d.email && specs?.channels?.email?.configured !== false) {
    out.push({ channel_type: 'email', enabled: true, ...sched, recipients: d.recipients.map((r) => (r.id != null ? { id: r.id, email: r.email } : { email: r.email })), details: {} })
  }
  if (d.slack && d.slackChannel.trim()) {
    out.push({ channel_type: 'slack', enabled: true, ...sched, recipients: [], details: { channel: d.slackChannel.trim() } })
  }
  return out
}

function ChannelsEditor({ value, onChange, specs }: { value: ChannelDraft; onChange(d: ChannelDraft): void; specs?: metabase.MbPulseFormInput }) {
  const users = useMbUsers()
  const [entry, setEntry] = useState('')
  const emailOk = specs?.channels?.email?.configured !== false
  const slackOk = !!specs?.channels?.slack?.configured
  const slackOptions = specs?.channels?.slack?.fields?.find((f) => f.name === 'channel')?.options ?? []
  const add = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    const u = users.data?.find((x) => x.email?.toLowerCase() === v.toLowerCase() || x.common_name?.toLowerCase() === v.toLowerCase())
    const email = u?.email ?? v
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return
    if (value.recipients.some((r) => r.email.toLowerCase() === email.toLowerCase())) return setEntry('')
    onChange({ ...value, recipients: [...value.recipients, u?.id != null ? { id: u.id, email, common_name: u.common_name } : { email }] })
    setEntry('')
  }
  return (
    <div className="space-y-3">
      <div className={cn('rounded-lg border border-edge-default p-3', !emailOk && 'opacity-60')}>
        <Checkbox label={<span className="inline-flex items-center gap-1.5"><Icon name="mail" size={14} /> Email</span>} description={emailOk ? undefined : 'Email (SMTP) isn’t configured in Metabase.'} checked={value.email && emailOk} disabled={!emailOk} onChange={(e) => onChange({ ...value, email: (e.target as HTMLInputElement).checked })} />
        {value.email && emailOk ? (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {value.recipients.map((r) => (
                <span key={r.email} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[12px] text-content ring-1 ring-inset ring-edge-default">
                  {r.common_name ?? r.email}
                  <button type="button" aria-label={`Remove ${r.email}`} onClick={() => onChange({ ...value, recipients: value.recipients.filter((x) => x.email !== r.email) })} className="text-content-subtle hover:text-content">
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
            <Input
              list="bi-users"
              value={entry}
              placeholder="Add a person or email, then Enter"
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  add(entry)
                }
              }}
              onBlur={() => add(entry)}
            />
            <datalist id="bi-users">
              {(users.data ?? []).map((u) => <option key={u.id ?? u.email} value={u.email}>{u.common_name}</option>)}
            </datalist>
            {users.isError && classifyMbError(users.error).kind === 'forbidden' ? <div className="text-[11px] text-content-subtle">Your account can’t list Metabase users — type email addresses.</div> : null}
          </div>
        ) : null}
      </div>
      <div className={cn('rounded-lg border border-edge-default p-3', !slackOk && 'opacity-60')}>
        <Checkbox label={<span className="inline-flex items-center gap-1.5"><Icon name="slack" size={14} /> Slack</span>} description={slackOk ? undefined : 'Slack isn’t connected to Metabase.'} checked={value.slack && slackOk} disabled={!slackOk} onChange={(e) => onChange({ ...value, slack: (e.target as HTMLInputElement).checked })} />
        {value.slack && slackOk ? (
          <div className="mt-2">
            {slackOptions.length ? (
              <select aria-label="Slack channel" value={value.slackChannel} onChange={(e) => onChange({ ...value, slackChannel: e.target.value })} className="h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[13px] text-content">
                <option value="">Pick a channel…</option>
                {slackOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <Input value={value.slackChannel} onChange={(e) => onChange({ ...value, slackChannel: e.target.value })} placeholder="#channel" />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function channelProblem(d: ChannelDraft, specs?: metabase.MbPulseFormInput): string | null {
  const emailOn = d.email && specs?.channels?.email?.configured !== false
  const slackOn = d.slack && !!specs?.channels?.slack?.configured
  if (!emailOn && !slackOn) return 'Turn on at least one channel.'
  if (emailOn && !d.recipients.length && !slackOn) return 'Add at least one email recipient.'
  if (slackOn && !d.slackChannel.trim()) return 'Pick a Slack channel.'
  return null
}

function SubscriptionEditor({ initial, specs, tz, onClose }: { initial: metabase.MbPulse | null; specs?: metabase.MbPulseFormInput; tz?: string; onClose(): void }) {
  const toast = useToast()
  const invalidate = useInvalidateBi()
  const dashboards = useDashboardIndex()
  const [dashId, setDashId] = useState<number | null>(initial?.dashboard_id ?? null)
  const [name, setName] = useState(initial?.name ?? '')
  const [sched, setSched] = useState<Schedule>(initial ? fromChannel(initial.channels[0]) : { ...DEFAULT_SCHEDULE })
  const [ch, setCh] = useState<ChannelDraft>(draftFrom(initial?.channels))
  const [skipEmpty, setSkipEmpty] = useState(initial?.skip_if_empty ?? true)
  const [csv, setCsv] = useState(!!initial?.cards.some((c) => c.include_csv))
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)

  useEffect(() => {
    if (!initial && dashId && !name) setName(dashboards.data?.find((d) => d.id === dashId)?.name ?? '')
  }, [dashId]) // eslint-disable-line react-hooks/exhaustive-deps

  const problem = !dashId ? 'Pick a dashboard.' : channelProblem(ch, specs)

  const build = async (): Promise<metabase.MbPulseInput> => {
    const detail = await metabaseClient.getDashboardDetail(dashId!)
    const cards: metabase.MbPulseCard[] = detail.dashcards
      .filter((dc) => dc.card_id != null)
      .map((dc) => ({ id: dc.card_id!, include_csv: csv, include_xls: false, dashboard_card_id: dc.id, dashboard_id: detail.id }))
    return { name: name.trim() || detail.name, cards, channels: channelsFrom(ch, sched, specs), dashboard_id: detail.id, collection_id: detail.collection_id ?? null, skip_if_empty: skipEmpty, parameters: initial?.parameters ?? [] }
  }

  const save = async () => {
    setBusy('save')
    try {
      const body = await build()
      if (initial) await metabaseClient.updateSubscription(initial.id, body)
      else await metabaseClient.createSubscription(body)
      invalidate(['subscriptions'])
      toast.success(initial ? 'Subscription updated' : 'Subscription created', { description: describeSchedule(sched) })
      onClose()
    } catch (e) {
      toast.error('Couldn’t save the subscription', { description: errorToast(e) })
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    try {
      await metabaseClient.testSubscription({ ...(await build()), skip_if_empty: false })
      toast.success('Test sent', { description: 'Check the inbox / channel.' })
    } catch (e) {
      toast.error('Couldn’t send the test', { description: errorToast(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit subscription' : 'New dashboard subscription'}
      width="lg"
      branded
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {problem ? <span className="mr-auto text-[12px] text-content-muted">{problem}</span> : null}
          <Button leading={<Icon name="send" size={13} />} disabled={!!problem} loading={busy === 'test'} onClick={test}>Send test</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!problem} loading={busy === 'save'} onClick={save}>{initial ? 'Save' : 'Create'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Dashboard" required>
          {dashboards.isLoading ? (
            <Spinner />
          ) : dashboards.isError ? (
            <InlineError error={dashboards.error} />
          ) : (
            <select value={dashId ?? ''} onChange={(e) => setDashId(e.target.value ? Number(e.target.value) : null)} disabled={!!initial} className="h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[13px] text-content">
              <option value="">Pick a dashboard…</option>
              {(dashboards.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the dashboard name" />
        </Field>
        <Field label="Schedule">
          <ScheduleBuilder value={sched} onChange={setSched} tz={tz} />
        </Field>
        <Field label="Deliver to">
          <ChannelsEditor value={ch} onChange={setCh} specs={specs} />
        </Field>
        <div className="flex flex-col gap-2">
          <Checkbox label="Don’t send if every card is empty" checked={skipEmpty} onChange={(e) => setSkipEmpty((e.target as HTMLInputElement).checked)} />
          <Checkbox label="Attach results as CSV" checked={csv} onChange={(e) => setCsv((e.target as HTMLInputElement).checked)} />
        </div>
      </div>
    </Modal>
  )
}

function hasGoal(c?: metabase.MbCard): boolean {
  const s = c?.visualization_settings ?? {}
  return s['graph.goal_value'] != null || s['progress.goal'] != null
}

function AlertEditor({ initial, specs, tz, onClose }: { initial: metabase.MbAlert | null; specs?: metabase.MbPulseFormInput; tz?: string; onClose(): void }) {
  const toast = useToast()
  const invalidate = useInvalidateBi()
  const cards = useCards()
  const [cardId, setCardId] = useState<number | null>(initial?.card.id ?? null)
  const [cond, setCond] = useState<'rows' | 'above' | 'below'>(initial ? (initial.alert_condition === 'rows' ? 'rows' : initial.alert_above_goal ? 'above' : 'below') : 'rows')
  const [firstOnly, setFirstOnly] = useState(initial?.alert_first_only ?? false)
  const [sched, setSched] = useState<Schedule>(initial ? fromChannel(initial.channels[0]) : { ...DEFAULT_SCHEDULE, type: 'hourly' })
  const [ch, setCh] = useState<ChannelDraft>(draftFrom(initial?.channels))
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const card = cards.data?.find((c) => c.id === cardId)
  const goalOk = hasGoal(card)
  const list = useMemo(() => {
    const f = q.trim().toLowerCase()
    return (cards.data ?? []).filter((c) => !c.archived && (!f || c.name.toLowerCase().includes(f))).slice(0, 300)
  }, [cards.data, q])
  const problem = !cardId ? 'Pick a question.' : cond !== 'rows' && !goalOk ? 'Goal alerts need a goal line set on the question in Metabase.' : channelProblem(ch, specs)

  const save = async () => {
    if (!cardId) return
    setBusy(true)
    const body: metabase.MbAlertInput = {
      card: { id: cardId, include_csv: false, include_xls: false, dashboard_card_id: null },
      alert_condition: cond === 'rows' ? 'rows' : 'goal',
      alert_above_goal: cond === 'rows' ? null : cond === 'above',
      alert_first_only: firstOnly,
      channels: channelsFrom(ch, sched, specs),
    }
    try {
      if (initial) await metabaseClient.updateAlert(initial.id, body)
      else await metabaseClient.createAlert(body)
      invalidate(['alerts'])
      toast.success(initial ? 'Alert updated' : 'Alert created', { description: `Checked ${lowerFirst(describeSchedule(sched))}` })
      onClose()
    } catch (e) {
      toast.error('Couldn’t save the alert', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit alert' : 'New question alert'}
      width="lg"
      branded
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {problem ? <span className="mr-auto text-[12px] text-content-muted">{problem}</span> : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!problem} loading={busy} onClick={save}>{initial ? 'Save' : 'Create'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Question" required>
          {initial ? (
            <div className="text-[13px] font-medium text-content">{initial.card.name ?? card?.name}</div>
          ) : cards.isError ? (
            <InlineError error={cards.error} />
          ) : (
            <div className="space-y-1.5">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter questions…" />
              <select size={6} value={cardId ?? ''} onChange={(e) => setCardId(Number(e.target.value))} aria-label="Question" className="w-full rounded-md border border-edge-default bg-surface-raised p-1 text-[13px] text-content">
                {list.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.collection?.name ?? 'Our analytics'}</option>)}
              </select>
            </div>
          )}
        </Field>
        <Field label="Alert me">
          <Segmented<'rows' | 'above' | 'below'>
            ariaLabel="Condition"
            value={cond}
            onChange={setCond}
            options={[
              { value: 'rows', label: 'When it has results' },
              { value: 'above', label: 'Goes above goal', disabled: !goalOk, title: goalOk ? undefined : 'Set a goal line on the question in Metabase first' },
              { value: 'below', label: 'Goes below goal', disabled: !goalOk, title: goalOk ? undefined : 'Set a goal line on the question in Metabase first' },
            ]}
          />
        </Field>
        <Checkbox label="Only alert the first time" checked={firstOnly} onChange={(e) => setFirstOnly((e.target as HTMLInputElement).checked)} />
        <Field label="Check">
          <ScheduleBuilder value={sched} onChange={setSched} tz={tz} label="Check" />
        </Field>
        <Field label="Notify">
          <ChannelsEditor value={ch} onChange={setCh} specs={specs} />
        </Field>
      </div>
    </Modal>
  )
}

