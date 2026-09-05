import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PrometheusIcon,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import { useAlerts, useSilenceAlert } from '../data/observability.ts'
import { LoadingCard, SourceError } from './states.tsx'

const STATE_TONE: Record<lgtm.AlertState, 'failed' | 'progressing' | 'healthy'> = {
  firing: 'failed',
  pending: 'progressing',
  resolved: 'healthy',
}
const SEVERITY_TONE: Record<lgtm.AlertSeverity, 'failed' | 'progressing' | 'info'> = {
  critical: 'failed',
  warning: 'progressing',
  info: 'info',
}

/**
 * Alerts — Alertmanager active list with severity tabs, summary banner,
 * and a detail drawer that shows the matched expression, runbook URL,
 * and a silence action.
 */
export function Alerts() {
  const q = useAlerts()
  const silence = useSilenceAlert()
  const [tab, setTab] = useState<'active' | 'firing' | 'pending' | 'resolved'>('active')
  const [openId, setOpenId] = useState<string | null>(null)

  const all = q.data ?? []
  const counts = useMemo(() => {
    const out = { active: 0, firing: 0, pending: 0, resolved: 0 }
    for (const a of all) {
      if (a.state === 'firing') {
        out.firing++
        out.active++
      } else if (a.state === 'pending') {
        out.pending++
        out.active++
      } else if (a.state === 'resolved') {
        out.resolved++
      }
    }
    return out
  }, [all])

  const list = useMemo(() => {
    if (tab === 'active') return all.filter((a) => a.state === 'firing' || a.state === 'pending')
    return all.filter((a) => a.state === tab)
  }, [all, tab])

  if (q.isLoading) return <LoadingCard label="Loading alerts…" />
  if (q.isError) {
    return <SourceError tool="Alertmanager" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />
  }

  const sorted = list.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  const open = all.find((a) => a.fingerprint === openId) ?? null

  const critical = all.filter((a) => a.state === 'firing' && a.severity === 'critical').length

  return (
    <div className="space-y-4">
      {critical > 0 ? (
        <Card className="border-rose-200/60 bg-rose-50/40 border">
          <CardBody className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-700">
              <IconShieldAlert />
            </span>
            <div>
              <div className="text-sm font-semibold text-content">
                {critical} critical alert{critical === 1 ? '' : 's'} firing
              </div>
              <div className="text-[11px] text-content-muted">
                Check service health and escalation channels.
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
          <Tab on={tab === 'active'} onClick={() => setTab('active')}>
            Active <Count>{counts.active}</Count>
          </Tab>
          <Tab on={tab === 'firing'} onClick={() => setTab('firing')} tone="rose">
            Firing <Count>{counts.firing}</Count>
          </Tab>
          <Tab on={tab === 'pending'} onClick={() => setTab('pending')} tone="amber">
            Pending <Count>{counts.pending}</Count>
          </Tab>
          <Tab on={tab === 'resolved'} onClick={() => setTab('resolved')} tone="emerald">
            Resolved <Count>{counts.resolved}</Count>
          </Tab>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="All clear 🎉" description="No alerts in this filter." />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {sorted.map((a) => (
                <AlertRow key={a.fingerprint} alert={a} onOpen={() => setOpenId(a.fingerprint)} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {open ? (
        <AlertDetail
          alert={open}
          onClose={() => setOpenId(null)}
          onSilence={(min) => silence.mutate({ fingerprint: open.fingerprint, durationMin: min })}
          silencing={silence.isPending && silence.variables?.fingerprint === open.fingerprint}
        />
      ) : null}
    </div>
  )
}

function severityRank(s: lgtm.AlertSeverity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2
}

function Tab({
  on,
  onClick,
  tone = 'brand',
  children,
}: {
  on: boolean
  onClick(): void
  tone?: 'brand' | 'rose' | 'amber' | 'emerald'
  children: React.ReactNode
}) {
  const onCls = {
    brand: 'bg-brand-50 text-brand-700',
    rose: 'bg-rose-50 text-rose-700',
    amber: 'bg-amber-50 text-amber-700',
    emerald: 'bg-emerald-50 text-emerald-700',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? `rounded-md ${onCls} px-2.5 py-1 text-[12px] font-semibold`
          : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
      }
    >
      {children}
    </button>
  )
}
function Count({ children }: { children: React.ReactNode }) {
  return <span className="ml-1 font-mono text-[10px] tabular-nums opacity-60">{children}</span>
}

function AlertRow({ alert: a, onOpen }: { alert: lgtm.Alert; onOpen(): void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full px-5 py-3 text-left transition-colors hover:bg-brand-50/40"
      >
        <div className="flex items-center gap-2">
          <StatusBadge kind={SEVERITY_TONE[a.severity]}>{a.severity}</StatusBadge>
          <StatusBadge kind={STATE_TONE[a.state]}>{a.state}</StatusBadge>
          <span className="truncate text-sm font-semibold text-content">{a.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-content-muted">
            {formatRelative(a.startsAt)}
          </span>
        </div>
        {a.summary ? (
          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
            {a.summary}
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] font-mono text-content-subtle">
          {Object.entries(a.labels)
            .slice(0, 4)
            .map(([k, v]) => (
              <span key={k} className="rounded bg-surface-sunken px-1.5 py-0.5">
                <span className="opacity-60">{k}=</span>
                {v}
              </span>
            ))}
        </div>
      </button>
    </li>
  )
}

function AlertDetail({
  alert: a,
  onClose,
  onSilence,
  silencing,
}: {
  alert: lgtm.Alert
  onClose(): void
  onSilence(durationMin: number): void
  silencing: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
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
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge kind={SEVERITY_TONE[a.severity]}>{a.severity}</StatusBadge>
              <StatusBadge kind={STATE_TONE[a.state]}>{a.state}</StatusBadge>
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">{a.name}</h2>
            <div className="mt-1 text-[11px] text-content-muted">
              fired {formatRelative(a.startsAt)}
              {a.value != null ? ` · current value ${a.value}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {a.summary ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Summary</div>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-content">{a.summary}</p>
                {a.description ? (
                  <p className="mt-2 text-[12px] leading-relaxed text-content-muted">{a.description}</p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {a.expression ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Expression</div>
              </CardHeader>
              <CardBody>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                  {a.expression}
                </pre>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Labels</div>
            </CardHeader>
            <CardBody>
              <table className="w-full text-[12px]">
                <tbody>
                  {Object.entries(a.labels).map(([k, v]) => (
                    <tr key={k} className="border-b border-edge-subtle last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-content-subtle">{k}</td>
                      <td className="py-1.5 font-mono text-content">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">Actions</div>
            </CardHeader>
            <CardBody className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => onSilence(15)} loading={silencing}>
                Silence 15m
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onSilence(60)} loading={silencing}>
                Silence 1h
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onSilence(1440)} loading={silencing}>
                Silence 24h
              </Button>
              {a.runbook_url ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => window.open(a.runbook_url, '_blank', 'noopener')}
                >
                  Runbook ↗
                </Button>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function IconShieldAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
