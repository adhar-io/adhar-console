import { useMemo, useState } from 'react'
import { cn } from '@adhar/utils'
import { type TimeSelection, useLogLabels, useLogLabelValues } from '../data/observability.ts'
import {
  buildLogQL,
  buildSelector,
  EMPTY_SPEC,
  type LabelFilterOp,
  type LineFilterOp,
  type LogQLSpec,
  type MatcherOp,
  type MetricAgg,
  type MetricFn,
  parseLogQL,
  type ParserKind,
  validateSpec,
} from '../data/logql.ts'

/**
 * Visual LogQL builder. It edits the same query string as the code editor:
 * every change is rendered back to LogQL (`buildLogQL`), and the current
 * query is parsed into the form (`parseLogQL`). When the query uses LogQL the
 * form can't represent, the builder says so instead of rewriting it.
 */

const MATCH_OPS: MatcherOp[] = ['=', '!=', '=~', '!~']
const LINE_OPS: Array<[LineFilterOp, string]> = [['|=', 'contains'], ['!=', 'does not contain'], ['|~', 'matches regex'], ['!~', 'does not match regex']]
const LABEL_OPS: LabelFilterOp[] = ['=', '!=', '=~', '!~', '>', '>=', '<', '<=']

const ctl = 'h-7 rounded-md border border-edge-default bg-surface-app px-2 text-[11px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none'

export function LogQLBuilder({
  query,
  sel,
  onChange,
  onRun,
}: {
  query: string
  sel: TimeSelection
  onChange(q: string): void
  onRun(q: string): void
}) {
  const parsed = useMemo(() => parseLogQL(query), [query])
  const [fallback, setFallback] = useState<LogQLSpec | null>(null)
  // Keep the form's own state (incl. half-filled rows that don't render to
  // LogQL yet) while it still describes the query; re-parse when the query
  // was changed elsewhere (code editor, history, facet click).
  const spec = fallback && buildLogQL(fallback) === query.trim() ? fallback : parsed
  const labels = useLogLabels(sel)

  if (!spec) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-edge-default px-3 py-2 text-[11px] text-content-muted">
        This query uses LogQL the builder can't represent (e.g. <code className="font-mono">unwrap</code>, <code className="font-mono">label_format</code>, binary ops) — edit it in Code.
        <button
          type="button"
          onClick={() => {
            const s = structuredClone(EMPTY_SPEC)
            s.matchers = [{ key: 'namespace', op: '=', value: '' }]
            setFallback(s)
            onChange(buildLogQL(s))
          }}
          className="rounded-md px-2 py-0.5 font-medium text-brand-700 hover:bg-surface-sunken dark:text-brand-300"
        >
          Start a new query in the builder
        </button>
      </div>
    )
  }

  const update = (fn: (s: LogQLSpec) => void) => {
    const next = structuredClone(spec)
    fn(next)
    setFallback(next)
    onChange(buildLogQL(next))
  }
  const problems = validateSpec(spec)
  const selector = buildSelector(spec.matchers.filter((m) => m.value))

  return (
    <div className="space-y-2 rounded-lg border border-edge-subtle bg-surface-sunken/30 p-2.5">
      <Row label="Streams">
        {spec.matchers.map((m, i) => (
          <MatcherEditor
            key={i}
            m={m}
            labels={labels.data ?? []}
            sel={sel}
            selector={selector === '{}' ? '' : selector}
            onChange={(next) => update((s) => { s.matchers[i] = next })}
            onRemove={() => update((s) => { s.matchers.splice(i, 1) })}
          />
        ))}
        <AddBtn onClick={() => update((s) => { s.matchers.push({ key: '', op: '=', value: '' }) })}>label</AddBtn>
      </Row>

      <Row label="Line">
        {spec.lineFilters.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <select aria-label="Line filter" value={f.op} onChange={(e) => update((s) => { s.lineFilters[i].op = e.target.value as LineFilterOp })} className={ctl}>
              {LINE_OPS.map(([op, l]) => <option key={op} value={op}>{l}</option>)}
            </select>
            <input aria-label="Line filter text" value={f.value} onChange={(e) => update((s) => { s.lineFilters[i].value = e.target.value })} placeholder="error" className={cn(ctl, 'w-40 font-mono')} />
            <RemoveBtn onClick={() => update((s) => { s.lineFilters.splice(i, 1) })} />
          </span>
        ))}
        <AddBtn onClick={() => update((s) => { s.lineFilters.push({ op: '|=', value: '' }) })}>line filter</AddBtn>
      </Row>

      <Row label="Parse">
        <select aria-label="Parser" value={spec.parser} onChange={(e) => update((s) => { s.parser = e.target.value as ParserKind })} className={ctl}>
          <option value="none">no parser</option>
          <option value="json">json</option>
          <option value="logfmt">logfmt</option>
          <option value="pattern">pattern</option>
          <option value="regexp">regexp</option>
        </select>
        {spec.parser === 'pattern' || spec.parser === 'regexp' ? (
          <input
            aria-label="Parser expression"
            value={spec.parserArg ?? ''}
            onChange={(e) => update((s) => { s.parserArg = e.target.value })}
            placeholder={spec.parser === 'pattern' ? '<ip> - - <_> "<method> <path> <_>" <status>' : '(?P<status>\\d{3})'}
            className={cn(ctl, 'min-w-60 flex-1 font-mono')}
          />
        ) : null}
        {spec.labelFilters.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <input aria-label="Field" value={f.key} onChange={(e) => update((s) => { s.labelFilters[i].key = e.target.value })} placeholder="status" className={cn(ctl, 'w-28 font-mono')} />
            <select aria-label="Field operator" value={f.op} onChange={(e) => update((s) => { s.labelFilters[i].op = e.target.value as LabelFilterOp })} className={cn(ctl, 'font-mono')}>
              {LABEL_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input aria-label="Field value" value={f.value} onChange={(e) => update((s) => { s.labelFilters[i].value = e.target.value })} placeholder="500" className={cn(ctl, 'w-28 font-mono')} />
            <RemoveBtn onClick={() => update((s) => { s.labelFilters.splice(i, 1) })} />
          </span>
        ))}
        <AddBtn onClick={() => update((s) => { s.labelFilters.push({ key: '', op: '=', value: '' }) })}>field filter</AddBtn>
        <input
          aria-label="line_format template"
          value={spec.lineFormat ?? ''}
          onChange={(e) => update((s) => { s.lineFormat = e.target.value || undefined })}
          placeholder="line_format {{.msg}}"
          className={cn(ctl, 'w-44 font-mono')}
        />
      </Row>

      <Row label="Metric">
        <select aria-label="Metric function" value={spec.metric.fn} onChange={(e) => update((s) => { s.metric.fn = e.target.value as MetricFn })} className={ctl}>
          <option value="none">show log lines</option>
          <option value="count_over_time">count_over_time</option>
          <option value="rate">rate (lines/s)</option>
          <option value="bytes_over_time">bytes_over_time</option>
          <option value="bytes_rate">bytes_rate</option>
        </select>
        {spec.metric.fn !== 'none' ? (
          <>
            <input aria-label="Range" value={spec.metric.range} onChange={(e) => update((s) => { s.metric.range = e.target.value })} className={cn(ctl, 'w-16 font-mono')} />
            <select aria-label="Aggregation" value={spec.metric.agg} onChange={(e) => update((s) => { s.metric.agg = e.target.value as MetricAgg })} className={ctl}>
              {(['sum', 'avg', 'max', 'min', 'topk', 'none'] as MetricAgg[]).map((a) => <option key={a} value={a}>{a === 'none' ? 'no aggregation' : a}</option>)}
            </select>
            {spec.metric.agg === 'topk' ? (
              <input aria-label="k" type="number" min={1} value={spec.metric.k ?? 10} onChange={(e) => update((s) => { s.metric.k = Number(e.target.value) || 10 })} className={cn(ctl, 'w-14')} />
            ) : null}
            {spec.metric.agg !== 'none' ? (
              <input
                aria-label="Group by labels"
                list="logql-labels"
                value={spec.metric.by.join(', ')}
                onChange={(e) => update((s) => { s.metric.by = e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
                placeholder="by namespace, app"
                className={cn(ctl, 'w-44 font-mono')}
              />
            ) : null}
          </>
        ) : null}
      </Row>
      <datalist id="logql-labels">{(labels.data ?? []).map((l) => <option key={l} value={l} />)}</datalist>

      <div className="flex flex-wrap items-center gap-2">
        {problems.length ? (
          <span className="text-[11px] text-amber-700 dark:text-amber-300">{problems[0]}</span>
        ) : (
          <span className="text-[11px] text-content-subtle">Builder edits the query above.</span>
        )}
        <button
          type="button"
          disabled={problems.length > 0}
          onClick={() => onRun(buildLogQL(spec))}
          className="ml-auto inline-flex h-7 items-center rounded-md bg-brand-600 px-3 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
        >
          Run query
        </button>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      {children}
    </div>
  )
}

function AddBtn({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
      + {children}
    </button>
  )
}

function RemoveBtn({ onClick }: { onClick(): void }) {
  return (
    <button type="button" aria-label="Remove" onClick={onClick} className="flex h-7 w-6 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
      ×
    </button>
  )
}

function MatcherEditor({
  m,
  labels,
  sel,
  selector,
  onChange,
  onRemove,
}: {
  m: LogQLSpec['matchers'][number]
  labels: string[]
  sel: TimeSelection
  selector: string
  onChange(m: LogQLSpec['matchers'][number]): void
  onRemove(): void
}) {
  const values = useLogLabelValues(m.key || null, sel, selector || undefined)
  const id = `lv-${m.key}`
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-edge-subtle bg-surface-raised p-0.5">
      <select aria-label="Label" value={m.key} onChange={(e) => onChange({ ...m, key: e.target.value })} className={cn(ctl, 'border-0 font-mono')}>
        <option value="">label…</option>
        {m.key && !labels.includes(m.key) ? <option value={m.key}>{m.key}</option> : null}
        {labels.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      <select aria-label="Matcher operator" value={m.op} onChange={(e) => onChange({ ...m, op: e.target.value as MatcherOp })} className={cn(ctl, 'border-0 font-mono')}>
        {MATCH_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <input aria-label="Label value" list={id} value={m.value} onChange={(e) => onChange({ ...m, value: e.target.value })} placeholder="value" className={cn(ctl, 'w-40 border-0 font-mono')} />
      <datalist id={id}>{(values.data ?? []).slice(0, 500).map((v) => <option key={v} value={v} />)}</datalist>
      <RemoveBtn onClick={onRemove} />
    </span>
  )
}
