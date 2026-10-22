import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  useCan,
  useOverlayDismiss,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { CodeEditor } from '../components/code-editor.tsx'
import { useTestRuns, type TestRun } from '../data/k6.ts'
import {
  DEFAULT_CONFIG,
  LABEL_TEST,
  normaliseName,
  type PerfTestConfig,
  STARTERS,
  type Threshold,
} from '../data/perf-format.ts'
import { usePublicGiteaUrl } from '../data/git.ts'
import { filesUrlOf, newTestProblem, PERF_DIR, perfTestDir, perfTestName, type PerfTestLocation } from '../data/perf-location.ts'
import {
  canAuthorPerf,
  findTest,
  type PerfSuite as Suite,
  type PerfTest,
  useCreatePerfTest,
  useDeletePerfTest,
  usePerfSuite,
  usePerfTest,
  usePerfTestHistory,
  useRunPerfTest,
  useSavePerfTest,
} from '../data/perf-suite.ts'
import { materialiseArtefact, usePerfInsights } from '../data/perf-automation.ts'
import { runPerfTestChecks, saveScheduleChecks } from '../data/access.ts'
import { CiPanel, GatePanel, TrendsPanel } from './perf-test-insights.tsx'

/**
 * The performance test workbench — write the test, configure it, run it.
 *
 * Everything here is backed by the application repositories rather than by
 * cluster objects, because a load test is code: it wants review, history and
 * a diff, next to the code it measures. Each app keeps its tests in `perf/`
 * (a template ships one); the console reads them from there, commits edits
 * back to the app's default branch, then runs the committed version, so a
 * result can always be traced to the exact script that produced it.
 */
export function PerfSuite({
  onOpenRun,
  onOpenResults,
  onSchedule,
  selected: selectedProp,
  onSelect,
  createToken,
}: {
  onOpenRun?(namespace: string, name: string): void
  onOpenResults?(test: string): void
  onSchedule?(test: string): void
  /** Controlled selection — the Performance page keeps it in `?suite=`. */
  selected?: string
  onSelect?(test: string): void
  /** Bumping this opens the "New test" dialog (the page header's button). */
  createToken?: number
}) {
  const suiteQ = usePerfSuite()
  const suite = suiteQ.data
  const runsQ = useTestRuns()
  const [selectedState, setSelectedState] = useState<string | null>(selectedProp ?? null)
  const selected = selectedProp ?? selectedState
  const setSelected = (t: string | null) => {
    setSelectedState(t)
    if (t && t !== selectedProp) onSelect?.(t)
  }
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    if (createToken) setCreating(true)
  }, [createToken])
  // Authoring is a commit to the app repository — Gitea's push permission decides.
  const canEdit = canAuthorPerf(suite)

  const locations = useMemo(() => suite?.tests ?? [], [suite])
  const tests = useMemo(() => locations.map((t) => t.name), [locations])

  // The newest run per test, by the label the console stamps on every run it
  // creates. The list used to be bare names: which of a dozen tests last
  // failed, and which had never run at all, were invisible until you clicked
  // through them one at a time.
  const lastRun = useMemo(() => {
    const out = new Map<string, TestRun>()
    for (const r of runsQ.data ?? []) {
      const name = r.metadata.labels?.[LABEL_TEST]
      if (!name) continue
      const prev = out.get(name)
      if (!prev || (r.metadata.creationTimestamp ?? '') > (prev.metadata.creationTimestamp ?? '')) out.set(name, r)
    }
    return out
  }, [runsQ.data])
  useEffect(() => {
    if (!selected && tests.length) setSelected(tests[0])
    if (selected && tests.length && !tests.includes(selected)) setSelected(tests[0] ?? null)
  }, [tests, selected])

  if (suiteQ.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (suiteQ.isError) {
    return (
      <EmptyState
        title="Gitea is not reachable"
        description={`Performance tests live in the application repositories in Gitea, and the console could not reach Gitea: ${
          (suiteQ.error as Error).message
        }`}
      />
    )
  }
  if (!suite) return null
  if (!suite.apps.length) {
    return (
      <Card>
        <CardBody className="py-10">
          <EmptyState
            title="No application repositories yet"
            description={`A performance test lives in its application's repository, under ${PERF_DIR}/. Create an application from a template — every template ships its service with a load test — and it shows up here.`}
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_1fr]">
      <TestList
        suite={suite}
        tests={locations}
        selected={selected}
        onSelect={setSelected}
        onNew={() => setCreating(true)}
        canEdit={canEdit}
        lastRun={lastRun}
        onOpenRun={onOpenRun}
      />
      {selected
        ? (
          <TestWorkbench
            suite={suite}
            name={selected}
            canEdit={canAuthorPerf(suite, selected)}
            onOpenRun={onOpenRun}
            onOpenResults={onOpenResults}
            onSchedule={onSchedule}
          />
        )
        : (
          <Card>
            <CardBody className="py-12">
              <EmptyState
                title="No tests yet"
                description={`None of the ${suite.apps.length} application repositor${suite.apps.length === 1 ? 'y has' : 'ies have'} a ${PERF_DIR}/ folder. A performance test is a k6 script plus its configuration, committed next to the code it measures. Start from a template — every one of them declares thresholds, so the run produces a verdict rather than just a number.`}
                action={canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>New test</Button> : undefined}
              />
            </CardBody>
          </Card>
        )}
      {creating
        ? <NewTestDialog suite={suite} onClose={() => setCreating(false)} onCreated={setSelected} />
        : null}
    </div>
  )
}

/* ─────────────────────────── list ─────────────────────────── */

function TestList({
  suite,
  tests,
  selected,
  onSelect,
  onNew,
  canEdit,
  lastRun,
  onOpenRun,
}: {
  suite: Suite
  tests: PerfTestLocation[]
  selected: string | null
  onSelect(name: string): void
  onNew(): void
  canEdit: boolean
  /** Newest run per test, so the list can say what happened last. */
  lastRun: Map<string, TestRun>
  onOpenRun?(namespace: string, name: string): void
}) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = needle ? tests.filter((t) => `${t.name} ${t.repo}`.toLowerCase().includes(needle)) : tests
  const repos = new Set(tests.map((t) => t.repo)).size
  return (
    <Card className="flex max-h-[720px] flex-col overflow-hidden">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-content">Tests</div>
            <div className="truncate text-[11px] text-content-subtle">
              {PERF_DIR}/ in {repos} of {suite.apps.length} application repo{suite.apps.length === 1 ? '' : 's'}
            </div>
          </div>
          {canEdit ? <Button size="xs" onClick={onNew}>New</Button> : null}
        </div>
        {tests.length > 5 ? (
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a test…"
            aria-label="Find a test"
            className="mt-2 h-8 w-full rounded-lg border border-edge-default bg-surface-app px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        ) : null}
      </CardHeader>
      <CardBody className="min-h-0 flex-1 overflow-y-auto p-0">
        {suite.unreadable.length
          ? (
            <div className="border-b border-edge-subtle px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              Could not read {PERF_DIR}/ in {suite.unreadable.join(', ')} — their tests are not listed.
            </div>
          )
          : null}
        {tests.length === 0
          ? <div className="px-4 py-6 text-[12px] text-content-muted">No tests committed yet.</div>
          : shown.length === 0
          ? <div className="px-4 py-6 text-[12px] text-content-muted">No test matches “{q}”.</div>
          : (
            <ul>
              {shown.map((loc) => {
                const t = loc.name
                const run = lastRun.get(t)
                const stage = run?.status?.stage ?? (run ? 'initialization' : undefined)
                return (
                  <li key={t}>
                    <button
                      type="button"
                      onClick={() => onSelect(t)}
                      className={cn(
                        'block w-full px-3 py-2 text-left transition-colors hover:bg-surface-sunken',
                        selected === t && 'bg-surface-sunken',
                      )}
                    >
                      <span className="block truncate font-mono text-[12px] text-content">{t}</span>
                      <span className="block truncate font-mono text-[10px] text-content-subtle">{loc.repo}/{loc.dir}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-content-subtle">
                        {run
                          ? (
                            <>
                              <span
                                className={cn(
                                  'h-1.5 w-1.5 shrink-0 rounded-full',
                                  stage === 'finished'
                                    ? 'bg-emerald-500'
                                    : stage === 'error'
                                    ? 'bg-rose-500'
                                    : stage === 'stopped'
                                    ? 'bg-amber-500'
                                    : 'animate-pulse bg-brand-500',
                                )}
                              />
                              <span className="truncate">
                                {stage} · {formatRelative(run.metadata.creationTimestamp ?? '')}
                              </span>
                              {onOpenRun
                                ? (
                                  <span
                                    role="link"
                                    tabIndex={0}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onOpenRun(run.metadata.namespace ?? '', run.metadata.name)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key !== 'Enter') return
                                      e.stopPropagation()
                                      onOpenRun(run.metadata.namespace ?? '', run.metadata.name)
                                    }}
                                    className="ml-auto shrink-0 font-medium text-brand-700 hover:underline dark:text-brand-300"
                                  >
                                    open
                                  </span>
                                )
                                : null}
                            </>
                          )
                          : <span className="italic">never run</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── workbench ─────────────────────────── */

type Tab = 'script' | 'config' | 'gate' | 'trends' | 'ci' | 'history'

const TAB_LABEL: Record<Tab, string> = {
  script: 'Script',
  config: 'Config',
  gate: 'Gate',
  trends: 'Trends',
  ci: 'CI & promotion',
  history: 'History',
}

function TestWorkbench({
  suite,
  name,
  canEdit,
  onOpenRun,
  onOpenResults,
  onSchedule,
}: {
  suite: Suite
  name: string
  canEdit: boolean
  onOpenRun?(namespace: string, runName: string): void
  onOpenResults?(test: string): void
  onSchedule?(test: string): void
}) {
  const insights = usePerfInsights()
  const q = usePerfTest(suite, name)
  const save = useSavePerfTest(suite)
  const run = useRunPerfTest()
  const remove = useDeletePerfTest(suite)
  const toast = useToast()
  const publicUrl = usePublicGiteaUrl()
  const [tab, setTab] = useState<Tab>('script')
  // Deleting commits a removal to the app repo — the second click confirms.
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Local drafts, so an edit survives a background refetch and the Save
  // button can say whether anything actually changed.
  const [script, setScript] = useState<string | null>(null)
  const [config, setConfig] = useState<PerfTestConfig | null>(null)

  useEffect(() => {
    setScript(null)
    setConfig(null)
    setConfirmDelete(false)
  }, [name])

  const test = q.data
  const where = findTest(suite, name)
  const filesUrl = where ? publicUrl(filesUrlOf(where)) : undefined
  const liveScript = script ?? test?.script ?? ''
  const liveConfig = config ?? test?.config ?? DEFAULT_CONFIG
  const dirty = (script !== null && script !== test?.script) ||
    (config !== null && JSON.stringify(config) !== JSON.stringify(test?.config))
  // Cluster writes, asked in the test's namespace (docs/rbac.md): a run applies
  // the artefact ConfigMap and a TestRun; a schedule also installs the runner.
  const runNs = test?.config.namespace || 'default'
  const canRun = useCan(runPerfTestChecks(runNs), { enabled: !!test })
  const canSchedule = useCan(saveScheduleChecks(runNs), { enabled: !!test })

  if (q.isLoading) return <Card><CardBody className="flex justify-center py-16"><Spinner /></CardBody></Card>
  if (!test) {
    return <Card><CardBody className="py-10"><EmptyState title="Could not read that test" /></CardBody></Card>
  }

  const doSave = async () => {
    try {
      const res = await save.mutateAsync({
        name,
        script: script !== null ? script : undefined,
        config: config !== null ? config : undefined,
        scriptSha: test.scriptSha,
        configSha: test.configSha,
      })
      setScript(null)
      setConfig(null)
      toast.success('Committed', { description: res.commit ? `commit ${res.commit.slice(0, 7)}` : undefined })
      // Keep the cluster copy that schedules and CI run in step with git, so
      // a budget committed here is the budget the next scheduled run enforces.
      // Best effort: the namespace may not exist until the first run.
      materialiseArtefact({ name, config: liveConfig, script: liveScript, location: res.location }, res.commit).catch(() => undefined)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const doDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      await remove.mutateAsync(name)
      toast.success(`Removed ${name}`, { description: where ? `from ${where.repo}/${where.dir}` : undefined })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setConfirmDelete(false)
    }
  }

  const doRun = async () => {
    // Running an unsaved edit would produce a result that no commit explains,
    // which is the exact problem this suite exists to prevent.
    if (dirty) {
      toast.warning('Commit first', { description: 'A run is labelled with the commit it came from, so the script has to be saved before it can run.' })
      return
    }
    try {
      const created = await run.mutateAsync({ test, commit: latestCommit(test) })
      toast.success(`Started ${created.metadata.name}`)
      onOpenRun?.(created.metadata.namespace ?? liveConfig.namespace, created.metadata.name)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-content">{liveConfig.title || name}</span>
              {dirty ? <Badge>unsaved</Badge> : null}
            </div>
            {where
              ? (
                <a
                  href={filesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-mono text-[11px] text-brand-700 hover:underline dark:text-brand-300"
                >
                  {where.org}/{where.repo} · {where.dir}/ @ {where.branch} ↗
                </a>
              )
              : null}
            <div className="truncate text-[11px] text-content-subtle">
              {liveConfig.namespace} · {liveConfig.parallelism} runner{liveConfig.parallelism === 1 ? '' : 's'}
              {liveConfig.tags.length ? ` · ${liveConfig.tags.join(', ')}` : ''}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {canEdit
              ? (
                <Button variant="ghost" size="sm" loading={remove.isPending} onClick={doDelete} className={confirmDelete ? 'text-rose-700 dark:text-rose-300' : undefined}>
                  {confirmDelete ? 'Confirm delete' : 'Delete'}
                </Button>
              )
              : null}
            {onSchedule && canSchedule
              ? <Button variant="ghost" size="sm" onClick={() => onSchedule(name)}>Schedule</Button>
              : null}
            {canEdit
              ? (
                <Button variant="secondary" size="sm" disabled={!dirty} loading={save.isPending} onClick={doSave}>
                  Commit
                </Button>
              )
              : null}
            {canRun
              ? (
                <Button variant="primary" size="sm" loading={run.isPending} onClick={doRun}>
                  Run test
                </Button>
              )
              : null}
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                tab === t ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content',
              )}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardBody className="p-0">
        {tab === 'script'
          ? (
            <CodeEditor
              value={liveScript}
              language="javascript"
              readOnly={!canEdit}
              onChange={setScript}
              onSave={canEdit ? doSave : undefined}
              filename={where ? `${where.dir}/load.js` : `${name}.js`}
              height={520}
              wordWrap
            />
          )
          : tab === 'config'
          ? <ConfigForm value={liveConfig} onChange={setConfig} readOnly={!canEdit} />
          : tab === 'gate'
          ? <GatePanel name={name} value={liveConfig} onChange={setConfig} readOnly={!canEdit} insights={insights} />
          : tab === 'trends'
          ? <TrendsPanel name={name} config={test.config} insights={insights} onOpenResults={onOpenResults} />
          : tab === 'ci'
          ? <CiPanel test={test} dirty={dirty} />
          : <History suite={suite} name={name} />}
      </CardBody>
    </Card>
  )
}

/** Newest app commit that touched this test's files, for the run label. */
function latestCommit(test: PerfTest): string | undefined {
  return test.commit
}

/* ─────────────────────────── config form ─────────────────────────── */

function ConfigForm({
  value,
  onChange,
  readOnly,
}: {
  value: PerfTestConfig
  onChange(c: PerfTestConfig): void
  readOnly: boolean
}) {
  const set = <K extends keyof PerfTestConfig>(k: K, v: PerfTestConfig[K]) => onChange({ ...value, [k]: v })

  return (
    <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
      <div className="space-y-3">
        <Field label="Title">
          <Input value={value.title} disabled={readOnly} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea
            rows={2}
            value={value.description}
            disabled={readOnly}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <Field label="Namespace" hint="Where the TestRun and its generated ConfigMap are created.">
          <Input value={value.namespace} disabled={readOnly} onChange={(e) => set('namespace', e.target.value)} />
        </Field>
        <Field label="Parallelism" hint="Runner pods the load is split across.">
          <Input
            type="number"
            min={1}
            max={100}
            disabled={readOnly}
            value={String(value.parallelism)}
            onChange={(e) => set('parallelism', Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
        <Field label="Arguments" hint="Passed to k6, e.g. --vus 50 --duration 30s. The script's own options win.">
          <Input value={value.arguments} disabled={readOnly} onChange={(e) => set('arguments', e.target.value)} />
        </Field>
        <Field label="Tags" hint="Comma separated.">
          <Input
            value={value.tags.join(', ')}
            disabled={readOnly}
            onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
          />
        </Field>
      </div>

      <div className="space-y-3">
        <KeyValues
          label="Environment"
          hint="Reaches the script as __ENV.NAME. Never put secrets here — this file is committed."
          value={value.env}
          readOnly={readOnly}
          onChange={(env) => set('env', env)}
        />

        <div className="rounded-lg border border-edge-default p-3">
          <div className="text-[12px] font-semibold text-content">System under test</div>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Which pods this test drives. Without it the report can still chart the load generators and the
            infrastructure, but not the thing you are actually measuring — and it will not guess.
          </p>
          <div className="mt-2 space-y-2">
            <Field label="Namespace">
              <Input
                value={value.target?.namespace ?? ''}
                disabled={readOnly}
                placeholder="payments"
                onChange={(e) => set('target', { ...value.target, namespace: e.target.value || undefined })}
              />
            </Field>
            <Field label="Label selector" hint="e.g. app=checkout">
              <Input
                value={value.target?.selector ?? ''}
                disabled={readOnly}
                placeholder="app=checkout"
                onChange={(e) => set('target', { ...value.target, selector: e.target.value || undefined })}
              />
            </Field>
          </div>
        </div>

        <ThresholdList
          value={value.thresholds}
          readOnly={readOnly}
          onChange={(thresholds) => set('thresholds', thresholds)}
        />
      </div>
    </div>
  )
}

function KeyValues({
  label,
  hint,
  value,
  readOnly,
  onChange,
}: {
  label: string
  hint: string
  value: Record<string, string>
  readOnly: boolean
  onChange(v: Record<string, string>): void
}) {
  const entries = Object.entries(value)
  const setKey = (old: string, next: string) => {
    const out: Record<string, string> = {}
    for (const [k, v] of entries) out[k === old ? next : k] = v
    onChange(out)
  }
  return (
    <div className="rounded-lg border border-edge-default p-3">
      <div className="text-[12px] font-semibold text-content">{label}</div>
      <p className="mt-0.5 text-[11px] text-content-muted">{hint}</p>
      <div className="mt-2 space-y-1.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5">
            <Input
              className="flex-1"
              value={k}
              disabled={readOnly}
              onChange={(e) => setKey(k, e.target.value)}
            />
            <Input
              className="flex-1"
              value={v}
              disabled={readOnly}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            />
            {!readOnly
              ? (
                <button
                  type="button"
                  aria-label={`Remove ${k}`}
                  onClick={() => {
                    const { [k]: _drop, ...rest } = value
                    onChange(rest)
                  }}
                  className="rounded px-1.5 text-content-subtle hover:text-content"
                >
                  ✕
                </button>
              )
              : null}
          </div>
        ))}
        {!readOnly
          ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onChange({ ...value, [`VAR_${entries.length + 1}`]: '' })}
            >
              Add variable
            </Button>
          )
          : null}
      </div>
    </div>
  )
}

function ThresholdList({
  value,
  readOnly,
  onChange,
}: {
  value: Threshold[]
  readOnly: boolean
  onChange(v: Threshold[]): void
}) {
  return (
    <div className="rounded-lg border border-edge-default p-3">
      <div className="text-[12px] font-semibold text-content">Thresholds</div>
      <p className="mt-0.5 text-[11px] text-content-muted">
        Recorded here for the report. k6 enforces what is declared in the SCRIPT — anything listed here that the
        script does not declare is a note, not a gate.
      </p>
      <div className="mt-2 space-y-1.5">
        {value.map((t, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              className="flex-1"
              value={t.metric}
              disabled={readOnly}
              placeholder="http_req_duration"
              onChange={(e) => onChange(value.map((x, j) => j === i ? { ...x, metric: e.target.value } : x))}
            />
            <Input
              className="flex-1"
              value={t.expression}
              disabled={readOnly}
              placeholder="p(95)<500"
              onChange={(e) => onChange(value.map((x, j) => j === i ? { ...x, expression: e.target.value } : x))}
            />
            {!readOnly
              ? (
                <button
                  type="button"
                  aria-label="Remove threshold"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  className="rounded px-1.5 text-content-subtle hover:text-content"
                >
                  ✕
                </button>
              )
              : null}
          </div>
        ))}
        {!readOnly
          ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onChange([...value, { metric: '', expression: '' }])}
            >
              Add threshold
            </Button>
          )
          : null}
      </div>
    </div>
  )
}

/* ─────────────────────────── history ─────────────────────────── */

function History({ suite, name }: { suite: Suite; name: string }) {
  const q = usePerfTestHistory(suite, name)
  const commits = q.data ?? []
  if (q.isLoading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!commits.length) {
    return (
      <div className="p-6">
        <EmptyState
          compact
          title="No commits found for this test"
          description="Commits that touched this test's load.js or test.json in its application repository are listed here."
        />
      </div>
    )
  }
  return (
    <ul className="divide-y divide-edge-subtle">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-start gap-3 px-4 py-2.5">
          <code className="shrink-0 font-mono text-[11px] text-content-muted">{c.sha?.slice(0, 7)}</code>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] text-content">{c.message.split('\n')[0]}</div>
            <div className="text-[11px] text-content-subtle">
              {c.author.login}
              {c.created ? ` · ${formatRelative(c.created)}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ─────────────────────────── new test ─────────────────────────── */

function NewTestDialog({
  suite,
  onClose,
  onCreated,
}: {
  suite: Suite
  onClose(): void
  onCreated(name: string): void
}) {
  const create = useCreatePerfTest(suite)
  const toast = useToast()
  // Default to the first app without a test, so the common case — giving an
  // app its first test — is one click.
  const firstWithout = suite.apps.find((a) => !suite.tests.some((t) => t.repo === a.name))
  const [app, setApp] = useState((firstWithout ?? suite.apps[0])?.name ?? '')
  const [raw, setRaw] = useState('')
  const [starterId, setStarterId] = useState(STARTERS[0].id)
  const [namespace, setNamespace] = useState('default')

  const sub = normaliseName(raw)
  const starter = STARTERS.find((s) => s.id === starterId) ?? STARTERS[0]
  const error = newTestProblem(suite.tests, app, sub)
  const name = app ? perfTestName(app, sub) : ''
  const ready = Boolean(name) && !error

  // Hand-rolled (it needs the code-starter layout) but owes the same overlay
  // behaviour as Modal: portal above the shell, ESC, focus trap, scroll lock.
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayDismiss(true, onClose, { focusRef: panelRef })

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-perf-test-title"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl"
      >
        <div className="border-b border-edge-default px-5 py-3">
          <div id="new-perf-test-title" className="text-sm font-semibold text-content">New performance test</div>
          <div className="text-[11px] text-content-subtle">
            Committed to {suite.org}/{app || '…'} · {perfTestDir(sub)}/
          </div>
        </div>
        <div className="space-y-3 px-5 py-4">
          <Field label="Application" hint="The test lives in this application's repository, next to its code.">
            <Select
              value={app}
              onChange={(e) => setApp(e.target.value)}
              options={suite.apps.map((a) => ({ value: a.name, label: a.name }))}
            />
          </Field>
          <Field
            label="Test"
            hint={`Blank for the app's default test in ${PERF_DIR}/; a name puts it in ${PERF_DIR}/<name>/.`}
            error={error ?? undefined}
          >
            <Input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="smoke" />
          </Field>
          {name
            ? (
              <div className="text-[11px] text-content-subtle">
                Will be created as <code className="font-mono">{name}</code> — it also names the TestRun and ConfigMap.
              </div>
            )
            : null}

          <Field label="Namespace">
            <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          </Field>

          <Field label="Start from">
            <Select
              value={starterId}
              onChange={(e) => setStarterId(e.target.value)}
              options={STARTERS.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Field>
          <p className="text-[11px] text-content-muted">{starter.blurb}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-edge-default px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready || create.isPending}
            onClick={async () => {
              try {
                const created = await create.mutateAsync({ app, test: sub || undefined, starter, namespace })
                toast.success(`Created ${created}`, { description: `in ${app}/${perfTestDir(sub)}` })
                onCreated(created)
                onClose()
              } catch (e) {
                toast.error((e as Error).message)
              }
            }}
          >
            {create.isPending ? 'Creating…' : 'Create test'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
