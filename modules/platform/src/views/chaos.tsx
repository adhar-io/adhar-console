import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChaosMeshIcon,
  DataTable,
  EmptyState,
  Field,
  Input,
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
  CHAOS_KINDS,
  injectedCount,
  isLive,
  kindById,
  kindIdOf,
  modeLabel,
  modeNeedsValue,
  phaseOf,
  targetSummary,
  type ChaosExperiment,
  type ChaosKind,
  type ChaosKindId,
  type ChaosPhase,
} from '../data/chaos-kinds.ts'
import { ChaosGameDays } from './chaos-gameday.tsx'
import {
  createChaosExperiment,
  deleteChaosExperiment,
  setChaosPaused,
  useChaosExperiments,
  useChaosSchedules,
  useTargetNamespaces,
} from '../data/chaos.ts'

/**
 * Chaos Engineering — Chaos Mesh, with the blast radius always on screen.
 *
 * A chaos console has one job that no other list view has: it must never let
 * someone be wrong about whether a fault is currently applied to a running
 * system. Three decisions follow from that and are worth stating, because they
 * each cost something:
 *
 *   • "Live" is computed from the injected RECORDS, not from the desired
 *     phase. An experiment that has been asked to stop but is still applied
 *     reads as `recovering`, not `stopped`.
 *   • Stopping is a pause annotation, never a delete. Chaos Mesh unwinds the
 *     fault on the way out; deleting a live experiment can strand it.
 *   • Launching states the blast radius in words — "all pods in payments" —
 *     and high-blast kinds require typing the name to confirm. Slower on
 *     purpose.
 */
type ChaosTab = 'experiments' | 'gamedays'

export function ChaosView({ namespace }: { namespace?: string }) {
  /*
   * "Experiments" is every individual fault on the cluster. "Game days" is
   * the automated side: a catalogue of scenarios composed into one Chaos Mesh
   * workflow. Tabs rather than pages because the second is how you should
   * normally run the first.
   */
  const [tab, setTab] = useState<ChaosTab>('experiments')
  const { experiments, installedKinds, anyInstalled, isLoading, error } = useChaosExperiments(namespace)
  const schedules = useChaosSchedules(namespace)
  const [launching, setLaunching] = useState(false)
  const canManage = useCan('platform.manage')

  if (!isLoading && !anyInstalled) {
    return (
      <EmptyState
        title="Chaos Mesh is not installed"
        description={
          <>
            None of the Chaos Mesh CRDs are registered on this cluster, so there are no experiments to show.
            Chaos Mesh ships with the Adhar platform as an optional application — enable it in the stack and
            this page populates on its own.{' '}
            <a
              className="text-brand-700 underline dark:text-brand-300"
              href="https://chaos-mesh.org/docs/production-installation-using-helm/"
              target="_blank"
              rel="noreferrer"
            >
              Install guide ↗
            </a>
          </>
        }
      />
    )
  }

  const live = experiments.filter(isLive)

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
        {live.length > 0 ? <LiveBanner experiments={live} /> : null}
        <ChaosGameDays namespace={namespace} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {tabs}
      {live.length > 0 ? <LiveBanner experiments={live} /> : null}

      <Summary experiments={experiments} loading={isLoading} scheduleCount={schedules.data?.length ?? 0} />

      {error ? (
        <Card>
          <CardBody className="text-[12px] text-rose-600 dark:text-rose-400">
            Some chaos kinds could not be read: {(error as Error).message}. Experiments of those kinds are
            missing from this list.
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-content">
                <ChaosMeshIcon size={16} /> Experiments
              </div>
              <div className="text-[12px] text-content-muted">
                {installedKinds.length} of {CHAOS_KINDS.length} fault kinds are installed on this cluster.
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
          <ExperimentTable experiments={experiments} loading={isLoading} canManage={canManage} />
        </CardBody>
      </Card>

      <KindCatalog installed={installedKinds} />

      {launching ? (
        <LaunchDialog installed={installedKinds} onClose={() => setLaunching(false)} />
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
function LiveBanner({ experiments }: { experiments: ChaosExperiment[] }) {
  return (
    <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 dark:border-rose-500/40 dark:bg-rose-500/10">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <span className="text-sm font-semibold text-rose-800 dark:text-rose-200">
          {experiments.length} chaos experiment{experiments.length === 1 ? '' : 's'} currently injecting faults
        </span>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {experiments.map((e) => (
          <div key={`${e.metadata.namespace}/${e.metadata.name}`} className="text-[12px] text-rose-700 dark:text-rose-300">
            <span className="font-medium">{e.metadata.name}</span> — {e.spec?.action ?? e.kind} on{' '}
            {targetSummary(e)}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── summary ─────────────────────────── */

function Summary({
  experiments,
  loading,
  scheduleCount,
}: {
  experiments: ChaosExperiment[]
  loading: boolean
  scheduleCount: number
}) {
  const stats = useMemo(() => {
    const live = experiments.filter(isLive).length
    const paused = experiments.filter((e) => phaseOf(e) === 'paused').length
    const finished = experiments.filter((e) => phaseOf(e) === 'finished').length
    return { total: experiments.length, live, paused, finished }
  }, [experiments])

  const tiles: Array<{ label: string; value: ReactNode; hint: string; alarm?: boolean }> = [
    { label: 'Experiments', value: stats.total, hint: 'Chaos objects on the cluster' },
    { label: 'Injecting now', value: stats.live, hint: 'Faults currently applied to targets', alarm: stats.live > 0 },
    { label: 'Paused', value: stats.paused, hint: 'Stopped and fully recovered' },
    { label: 'Scheduled', value: scheduleCount, hint: 'Chaos Mesh Schedules — chaos on a cron' },
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
  paused: 'paused',
  finished: 'healthy',
  unknown: 'unknown',
}

const PHASE_LABEL: Record<ChaosPhase, string> = {
  injected: 'injecting',
  injecting: 'starting',
  recovering: 'recovering',
  paused: 'stopped',
  finished: 'recovered',
  unknown: 'unknown',
}

function ExperimentTable({
  experiments,
  loading,
  canManage,
}: {
  experiments: ChaosExperiment[]
  loading: boolean
  canManage: boolean
}) {
  const columns: Column<ChaosExperiment>[] = [
    {
      key: 'name',
      header: 'Experiment',
      pinned: true,
      cell: (e) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{e.metadata.name}</div>
          <div className="truncate text-[11px] text-content-subtle">{e.metadata.namespace}</div>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Fault',
      value: (e) => `${kindById(kindIdOf(e.kind) ?? 'pod')?.label ?? e.kind} ${e.spec?.action ?? ''}`,
      cell: (e) => {
        const kind = kindById(kindIdOf(e.kind) ?? 'pod')
        return (
          <div className="flex items-center gap-1.5">
            <Badge>{kind?.label ?? e.kind}</Badge>
            {e.spec?.action ? <code className="text-[11px] text-content-muted">{e.spec.action}</code> : null}
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
        const { injected, total } = injectedCount(e)
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge kind={PHASE_KIND[phase]} pulse={isLive(e)}>
              {PHASE_LABEL[phase]}
            </StatusBadge>
            {total > 0 ? (
              <span className="text-[11px] tabular-nums text-content-subtle">
                {injected}/{total}
              </span>
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
      cell: (e) => (
        <span className="text-[12px] text-content-muted">
          {e.spec?.duration ?? <span className="text-amber-700 dark:text-amber-400">until stopped</span>}
        </span>
      ),
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
      cell: (e) => <RowActions experiment={e} />,
    })
  }

  return (
    <DataTable
      columns={columns}
      rows={experiments}
      rowKey={(e) => `${e.kind}/${e.metadata.namespace}/${e.metadata.name}`}
      loading={loading}
      tableId="chaos-experiments"
      features={{ search: true, filters: true, columns: true, density: true, export: true }}
      defaultSort={{ key: 'created', dir: 'desc' }}
      searchPlaceholder="Search experiments…"
      empty={
        <EmptyState
          title="No chaos experiments"
          description="Nothing is being broken on purpose right now. Start with a pod-failure on a non-critical workload — it is the experiment real clusters survive."
        />
      }
    />
  )
}

function RowActions({ experiment }: { experiment: ChaosExperiment }) {
  const toast = useToast()
  const qc = useQueryClient()
  const kindId = kindIdOf(experiment.kind)
  const live = isLive(experiment)
  const phase = phaseOf(experiment)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['chaos'] })

  const pause = useMutation({
    mutationFn: (paused: boolean) =>
      setChaosPaused(kindId!, experiment.metadata.namespace!, experiment.metadata.name, paused),
    onSuccess: (_d, paused) => {
      toast.success(paused ? 'Stopping — Chaos Mesh is recovering the fault' : 'Experiment resumed')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteChaosExperiment(kindId!, experiment.metadata.namespace!, experiment.metadata.name),
    onSuccess: () => {
      toast.success('Experiment deleted')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  if (!kindId) return null

  return (
    <div className="flex justify-end gap-1">
      {/* Resume is offered only for an experiment a person paused. A finished
          one has already recovered and run its course; clearing an annotation
          it never had would do nothing, so offering the button would lie. */}
      {phase === 'paused' ? (
        <Button variant="ghost" size="xs" disabled={pause.isPending} onClick={() => pause.mutate(false)}>
          Resume
        </Button>
      ) : phase === 'finished' ? null : (
        <Button variant="ghost" size="xs" disabled={pause.isPending} onClick={() => pause.mutate(true)}>
          Stop
        </Button>
      )}
      {/* Deleting a live experiment can strand the injected fault with nothing
          left to recover it, so the only route to delete is: stop, then go. */}
      <Button
        variant="ghost"
        size="xs"
        disabled={live || remove.isPending}
        title={live ? 'Stop the experiment first — deleting it now could leave the fault applied' : undefined}
        onClick={() => remove.mutate()}
      >
        Delete
      </Button>
    </div>
  )
}

/* ─────────────────────────── kind catalogue ─────────────────────────── */

const BLAST_TONE: Record<ChaosKind['blast'], string> = {
  low: 'text-emerald-700 dark:text-emerald-400',
  medium: 'text-amber-700 dark:text-amber-400',
  high: 'text-rose-700 dark:text-rose-400',
}

function KindCatalog({ installed }: { installed: ChaosKind[] }) {
  const ids = new Set(installed.map((k) => k.id))
  return (
    <Card>
      <CardHeader>
        <div className="text-sm font-semibold text-content">Fault kinds</div>
        <div className="text-[12px] text-content-muted">
          What Chaos Mesh can break, ordered by how much of a real outage it resembles.
        </div>
      </CardHeader>
      <CardBody className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
        {CHAOS_KINDS.map((kind) => {
          const present = ids.has(kind.id)
          return (
            <div
              key={kind.id}
              className={cn(
                'rounded-lg border border-edge-default px-3 py-2',
                !present && 'opacity-50',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-content">{kind.label}</span>
                <span className={cn('text-[10px] font-medium uppercase', BLAST_TONE[kind.blast])}>
                  {kind.blast}
                </span>
                {!present ? <span className="ml-auto text-[10px] text-content-subtle">not installed</span> : null}
              </div>
              <div className="mt-0.5 text-[11px] text-content-muted">{kind.blurb}</div>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── launch dialog ─────────────────────────── */

const MODES = ['one', 'fixed', 'fixed-percent', 'random-max-percent', 'all'] as const

function LaunchDialog({ installed, onClose }: { installed: ChaosKind[]; onClose(): void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const namespaces = useTargetNamespaces()

  const [kindId, setKindId] = useState<ChaosKindId>(installed[0]?.id ?? 'pod')
  const kind = kindById(kindId)
  const [action, setAction] = useState(kind?.actions[0] ?? '')
  const [name, setName] = useState('')
  const [targetNs, setTargetNs] = useState('')
  const [labels, setLabels] = useState('')
  const [mode, setMode] = useState<typeof MODES[number]>('one')
  const [value, setValue] = useState('1')
  const [duration, setDuration] = useState('60s')
  const [confirm, setConfirm] = useState('')

  const pickKind = (id: ChaosKindId) => {
    setKindId(id)
    setAction(kindById(id)?.actions[0] ?? '')
  }

  const labelSelectors = useMemo(() => {
    const out: Record<string, string> = {}
    for (const pair of labels.split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim())
      if (k && v) out[k] = v
    }
    return out
  }, [labels])

  // High-blast kinds, or anything pointed at every pod, must be typed out.
  const needsConfirm = kind?.blast === 'high' || mode === 'all'
  const confirmed = !needsConfirm || confirm === name

  const create = useMutation({
    mutationFn: () =>
      createChaosExperiment({
        kindId,
        name,
        namespace: targetNs,
        action,
        targetNamespaces: [targetNs],
        labelSelectors,
        mode,
        value: modeNeedsValue(mode) ? value : undefined,
        duration: duration || undefined,
      }),
    onSuccess: (e) => {
      toast.success(`${e.metadata.name} launched — Chaos Mesh is selecting targets`)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const ready = name.trim() && targetNs && action && confirmed &&
    (!modeNeedsValue(mode) || value.trim())

  const blastSentence = targetNs
    ? `${action} on ${modeLabel(mode, value)} in ${targetNs}${
      Object.keys(labelSelectors).length ? ` matching ${Object.entries(labelSelectors).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''
    }${duration ? ` for ${duration}` : ', until you stop it'}`
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
        <Field label="Fault kind">
          <Select
            value={kindId}
            onChange={(e) => pickKind(e.target.value as ChaosKindId)}
            options={installed.map((k) => ({ value: k.id, label: `${k.label} — ${k.blurb}` }))}
          />
        </Field>

        <Field label="Action">
          <Select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            options={(kind?.actions ?? []).map((a) => ({ value: a, label: a }))}
          />
        </Field>

        <Field label="Name" hint="Lowercase, dashes — it names the Kubernetes object.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-pod-failure" />
        </Field>

        <Field label="Target namespace" hint="The experiment is created here and targets pods here.">
          <Select
            value={targetNs}
            onChange={(e) => setTargetNs(e.target.value)}
            options={[
              { value: '', label: namespaces.isLoading ? 'Loading namespaces…' : 'Choose a namespace…' },
              ...(namespaces.data ?? []).map((n) => ({ value: n, label: n })),
            ]}
          />
        </Field>

        <Field label="Label selector" hint="Narrows the target, e.g. app=checkout. Optional but strongly advised.">
          <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="app=checkout" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Mode">
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof MODES[number])}
              options={MODES.map((m) => ({ value: m, label: modeLabel(m, value) }))}
            />
          </Field>
          {modeNeedsValue(mode) ? (
            <Field label={mode === 'fixed' ? 'Pods' : 'Percent'}>
              <Input value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          ) : (
            <Field label="Duration" hint="Go duration. Empty = until stopped.">
              <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="60s" />
            </Field>
          )}
        </div>

        {modeNeedsValue(mode) ? (
          <Field label="Duration" hint="Go duration — 30s, 5m. Empty means it runs until you stop it.">
            <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="60s" />
          </Field>
        ) : null}

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
          {!duration ? (
            <div className="mt-1 text-[11px]">
              With no duration the fault stays applied until someone stops it here.
            </div>
          ) : null}
        </div>

        {needsConfirm ? (
          <Field
            label="Confirm"
            hint={`${kind?.blast === 'high' ? 'High blast radius' : 'Targets every matching pod'} — type the name to confirm.`}
          >
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={name || 'experiment name'} />
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}
