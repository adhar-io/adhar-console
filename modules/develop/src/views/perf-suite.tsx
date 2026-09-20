import { useEffect, useMemo, useState } from 'react'
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
  StatusBadge,
  Textarea,
  useCan,
  useToast,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import { CodeEditor } from '../components/code-editor.tsx'
import {
  DEFAULT_CONFIG,
  nameError,
  normaliseName,
  type PerfTestConfig,
  STARTERS,
  type Threshold,
} from '../data/perf-format.ts'
import {
  type PerfTest,
  type SuiteRepo,
  useCreatePerfTest,
  useCreateSuiteRepo,
  useDeletePerfTest,
  usePerfTest,
  usePerfTestHistory,
  usePerfTests,
  useRunPerfTest,
  useSavePerfTest,
  useSuiteRepo,
} from '../data/perf-suite.ts'

/**
 * The performance test workbench — write the test, configure it, run it.
 *
 * Everything here is backed by a git repository rather than by cluster
 * objects, because a load test is code: it wants review, history and a
 * diff. The console commits, then runs the committed version, so a result
 * can always be traced to the exact script that produced it.
 */
export function PerfSuite({ onOpenRun }: { onOpenRun?(namespace: string, name: string): void }) {
  const suiteQ = useSuiteRepo()
  const suite = suiteQ.data
  const testsQ = usePerfTests(suite)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const canEdit = useCan('develop')

  const tests = testsQ.data ?? []
  useEffect(() => {
    if (!selected && tests.length) setSelected(tests[0])
    if (selected && tests.length && !tests.includes(selected)) setSelected(tests[0] ?? null)
  }, [tests, selected])

  if (suiteQ.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (suiteQ.isError) {
    return (
      <EmptyState
        title="Gitea is not reachable"
        description={`The performance suite lives in a Gitea repository, and the console could not reach Gitea: ${
          (suiteQ.error as Error).message
        }`}
      />
    )
  }
  if (!suite?.exists) return <CreateSuite canEdit={canEdit} />

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_1fr]">
      <TestList
        suite={suite}
        tests={tests}
        loading={testsQ.isLoading}
        selected={selected}
        onSelect={setSelected}
        onNew={() => setCreating(true)}
        canEdit={canEdit}
      />
      {selected
        ? <TestWorkbench suite={suite} name={selected} canEdit={canEdit} onOpenRun={onOpenRun} />
        : (
          <Card>
            <CardBody className="py-12">
              <EmptyState
                title="No tests yet"
                description="A performance test is a k6 script plus its configuration, stored in git. Start from a template — every one of them declares thresholds, so the run produces a verdict rather than just a number."
                action={canEdit ? <Button onClick={() => setCreating(true)}>New test</Button> : undefined}
              />
            </CardBody>
          </Card>
        )}
      {creating
        ? <NewTestDialog suite={suite} existing={tests} onClose={() => setCreating(false)} onCreated={setSelected} />
        : null}
    </div>
  )
}

/* ─────────────────────────── first run ─────────────────────────── */

function CreateSuite({ canEdit }: { canEdit: boolean }) {
  const create = useCreateSuiteRepo()
  const toast = useToast()
  return (
    <Card>
      <CardBody className="py-10">
        <EmptyState
          title="The performance suite has no repository yet"
          description="Tests live in their own Gitea repository so they can be reviewed, diffed and traced — a script stored only as a ConfigMap has no author and no history, so a number it produced can never be explained. The console will create it and commit a README describing the layout."
          action={canEdit
            ? (
              <Button
                disabled={create.isPending}
                onClick={() =>
                  create.mutate(undefined, {
                    onSuccess: () => toast.success('Created the performance-tests repository'),
                    onError: (e: Error) => toast.error(e.message),
                  })}
              >
                {create.isPending ? 'Creating…' : 'Create the repository'}
              </Button>
            )
            : undefined}
        />
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── list ─────────────────────────── */

function TestList({
  suite,
  tests,
  loading,
  selected,
  onSelect,
  onNew,
  canEdit,
}: {
  suite: SuiteRepo
  tests: string[]
  loading: boolean
  selected: string | null
  onSelect(name: string): void
  onNew(): void
  canEdit: boolean
}) {
  return (
    <Card className="flex max-h-[720px] flex-col overflow-hidden">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-content">Tests</div>
            <a
              href={suite.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate text-[11px] text-brand-700 hover:underline dark:text-brand-300"
            >
              {suite.org}/{suite.repo} ↗
            </a>
          </div>
          {canEdit ? <Button size="xs" onClick={onNew}>New</Button> : null}
        </div>
      </CardHeader>
      <CardBody className="min-h-0 flex-1 overflow-y-auto p-0">
        {loading
          ? <div className="flex justify-center py-8"><Spinner /></div>
          : tests.length === 0
          ? <div className="px-4 py-6 text-[12px] text-content-muted">No tests committed yet.</div>
          : (
            <ul>
              {tests.map((t) => (
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
                  </button>
                </li>
              ))}
            </ul>
          )}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── workbench ─────────────────────────── */

type Tab = 'script' | 'config' | 'history'

function TestWorkbench({
  suite,
  name,
  canEdit,
  onOpenRun,
}: {
  suite: SuiteRepo
  name: string
  canEdit: boolean
  onOpenRun?(namespace: string, runName: string): void
}) {
  const q = usePerfTest(suite, name)
  const save = useSavePerfTest(suite)
  const run = useRunPerfTest()
  const remove = useDeletePerfTest(suite)
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('script')

  // Local drafts, so an edit survives a background refetch and the Save
  // button can say whether anything actually changed.
  const [script, setScript] = useState<string | null>(null)
  const [config, setConfig] = useState<PerfTestConfig | null>(null)

  useEffect(() => {
    setScript(null)
    setConfig(null)
  }, [name])

  const test = q.data
  const liveScript = script ?? test?.script ?? ''
  const liveConfig = config ?? test?.config ?? DEFAULT_CONFIG
  const dirty = (script !== null && script !== test?.script) ||
    (config !== null && JSON.stringify(config) !== JSON.stringify(test?.config))

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
    } catch (e) {
      toast.error((e as Error).message)
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
            <div className="truncate text-[11px] text-content-subtle">
              {liveConfig.namespace} · {liveConfig.parallelism} runner{liveConfig.parallelism === 1 ? '' : 's'}
              {liveConfig.tags.length ? ` · ${liveConfig.tags.join(', ')}` : ''}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {canEdit
              ? (
                <>
                  <Button variant="ghost" size="sm" disabled={!dirty || save.isPending} onClick={doSave}>
                    {save.isPending ? 'Committing…' : 'Commit'}
                  </Button>
                  <Button size="sm" disabled={run.isPending} onClick={doRun}>
                    {run.isPending ? 'Starting…' : 'Run test'}
                  </Button>
                </>
              )
              : null}
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          {(['script', 'config', 'history'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                tab === t ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content',
              )}
            >
              {t}
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
              filename={`${name}.js`}
              height={520}
              wordWrap
            />
          )
          : tab === 'config'
          ? <ConfigForm value={liveConfig} onChange={setConfig} readOnly={!canEdit} />
          : <History suite={suite} name={name} />}
      </CardBody>
    </Card>
  )
}

/** Newest commit we know about for this test, for the run label. */
function latestCommit(test: PerfTest): string | undefined {
  return test.scriptSha
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

function History({ suite, name }: { suite: SuiteRepo; name: string }) {
  const q = usePerfTestHistory(suite, name)
  const commits = q.data ?? []
  if (q.isLoading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!commits.length) {
    return (
      <div className="p-6">
        <EmptyState
          compact
          title="No commits found for this test"
          description="Only commits the console made are matched here. Anything committed directly to the repository still shows in Gitea."
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
            <div className="truncate text-[12px] text-content">{c.commit?.message?.split('\n')[0]}</div>
            <div className="text-[11px] text-content-subtle">
              {c.commit?.author?.name}
              {c.commit?.author?.date ? ` · ${formatRelative(c.commit.author.date)}` : ''}
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
  existing,
  onClose,
  onCreated,
}: {
  suite: SuiteRepo
  existing: string[]
  onClose(): void
  onCreated(name: string): void
}) {
  const create = useCreatePerfTest(suite)
  const toast = useToast()
  const [raw, setRaw] = useState('')
  const [starterId, setStarterId] = useState(STARTERS[0].id)
  const [namespace, setNamespace] = useState('default')

  const name = normaliseName(raw)
  const starter = STARTERS.find((s) => s.id === starterId) ?? STARTERS[0]
  const error = raw ? nameError(name) ?? (existing.includes(name) ? 'A test with that name already exists.' : null) : null
  const ready = Boolean(name) && !error

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl">
        <div className="border-b border-edge-default px-5 py-3">
          <div className="text-sm font-semibold text-content">New performance test</div>
          <div className="text-[11px] text-content-subtle">Committed to {suite.org}/{suite.repo}</div>
        </div>
        <div className="space-y-3 px-5 py-4">
          <Field
            label="Name"
            hint="Also names the TestRun and ConfigMap."
            error={error ?? undefined}
          >
            <Input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="checkout-load" />
          </Field>
          {name && name !== raw
            ? <div className="text-[11px] text-content-subtle">Will be created as <code className="font-mono">{name}</code></div>
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
            disabled={!ready || create.isPending}
            onClick={async () => {
              try {
                await create.mutateAsync({ name, starter, namespace })
                toast.success(`Created ${name}`)
                onCreated(name)
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
    </div>
  )
}
