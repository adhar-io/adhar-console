import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Field, Input, Modal, Select, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import {
  CHAOS_FAULTS,
  type ChaosFault,
  FAMILY_LABEL,
  faultById,
  type FaultFamily,
  modeLabel,
  type TargetMode,
} from '../data/chaos-kinds.ts'
import { createChaosEngine, useChaosCluster, useTargetNamespaces } from '../data/chaos.ts'
import { type Guard, isProtectedNamespace, launchAllowed, MAX_FAULT_SECONDS, reviewLaunch } from '../data/chaos-safety.ts'

/**
 * New experiment — a three-step guided flow with the blast radius on screen
 * the whole way:
 *
 *   1. Fault    — what to break, from the faults installed on this cluster,
 *                 each with what it does and how much of an outage it is.
 *   2. Target   — where, how much of it, for how long, and the steady-state
 *                 probe that turns "I broke it" into a verdict.
 *   3. Review   — the run in one sentence, every safety rail that applies
 *                 (blocked / type the name to confirm / said out loud), then
 *                 Launch. The run's live canvas opens as soon as it is created.
 */

const MODES: TargetMode[] = ['one', 'percent', 'all']
const APP_KINDS = ['deployment', 'statefulset', 'daemonset', 'rollout'] as const
type Step = 'fault' | 'target' | 'review'
const STEPS: Array<[Step, string]> = [['fault', 'Fault'], ['target', 'Target'], ['review', 'Review & launch']]

export const BLAST_TONE: Record<ChaosFault['blast'], 'emerald' | 'amber' | 'rose'> = { low: 'emerald', medium: 'amber', high: 'rose' }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

export function LaunchWizard({ installed, initialFault, taken = [], onClose, onLaunched }: {
  installed: ChaosFault[]
  initialFault?: string
  /** Engine names that exist already. */
  taken?: string[]
  onClose(): void
  /** The created engine's name — the caller opens its live canvas. */
  onLaunched(name: string): void
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const { cluster } = useChaosCluster()
  const namespaces = useTargetNamespaces()
  const startFault = installed.find((f) => f.id === initialFault)?.id ?? installed[0]?.id ?? 'pod-delete'
  const [step, setStep] = useState<Step>(initialFault && installed.some((f) => f.id === initialFault) ? 'target' : 'fault')
  const [family, setFamily] = useState<FaultFamily | 'all'>('all')
  const [faultId, setFaultId] = useState<string>(startFault)
  const fault = faultById(faultId)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [targetNs, setTargetNs] = useState('')
  const [label, setLabel] = useState('')
  const [appKind, setAppKind] = useState<typeof APP_KINDS[number]>('deployment')
  const [node, setNode] = useState('')
  const [mode, setMode] = useState<TargetMode>('one')
  const [percent, setPercent] = useState('50')
  const [env, setEnv] = useState<Record<string, string>>({})
  const [probeUrl, setProbeUrl] = useState('')
  const [probeCode, setProbeCode] = useState('200')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const pickFault = (id: string) => {
    setFaultId(id)
    setEnv({})
  }
  const knob = (key: string, fallback: string) => env[key] ?? fallback
  const durationDefault = fault?.knobs.find((k) => k.env === 'TOTAL_CHAOS_DURATION')?.value ?? '60'
  const duration = knob('TOTAL_CHAOS_DURATION', durationDefault)
  const suggested = slug(`${label.split('=')[1] || targetNs || 'chaos'}-${faultId}`).slice(0, 63)
  const runName = nameTouched ? name : suggested
  const nsLabels = namespaces.data?.find((n) => n.name === targetNs)?.labels

  const guards = useMemo(() => reviewLaunch({
    name: runName,
    namespace: fault?.node ? undefined : targetNs || undefined,
    namespaceLabels: nsLabels,
    label,
    mode,
    percent,
    blast: fault?.blast ?? 'low',
    seconds: Number(duration),
    hasProbe: !!probeUrl.trim(),
    node: !!fault?.node,
    taken,
  }), [runName, fault, targetNs, nsLabels, label, mode, percent, duration, probeUrl, taken])
  const blocked = guards.filter((g) => g.level === 'block')
  const needsConfirm = guards.some((g) => g.level === 'confirm')
  const allowed = launchAllowed(guards, confirm, runName)

  const blastSentence = fault?.node
    ? `${fault.label} on ${node.trim() ? `node ${node.trim()}` : 'a node the runner picks'} for ${duration}s`
    : targetNs
    ? `${fault?.label ?? faultId} on ${modeLabel(mode, percent)} in ${targetNs}${label.trim() ? ` matching ${label.trim()}` : ' (any pod)'} for ${duration}s`
    : 'Choose a target namespace.'

  const launch = async () => {
    setBusy(true)
    try {
      const code = Number(probeCode) || 200
      const created = await createChaosEngine({
        fault: faultId,
        name: runName,
        targetNamespace: targetNs,
        label: label.trim() || undefined,
        appKind,
        mode,
        percent: mode === 'percent' ? percent : undefined,
        node: fault?.node ? node.trim() || undefined : undefined,
        env,
        ...(probeUrl.trim() ? { steadyState: { url: probeUrl.trim(), statusCode: code, intervalSeconds: 5 } } : {}),
      }, cluster)
      toast.success(`${created.metadata.name} launched — Litmus is selecting targets`)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      onLaunched(created.metadata.name)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const targetReady = fault?.node || (targetNs && !isProtectedNamespace(targetNs))
  const families = [...new Set(installed.map((f) => f.family))]
  const list = installed.filter((f) => family === 'all' || f.family === family)
  const idx = STEPS.findIndex(([s]) => s === step)

  return (
    <Modal
      open
      onClose={onClose}
      branded
      width="xl"
      title="New chaos experiment"
      description="Break something on purpose, with a way back."
      footer={
        <>
          <Button variant="ghost" onClick={idx === 0 ? onClose : () => setStep(STEPS[idx - 1][0])}>{idx === 0 ? 'Cancel' : 'Back'}</Button>
          {step === 'review' ? (
            <Button variant="danger" disabled={!allowed || busy} onClick={() => void launch()}>{busy ? 'Launching…' : 'Launch experiment'}</Button>
          ) : (
            <Button variant="primary" disabled={step === 'fault' ? !fault : !targetReady} onClick={() => setStep(STEPS[idx + 1][0])}>Next</Button>
          )}
        </>
      }
    >
      <ol className="mb-4 flex items-center gap-2 text-[11px]">
        {STEPS.map(([s, l], i) => (
          <li key={s} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              disabled={i > idx && !(i === 2 && targetReady) && !(i === 1 && fault)}
              onClick={() => setStep(s)}
              className={cn('flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium', i === idx ? 'bg-brand-600 text-white' : i < idx ? 'text-brand-700 dark:text-brand-300' : 'text-content-subtle')}
            >
              <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px]', i === idx ? 'bg-white/20' : 'bg-surface-sunken')}>{i < idx ? '✓' : i + 1}</span>
              <span className="truncate">{l}</span>
            </button>
            {i < STEPS.length - 1 ? <span className="h-px w-4 bg-edge-default sm:w-8" /> : null}
          </li>
        ))}
      </ol>

      {step === 'fault' ? (
        <div className="space-y-3">
          {installed.length === 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              No fault definitions (ChaosExperiments) are installed in the chaos namespace, so nothing can run yet. The litmus package installs them.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {(['all', ...families] as Array<FaultFamily | 'all'>).map((f) => (
              <button key={f} type="button" onClick={() => setFamily(f)} className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-medium', family === f ? 'bg-brand-600 text-white' : 'bg-surface-sunken text-content-muted hover:text-content')}>
                {f === 'all' ? 'All faults' : FAMILY_LABEL[f]}
              </button>
            ))}
          </div>
          <div className="grid max-h-[46vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {list.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => pickFault(f.id)}
                className={cn('rounded-lg border px-3 py-2 text-left transition-colors', f.id === faultId ? 'border-brand-400 bg-brand-50/70 ring-1 ring-brand-400 dark:bg-brand-500/10' : 'border-edge-default hover:bg-surface-sunken')}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-content">{f.label}</span>
                  <span className="text-[10px] text-content-subtle">{FAMILY_LABEL[f.family]}</span>
                  <Badge tone={BLAST_TONE[f.blast]} className="ml-auto">{f.blast}</Badge>
                </div>
                <div className="mt-0.5 text-[11px] text-content-muted">{f.blurb}</div>
              </button>
            ))}
          </div>
          {CHAOS_FAULTS.length > installed.length ? (
            <div className="text-[11px] text-content-subtle">{CHAOS_FAULTS.length - installed.length} catalogued fault{CHAOS_FAULTS.length - installed.length === 1 ? ' is' : 's are'} not installed on this cluster and not offered.</div>
          ) : null}
        </div>
      ) : null}

      {step === 'target' && fault ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-[12px]">
            <span className="font-semibold text-content">{fault.label}</span>
            <Badge tone={BLAST_TONE[fault.blast]}>{fault.blast} blast</Badge>
            <span className="truncate text-content-muted">{fault.blurb}</span>
          </div>
          {fault.node ? (
            <Field label="Node" hint="Empty lets the runner pick one. Name a node to be precise.">
              <Input value={node} onChange={(e) => setNode(e.target.value)} placeholder="production-worker-workers-2" />
            </Field>
          ) : (
            <>
              <Field label="Target namespace" hint="Where the pods being broken live. Platform namespaces cannot be targeted from here.">
                <Select
                  value={targetNs}
                  onChange={(e) => setTargetNs(e.target.value)}
                  options={[
                    { value: '', label: namespaces.isLoading ? 'Loading namespaces…' : 'Choose a namespace…' },
                    ...(namespaces.data ?? []).filter((n) => !isProtectedNamespace(n.name)).map((n) => ({ value: n.name, label: n.name })),
                  ]}
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="App label" hint="One label, e.g. app=checkout. Strongly advised.">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="app=checkout" />
                </Field>
                <Field label="App kind">
                  <Select value={appKind} onChange={(e) => setAppKind(e.target.value as typeof APP_KINDS[number])} options={APP_KINDS.map((k) => ({ value: k, label: k }))} />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="How much of it">
                  <Select value={mode} onChange={(e) => setMode(e.target.value as TargetMode)} options={MODES.map((m) => ({ value: m, label: modeLabel(m, percent) }))} />
                </Field>
                {mode === 'percent' ? (
                  <Field label="Percent of pods"><Input type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} /></Field>
                ) : <div className="hidden sm:block" />}
              </div>
            </>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fault.knobs.map((k) => (
              <Field key={k.env} label={k.label} hint={k.env === 'TOTAL_CHAOS_DURATION' ? `At most ${MAX_FAULT_SECONDS}s.` : k.hint}>
                <Input value={knob(k.env, k.value)} onChange={(e) => setEnv((prev) => ({ ...prev, [k.env]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
            <Field label="Steady-state probe" hint="Polled every 5s through the fault. One failed poll fails the run — that is the hypothesis being tested.">
              <Input value={probeUrl} onChange={(e) => setProbeUrl(e.target.value)} placeholder="http://checkout.payments.svc.cluster.local/health" />
            </Field>
            <Field label="Expect status"><Input value={probeCode} onChange={(e) => setProbeCode(e.target.value)} /></Field>
          </div>
        </div>
      ) : null}

      {step === 'review' && fault ? (
        <div className="space-y-3">
          <Field label="Run name" hint="Names the ChaosEngine. Lowercase letters, digits and dashes.">
            <Input value={runName} onChange={(e) => { setNameTouched(true); setName(e.target.value) }} />
          </Field>
          <div className={cn('rounded-lg border px-3 py-2.5 text-[12.5px]', needsConfirm || blocked.length ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100' : 'border-edge-default bg-surface-sunken text-content')}>
            <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">Blast radius</div>
            <div className="mt-0.5 font-medium">This will: {blastSentence}.</div>
          </div>
          {guards.length ? <ul className="space-y-1.5">{guards.map((g, i) => <GuardRow key={i} g={g} />)}</ul> : (
            <div className="text-[12px] text-emerald-700 dark:text-emerald-400">Bounded, probed and labelled — nothing to confirm.</div>
          )}
          {needsConfirm && !blocked.length ? (
            <Field label="Confirm" hint={`Type ${runName} to confirm.`}>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={runName} aria-label="Type the run name to confirm" />
            </Field>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}

const GUARD_STYLE: Record<Guard['level'], { tone: string; label: string }> = {
  block: { tone: 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200', label: 'Blocked' },
  confirm: { tone: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200', label: 'Confirm' },
  warn: { tone: 'border-edge-default bg-surface-raised text-content-muted', label: 'Note' },
}

export function GuardRow({ g }: { g: Guard }) {
  const s = GUARD_STYLE[g.level]
  return (
    <li className={cn('flex gap-2 rounded-md border px-2.5 py-1.5 text-[12px]', s.tone)}>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide opacity-80">{s.label}</span>
      <span>{g.message}</span>
    </li>
  )
}
