import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import { assistStore, useAssist, type UiBlock } from './store.ts'

/**
 * Generative UI — the component registry Adhar AI renders into.
 *
 * Two things feed it:
 *   • every cluster tool the agent runs is mapped server-side to a component
 *     (a pod diagnosis renders as a diagnosis card, not a JSON blob), and
 *   • the agent can call `render_ui` to choose a component itself when a
 *     table / metric row / timeline communicates better than prose.
 *
 * Both arrive as AG-UI `CUSTOM` events named `adhar.ui` and land here. Because
 * the props are ultimately produced by a language model, EVERY component is
 * defensive: unknown component ids degrade to a labelled JSON block, and bad
 * props render an empty state rather than throwing inside the transcript.
 */

type Props = Record<string, unknown>
type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-rose-700 dark:text-rose-300',
  info: 'text-sky-700 dark:text-sky-300',
  muted: 'text-content-muted',
}
const TONE_CHIP: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
  bad: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300',
  muted: 'bg-surface-sunken text-content-muted ring-edge-default',
}

/* ─────────────────────── prop coercion helpers ─────────────────────── */

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arr = (v: unknown): Props[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Props[] : [])
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [])

function tone(v: unknown, fallback: Tone = 'muted'): Tone {
  const s = str(v).toLowerCase()
  if (s === 'ok' || s === 'success' || s === 'pass' || s === 'healthy') return 'ok'
  if (s === 'warn' || s === 'warning') return 'warn'
  if (s === 'bad' || s === 'danger' || s === 'error' || s === 'fail' || s === 'critical') return 'bad'
  if (s === 'info') return 'info'
  if (s === 'muted' || s === 'neutral') return 'muted'
  return fallback
}

/** Classify a free-text Kubernetes status/phase into a tone. */
function statusTone(s: string): Tone {
  const v = s.toLowerCase()
  if (!v) return 'muted'
  if (/fail|error|crash|backoff|unhealthy|degraded|evict|oom|lost|denied|missing/.test(v)) return 'bad'
  if (/pending|progress|updating|creating|waiting|outofsync|unknown/.test(v)) return 'warn'
  if (/running|ready|healthy|succeed|active|bound|synced|complete|true/.test(v)) return 'ok'
  return 'muted'
}

/* ─────────────────────────── chrome ─────────────────────────── */

function Panel({ title, children, tone: t }: { title?: string; children: ReactNode; tone?: Tone }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-surface-raised',
        t === 'bad' ? 'border-rose-200/70 dark:border-rose-500/30' : t === 'warn' ? 'border-amber-200/70 dark:border-amber-500/30' : 'border-edge-default',
      )}
    >
      {title ? (
        <div className="border-b border-edge-subtle bg-surface-sunken/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
          {title}
        </div>
      ) : null}
      <div className="p-3">{children}</div>
    </div>
  )
}

function Chip({ t, children }: { t: Tone; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset', TONE_CHIP[t])}>{children}</span>
}

function Empty({ text }: { text: string }) {
  return <p className="py-1 text-[12px] text-content-subtle">{text}</p>
}

function KeyVal({ k, v, t }: { k: string; v: ReactNode; t?: Tone }) {
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="shrink-0 text-content-subtle">{k}</span>
      <span className={cn('min-w-0 truncate font-medium', t ? TONE_TEXT[t] : 'text-content')}>{v}</span>
    </div>
  )
}

/* ─────────────────── cluster-tool components ─────────────────── */

function PodDiagnostics({ props: p }: { props: Props }) {
  const containers = arr(p.containers)
  const initContainers = arr(p.initContainers)
  const issues = strArr(p.issues)
  const healthy = issues.length === 1 && issues[0].startsWith('none detected')
  const phase = str(p.phase)
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip t={statusTone(phase)}>{phase || 'unknown'}</Chip>
        {p.reason ? <Chip t="bad">{str(p.reason)}</Chip> : null}
        {p.qosClass ? <Chip t="muted">QoS {str(p.qosClass)}</Chip> : null}
        {p.node ? <span className="text-[11px] text-content-subtle">on {str(p.node)}</span> : null}
      </div>

      {containers.length || initContainers.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11.5px]">
            <thead className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              <tr>
                <th className="py-1 pr-2">Container</th>
                <th className="py-1 pr-2">State</th>
                <th className="py-1 pr-2 text-right">Restarts</th>
                <th className="py-1">Image</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {[...initContainers.map((c) => ({ ...c, init: true })), ...containers].map((c, i) => {
                const state = str(c.state)
                const restarts = num(c.restartCount) ?? 0
                return (
                  <tr key={i}>
                    <td className="py-1 pr-2 font-medium text-content">
                      {str(c.name)}
                      {c.init ? <span className="ml-1 text-[9.5px] uppercase text-content-subtle">init</span> : null}
                      {c.ready === false ? <span className="ml-1 text-rose-600 dark:text-rose-400">●</span> : null}
                    </td>
                    <td className={cn('py-1 pr-2', TONE_TEXT[statusTone(state)])}>{state || '—'}</td>
                    <td className={cn('py-1 pr-2 text-right tabular-nums', restarts > 0 ? TONE_TEXT.warn : 'text-content-muted')}>{restarts}</td>
                    <td className="max-w-[16rem] truncate py-1 font-mono text-[10.5px] text-content-subtle" title={str(c.image)}>{str(c.image)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <ul className="space-y-1">
        {issues.map((issue, i) => (
          <li key={i} className={cn('flex gap-1.5 text-[12px]', healthy ? TONE_TEXT.ok : TONE_TEXT.bad)}>
            <span aria-hidden>{healthy ? '✓' : '▸'}</span>
            <span className="min-w-0 text-content">{issue}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function WorkloadHealth({ props: p }: { props: Props }) {
  const r = (p.replicas ?? {}) as Props
  const desired = num(r.desired) ?? 0
  const ready = num(r.ready) ?? 0
  const pct = desired > 0 ? Math.min(100, Math.round((ready / desired) * 100)) : 0
  const healthy = p.healthy === true
  const podIssues = arr(p.podIssues)
  const conditions = strArr(p.conditions)
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="font-medium text-content">{ready} / {desired} ready</span>
            <span className={cn('text-[11px]', healthy ? TONE_TEXT.ok : TONE_TEXT.bad)}>{healthy ? 'healthy' : 'degraded'}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-sunken">
            <div className={cn('h-full rounded-full transition-[width]', healthy ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-rose-500')} style={{ width: `${Math.max(pct, desired > 0 && ready === 0 ? 2 : pct)}%` }} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        {(['current', 'ready', 'available', 'updated', 'unavailable', 'misscheduled'] as const).map((k) =>
          num(r[k]) === undefined ? null : <KeyVal key={k} k={k} v={String(num(r[k]))} t={k === 'unavailable' || k === 'misscheduled' ? (num(r[k])! > 0 ? 'bad' : 'muted') : undefined} />,
        )}
      </div>
      {conditions.length ? (
        <div className="flex flex-wrap gap-1">
          {conditions.map((c, i) => <Chip key={i} t={/=True/.test(c) && !/Progressing/.test(c) ? 'ok' : /=False/.test(c) ? 'bad' : 'muted'}>{c}</Chip>)}
        </div>
      ) : null}
      {podIssues.length ? (
        <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">Pods with issues · {podIssues.length}</div>
          <ul className="space-y-1">
            {podIssues.slice(0, 6).map((pod, i) => (
              <li key={i} className="text-[11.5px]">
                <span className="font-medium text-content">{str(pod.pod)}</span>
                <span className="text-content-subtle"> — {strArr(pod.issues)[0] ?? 'unhealthy'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function EventsScan({ props: p }: { props: Props }) {
  const groups = arr(p.groups)
  if (!groups.length) return <Empty text="No warning events in scope — nothing is complaining." />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11.5px]">
        <thead className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          <tr>
            <th className="py-1 pr-2">Reason</th>
            <th className="py-1 pr-2">Object</th>
            <th className="py-1 pr-2 text-right">Count</th>
            <th className="py-1">Message</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {groups.slice(0, 15).map((g, i) => (
            <tr key={i}>
              <td className="py-1 pr-2"><Chip t="bad">{str(g.reason)}</Chip></td>
              <td className="py-1 pr-2 font-mono text-[10.5px] text-content">{str(g.object)}</td>
              <td className="py-1 pr-2 text-right tabular-nums text-content-muted">{num(g.count) ?? 1}</td>
              <td className="max-w-[22rem] truncate py-1 text-content-muted" title={str(g.message)}>{str(g.message)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {groups.length > 15 ? <p className="pt-1.5 text-[11px] text-content-subtle">+{groups.length - 15} more groups</p> : null}
    </div>
  )
}

function ArgoApp({ props: p }: { props: Props }) {
  const sync = str((p.sync as Props)?.status)
  const health = str((p.health as Props)?.status)
  const src = (p.source ?? {}) as Props
  const issues = arr(p.resourcesWithIssues)
  const op = p.lastOperation as Props | undefined
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip t={sync === 'Synced' ? 'ok' : 'warn'}>sync: {sync || 'unknown'}</Chip>
        <Chip t={statusTone(health)}>health: {health || 'unknown'}</Chip>
        {p.project ? <Chip t="muted">project {str(p.project)}</Chip> : null}
      </div>
      {src.repoURL ? (
        <div className="space-y-0.5">
          <KeyVal k="source" v={<span className="font-mono text-[11px]">{str(src.repoURL).replace(/^https?:\/\//, '')}{src.path ? ` · ${str(src.path)}` : ''}</span>} />
          {src.targetRevision ? <KeyVal k="revision" v={<span className="font-mono text-[11px]">{str(src.targetRevision)}</span>} /> : null}
        </div>
      ) : null}
      {op?.phase ? <KeyVal k="last op" v={`${str(op.phase)}${op.message ? ` — ${str(op.message)}` : ''}`} t={statusTone(str(op.phase))} /> : null}
      {issues.length ? (
        <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">Resources needing attention · {issues.length}</div>
          <ul className="space-y-1">
            {issues.slice(0, 8).map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <span className="font-mono text-content">{str(r.resource)}</span>
                {r.namespace ? <span className="text-content-subtle">· {str(r.namespace)}</span> : null}
                {r.sync ? <Chip t={str(r.sync) === 'Synced' ? 'ok' : 'warn'}>{str(r.sync)}</Chip> : null}
                {r.health ? <Chip t={statusTone(str(r.health))}>{str(r.health)}</Chip> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function LogViewer({ props: p }: { props: Props }) {
  const raw = str(p.lines)
  const lines = raw.split('\n').filter(Boolean)
  if (!lines.length) return <Empty text="No log output." />
  return (
    <pre className="max-h-72 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[10.5px] leading-relaxed text-code-fg">
      {lines.slice(-200).map((l, i) => (
        <div key={i} className={cn(/error|fatal|panic|exception/i.test(l) ? 'text-rose-300' : /warn/i.test(l) ? 'text-amber-300' : undefined)}>
          {l}
        </div>
      ))}
    </pre>
  )
}

function ResourceList({ props: p }: { props: Props }) {
  const items = arr(p.items)
  if (!items.length) return <Empty text="No matching resources." />
  return (
    <ul className="divide-y divide-edge-subtle">
      {items.slice(0, 40).map((r, i) => {
        const kind = str(r.kind)
        const name = str(r.name)
        const status = str(r.status)
        return (
          <li key={i} className="flex items-center gap-2 py-1 text-[11.5px]">
            <button
              type="button"
              onClick={() => openResource(kind, name, str(r.namespace) || undefined)}
              className="min-w-0 flex-1 truncate text-left font-mono text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300"
              title={`Open ${kind}/${name}`}
            >
              {name}
            </button>
            {r.namespace ? <span className="shrink-0 text-content-subtle">{str(r.namespace)}</span> : null}
            {status ? <Chip t={tone(r.tone, statusTone(status))}>{status}</Chip> : null}
          </li>
        )
      })}
      {items.length > 40 ? <li className="pt-1 text-[11px] text-content-subtle">+{items.length - 40} more</li> : null}
    </ul>
  )
}

/** Ask the host to open a resource drawer, if it registered a handler. */
function openResource(kind: string, name: string, namespace?: string) {
  globalThis.dispatchEvent(new CustomEvent('adhar:ai:open-resource', { detail: { kind, name, namespace } }))
}

function ResourceSummary({ props: p }: { props: Props }) {
  const [open, setOpen] = useState(false)
  const obj = (p.object ?? {}) as Props
  const meta = (obj.metadata ?? {}) as Props
  const status = (obj.status ?? {}) as Props
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {meta.name ? <KeyVal k="name" v={str(meta.name)} /> : null}
        {meta.namespace ? <KeyVal k="namespace" v={str(meta.namespace)} /> : null}
        {obj.kind ? <KeyVal k="kind" v={str(obj.kind)} /> : null}
        {status.phase ? <KeyVal k="phase" v={str(status.phase)} t={statusTone(str(status.phase))} /> : null}
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
        {open ? 'Hide' : 'Show'} full object
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[10.5px] leading-relaxed text-code-fg">
          {JSON.stringify(obj, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

/* ─────────────────── human-in-the-loop: proposal ─────────────────── */

function Proposal({ props: p }: { props: Props }) {
  const [phase, setPhase] = useState<'idle' | 'applying' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const [showYaml, setShowYaml] = useState(false)
  const canApply = useAssistCanApply()
  const manifest = p.manifest
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/25 dark:bg-amber-500/10">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
        Proposed change — review &amp; apply
      </div>
      <div className="mt-1 text-[13px] text-content">{str(p.summary, 'A change was proposed.')}</div>
      <button type="button" onClick={() => setShowYaml((s) => !s)} className="mt-2 text-[11px] font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-300">
        {showYaml ? 'Hide' : 'View'} manifest
      </button>
      {showYaml ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-code p-3 font-mono text-[10.5px] leading-relaxed text-code-fg">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canApply || phase === 'applying' || phase === 'done'}
          onClick={async () => {
            setPhase('applying')
            try {
              const r = await assistStore.applyProposal(manifest)
              setPhase(r.ok ? 'done' : 'error')
              setMsg(r.message)
            } catch (e) {
              setPhase('error')
              setMsg(e instanceof Error ? e.message : String(e))
            }
          }}
          className="rounded-md bg-amber-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {phase === 'applying' ? 'Applying…' : phase === 'done' ? 'Applied ✓' : 'Apply'}
        </button>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(manifest, null, 2))}
          className="rounded-md border border-amber-300 px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/10"
        >
          Copy
        </button>
        {msg ? <span className={cn('text-[11px]', phase === 'error' ? TONE_TEXT.bad : TONE_TEXT.ok)}>{msg}</span> : null}
      </div>
      <p className="mt-2 text-[11px] text-amber-800/80 dark:text-amber-300/80">Nothing happens until you review and apply.</p>
    </div>
  )
}

/** Subscribed, so the Apply button enables as soon as the host registers a handler. */
function useAssistCanApply(): boolean {
  return useAssist().canApply
}

/* ─────────────────── model-directed components ─────────────────── */

function DataTable({ props: p }: { props: Props }) {
  const columns = arr(p.columns)
  const rows = arr(p.rows)
  if (!rows.length) return <Empty text="No rows." />
  const cols = columns.length
    ? columns.map((c) => ({ key: str(c.key), label: str(c.label, str(c.key)), align: str(c.align) }))
    : Object.keys(rows[0]).map((k) => ({ key: k, label: k, align: '' }))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11.5px]">
        <thead className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          <tr>
            {cols.map((c) => <th key={c.key} className={cn('py-1 pr-3', c.align === 'right' && 'text-right')}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {rows.slice(0, 50).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = r[c.key]
                const text = typeof v === 'object' && v !== null ? JSON.stringify(v) : str(v, '—')
                return (
                  <td key={c.key} className={cn('py-1 pr-3 text-content', c.align === 'right' && 'text-right tabular-nums')}>
                    {text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Metrics({ props: p }: { props: Props }) {
  const items = arr(p.items)
  if (!items.length) return <Empty text="No metrics." />
  return (
    <div className={cn('grid gap-2', items.length <= 2 ? 'grid-cols-2' : items.length === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4')}>
      {items.slice(0, 8).map((m, i) => (
        <div key={i} className="rounded-lg border border-edge-subtle bg-surface-sunken/40 px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{str(m.label)}</div>
          <div className={cn('truncate text-lg font-semibold leading-tight tabular-nums', m.tone ? TONE_TEXT[tone(m.tone)] : 'text-content')} title={str(m.value)}>
            {str(m.value, '—')}
          </div>
          {m.hint ? <div className="truncate text-[10.5px] text-content-subtle">{str(m.hint)}</div> : null}
        </div>
      ))}
    </div>
  )
}

function Timeline({ props: p }: { props: Props }) {
  const items = arr(p.items)
  if (!items.length) return <Empty text="Nothing to show on the timeline." />
  return (
    <ol className="relative space-y-2.5 border-l border-edge-default pl-4">
      {items.slice(0, 20).map((it, i) => {
        const t = tone(it.tone, 'muted')
        return (
          <li key={i} className="relative">
            <span className={cn('absolute -left-[21px] top-1 h-2 w-2 rounded-full ring-2 ring-surface-raised', t === 'bad' ? 'bg-rose-500' : t === 'warn' ? 'bg-amber-500' : t === 'ok' ? 'bg-emerald-500' : 'bg-edge-strong')} />
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[12px] font-medium text-content">{str(it.label)}</span>
              {it.at ? <span className="text-[10.5px] text-content-subtle">{str(it.at)}</span> : null}
            </div>
            {it.detail ? <p className="text-[11.5px] text-content-muted">{str(it.detail)}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}

function Checklist({ props: p }: { props: Props }) {
  const items = arr(p.items)
  if (!items.length) return <Empty text="No checks." />
  return (
    <ul className="space-y-1.5">
      {items.slice(0, 20).map((it, i) => {
        const s = str(it.status).toLowerCase()
        const t: Tone = s === 'pass' ? 'ok' : s === 'fail' ? 'bad' : s === 'warn' ? 'warn' : 'muted'
        return (
          <li key={i} className="flex gap-2 text-[12px]">
            <span className={cn('mt-px shrink-0 font-semibold', TONE_TEXT[t])} aria-hidden>{t === 'ok' ? '✓' : t === 'bad' ? '✕' : '!'}</span>
            <span className="min-w-0">
              <span className="text-content">{str(it.label)}</span>
              {it.detail ? <span className="block text-[11px] text-content-subtle">{str(it.detail)}</span> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Comparison({ props: p }: { props: Props }) {
  const left = (p.left ?? {}) as Props
  const right = (p.right ?? {}) as Props
  const side = (s: Props) => (
    <div className="min-w-0 flex-1 rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{str(s.title)}</div>
      <div className="space-y-0.5">
        {arr(s.items).slice(0, 10).map((it, i) => <KeyVal key={i} k={str(it.label)} v={str(it.value, '—')} />)}
      </div>
    </div>
  )
  return <div className="flex flex-col gap-2 sm:flex-row">{side(left)}{side(right)}</div>
}

function Callout({ props: p }: { props: Props }) {
  const t = tone(p.tone, 'info')
  const border = t === 'bad' ? 'border-rose-200 dark:border-rose-500/30' : t === 'warn' ? 'border-amber-200 dark:border-amber-500/30' : t === 'ok' ? 'border-emerald-200 dark:border-emerald-500/30' : 'border-sky-200 dark:border-sky-500/30'
  const bg = t === 'bad' ? 'bg-rose-50/70 dark:bg-rose-500/10' : t === 'warn' ? 'bg-amber-50/70 dark:bg-amber-500/10' : t === 'ok' ? 'bg-emerald-50/70 dark:bg-emerald-500/10' : 'bg-sky-50/70 dark:bg-sky-500/10'
  return <div className={cn('rounded-xl border px-3 py-2 text-[12.5px]', border, bg, TONE_TEXT[t])}>{str(p.text)}</div>
}

function BarChart({ props: p }: { props: Props }) {
  const items = arr(p.items).filter((i) => num(i.value) !== undefined)
  if (!items.length) return <Empty text="No data." />
  const max = Math.max(...items.map((i) => num(i.value)!), 1)
  const unit = str(p.unit)
  return (
    <div className="space-y-1.5">
      {items.slice(0, 15).map((it, i) => {
        const v = num(it.value)!
        return (
          <div key={i} className="flex items-center gap-2 text-[11.5px]">
            <span className="w-28 shrink-0 truncate text-content-muted" title={str(it.label)}>{str(it.label)}</span>
            <span className="h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-surface-sunken">
              <span className="block h-full rounded-sm bg-brand-500/80" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-content">{v}{unit ? ` ${unit}` : ''}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ─────────────────────────── registry ─────────────────────────── */

const REGISTRY: Record<string, (p: { props: Props }) => ReactNode> = {
  'pod-diagnostics': PodDiagnostics,
  'workload-health': WorkloadHealth,
  'events-scan': EventsScan,
  'argocd-app': ArgoApp,
  'log-viewer': LogViewer,
  'resource-list': ResourceList,
  'resource-summary': ResourceSummary,
  proposal: Proposal,
  table: DataTable,
  metrics: Metrics,
  timeline: Timeline,
  checklist: Checklist,
  comparison: Comparison,
  callout: Callout,
  'bar-chart': BarChart,
}

/** Component ids a model may pick — mirrored in the render_ui tool schema. */
export const GENERATIVE_COMPONENTS = Object.keys(REGISTRY)

/**
 * Render one generative-UI block. A `proposal` and a `callout` carry their own
 * chrome; everything else is wrapped in a titled panel.
 */
export function GenerativeBlock({ block }: { block: UiBlock }) {
  const Component = REGISTRY[block.component]
  if (!Component) {
    return (
      <Panel title={block.title ?? block.component}>
        <pre className="max-h-56 overflow-auto font-mono text-[10.5px] text-content-muted">{JSON.stringify(block.props, null, 2)}</pre>
      </Panel>
    )
  }
  if (block.component === 'proposal' || block.component === 'callout') {
    return <BlockBoundary><Component props={block.props ?? {}} /></BlockBoundary>
  }
  const t: Tone | undefined = block.component === 'events-scan' ? 'warn' : undefined
  return (
    <Panel title={block.title} tone={t}>
      <BlockBoundary><Component props={block.props ?? {}} /></BlockBoundary>
    </Panel>
  )
}

/**
 * Model-authored props can be any shape, and a throw during render would blank
 * the entire transcript. A real error boundary is the only thing that contains
 * a render-phase error — a try/catch around JSX cannot, because the child
 * renders after the element is created.
 */
class BlockBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[agui] generative block failed to render', error, info.componentStack)
  }
  render() {
    if (this.state.failed) return <Empty text="This result could not be displayed." />
    return this.props.children
  }
}
