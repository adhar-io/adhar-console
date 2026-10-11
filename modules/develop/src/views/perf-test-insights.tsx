import { type ReactNode, useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  StatusBadge,
  TimeSeriesChart,
  type Threshold as ChartThreshold,
  useCan,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import {
  type PerfInsights,
  useInstallRunner,
  usePinBaseline,
  useRunnerStatus,
  verdictFor,
} from '../data/perf-automation.ts'
import type { PerfTestConfig } from '../data/perf-format.ts'
import { DEFAULT_GATE, DEFAULT_TOLERANCE, hasBudget, type PerfGate, trendPoints } from '../data/perf-gate.ts'
import { fmtMetric, fmtMs, type MetricKey, type RunRecord } from '../data/perf-results.ts'
import {
  ciRoleBinding,
  kargoAnalysisTemplate,
  RUNNER_SA,
  tektonPipelineSnippet,
  tektonTask,
} from '../data/perf-runner.ts'
import type { PerfTest } from '../data/perf-suite.ts'
import { fmtDay, RegressionBadge, Snippet, TriggerBadge, VerdictBadge } from './perf-bits.tsx'

/**
 * The automation half of a test's workbench: how it has trended, what it
 * must achieve, and how to make a pipeline enforce that.
 */

/* ─────────────────────────── trends ─────────────────────────── */

const RANGES: Array<{ id: string; label: string; days?: number }> = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All' },
]

// Theme-aware palette: brand for the headline series, then neutral contrasts.
const C = {
  p95: 'var(--color-brand-500)',
  p99: 'var(--color-amber-500, #f59e0b)',
  avg: 'var(--color-teal-500, #14b8a6)',
  limit: 'var(--color-rose-500, #f43f5e)',
  base: 'var(--color-content-subtle)',
}

export function TrendsPanel({
  name,
  config,
  insights,
  onOpenResults,
}: {
  name: string
  config: PerfTestConfig
  insights: PerfInsights
  onOpenResults?(test: string): void
}) {
  const [range, setRange] = useState('30d')
  const days = RANGES.find((r) => r.id === range)?.days
  const records = useMemo(() => {
    const since = days ? Date.now() - days * 86_400_000 : 0
    return insights.records.filter((r) => r.test === name && Date.parse(r.startedAt ?? '') >= since)
  }, [insights.records, name, days])
  const pin = usePinBaseline()
  const toast = useToast()
  const canManage = useCan('develop')

  const gate = config.gate
  const base = config.baseline
  const series = (key: MetricKey) => trendPoints(records, key)

  const latencyThresholds: ChartThreshold[] = [
    ...(gate?.p95Ms !== undefined ? [{ value: gate.p95Ms, label: `p95 budget ${fmtMs(gate.p95Ms)}`, color: C.limit }] : []),
    ...(base?.metrics.p95Ms !== undefined ? [{ value: base.metrics.p95Ms, label: 'baseline p95', color: C.base }] : []),
  ]
  const errorThresholds: ChartThreshold[] = [
    ...(gate?.errorRatePct !== undefined ? [{ value: gate.errorRatePct, label: `budget ${gate.errorRatePct}%`, color: C.limit }] : []),
    ...(base?.metrics.errorRatePct !== undefined ? [{ value: base.metrics.errorRatePct, label: 'baseline', color: C.base }] : []),
  ]
  const rpsThresholds: ChartThreshold[] = [
    ...(gate?.minRps !== undefined ? [{ value: gate.minRps, label: `minimum ${gate.minRps}/s`, color: C.limit }] : []),
    ...(base?.metrics.rps !== undefined ? [{ value: base.metrics.rps, label: 'baseline', color: C.base }] : []),
  ]

  const verdicts = records.map((r) => verdictFor(r, config))
  const passed = verdicts.filter((v) => v.status === 'pass').length
  const failed = verdicts.filter((v) => v.status === 'fail').length
  const latest = records[0]
  const latestVerdict = latest ? verdictFor(latest, config) : undefined

  if (!insights.records.some((r) => r.test === name)) {
    return (
      <div className="p-6">
        <EmptyState
          compact
          title="No history yet"
          description="Every finished run of this test is kept as a result. Run it, or give it a schedule, and its latency, error rate and throughput are charted here run by run."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                range === r.id ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-content-muted">
          {records.length} run{records.length === 1 ? '' : 's'} · {passed} passed · {failed} failed
        </span>
        <div className="ml-auto flex items-center gap-2">
          {latestVerdict ? <VerdictBadge verdict={latestVerdict} /> : null}
          {onOpenResults ? <Button size="xs" variant="ghost" onClick={() => onOpenResults(name)}>All results</Button> : null}
        </div>
      </div>

      <p className="text-[11px] text-content-subtle">
        One point per kept run, from its end-of-test summary. Red lines are the gate’s budgets, grey ones the baseline.
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartBlock title="Latency" hint="p95, p99 and average." wide>
          <TimeSeriesChart
            height={120}
            series={[
              { name: 'p95', points: series('p95Ms'), color: C.p95 },
              { name: 'p99', points: series('p99Ms'), color: C.p99 },
              { name: 'avg', points: series('avgMs'), color: C.avg },
            ].filter((s) => s.points.length)}
            thresholds={latencyThresholds}
            formatY={fmtMs}
            formatTime={fmtDay}
            emptyLabel="Needs two runs with latency to draw a trend"
          />
        </ChartBlock>
        <ChartBlock title="Error rate" hint="Failed HTTP requests, percent.">
          <TimeSeriesChart
            height={170}
            series={[{ name: 'errors', points: series('errorRatePct'), color: C.p99 }]}
            thresholds={errorThresholds}
            formatY={(v) => `${v.toFixed(v < 10 ? 1 : 0)}%`}
            formatTime={fmtDay}
            emptyLabel="Needs two runs with an error rate"
          />
        </ChartBlock>
        <ChartBlock title="Throughput" hint="Requests per second, all runners combined.">
          <TimeSeriesChart
            height={170}
            series={[{ name: 'req/s', points: series('rps'), color: C.avg }]}
            thresholds={rpsThresholds}
            formatY={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(v < 10 ? 1 : 0))}
            formatTime={fmtDay}
            emptyLabel="Needs two runs with throughput"
          />
        </ChartBlock>
      </div>

      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-content">Recent runs</div>
        <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
          {records.slice(0, 8).map((r) => (
            <RecentRow
              key={r.resultName}
              record={r}
              config={config}
              canPin={canManage && Boolean(r.metrics) && base?.run !== r.run}
              onPin={() =>
                pin.mutate({ record: r }, {
                  onSuccess: () => toast.success(`Pinned ${r.run} as the baseline`, { description: 'Committed to test.json.' }),
                  onError: (e: Error) => toast.error('Could not pin the baseline', { description: e.message }),
                })}
              pinning={pin.isPending}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

function ChartBlock({ title, hint, wide, children }: { title: string; hint: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn('min-w-0', wide && 'lg:col-span-2')}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-content">{title}</span>
        <span className="truncate text-[11px] text-content-subtle">{hint}</span>
      </div>
      {children}
    </div>
  )
}

function RecentRow({
  record: r,
  config,
  canPin,
  onPin,
  pinning,
}: {
  record: RunRecord
  config: PerfTestConfig
  canPin: boolean
  onPin(): void
  pinning: boolean
}) {
  const v = verdictFor(r, config)
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
      <span className="min-w-0 flex-1 truncate font-mono text-content" title={r.run}>{r.run}</span>
      <TriggerBadge trigger={r.trigger} schedule={r.schedule} />
      <span className="w-16 text-right tabular-nums text-content-muted">{fmtMetric('p95Ms', r.metrics?.p95Ms)}</span>
      <span className="w-14 text-right tabular-nums text-content-muted">{fmtMetric('errorRatePct', r.metrics?.errorRatePct)}</span>
      {config.baseline ? <RegressionBadge deltas={v.regressions} isBaseline={config.baseline.run === r.run} /> : null}
      <VerdictBadge verdict={v} compact />
      <span className="w-24 text-right text-content-subtle" title={r.startedAt ? formatAbsolute(r.startedAt) : undefined}>
        {r.startedAt ? formatRelative(r.startedAt) : '—'}
      </span>
      <span className="flex w-24 justify-end">
        {canPin ? <Button size="xs" variant="ghost" disabled={pinning} onClick={onPin}>Pin baseline</Button> : null}
      </span>
    </li>
  )
}

/* ─────────────────────────── gate ─────────────────────────── */

function NumberField({
  label,
  hint,
  unit,
  value,
  onChange,
  readOnly,
}: {
  label: string
  hint?: string
  unit: string
  value: number | undefined
  onChange(v: number | undefined): void
  readOnly: boolean
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={0}
          step="any"
          disabled={readOnly}
          value={value === undefined ? '' : String(value)}
          placeholder="no limit"
          onChange={(e) => {
            const raw = e.target.value
            const n = Number(raw)
            onChange(raw === '' || !Number.isFinite(n) || n < 0 ? undefined : n)
          }}
        />
        <span className="w-8 shrink-0 text-[11px] text-content-subtle">{unit}</span>
      </div>
      {hint ? <p className="text-[11px] text-content-subtle">{hint}</p> : null}
    </Field>
  )
}

/**
 * The gate editor. It edits the workbench's config draft, so the usual
 * Commit button commits it — a budget change is a reviewed, attributed git
 * change like any other.
 */
export function GatePanel({
  name,
  value,
  onChange,
  readOnly,
  insights,
}: {
  name: string
  value: PerfTestConfig
  onChange(c: PerfTestConfig): void
  readOnly: boolean
  insights: PerfInsights
}) {
  const gate: PerfGate = value.gate ?? DEFAULT_GATE
  const set = (patch: Partial<PerfGate>) => onChange({ ...value, gate: { ...gate, ...patch } })
  const setTol = (patch: Partial<PerfGate['tolerance']>) => set({ tolerance: { ...gate.tolerance, ...patch } })
  const pin = usePinBaseline()
  const toast = useToast()
  const base = value.baseline

  // The gate being edited, applied to the latest run — so the effect of a
  // budget change is visible before it is committed.
  const latest = insights.records.find((r) => r.test === name)
  const preview = latest ? verdictFor(latest, value) : undefined

  return (
    <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <div className="text-[12px] font-semibold text-content">Budgets</div>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Absolute limits every run must meet, on top of the thresholds in the script. Empty means no limit. Enforced by
            the console, by schedules and by the CI task alike.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField label="p95 latency" unit="ms" value={gate.p95Ms} readOnly={readOnly} onChange={(v) => set({ p95Ms: v })} />
          <NumberField
            label="p99 latency"
            unit="ms"
            hint="k6 prints p(99) only if the script lists it in summaryTrendStats."
            value={gate.p99Ms}
            readOnly={readOnly}
            onChange={(v) => set({ p99Ms: v })}
          />
          <NumberField label="Average latency" unit="ms" value={gate.avgMs} readOnly={readOnly} onChange={(v) => set({ avgMs: v })} />
          <NumberField label="Error rate" unit="%" value={gate.errorRatePct} readOnly={readOnly} onChange={(v) => set({ errorRatePct: v })} />
          <NumberField label="Minimum throughput" unit="req/s" value={gate.minRps} readOnly={readOnly} onChange={(v) => set({ minRps: v })} />
        </div>
        <Checkbox
          checked={gate.requireThresholds}
          disabled={readOnly}
          onChange={(e) => set({ requireThresholds: e.target.checked })}
          label="The script’s thresholds must pass"
          description="k6 exits 99 when a threshold is crossed. Turn off only for exploratory tests whose thresholds are deliberately aspirational."
        />
        {value.gate && !readOnly
          ? (
            <Button size="xs" variant="ghost" onClick={() => onChange({ ...value, gate: undefined })}>
              Remove the gate (thresholds only)
            </Button>
          )
          : null}
      </div>

      <div className="space-y-4">
        <div className="rounded-lg border border-edge-default p-3">
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-semibold text-content">Baseline</div>
            {base ? <span className="font-mono text-[11px] text-content-muted">{base.run}</span> : null}
            {base && !readOnly
              ? (
                <Button
                  className="ml-auto"
                  size="xs"
                  variant="ghost"
                  disabled={pin.isPending}
                  onClick={() =>
                    pin.mutate({ test: name, unpin: true }, {
                      onSuccess: () => toast.success('Unpinned the baseline'),
                      onError: (e: Error) => toast.error('Could not unpin the baseline', { description: e.message }),
                    })}
                >
                  Unpin
                </Button>
              )
              : null}
          </div>
          {base
            ? (
              <>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                  {(['p95Ms', 'p99Ms', 'avgMs', 'errorRatePct', 'rps'] as MetricKey[]).map((k) => (
                    <div key={k}>
                      <div className="text-[10px] text-content-subtle">{k === 'rps' ? 'throughput' : k.replace('Ms', '').replace('errorRatePct', 'errors')}</div>
                      <div className="font-mono text-content">{fmtMetric(k, base.metrics[k as keyof typeof base.metrics])}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[11px] text-content-subtle">
                  Pinned {base.pinnedAt ? formatRelative(base.pinnedAt) : ''}
                  {base.pinnedBy ? ` by ${base.pinnedBy}` : ''}
                  {base.commit ? ` · script ${base.commit.slice(0, 7)}` : ''}. The numbers are copied into test.json, so the
                  baseline outlives its result.
                </div>
              </>
            )
            : (
              <p className="mt-1 text-[11px] text-content-muted">
                None pinned. Pin a run you trust from Trends or Results; every later run is then compared against it.
              </p>
            )}
        </div>

        <div className="space-y-3">
          <div className="text-[12px] font-semibold text-content">Regression tolerance</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumberField label="Latency" unit="%" hint="Slower by more is a regression." value={gate.tolerance.latencyPct} readOnly={readOnly} onChange={(v) => setTol({ latencyPct: v ?? DEFAULT_TOLERANCE.latencyPct })} />
            <NumberField label="Error rate" unit="pts" hint="Absolute percentage points." value={gate.tolerance.errorRatePts} readOnly={readOnly} onChange={(v) => setTol({ errorRatePts: v ?? DEFAULT_TOLERANCE.errorRatePts })} />
            <NumberField label="Throughput" unit="%" hint="Lower by more is a regression." value={gate.tolerance.throughputPct} readOnly={readOnly} onChange={(v) => setTol({ throughputPct: v ?? DEFAULT_TOLERANCE.throughputPct })} />
          </div>
          <Checkbox
            checked={gate.failOnRegression}
            disabled={readOnly}
            onChange={(e) => set({ failOnRegression: e.target.checked })}
            label="A regression against the baseline fails the gate"
            description="Off: regressions are flagged on every run but do not fail it."
          />
        </div>

        <div className="rounded-lg border border-edge-default p-3">
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-semibold text-content">This gate on the latest run</div>
            {preview ? <VerdictBadge verdict={preview} /> : null}
          </div>
          {preview && latest
            ? (
              <ul className="mt-2 space-y-0.5">
                <li className="text-[11px] text-content-subtle">{latest.run} · {latest.startedAt ? formatRelative(latest.startedAt) : ''}</li>
                {preview.checks.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-2 text-[12px]">
                    <span className={c.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                      {c.passed ? '✓' : '✗'}
                    </span>
                    <span className="text-content">{c.label}</span>
                    <span className="truncate text-content-muted">{c.detail}</span>
                  </li>
                ))}
              </ul>
            )
            : <p className="mt-1 text-[11px] text-content-muted">No run of this test has been kept yet.</p>}
          {!hasBudget(value.gate) && !value.baseline
            ? <p className="mt-2 text-[11px] text-content-subtle">With no budget and no baseline the verdict is the script’s thresholds alone.</p>
            : null}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── CI & promotion ─────────────────────────── */

export function CiPanel({ test, dirty }: { test: PerfTest; dirty: boolean }) {
  const ns = test.config.namespace || 'default'
  const status = useRunnerStatus(test)
  const install = useInstallRunner()
  const toast = useToast()
  const canManage = useCan('develop')
  const [ciSa, setCiSa] = useState('pipeline')
  const [ciNs, setCiNs] = useState('tekton-pipelines')
  const [project, setProject] = useState('')

  const ready = status.data?.artefact && status.data?.serviceAccount

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start gap-3 rounded-lg border border-edge-default p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-content">Runner in {ns}</span>
            {status.isLoading
              ? null
              : ready
              ? <StatusBadge kind="healthy">installed</StatusBadge>
              : <StatusBadge kind="degraded">not installed</StatusBadge>}
          </div>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Every caller below runs <code className="font-mono">run.sh</code> from the <code className="font-mono">k6-{test.name}</code>{' '}
            ConfigMap, under the <code className="font-mono">{RUNNER_SA}</code> Role. It starts the committed test, keeps
            the result, applies the gate from test.json and exits 1 when the gate fails. Installing writes the ServiceAccount,
            Role and RoleBinding, and refreshes the ConfigMap from the latest commit.
          </p>
          {dirty ? <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">Commit first — the runner uses the committed test.</p> : null}
        </div>
        {canManage
          ? (
            <Button
              size="sm"
              disabled={install.isPending || dirty}
              onClick={() =>
                install.mutate(test, {
                  onSuccess: () => toast.success(`Runner ${ready ? 'refreshed' : 'installed'} in ${ns}`),
                  onError: (e: Error) => toast.error('Could not install the runner', { description: e.message }),
                })}
            >
              {install.isPending ? 'Installing…' : ready ? 'Refresh' : 'Install runner'}
            </Button>
          )
          : null}
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-[12px] font-semibold text-content">Tekton — gate a pipeline</div>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Add the Task to the pipeline’s namespace, call it after the deploy step, and the PipelineRun fails when the
            gate does. The verdict is also exposed as the <code className="font-mono">verdict</code> result.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pipeline ServiceAccount">
            <Input value={ciSa} onChange={(e) => setCiSa(e.target.value.trim())} />
          </Field>
          <Field label="Pipeline namespace">
            <Input value={ciNs} onChange={(e) => setCiNs(e.target.value.trim())} />
          </Field>
        </div>
        <Snippet title="Task" hint="kubectl apply -n <pipeline namespace> -f -" code={tektonTask({ test: test.name, namespace: ns })} />
        <Snippet title="Pipeline step" code={tektonPipelineSnippet({ test: test.name, namespace: ns })} />
        <Snippet
          title="RoleBinding"
          hint={`Lets ${ciNs}/${ciSa} drive the runner in ${ns}.`}
          code={ciRoleBinding({ namespace: ns, saName: ciSa || 'pipeline', saNamespace: ciNs || 'default' })}
        />
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-[12px] font-semibold text-content">Kargo — verify a promotion</div>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Kargo verifies a promotion with an Argo Rollouts AnalysisTemplate. This one runs the test as a Job: the
            promotion to the Stage is only verified when the gate passes. Create the <code className="font-mono">{RUNNER_SA}</code>{' '}
            ServiceAccount in the project namespace and bind it with the RoleBinding above (subject = that ServiceAccount).
          </p>
        </div>
        <Field label="Kargo project namespace">
          <Input value={project} onChange={(e) => setProject(e.target.value.trim())} placeholder="my-project" />
        </Field>
        <Snippet
          title="AnalysisTemplate"
          code={kargoAnalysisTemplate({ test: test.name, namespace: ns, project: project || '<project>' })}
        />
      </div>
    </div>
  )
}
