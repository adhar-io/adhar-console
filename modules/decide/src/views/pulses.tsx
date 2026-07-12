import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { metabase } from '@adhar-console/api-clients'
import { useQuestions, usePulses, useTogglePulse } from '../data/bi.ts'

const CHANNEL_ICON: Record<string, string> = {
  email: '📧',
  slack: '💬',
}

/**
 * Pulses & alerts — scheduled email/Slack reports backed by saved
 * questions. Toggle per pulse, see channels + thresholds.
 */
export function Pulses() {
  const q = usePulses()
  const questions = useQuestions()
  const toggle = useTogglePulse()

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading pulses…
      </div>
    )
  }

  const list = q.data ?? []
  if (list.length === 0) {
    return <EmptyState title="No pulses" description="Define a Metabase pulse or alert to start scheduled delivery." />
  }
  const active = list.filter((p) => p.active).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Pulses" value={list.length} />
        <Tile label="Active" value={active} accent="emerald" />
        <Tile label="Disabled" value={list.length - active} accent={list.length - active > 0 ? 'amber' : 'slate'} />
        <Tile label="Alerts" value={list.filter((p) => p.alert_condition).length} accent="rose" />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {list.map((p) => (
          <PulseCard
            key={p.id}
            pulse={p}
            cards={questions.data ?? []}
            onToggle={(active) => toggle.mutate({ id: p.id, active })}
            busy={toggle.isPending && toggle.variables?.id === p.id}
          />
        ))}
      </div>
    </div>
  )
}

function PulseCard({
  pulse: p,
  cards,
  onToggle,
  busy,
}: {
  pulse: metabase.Pulse
  cards: metabase.Question[]
  onToggle(active: boolean): void
  busy: boolean
}) {
  const isAlert = !!p.alert_condition
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-content">{p.name}</span>
              {isAlert ? <StatusBadge kind="failed">alert</StatusBadge> : <StatusBadge kind="info">digest</StatusBadge>}
            </div>
            {p.description ? (
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
                {p.description}
              </p>
            ) : null}
          </div>
          <Toggle enabled={p.active} onChange={onToggle} busy={busy} />
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            Cards
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {p.card_ids.map((id) => {
              const c = cards.find((x) => x.id === id)
              return (
                <span
                  key={id}
                  className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-content-muted"
                >
                  {c?.name ?? `card ${id}`}
                </span>
              )
            })}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            Channels
          </div>
          <ul className="mt-1 space-y-1.5 text-[11px]">
            {p.channels.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1.5">
                <span className="text-base">{CHANNEL_ICON[c.channel_type] ?? '🔔'}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-content">
                  {c.channel_type}
                </span>
                <span className="text-content-muted">· {c.schedule}</span>
                {c.recipients?.length ? (
                  <span className="ml-auto truncate font-mono text-[10px] text-content-subtle">
                    {c.recipients.join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        {isAlert ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 p-2 text-[11px] text-amber-900">
            Trigger when value{' '}
            <span className="font-mono">
              {p.alert_above_goal ? '>' : '<'}
              {' '}
              {p.goal ?? '—'}
            </span>
          </div>
        ) : null}

        <div className="flex items-center justify-between text-[11px] text-content-muted">
          <span>
            {p.last_run_at ? `last run ${formatRelative(p.last_run_at)}` : 'never run'}
          </span>
          <span className="font-mono text-[10px] text-content-subtle">created {formatRelative(p.created_at)}</span>
        </div>
      </CardBody>
    </Card>
  )
}

function Toggle({
  enabled,
  onChange,
  busy,
}: {
  enabled: boolean
  onChange(v: boolean): void
  busy: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      disabled={busy}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        enabled ? 'bg-brand-500' : 'bg-edge-default'
      } ${busy ? 'opacity-60' : ''}`}
      role="switch"
      aria-checked={enabled}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          enabled ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function Tile({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: number
  accent?: 'slate' | 'emerald' | 'amber' | 'rose'
}) {
  const cls = {
    slate: 'from-slate-50 to-white text-content',
    emerald: 'from-emerald-50 to-white text-emerald-700',
    amber: 'from-amber-50 to-white text-amber-700',
    rose: 'from-rose-50 to-white text-rose-700',
  }[accent]
  return (
    <Card className={`bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
      </CardBody>
    </Card>
  )
}
