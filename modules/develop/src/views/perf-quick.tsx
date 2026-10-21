import { useMemo, useState } from 'react'
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { normaliseName } from '../data/perf-format.ts'
import { newTestProblem, perfTestDir, perfTestName } from '../data/perf-location.ts'
import { newTestLocation, usePerfSuite, useRunPerfTest, useSavePerfTest } from '../data/perf-suite.ts'
import {
  fmtTotal,
  generateScript,
  type HttpMethod,
  type Profile,
  PROFILES,
  profileStages,
  quickConfig,
  type QuickRequest,
  type QuickSpec,
  specErrors,
  type Stage,
  totalSeconds,
  durationSeconds,
} from '../data/perf-quick.ts'

/**
 * Quick test — build an HTTP load test without writing k6.
 *
 * Requests, a load profile and pass criteria on the left; the generated
 * script, always visible, on the right. "Save" commits it to the chosen
 * application's repository as an ordinary test (`perf/<name>/`); "Save & run"
 * also starts it, labelled with that commit.
 */
export function QuickTestModal({ open, onClose, onSaved, onStarted }: {
  open: boolean
  onClose(): void
  onSaved(test: string): void
  onStarted(namespace: string, run: string, test: string): void
}) {
  const suite = usePerfSuite().data
  const apps = suite?.apps ?? []
  const save = useSavePerfTest(suite)
  const run = useRunPerfTest()
  const toast = useToast()

  const [app, setApp] = useState('')
  const [rawName, setRawName] = useState('')
  const [requests, setRequests] = useState<QuickRequest[]>([{ name: 'home', method: 'GET', url: 'https://', headers: [] }])
  const [profile, setProfile] = useState<Profile>('load')
  const [peak, setPeak] = useState(20)
  const [custom, setCustom] = useState<Stage[]>([{ duration: '30s', target: 10 }, { duration: '1m', target: 10 }, { duration: '30s', target: 0 }])
  const [think, setThink] = useState(1)
  const [p95, setP95] = useState<number | ''>(500)
  const [errPct, setErrPct] = useState<number | ''>(1)
  const [checksPct, setChecksPct] = useState<number | ''>(99)
  const [namespace, setNamespace] = useState('default')
  const [parallelism, setParallelism] = useState(1)
  const [busy, setBusy] = useState<null | 'save' | 'run'>(null)

  const sub = normaliseName(rawName)
  const appName = app || apps[0]?.name || ''
  // Empty name = the app's default test in perf/, allowed while it has none.
  const nameErr = suite ? newTestProblem(suite.tests, appName, sub) : null
  const name = appName ? perfTestName(appName, sub) : ''
  const spec: QuickSpec = {
    name: name || 'quick-test',
    requests,
    profile,
    peakVus: peak,
    stages: custom,
    thinkTimeS: think,
    thresholds: {
      p95Ms: p95 === '' ? undefined : p95,
      errorRatePct: errPct === '' ? undefined : errPct,
      checksPct: checksPct === '' ? undefined : checksPct,
    },
    namespace,
    parallelism,
  }
  const stages = profileStages(profile, peak, custom)
  const errors = specErrors(spec, stages)
  const script = useMemo(() => generateScript(spec), [JSON.stringify(spec)]) // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !nameErr && !errors.length && !!suite && !!appName

  const commit = async () => {
    const location = newTestLocation(suite!, appName, sub)
    return await save.mutateAsync({ name, location, script, config: quickConfig(spec), message: `perf: add ${name} (quick test, ${profile} profile)` })
  }
  const doSave = async (thenRun: boolean) => {
    setBusy(thenRun ? 'run' : 'save')
    try {
      const { commit: sha, location } = await commit()
      if (!thenRun) {
        toast.success(`Saved ${name}`, { description: sha ? `commit ${sha.slice(0, 7)}` : undefined })
        onSaved(name)
        return
      }
      const created = await run.mutateAsync({ test: { name, script, config: quickConfig(spec), configRaw: '', location }, commit: sha })
      toast.success(`Started ${created.metadata.name}`)
      onStarted(created.metadata.namespace ?? namespace, created.metadata.name, name)
    } catch (e) {
      toast.error(thenRun ? 'Could not start the test' : 'Could not save the test', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const setReq = (i: number, patch: Partial<QuickRequest>) => setRequests((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quick test"
      description={apps.length
        ? `Build an HTTP load test — it is committed to ${suite!.org}/${appName}/${perfTestDir(sub)} as an ordinary k6 test.`
        : 'A test is committed to an application repository, and this org has none yet — create an application from a template first.'}
      width="xl"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-content-subtle">
            {errors[0] ?? nameErr ?? (`${stages.length} stage${stages.length === 1 ? '' : 's'} · ${fmtTotal(totalSeconds(stages))} · peak ${Math.max(...stages.map((s) => s.target))} VUs × ${parallelism} runner${parallelism === 1 ? '' : 's'}`)}
          </span>
          <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="secondary" disabled={!ready || !!busy} loading={busy === 'save'} onClick={() => doSave(false)}>Save to repo</Button>
          <Button variant='primary' size="sm" disabled={!ready || !!busy} loading={busy === 'run'} onClick={() => doSave(true)}>Save &amp; run</Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_9rem_6rem]">
            <Field label="Application" required hint="The test is committed to this repository.">
              <Select value={appName} onChange={(e) => setApp(e.target.value)} options={apps.map((a) => ({ value: a.name, label: a.name }))} />
            </Field>
            <Field label="Test name" error={nameErr ?? undefined} hint={name ? `Saved as ${name} in ${perfTestDir(sub)}/` : undefined}>
              <Input autoFocus value={rawName} onChange={(e) => setRawName(e.target.value)} placeholder="smoke (blank = the app's default test)" />
            </Field>
            <Field label="Namespace"><Input value={namespace} onChange={(e) => setNamespace(e.target.value)} /></Field>
            <Field label="Runners"><Input type="number" min={1} max={20} value={parallelism} onChange={(e) => setParallelism(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} /></Field>
          </div>

          <section>
            <Heading>Requests <span className="font-normal text-content-subtle">· run in order, each iteration</span></Heading>
            <div className="space-y-2">
              {requests.map((r, i) => (
                <RequestEditor key={i} index={i} req={r} onChange={(p) => setReq(i, p)} onRemove={requests.length > 1 ? () => setRequests((rs) => rs.filter((_, j) => j !== i)) : undefined} />
              ))}
              <Button size="xs" variant="ghost" onClick={() => setRequests((rs) => [...rs, { name: '', method: 'GET', url: rs[rs.length - 1]?.url.replace(/\/[^/]*$/, '/') ?? 'https://', headers: [] }])}>+ Add request</Button>
            </div>
          </section>

          <section>
            <Heading>Load profile</Heading>
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
              {PROFILES.map((p) => (
                <button key={p.id} type="button" onClick={() => setProfile(p.id)} title={p.blurb} aria-pressed={profile === p.id} className={cn('rounded-lg border px-2 py-1.5 text-[12px] font-medium transition-colors', profile === p.id ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default text-content-muted hover:text-content')}>
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-content-subtle">{PROFILES.find((p) => p.id === profile)?.blurb}</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              {profile !== 'custom' ? (
                <Field label="Peak virtual users" className="w-40"><Input type="number" min={1} value={peak} onChange={(e) => setPeak(Math.max(1, Number(e.target.value) || 1))} /></Field>
              ) : null}
              <Field label="Think time (s)" className="w-32"><Input type="number" min={0} step={0.5} value={think} onChange={(e) => setThink(Math.max(0, Number(e.target.value) || 0))} /></Field>
            </div>
            {profile === 'custom' ? <StageEditor stages={custom} onChange={setCustom} /> : null}
            <ProfileChart stages={stages} />
          </section>

          <section>
            <Heading>Pass criteria <span className="font-normal text-content-subtle">· k6 thresholds; leave blank to skip</span></Heading>
            <div className="grid grid-cols-3 gap-3">
              <Field label="p95 under (ms)"><Input type="number" min={1} value={p95} onChange={(e) => setP95(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
              <Field label="Errors under (%)"><Input type="number" min={0} step={0.1} value={errPct} onChange={(e) => setErrPct(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
              <Field label="Checks over (%)"><Input type="number" min={0} max={100} value={checksPct} onChange={(e) => setChecksPct(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
            </div>
          </section>
        </div>

        <div className="flex min-h-0 flex-col">
          <Heading>Generated script <span className="font-normal text-content-subtle">· editable after saving</span></Heading>
          <pre className="max-h-144 min-h-80 flex-1 overflow-auto rounded-lg border border-edge-default bg-surface-sunken p-3 font-mono text-[11.5px] leading-relaxed text-content">{script}</pre>
        </div>
      </div>
    </Modal>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{children}</h3>
}

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

function RequestEditor({ index, req: r, onChange, onRemove }: { index: number; req: QuickRequest; onChange(p: Partial<QuickRequest>): void; onRemove?(): void }) {
  const [more, setMore] = useState(r.headers.length > 0 || !!r.body)
  const hasBody = !['GET', 'HEAD'].includes(r.method)
  return (
    <div className="rounded-lg border border-edge-default bg-surface-raised p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-center text-[11px] font-semibold tabular-nums text-content-subtle">{index + 1}</span>
        <div className="w-24"><Select aria-label="Method" value={r.method} onChange={(e) => onChange({ method: e.target.value as HttpMethod })} options={METHODS.map((m) => ({ value: m, label: m }))} /></div>
        <input value={r.url} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://api.example.com/v1/items" aria-label="URL" className="h-9 min-w-0 flex-1 basis-60 rounded-md border border-edge-default bg-surface-app px-2 font-mono text-[12px] text-content focus:border-brand-400 focus:outline-none" />
        <button type="button" onClick={() => setMore((x) => !x)} className="text-[11px] font-medium text-content-muted hover:text-content">{more ? 'Less' : 'Headers, body…'}</button>
        {onRemove ? <button type="button" onClick={onRemove} aria-label="Remove request" className="rounded px-1.5 text-content-subtle hover:bg-surface-sunken hover:text-rose-600">×</button> : null}
      </div>
      {more ? (
        <div className="mt-2 grid grid-cols-1 gap-2 pl-7">
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <Input value={r.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Name in results, e.g. list items" />
            <Input type="number" value={r.expectStatus ?? ''} onChange={(e) => onChange({ expectStatus: e.target.value ? Number(e.target.value) : undefined })} placeholder="Expect 2xx" aria-label="Expected status" />
          </div>
          {r.headers.map(([k, v], i) => (
            <div key={i} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
              <Input value={k} onChange={(e) => onChange({ headers: r.headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)) })} placeholder="Header" />
              <Input value={v} onChange={(e) => onChange({ headers: r.headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)) })} placeholder="Value — ${__ENV.TOKEN} reads an env var" />
              <button type="button" onClick={() => onChange({ headers: r.headers.filter((_, j) => j !== i) })} aria-label="Remove header" className="px-1.5 text-content-subtle hover:text-rose-600">×</button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => onChange({ headers: [...r.headers, ['', '']] })}>+ Header</Button>
            {hasBody && !r.headers.some(([k]) => k.toLowerCase() === 'content-type') ? <Button size="xs" variant="ghost" onClick={() => onChange({ headers: [...r.headers, ['Content-Type', 'application/json']] })}>+ JSON content type</Button> : null}
          </div>
          {hasBody ? <Textarea rows={3} value={r.body ?? ''} onChange={(e) => onChange({ body: e.target.value })} placeholder='{"sku": "abc-123", "qty": 1}' className="font-mono text-[12px]" /> : null}
        </div>
      ) : null}
    </div>
  )
}

function StageEditor({ stages, onChange }: { stages: Stage[]; onChange(s: Stage[]): void }) {
  return (
    <div className="mt-2 space-y-1.5">
      {stages.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          <span className="w-14 text-content-subtle">Stage {i + 1}</span>
          <span className="text-content-muted">ramp to</span>
          <input type="number" min={0} value={s.target} onChange={(e) => onChange(stages.map((x, j) => (j === i ? { ...x, target: Math.max(0, Number(e.target.value) || 0) } : x)))} className="h-8 w-20 rounded-md border border-edge-default bg-surface-app px-2 text-content" aria-label={`Stage ${i + 1} target`} />
          <span className="text-content-muted">VUs over</span>
          <input value={s.duration} onChange={(e) => onChange(stages.map((x, j) => (j === i ? { ...x, duration: e.target.value.trim() } : x)))} className={cn('h-8 w-20 rounded-md border bg-surface-app px-2 font-mono text-content', Number.isFinite(durationSeconds(s.duration)) ? 'border-edge-default' : 'border-rose-400')} aria-label={`Stage ${i + 1} duration`} />
          {stages.length > 1 ? <button type="button" onClick={() => onChange(stages.filter((_, j) => j !== i))} aria-label="Remove stage" className="px-1 text-content-subtle hover:text-rose-600">×</button> : null}
        </div>
      ))}
      <Button size="xs" variant="ghost" onClick={() => onChange([...stages, { duration: '1m', target: stages[stages.length - 1]?.target ?? 10 }])}>+ Stage</Button>
    </div>
  )
}

/**
 * Virtual users over time — one series, so no legend; the heading names it.
 * Each stage is a hover target with its own tooltip.
 */
function ProfileChart({ stages }: { stages: Stage[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560, H = 120, padL = 32, padB = 18, padT = 8
  const total = totalSeconds(stages) || 1
  const peak = Math.max(1, ...stages.map((s) => s.target))
  const x = (t: number) => padL + (t / total) * (W - padL - 4)
  const y = (v: number) => padT + (1 - v / peak) * (H - padT - padB)
  const pts: Array<[number, number]> = [[0, 0]]
  let t = 0
  const segs = stages.map((s) => {
    const from = t
    t += durationSeconds(s.duration) || 0
    pts.push([t, s.target])
    return { from, to: t, s }
  })
  const path = pts.map(([tt, v], i) => `${i ? 'L' : 'M'}${x(tt).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${path} L${x(t).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`
  const hv = hover != null ? segs[hover] : null
  return (
    <figure className="relative mt-3 rounded-lg border border-edge-default bg-surface-raised p-2">
      <figcaption className="mb-1 px-1 text-[11px] text-content-subtle">Virtual users over {fmtTotal(total)}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" role="img" aria-label={`Load profile peaking at ${peak} virtual users`} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - 4} y1={y(peak * f)} y2={y(peak * f)} className="stroke-edge-subtle" strokeWidth={1} />
            <text x={padL - 4} y={y(peak * f) + 3} textAnchor="end" className="fill-content-subtle text-[9px]">{Math.round(peak * f)}</text>
          </g>
        ))}
        <path d={area} className="fill-brand-500/12" />
        <path d={path} fill="none" className="stroke-brand-600 dark:stroke-brand-400" strokeWidth={2} strokeLinejoin="round" />
        {segs.map((sg, i) => (
          <rect key={i} x={x(sg.from)} y={padT} width={Math.max(4, x(sg.to) - x(sg.from))} height={H - padT - padB} fill={hover === i ? 'currentColor' : 'transparent'} className="text-brand-500/6" onMouseEnter={() => setHover(i)} />
        ))}
        <text x={padL} y={H - 4} className="fill-content-subtle text-[9px]">0</text>
        <text x={W - 4} y={H - 4} textAnchor="end" className="fill-content-subtle text-[9px]">{fmtTotal(total)}</text>
      </svg>
      {hv ? (
        <div className="pointer-events-none absolute right-3 top-2 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] shadow-md">
          <div className="font-semibold text-content">Stage {hover! + 1}</div>
          <div className="text-content-muted">→ {hv.s.target} VUs over {hv.s.duration}</div>
          <div className="text-content-subtle">{fmtTotal(hv.from)} – {fmtTotal(hv.to)}</div>
        </div>
      ) : null}
    </figure>
  )
}

