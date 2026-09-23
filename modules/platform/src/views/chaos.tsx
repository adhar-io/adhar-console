import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  Input,
  LitmusIcon,
  Modal,
  Select,
  StatusBadge,
  useCan,
  useToast,
  type Column,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import {
  CHAOS_FAULTS,
  CHAOS_NAMESPACE,
  durationOf,
  FAMILY_LABEL,
  faultById,
  faultOf,
  isLive,
  modeLabel,
  phaseOf,
  resultNameFor,
  targetSummary,
  type ChaosEngine,
  type ChaosFault,
  type ChaosPhase,
  type ChaosResult,
  type TargetMode,
} from '../data/chaos-kinds.ts'
import { ChaosGameDays } from './chaos-gameday.tsx'
import {
  createChaosEngine,
  deleteChaosEngine,
  stopChaosEngine,
  useChaosEngines,
  useChaosResults,
  useInstalledFaults,
  useTargetNamespaces,
} from '../data/chaos.ts'

/**
 * Chaos Engineering — LitmusChaos, with the blast radius always on screen.
 *
 * A chaos console has one job that no other list view has: it must never let
 * someone be wrong about whether a fault is currently applied to a running
 * system. Three decisions follow from that and are worth stating, because they
 * each cost something:
 *
 *   • "Live" is computed from what the RUNNER reports, not from what was
 *     asked for. A run that has been told to stop but whose runner still says
 *     the fault is applied reads as `recovering`, not `stopped`.
 *   • Stopping is `engineState: stop`, never a delete. Litmus unwinds the
 *     fault on the way out; deleting a live engine can strand it.
 *   • Launching states the blast radius in words — "all pods in payments" —
 *     and high-blast faults require typing the name to confirm. Slower on
 *     purpose.
 */
type ChaosTab = 'experiments' | 'gamedays'

export function ChaosView({ namespace }: { namespace?: string }) {
  /*
   * "Experiments" is every individual run on the cluster. "Game days" is the
   * automated side: a catalogue of scenarios composed into one workflow. Tabs
   * rather than pages because the second is how you should normally run the
   * first.
   */
  const [tab, setTab] = useState<ChaosTab>('experiments')
  const { engines, installed, isLoading, error } = useChaosEngines(namespace)
  const faults = useInstalledFaults()
  const results = useChaosResults()
  const [launching, setLaunching] = useState(false)
  const canManage = useCan('platform.manage')

  if (!isLoading && !installed) {
    return (
      <EmptyState
        title="LitmusChaos is not installed"
        description={
          <>
            The Litmus CRDs are not registered on this cluster, so there are no experiments to show. LitmusChaos
            ships with the Adhar platform as the chaos engine (the <code>litmus</code> package) — enable it in the
            stack and this page populates on its own.{' '}
            <a
              className="text-brand-700 underline dark:text-brand-300"
              href="https://docs.litmuschaos.io/docs/getting-started/installation"
              target="_blank"
              rel="noreferrer"
            >
              Litmus docs ↗
            </a>
          </>
        }
      />
    )
  }

  const live = engines.filter(isLive)

  const tabs = (
    <div className="flex gap-1">
      {([['experiments', 'Experiments'], ['gamedays', 'Game days']] as Array<[ChaosTab, string]>).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => setTab(id)}
          className={cn(
            'rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
            tab === id ? 'bg-brand-600 text-white' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )

  if (tab === 'gamedays') {
    return (
      <div className="space-y-4">
        {tabs}
        {live.length > 0 ? <LiveBanner engines={live} /> : null}
        <ChaosGameDays namespace={namespace} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {tabs}
      {live.length > 0 ? <LiveBanner engines={live} /> : null}

      <Summary engines={engines} loading={isLoading} />

      {error ? (
        <Card>
          <CardBody className="text-[12px] text-rose-600 dark:text-rose-400">
            Chaos runs could not be read: {(error as Error).message}.
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-content">
                <LitmusIcon size={16} /> Experiments
              </div>
              <div className="text-[12px] text-content-muted">
                {faults.installed.length} of {CHAOS_FAULTS.length} catalogued faults are installed on this cluster
                {faults.definitions > faults.installed.length ? ` (${faults.definitions} definitions in total)` : ''}.
              </div>
            </div>
            {canManage ? (
              <Button className="ml-auto" onClick={() => setLaunching(true)}>
                New experiment
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardBody className="p-0">
          <ExperimentTable engines={engines} results={results} loading={isLoading} canManage={canManage} />
        </CardBody>
      </Card>

      <FaultCatalog installed={faults.installed} />

      {launching ? (
        <LaunchDialog installed={faults.installed} onClose={() => setLaunching(false)} />
      ) : null}
    </div>
  )
}

/* ─────────────────────────── live banner ─────────────────────────── */

/**
 * The one thing that must be impossible to miss.
 *
 * Someone arriving at this page mid-incident needs to know in the first
 * second whether the thing they are debugging is a fault somebody injected.
 */
function LiveBanner({ engines }: { engines: ChaosEngine[] }) {
  return (
    <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 dark:border-rose-500/40 dark:bg-rose-500/10">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <span className="text-sm font-semibold text-rose-800 dark:text-rose-200">
          {engines.length} chaos experiment{engines.length === 1 ? '' : 's'} currently injecting faults
        </span>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {engines.map((e) => (
          <div key={`${e.metadata.namespace}/${e.metadata.name}`} className="text-[12px] text-rose-700 dark:text-rose-300">
            <span className="font-medium">{e.metadata.name}</span> — {faultOf(e)} on {targetSummary(e)}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── summary ─────────────────────────── */

function Summary({ engines, loading }: { engines: ChaosEngine[]; loading: boolean }) {
  const stats = useMemo(() => {
    const live = engines.filter(isLive).length
    const passed = engines.filter((e) => phaseOf(e) === 'passed').length
    const failed = engines.filter((e) => phaseOf(e) === 'failed').length
    return { total: engines.length, live, passed, failed }
  }, [engines])

  const tiles: Array<{ label: string; value: ReactNode; hint: string; alarm?: boolean }> = [
    { label: 'Runs', value: stats.total, hint: 'ChaosEngines on the cluster' },
    { label: 'Injecting now', value: stats.live, hint: 'Faults currently applied to targets', alarm: stats.live > 0 },
    { label: 'Hypothesis held', value: stats.passed, hint: 'Runs whose verdict was Pass' },
    { label: 'Hypothesis failed', value: stats.failed, hint: 'Runs whose verdict was Fail — the findings', alarm: stats.failed > 0 },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label}>
          <CardBody className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{t.label}</div>
            <div
              className={cn(
                'text-2xl font-semibold tabular-nums',
                t.alarm ? 'text-rose-600 dark:text-rose-400' : 'text-content',
              )}
            >
              {loading ? '—' : t.value}
            </div>
            <div className="text-[11px] text-content-subtle">{t.hint}</div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

/* ─────────────────────────── table ─────────────────────────── */

const PHASE_KIND: Record<ChaosPhase, StatusKind> = {
  injected: 'failed',
  injecting: 'progressing',
  recovering: 'degraded',
  stopped: 'paused',
  passed: 'healthy',
  failed: 'failed',
  unknown: 'unknown',
}

const PHASE_LABEL: Record<ChaosPhase, string> = {
  injected: 'injecting',
  injecting: 'starting',
  recovering: 'recovering',
  stopped: 'stopped',
  passed: 'passed',
  failed: 'failed',
  unknown: 'unknown',
}

function ExperimentTable({
  engines,
  results,
  loading,
  canManage,
}: {
  engines: ChaosEngine[]
  results: Map<string, ChaosResult>
  loading: boolean
  canManage: boolean
}) {
  const resultOf = (e: ChaosEngine) => {
    const n = resultNameFor(e)
    return n ? results.get(n) : undefined
  }

  const columns: Column<ChaosEngine>[] = [
    {
      key: 'name',
      header: 'Run',
      pinned: true,
      cell: (e) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{e.metadata.name}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {e.metadata.labels?.['adhar.io/chaos-gameday'] ? `game day ${e.metadata.labels['adhar.io/chaos-gameday']}` : e.metadata.namespace}
          </div>
        </div>
      ),
    },
    {
      key: 'fault',
      header: 'Fault',
      value: (e) => faultOf(e),
      cell: (e) => {
        const fault = faultById(faultOf(e))
        return (
          <div className="flex items-center gap-1.5">
            <Badge>{fault ? FAMILY_LABEL[fault.family] : 'fault'}</Badge>
            <code className="text-[11px] text-content-muted">{faultOf(e)}</code>
          </div>
        )
      },
    },
    {
      key: 'phase',
      header: 'State',
      value: (e) => PHASE_LABEL[phaseOf(e)],
      cell: (e) => {
        const phase = phaseOf(e)
        const r = resultOf(e)
        const probe = r?.status?.experimentStatus?.probeSuccessPercentage
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge kind={PHASE_KIND[phase]} pulse={isLive(e)}>
              {PHASE_LABEL[phase]}
            </StatusBadge>
            {phase === 'failed' && r?.status?.experimentStatus?.failStep ? (
              <span className="truncate text-[11px] text-rose-700 dark:text-rose-400" title={r.status.experimentStatus.failStep}>
                {r.status.experimentStatus.failStep}
              </span>
            ) : probe && probe !== '' ? (
              <span className="text-[11px] tabular-nums text-content-subtle">probes {probe}%</span>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'target',
      header: 'Blast radius',
      // The whole point of the page — never truncated away behind a tooltip.
      cell: (e) => <span className="text-[12px] text-content-muted">{targetSummary(e)}</span>,
    },
    {
      key: 'duration',
      header: 'Duration',
      value: (e) => durationOf(e) ?? 0,
      cell: (e) => {
        const d = durationOf(e)
        return <span className="text-[12px] text-content-muted">{d !== undefined ? `${d}s` : '—'}</span>
      },
    },
    {
      key: 'created',
      header: 'Started',
      value: (e) => e.metadata.creationTimestamp ?? '',
      cell: (e) =>
        e.metadata.creationTimestamp ? (
          <span title={formatAbsolute(e.metadata.creationTimestamp)} className="text-[12px] text-content-muted">
            {formatRelative(e.metadata.creationTimestamp)}
          </span>
        ) : (
          <span className="text-content-subtle">—</span>
        ),
    },
  ]

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      cell: (e) => <RowActions engine={e} />,
    })
  }

  return (
    <DataTable
      columns={columns}
      rows={engines}
      rowKey={(e) => `${e.metadata.namespace}/${e.metadata.name}`}
      loading={loading}
      tableId="chaos-experiments"
      features={{ search: true, filters: true, columns: true, density: true, export: true }}
      defaultSort={{ key: 'created', dir: 'desc' }}
      searchPlaceholder="Search runs…"
      empty={
        <EmptyState
          title="No chaos experiments"
          description="Nothing is being broken on purpose right now. Start with pod-delete on a non-critical workload — it is the experiment real clusters survive."
        />
      }
    />
  )
}

function RowActions({ engine }: { engine: ChaosEngine }) {
  const toast = useToast()
  const qc = useQueryClient()
  const live = isLive(engine)
  const phase = phaseOf(engine)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['chaos'] })

  const stop = useMutation({
    mutationFn: () => stopChaosEngine(engine.metadata.namespace ?? CHAOS_NAMESPACE, engine.metadata.name),
    onSuccess: () => {
      toast.success('Stopping — Litmus is recovering the fault')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteChaosEngine(engine),
    onSuccess: () => {
      toast.success('Run deleted')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const over = phase === 'passed' || phase === 'failed' || phase === 'stopped'

  return (
    <div className="flex justify-end gap-1">
      {/* A finished run has already recovered; there is nothing to stop and
          no resume — running the fault again is a new run with its own
          verdict, which is what the launcher is for. */}
      {!over ? (
        <Button variant="ghost" size="xs" disabled={stop.isPending || phase === 'recovering'} onClick={() => stop.mutate()}>
          Stop
        </Button>
      ) : null}
      {/* Deleting a live run can strand the injected fault with nothing left
          to recover it, so the only route to delete is: stop, then go. */}
      <Button
        variant="ghost"
        size="xs"
        disabled={live || remove.isPending}
        title={live ? 'Stop the run first — deleting it now could leave the fault applied' : undefined}
        onClick={() => remove.mutate()}
      >
        Delete
      </Button>
    </div>
  )
}

/* ─────────────────────────── fault catalogue ─────────────────────────── */

const BLAST_TONE: Record<ChaosFault['blast'], string> = {
  low: 'text-emerald-700 dark:text-emerald-400',
  medium: 'text-amber-700 dark:text-amber-400',
  high: 'text-rose-700 dark:text-rose-400',
}

function FaultCatalog({ installed }: { installed: ChaosFault[] }) {
  const ids = new Set(installed.map((k) => k.id))
  return (
    <Card>
      <CardHeader>
        <div className="text-sm font-semibold text-content">Faults</div>
        <div className="text-[12px] text-content-muted">
          What Litmus can break, ordered by how much of a real outage it resembles.
        </div>
      </CardHeader>
      <CardBody className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
        {CHAOS_FAULTS.map((fault) => {
          const present = ids.has(fault.id)
          return (
            <div
              key={fault.id}
              className={cn(
                'rounded-lg border border-edge-default px-3 py-2',
                !present && 'opacity-50',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-content">{fault.label}</span>
                <span className="text-[10px] text-content-subtle">{FAMILY_LABEL[fault.family]}</span>
                <span className={cn('text-[10px] font-medium uppercase', BLAST_TONE[fault.blast])}>
                  {fault.blast}
                </span>
                {!present ? <span className="ml-auto text-[10px] text-content-subtle">not installed</span> : null}
              </div>
              <div className="mt-0.5 text-[11px] text-content-muted">{fault.blurb}</div>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── launch dialog ─────────────────────────── */

const MODES: TargetMode[] = ['one', 'percent', 'all']
const APP_KINDS = ['deployment', 'statefulset', 'daemonset', 'rollout'] as const

function LaunchDialog({ installed, onClose }: { installed: ChaosFault[]; onClose(): void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const namespaces = useTargetNamespaces()

  const [faultId, setFaultId] = useState<string>(installed[0]?.id ?? 'pod-delete')
  const fault = faultById(faultId)
  const [name, setName] = useState('')
  const [targetNs, setTargetNs] = useState('')
  const [label, setLabel] = useState('')
  const [appKind, setAppKind] = useState<typeof APP_KINDS[number]>('deployment')
  const [node, setNode] = useState('')
  const [mode, setMode] = useState<TargetMode>('one')
  const [percent, setPercent] = useState('50')
  const [env, setEnv] = useState<Record<string, string>>({})
  const [probeUrl, setProbeUrl] = useState('')
  const [confirm, setConfirm] = useState('')

  const pickFault = (id: string) => {
    setFaultId(id)
    setEnv({})
  }

  const knob = (key: string, fallback: string) => env[key] ?? fallback
  const duration = knob('TOTAL_CHAOS_DURATION', fault?.knobs.find((k) => k.env === 'TOTAL_CHAOS_DURATION')?.value ?? '60')

  // High-blast faults, or anything pointed at every pod, must be typed out.
  const needsConfirm = fault?.blast === 'high' || mode === 'all'
  const confirmed = !needsConfirm || confirm === name

  const create = useMutation({
    mutationFn: () =>
      createChaosEngine({
        fault: faultId,
        name,
        targetNamespace: targetNs,
        label: label.trim() || undefined,
        appKind,
        mode,
        percent: mode === 'percent' ? percent : undefined,
        node: fault?.node ? node.trim() || undefined : undefined,
        env,
        ...(probeUrl.trim() ? { steadyState: { url: probeUrl.trim(), statusCode: 200, intervalSeconds: 5 } } : {}),
      }),
    onSuccess: (e) => {
      toast.success(`${e.metadata.name} launched — Litmus is selecting targets`)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const ready = name.trim() && (fault?.node || targetNs) && confirmed && (mode !== 'percent' || percent.trim())

  const blastSentence = fault?.node
    ? `${faultId} on ${node.trim() ? `node ${node.trim()}` : 'a node the runner picks'} for ${duration}s`
    : targetNs
    ? `${faultId} on ${modeLabel(mode, percent)} in ${targetNs}${label.trim() ? ` matching ${label.trim()}` : ''} for ${duration}s`
    : 'Choose a target namespace.'

  return (
    <Modal
      open
      onClose={onClose}
      branded
      width="lg"
      title="New chaos experiment"
      description="Break something on purpose, with a way back."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Launching…' : 'Launch experiment'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Fault">
          <Select
            value={faultId}
            onChange={(e) => pickFault(e.target.value)}
            options={installed.map((k) => ({ value: k.id, label: `${FAMILY_LABEL[k.family]} · ${k.label} — ${k.blurb}` }))}
          />
        </Field>

        <Field label="Name" hint="Lowercase, dashes — it names the ChaosEngine.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-pod-delete" />
        </Field>

        {fault?.node ? (
          <Field label="Node" hint="Empty lets the runner pick one. Name a node to be precise.">
            <Input value={node} onChange={(e) => setNode(e.target.value)} placeholder="production-worker-workers-2" />
          </Field>
        ) : (
          <>
            <Field label="Target namespace" hint="Where the pods being broken live.">
              <Select
                value={targetNs}
                onChange={(e) => setTargetNs(e.target.value)}
                options={[
                  { value: '', label: namespaces.isLoading ? 'Loading namespaces…' : 'Choose a namespace…' },
                  ...(namespaces.data ?? []).map((n) => ({ value: n, label: n })),
                ]}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="App label" hint="One label, e.g. app=checkout. Optional but strongly advised.">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="app=checkout" />
              </Field>
              <Field label="App kind">
                <Select
                  value={appKind}
                  onChange={(e) => setAppKind(e.target.value as typeof APP_KINDS[number])}
                  options={APP_KINDS.map((k) => ({ value: k, label: k }))}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode">
                <Select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as TargetMode)}
                  options={MODES.map((m) => ({ value: m, label: modeLabel(m, percent) }))}
                />
              </Field>
              {mode === 'percent' ? (
                <Field label="Percent">
                  <Input value={percent} onChange={(e) => setPercent(e.target.value)} />
                </Field>
              ) : (
                <div />
              )}
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          {(fault?.knobs ?? []).map((k) => (
            <Field key={k.env} label={k.label} hint={k.hint}>
              <Input value={knob(k.env, k.value)} onChange={(e) => setEnv((prev) => ({ ...prev, [k.env]: e.target.value }))} />
            </Field>
          ))}
        </div>

        <Field
          label="Steady-state probe"
          hint="Polled every 5s through the fault. One failed poll fails the run — that is the hypothesis being tested."
        >
          <Input
            value={probeUrl}
            onChange={(e) => setProbeUrl(e.target.value)}
            placeholder="http://checkout.payments.svc.cluster.local/health"
          />
        </Field>

        {/* The blast radius, in a sentence, before anyone presses the button. */}
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-[12px]',
            needsConfirm
              ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200'
              : 'border-edge-default bg-surface-sunken text-content-muted',
          )}
        >
          <span className="font-medium">This will: </span>
          {blastSentence}
          {!probeUrl.trim() ? (
            <div className="mt-1 text-[11px]">
              With no probe the verdict only says whether the fault ran, not whether the system survived it.
            </div>
          ) : null}
        </div>

        {needsConfirm ? (
          <Field
            label="Confirm"
            hint={`${fault?.blast === 'high' ? 'High blast radius' : 'Targets every matching pod'} — type the name to confirm.`}
          >
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={name || 'experiment name'} />
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}
