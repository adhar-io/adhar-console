import { useState } from 'react'
import { Button, EmptyState, Field, Modal, Textarea, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import { type Capabilities, type EngineState, suspendAllSchedules, WorkflowsApiError } from '../data/api.ts'
import { useEngine, useWorkflowCluster } from '../data/hooks.ts'
import { ErrorNote, KpiCard, Loading, Section } from './common.tsx'

/**
 * Engine (design 0026 §6.9, platform staff): the controller (leader, queue,
 * errors, step pods), the archive database, parallelism (global, namespace
 * default, per-namespace overrides) and "Suspend all schedules" (reason
 * required, audited by the BFF). Everything comes from
 * `GET /api/workflows/engine`, which refuses anyone without `workflowsAdmin`
 * — a 403 reads as a refusal, and a series Prometheus does not have reads as
 * "not reported", never as a zero.
 */

const bytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Math.round(n)))

/** The health strip the overview shows platform staff. */
export function EngineStrip({ engine }: { engine?: EngineState }) {
  const c = engine?.controller
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiCard label="Controller" value={c?.leader === null || c?.leader === undefined ? '—' : c.leader >= 1 ? 'leading' : 'no leader'} tone={c?.leader === 0 ? 'bad' : 'default'} />
      <KpiCard label="Queue depth" value={num(c?.queueDepth)} tone={(c?.queueDepth ?? 0) > 50 ? 'warn' : 'default'} />
      <KpiCard label="Step pods running" value={num(c?.runningPods)} hint={c?.pendingPods ? `${num(c.pendingPods)} pending` : undefined} />
      <KpiCard label="Archive" value={bytes(c?.archiveDatabaseBytes)} />
    </div>
  )
}

export function EngineView({ caps }: { caps: Capabilities }) {
  const q = useEngine()
  const argoUi = useToolPublicUrl('argo-workflows')
  const grafana = useToolPublicUrl('grafana')
  const [suspendOpen, setSuspendOpen] = useState(false)
  if (q.isLoading) return <Loading label="Reading the engine…" />
  if (q.error instanceof WorkflowsApiError && q.error.status === 403) {
    return <EmptyState title="The engine page is for platform staff" description="It needs the workflowsAdmin console permission (platform-admin, platform-engineer)." />
  }
  if (q.error) return <ErrorNote title="Could not read the engine" error={q.error} />
  const e = q.data
  if (!e) return null
  const c = e.controller
  return (
    <div className="space-y-6">
      {e.problems.length ? (
        <ul role="status" className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {e.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      <Section title="Controller">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="Leader" value={c.leader === null ? '—' : c.leader >= 1 ? 'elected' : 'none'} tone={c.leader === 0 ? 'bad' : c.leader ? 'good' : 'default'} />
          <KpiCard label="Version" value={<span className="font-mono text-sm">{caps.version ?? '—'}</span>} />
          <KpiCard label="Queue depth" value={num(c.queueDepth)} />
          <KpiCard label="Errors · 15 min" value={num(c.errors15m)} tone={(c.errors15m ?? 0) > 0 ? 'warn' : 'default'} />
          <KpiCard label="Step pods running" value={num(c.runningPods)} />
          <KpiCard label="Step pods pending" value={num(c.pendingPods)} tone={(c.pendingPods ?? 0) > 20 ? 'warn' : 'default'} />
        </div>
      </Section>
      <Section title="Archive">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="State" value={caps.archive ? 'on' : 'unavailable'} tone={caps.archive ? 'good' : 'warn'} />
          <KpiCard label="Database size" value={bytes(c.archiveDatabaseBytes)} />
          <KpiCard label="Retention" value="60 days" hint="archiveTTL (D-9)" />
        </div>
      </Section>
      <Section title="Parallelism">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Global" value={num(e.limits.parallelism)} />
          <KpiCard label="Per namespace (default)" value={num(e.limits.namespaceParallelism)} />
        </div>
        {e.namespaces.length ? (
          <table className="mt-2 w-full max-w-lg text-left text-xs">
            <thead><tr className="text-content-subtle"><th className="py-1">Namespace</th><th className="text-right">Limit</th></tr></thead>
            <tbody>{e.namespaces.map((o) => <tr key={o.name} className="border-t border-edge-subtle"><td className="py-1 font-mono">{o.name}</td><td className="text-right tabular-nums">{o.parallelismLimit ?? '—'}</td></tr>)}</tbody>
          </table>
        ) : <p className="text-xs text-content-subtle">No namespace overrides (label workflows.argoproj.io/parallelism-limit).</p>}
      </Section>
      <Section title="Schedules">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="danger" onClick={() => setSuspendOpen(true)}>Suspend all schedules…</Button>
          <span className="text-xs text-content-subtle">Every CronWorkflow is suspended as you, with your reason recorded on it and in the audit log.</span>
        </div>
      </Section>
      <Section title="Links">
        <div className="flex flex-wrap gap-3 text-sm">
          {argoUi ? <a className="text-brand-600 hover:underline dark:text-brand-400" href={argoUi} target="_blank" rel="noreferrer">Argo UI ↗</a> : null}
          {grafana ? <a className="text-brand-600 hover:underline dark:text-brand-400" href={grafana} target="_blank" rel="noreferrer">Grafana ↗</a> : null}
        </div>
      </Section>
      {suspendOpen ? <SuspendAllDialog onClose={() => setSuspendOpen(false)} /> : null}
    </div>
  )
}

function SuspendAllDialog({ onClose }: { onClose(): void }) {
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const r = await suspendAllSchedules({ reason: reason.trim() }, cluster)
      const n = r.suspended.length
      if (r.failed.length) toast.warning(`Suspended ${n}; ${r.failed.length} could not be suspended`, { description: r.failed.slice(0, 5).map((f) => `${f.schedule} (HTTP ${f.status})`).join(', ') })
      else toast.success(`Suspended ${n} schedule${n === 1 ? '' : 's'}`, r.alreadySuspended ? { description: `${r.alreadySuspended} were already suspended.` } : undefined)
      onClose()
    } catch (e) {
      toast.error('Could not suspend the schedules', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="sm"
      title="Suspend every schedule?"
      description="No CronWorkflow starts a run until it is resumed. Runs already going carry on."
      footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={busy} onClick={go}>Suspend all</Button></div>}
    >
      <Field label="Reason" required hint="recorded in the audit log">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.currentTarget.value)} aria-label="Reason" maxLength={500} />
      </Field>
    </Modal>
  )
}
