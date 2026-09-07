import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EmptyState, LegendDot, LokiIcon, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import {
  DEFAULT_RANGE,
  TIME_RANGES,
  bucketLogsByLevel,
  presetSelection,
  selectionLabel,
  selectionToWindow,
  useLogs,
  type HistogramBucket,
  type TimeRangeId,
  type TimeSelection,
} from '../data/observability.ts'
import {
  EMPTY_TEXT_FILTER,
  clearHistory,
  compileFilter,
  dedupKey,
  deleteSaved,
  formatTs,
  labelsOf,
  loadHistory,
  loadSaved,
  parseLine,
  pushHistory,
  saveQuery,
  splitMatches,
  toExport,
  withMatcher,
  type DedupMode,
  type SavedQuery,
  type TextFilter,
  type TsFormat,
} from '../data/log-fields.ts'
import { SourceError } from './states.tsx'
import {
  HIST_COLOR,
  Histogram,
  IconBolt,
  IconBtn,
  IconChevron,
  IconClock,
  IconCollapse,
  IconDownload,
  IconExpand,
  IconHistory,
  IconLabels,
  IconPlay,
  IconReset,
  IconSearch,
  IconSidebar,
  IconStar,
  IconTag,
  IconTrash,
  IconWrap,
  IconX,
  LEVELS,
  LEVEL_BAR,
  LEVEL_CHIP,
  LEVEL_TONE,
  LabelBrowser,
  LogDetailDrawer,
  LokiBadge,
  copy,
  levelOf,
  type Level,
} from './logs-panels.tsx'

/**
 * Logs explorer — enterprise LogQL workbench on top of Loki.
 *
 * Query      — LogQL bar with Run / ⌘⏎, recent history, saved queries, a
 *              label browser (Loki `/labels` + `/label/{name}/values`) that
 *              merges matchers into the selector, and starter queries.
 * Time       — quick presets, absolute from/to, histogram click-to-zoom,
 *              **Live** tail (sliding window, 4 s refresh) with pause.
 * Refine     — level chips with counts, client-side text filter (plain /
 *              regex, case, exclude) with match highlighting, dedup
 *              (exact / numbers / signature), order, limit.
 * Read       — stats strip (lines, errors, warnings, rate, streams, formats),
 *              level-coloured histogram, facets sidebar from stream labels +
 *              detected fields (click to filter, ＋ to pin in the query),
 *              stream with level gutter, timestamps (time / ISO / relative),
 *              wrap + label toggles, repeat counters, fullscreen.
 * Drill in   — row drawer: stream labels (pin / exclude), parsed JSON /
 *              logfmt fields (filter for / out), raw view, and **context**
 *              (±N lines from the same stream around the line).
 * Out        — export visible lines as .txt / .json / .csv, copy line/JSON.
 *
 * Everything renders what Loki actually returned — no synthetic fill.
 */

const STARTERS: Array<{ label: string; query: string; hint: string }> = [
  { label: 'Errors everywhere', query: '{namespace=~".+"} |= "error"', hint: 'any namespace, lines containing "error"' },
  { label: 'Platform system', query: '{namespace="adhar-system"}', hint: 'the Adhar control plane' },
  { label: 'Argo CD', query: '{namespace="argocd"}', hint: 'sync + controller logs' },
  { label: 'HTTP 5xx', query: '{namespace=~".+"} |~ "status=5[0-9]{2}"', hint: 'regex line filter' },
  { label: 'Slow queries', query: '{namespace=~".+"} |~ "(?i)slow (query|request)"', hint: 'case-insensitive regex' },
  { label: 'JSON errors', query: '{namespace=~".+"} | json | level="error"', hint: 'structured logs, parsed' },
]

const LIMITS = [100, 200, 500, 1000, 2000, 5000]

interface Prefs {
  wrap: boolean
  showLabels: boolean
  ts: TsFormat
  order: 'newest' | 'oldest'
  dedup: DedupMode
  limit: number
  facets: boolean
}

const DEFAULT_PREFS: Prefs = { wrap: true, showLabels: true, ts: 'time', order: 'newest', dedup: 'none', limit: 500, facets: true }
const PREFS_KEY = 'adhar.discover.logs.prefs.v1'

function loadPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY)
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

type FacetFilter = Map<string, Set<string>>

interface Row {
  entry: lgtm.LogEntry
  /** Times this line repeated when dedup is on. */
  repeats: number
}

export function Logs() {
  /* ── query & time ── */
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<TimeSelection>(presetSelection(DEFAULT_RANGE))
  const [live, setLive] = useState(false)
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSaved())

  /* ── refine ── */
  const [levels, setLevels] = useState<Set<string>>(new Set(LEVELS))
  const [text, setText] = useState<TextFilter>(EMPTY_TEXT_FILTER)
  const [facet, setFacet] = useState<FacetFilter>(new Map())
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs())
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch }
      try {
        globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  /* ── ui ── */
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [selected, setSelected] = useState<lgtm.LogEntry | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const hasQuery = query.trim().length > 0
  const q = useLogs(query, sel, prefs.limit, { live })
  const all = q.data ?? []

  /* ── run / helpers ── */
  const run = useCallback(
    (next?: string) => {
      const text = (next ?? draft).trim()
      if (next !== undefined) setDraft(next)
      setQuery(text)
      if (text) setHistory(pushHistory(text))
      setLabelsOpen(false)
      setHistoryOpen(false)
      setFacet(new Map())
    },
    [draft],
  )

  // "/" focuses the query from anywhere; ⌘/Ctrl+Enter runs it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  // Live tail only makes sense on a sliding preset window.
  useEffect(() => {
    if (sel.kind === 'absolute' && live) setLive(false)
  }, [sel, live])

  /* ── derived data ── */
  const matcher = useMemo(() => compileFilter(text), [text])

  const counts = useMemo(() => {
    const out: Record<Level, number> = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }
    for (const l of all) out[levelOf(l)] += 1
    return out
  }, [all])

  const facets = useMemo(() => buildFacets(all), [all])

  const rows = useMemo<Row[]>(() => {
    let list = all.filter((l) => levels.has(levelOf(l)))
    if (facet.size) {
      list = list.filter((l) => {
        for (const [key, vals] of facet) {
          const v = key.startsWith('field:') ? parseLine(l).fields[key.slice(6)] : labelsOf(l)[key]
          if (!vals.has(v ?? '')) return false
        }
        return true
      })
    }
    if (matcher) {
      list = list.filter((l) => {
        matcher.lastIndex = 0
        const hit = matcher.test(l.message)
        return text.exclude ? !hit : hit
      })
    }
    list = [...list].sort((a, b) =>
      prefs.order === 'newest' ? b.timestamp.localeCompare(a.timestamp) : a.timestamp.localeCompare(b.timestamp),
    )
    if (prefs.dedup === 'none') return list.map((entry) => ({ entry, repeats: 0 }))
    const seen = new Map<string, Row>()
    const out: Row[] = []
    for (const entry of list) {
      const key = dedupKey(entry.message, prefs.dedup)
      const prev = seen.get(key)
      if (prev) prev.repeats += 1
      else {
        const row = { entry, repeats: 0 }
        seen.set(key, row)
        out.push(row)
      }
    }
    return out
  }, [all, levels, facet, matcher, text.exclude, prefs.order, prefs.dedup])

  const buckets = useMemo(() => {
    const { start, end } = selectionToWindow(sel)
    return bucketLogsByLevel(all, start, end, 60)
  }, [all, sel])

  const stats = useMemo(() => computeStats(all, buckets, sel), [all, buckets, sel])

  const hidden = all.length - rows.length - rows.reduce((s, r) => s + r.repeats, 0)
  const refining = levels.size !== LEVELS.length || facet.size > 0 || !!text.text.trim()

  const zoomTo = (b: HistogramBucket) => {
    setLive(false)
    setSel({ kind: 'absolute', from: new Date(b.start).toISOString(), to: new Date(b.end).toISOString() })
  }

  const toggleFacet = (key: string, value: string) => {
    setFacet((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(key) ?? [])
      if (set.has(value)) set.delete(value)
      else set.add(value)
      if (set.size) next.set(key, set)
      else next.delete(key)
      return next
    })
  }

  const exportAs = (kind: 'txt' | 'json' | 'csv') => {
    const body = toExport(rows.map((r) => r.entry), kind)
    const blob = new Blob([body], { type: kind === 'json' ? 'application/json' : 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `logs-${new Date().toISOString().replace(/[:.]/g, '-')}.${kind}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setExportOpen(false)
  }

  return (
    <div className={cn('space-y-3', fullscreen && 'fixed inset-0 z-40 overflow-y-auto bg-surface-app p-4')}>
      {/* ═══════════ query bar ═══════════ */}
      <section className="relative rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
        <div className="flex items-start gap-2 p-2.5">
          <div className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-surface-sunken px-2.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            <LokiIcon size={13} /> LogQL
          </div>
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={inputRef}
              value={draft}
              rows={1}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  run()
                } else if (e.key === 'Escape') {
                  setLabelsOpen(false)
                  setHistoryOpen(false)
                }
              }}
              placeholder='{namespace="my-app"} |= "error"  — press / to focus, Enter to run'
              aria-label="LogQL query"
              className={cn(
                'block max-h-32 min-h-10 w-full resize-y rounded-lg border border-edge-default bg-surface-app px-3 py-2.5 pr-8 font-mono text-[12.5px] leading-5 text-content shadow-inner placeholder:text-content-subtle',
                'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
              )}
            />
            {draft ? (
              <button
                type="button"
                aria-label="Clear query"
                onClick={() => {
                  setDraft('')
                  inputRef.current?.focus()
                }}
                className="absolute right-2 top-2.5 flex h-5 w-5 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken hover:text-content"
              >
                <IconX />
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconBtn label="Browse labels" active={labelsOpen} onClick={() => { setLabelsOpen((o) => !o); setHistoryOpen(false) }}>
              <IconTag />
            </IconBtn>
            <div className="relative">
              <IconBtn label="History & saved queries" active={historyOpen} onClick={() => { setHistoryOpen((o) => !o); setLabelsOpen(false) }}>
                <IconHistory />
              </IconBtn>
              {historyOpen ? (
                <HistoryMenu
                  history={history}
                  saved={saved}
                  onPick={(qq) => run(qq)}
                  onDeleteSaved={(name) => setSaved(deleteSaved(name))}
                  onClearHistory={() => setHistory(clearHistory())}
                  onClose={() => setHistoryOpen(false)}
                />
              ) : null}
            </div>
            <div className="relative">
              <IconBtn label="Save query" active={saveOpen} onClick={() => setSaveOpen((o) => !o)}>
                <IconStar filled={saved.some((s) => s.query === draft.trim() && !!draft.trim())} />
              </IconBtn>
              {saveOpen ? (
                <SavePopover
                  query={draft}
                  onSave={(name) => {
                    setSaved(saveQuery(name, draft))
                    setSaveOpen(false)
                  }}
                  onClose={() => setSaveOpen(false)}
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => run()}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
            >
              <IconPlay /> Run
            </button>
            <button
              type="button"
              aria-pressed={live}
              disabled={!hasQuery || sel.kind === 'absolute'}
              title={sel.kind === 'absolute' ? 'Live tail needs a relative range' : live ? 'Pause live tail' : 'Start live tail'}
              onClick={() => setLive((v) => !v)}
              className={cn(
                'inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                live
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
              )}
            >
              {live ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </>
              ) : (
                <>
                  <IconBolt /> Live
                </>
              )}
            </button>
          </div>
        </div>

        {/* time · levels · view */}
        <div className="flex flex-wrap items-center gap-2 border-t border-edge-subtle px-2.5 py-2">
          <RangeSelect sel={sel} onPreset={(id) => setSel(presetSelection(id))} />
          <CustomRange sel={sel} onApply={(from, to) => { setLive(false); setSel({ kind: 'absolute', from, to }) }} />
          {sel.kind === 'absolute' ? (
            <button type="button" onClick={() => setSel(presetSelection(DEFAULT_RANGE))} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] text-content-muted hover:bg-surface-sunken hover:text-content" title="Back to the last hour">
              <IconReset /> reset
            </button>
          ) : null}
          <span className="mx-1 hidden h-5 w-px bg-edge-subtle sm:block" />
          <LevelChips levels={levels} counts={counts} onChange={setLevels} />
          <span className="ml-auto flex items-center gap-1.5">
            {q.isFetching && hasQuery ? (
              <span className="mr-1 inline-flex items-center gap-1 text-[10px] text-content-subtle"><Spinner size={10} /> {live ? 'tailing' : 'refreshing'}</span>
            ) : null}
            <IconBtn label={prefs.facets ? 'Hide facets' : 'Show facets'} active={prefs.facets} onClick={() => setPrefs({ facets: !prefs.facets })}><IconSidebar /></IconBtn>
            <IconBtn label={prefs.wrap ? 'Disable line wrap' : 'Wrap long lines'} active={prefs.wrap} onClick={() => setPrefs({ wrap: !prefs.wrap })}><IconWrap /></IconBtn>
            <IconBtn label={prefs.showLabels ? 'Hide labels' : 'Show labels'} active={prefs.showLabels} onClick={() => setPrefs({ showLabels: !prefs.showLabels })}><IconLabels /></IconBtn>
            <div className="relative">
              <IconBtn label="Export visible lines" active={exportOpen} onClick={() => setExportOpen((o) => !o)}><IconDownload /></IconBtn>
              {exportOpen ? (
                <Popover onClose={() => setExportOpen(false)} className="right-0 w-44">
                  {(['txt', 'json', 'csv'] as const).map((k) => (
                    <button key={k} type="button" disabled={rows.length === 0} onClick={() => exportAs(k)} className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-content-muted hover:bg-surface-sunken hover:text-content disabled:opacity-50">
                      <span>Download .{k}</span>
                      <span className="font-mono text-[10px] text-content-subtle">{rows.length}</span>
                    </button>
                  ))}
                </Popover>
              ) : null}
            </div>
            <IconBtn label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} active={fullscreen} onClick={() => setFullscreen((f) => !f)}>
              {fullscreen ? <IconCollapse /> : <IconExpand />}
            </IconBtn>
          </span>
        </div>

        {labelsOpen ? (
          <div className="relative px-2.5">
            <LabelBrowser sel={sel} draft={draft} onDraft={setDraft} onClose={() => setLabelsOpen(false)} />
          </div>
        ) : null}
      </section>

      {/* ═══════════ empty · error ═══════════ */}
      {!hasQuery ? (
        <Welcome onPick={(qq) => run(qq)} onBrowse={() => setLabelsOpen(true)} history={history} saved={saved} />
      ) : q.isError ? (
        <div className="rounded-2xl border border-edge-default bg-surface-raised p-6 shadow-sm">
          <SourceError compact tool="Loki" error={q.error} onRetry={() => q.refetch()} icon={<LokiIcon size={20} />} />
        </div>
      ) : (
        <>
          {/* ═══════════ stats + volume ═══════════ */}
          <section className="overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
            <div className="grid grid-cols-2 divide-y divide-edge-subtle border-b border-edge-subtle sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6 lg:divide-x">
              <Stat label="Lines" value={fmtNum(all.length)} hint={all.length >= prefs.limit ? `capped at ${fmtNum(prefs.limit)} — narrow the query` : selectionLabel(sel)} warn={all.length >= prefs.limit} />
              <Stat label="Errors" value={fmtNum(counts.error + counts.fatal)} hint={`${stats.errorPct}% of lines`} tone={counts.error + counts.fatal ? 'rose' : undefined} />
              <Stat label="Warnings" value={fmtNum(counts.warn)} hint={`${stats.warnPct}% of lines`} tone={counts.warn ? 'amber' : undefined} />
              <Stat label="Rate" value={`${stats.perMin}`} hint="lines / min" />
              <Stat label="Streams" value={fmtNum(stats.streams)} hint="distinct label sets" />
              <Stat label="Peak" value={stats.peak ? fmtNum(stats.peak.n) : '—'} hint={stats.peak ? `at ${stats.peak.at}` : 'no volume'} />
            </div>
            <div className="px-4 pb-3 pt-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[11px] text-content-subtle">
                  <span className="font-semibold uppercase tracking-wider">Volume</span>
                  <span>{selectionLabel(sel)}</span>
                  <span className="hidden sm:inline">· click a bar to zoom</span>
                </div>
                <div className="flex items-center gap-3">
                  <LegendDot color={HIST_COLOR.error}>error</LegendDot>
                  <LegendDot color={HIST_COLOR.warn}>warn</LegendDot>
                  <LegendDot color={HIST_COLOR.info}>info</LegendDot>
                </div>
              </div>
              <Histogram buckets={buckets} levels={levels} onZoom={zoomTo} />
            </div>
          </section>

          {/* ═══════════ facets + stream ═══════════ */}
          <div className={cn('grid gap-3', prefs.facets && 'lg:grid-cols-[240px_minmax(0,1fr)]')}>
            {prefs.facets ? (
              <Facets facets={facets} active={facet} onToggle={toggleFacet} onPin={(k, v) => run(withMatcher(draft || query, k, v))} onClear={() => setFacet(new Map())} />
            ) : null}

            <section className="min-w-0 overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
              {/* stream toolbar */}
              <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-3 py-2">
                <div className="relative flex min-w-56 flex-1 items-center">
                  <span className="pointer-events-none absolute left-2.5 text-content-subtle"><IconSearch /></span>
                  <input
                    value={text.text}
                    onChange={(e) => setText({ ...text, text: e.target.value })}
                    placeholder="Filter lines in this result (no re-query)"
                    aria-label="Filter lines"
                    className={cn(
                      'h-8 w-full rounded-lg border border-edge-default bg-surface-app pl-8 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
                      text.regex && 'font-mono',
                      matcher === null && text.text.trim() && text.regex && 'border-rose-400',
                    )}
                  />
                </div>
                <Toggle on={text.regex} onClick={() => setText({ ...text, regex: !text.regex })} title="Regular expression">.*</Toggle>
                <Toggle on={text.caseSensitive} onClick={() => setText({ ...text, caseSensitive: !text.caseSensitive })} title="Match case">Aa</Toggle>
                <Toggle on={text.exclude} onClick={() => setText({ ...text, exclude: !text.exclude })} title="Hide matching lines">¬</Toggle>
                <span className="mx-0.5 hidden h-5 w-px bg-edge-subtle md:block" />
                <Select value={prefs.dedup} onChange={(v) => setPrefs({ dedup: v as DedupMode })} title="Deduplicate repeated lines" options={[['none', 'Dedup: off'], ['exact', 'Dedup: exact'], ['numbers', 'Dedup: numbers'], ['signature', 'Dedup: signature']]} />
                <Select value={prefs.order} onChange={(v) => setPrefs({ order: v as Prefs['order'] })} title="Sort order" options={[['newest', 'Newest first'], ['oldest', 'Oldest first']]} />
                <Select value={String(prefs.limit)} onChange={(v) => setPrefs({ limit: Number(v) })} title="Max lines fetched" options={LIMITS.map((n) => [String(n), `Limit ${fmtNum(n)}`])} />
                <Select value={prefs.ts} onChange={(v) => setPrefs({ ts: v as TsFormat })} title="Timestamp format" options={[['time', 'HH:mm:ss.SSS'], ['iso', 'ISO 8601'], ['relative', 'Relative']]} />
              </div>

              {/* result summary */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge-subtle bg-surface-sunken/50 px-3 py-1.5 text-[11px] text-content-muted">
                <span>
                  <span className="font-semibold tabular-nums text-content">{fmtNum(rows.length)}</span> shown
                  {hidden > 0 ? <> · <span className="tabular-nums">{fmtNum(hidden)}</span> hidden by filters</> : null}
                  {prefs.dedup !== 'none' ? <> · <span className="tabular-nums">{fmtNum(rows.reduce((s, r) => s + r.repeats, 0))}</span> collapsed</> : null}
                </span>
                {refining ? (
                  <button type="button" onClick={() => { setLevels(new Set(LEVELS)); setFacet(new Map()); setText(EMPTY_TEXT_FILTER) }} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                    Clear refinements
                  </button>
                ) : null}
                <span className="ml-auto inline-flex items-center gap-2">
                  <LokiBadge />
                  <span className="font-mono text-[10px] text-content-subtle">{prefs.order === 'newest' ? '↓ newest' : '↑ oldest'}</span>
                </span>
              </div>

              {/* stream */}
              {q.isLoading ? (
                <StreamSkeleton />
              ) : rows.length === 0 ? (
                <div className="p-8">
                  <EmptyState
                    compact
                    title={all.length === 0 ? 'No log lines in this window' : 'Every line is filtered out'}
                    description={all.length === 0 ? 'Widen the time range, loosen the selector, or check the label browser for what Loki has.' : 'Relax the level, facet or text filters to see lines again.'}
                  />
                </div>
              ) : (
                <ol className={cn('divide-y divide-edge-subtle font-mono text-[12px]', !prefs.wrap && 'overflow-x-auto')}>
                  {rows.map((r, i) => (
                    <LogRow
                      key={`${r.entry.timestamp}-${i}`}
                      row={r}
                      ts={prefs.ts}
                      wrap={prefs.wrap}
                      showLabels={prefs.showLabels}
                      matcher={matcher}
                      onOpen={() => setSelected(r.entry)}
                      onFacet={toggleFacet}
                    />
                  ))}
                </ol>
              )}
            </section>
          </div>
        </>
      )}

      {selected ? (
        <LogDetailDrawer
          entry={selected}
          query={query}
          onClose={() => setSelected(null)}
          onQuery={(next) => {
            setSelected(null)
            run(next)
          }}
          onWindow={(from, to) => {
            setLive(false)
            setSel({ kind: 'absolute', from, to })
          }}
        />
      ) : null}
    </div>
  )
}

/* ─────────── welcome (no query yet) ─────────── */

function Welcome({
  onPick,
  onBrowse,
  history,
  saved,
}: {
  onPick(q: string): void
  onBrowse(): void
  history: string[]
  saved: SavedQuery[]
}) {
  return (
    <section className="rounded-2xl border border-edge-default bg-surface-raised p-6 shadow-sm">
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="max-w-md">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-md shadow-brand-600/25"><LokiIcon size={22} /></span>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-content">Search your logs</h2>
              <p className="text-[12px] text-content-muted">Loki needs a stream selector to start. Pick a starter, browse labels, or type LogQL above.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onBrowse} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content-muted hover:border-brand-300 hover:text-content">
              <IconTag /> Browse labels
            </button>
            <span className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-sunken px-3 text-[11px] text-content-subtle">
              <kbd className="rounded border border-edge-default bg-surface-raised px-1 font-mono text-[10px]">/</kbd> focus
              <kbd className="ml-2 rounded border border-edge-default bg-surface-raised px-1 font-mono text-[10px]">⏎</kbd> run
            </span>
          </div>
          {saved.length ? (
            <div className="mt-5">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Saved</div>
              <div className="flex flex-wrap gap-1.5">
                {saved.slice(0, 6).map((s) => (
                  <button key={s.name} type="button" onClick={() => onPick(s.query)} title={s.query} className="inline-flex items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content-muted hover:border-brand-300 hover:text-content">
                    <IconStar filled /> {s.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {history.length ? (
            <div className="mt-4">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Recent</div>
              <div className="flex flex-wrap gap-1.5">
                {history.slice(0, 4).map((h) => (
                  <button key={h} type="button" onClick={() => onPick(h)} className="max-w-full truncate rounded-md border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[11px] text-content-muted hover:border-brand-300 hover:text-content">
                    {h}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="grid flex-1 gap-2 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <button
              key={s.query}
              type="button"
              onClick={() => onPick(s.query)}
              className="group rounded-xl border border-edge-default bg-surface-app p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40 dark:hover:bg-brand-500/5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold text-content">{s.label}</span>
                <span className="text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"><IconPlay /></span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-brand-700 dark:text-brand-300">{s.query}</div>
              <div className="mt-1 text-[11px] text-content-subtle">{s.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ─────────── facets ─────────── */

interface FacetGroup {
  key: string
  /** Display name (label or field). */
  label: string
  kind: 'label' | 'field'
  values: Array<{ value: string; n: number }>
  total: number
}

const FACET_PRIORITY = ['namespace', 'app', 'service_name', 'service', 'job', 'pod', 'container', 'instance', 'node', 'level', 'detected_level']

function buildFacets(all: lgtm.LogEntry[]): FacetGroup[] {
  const sample = all.length > 3000 ? all.slice(0, 3000) : all
  const labels = new Map<string, Map<string, number>>()
  const fields = new Map<string, Map<string, number>>()
  for (const e of sample) {
    for (const [k, v] of Object.entries(labelsOf(e))) {
      if (k.startsWith('__')) continue
      const m = labels.get(k) ?? new Map<string, number>()
      m.set(v, (m.get(v) ?? 0) + 1)
      labels.set(k, m)
    }
    const parsed = parseLine(e)
    if (parsed.format === 'text') continue
    for (const [k, v] of Object.entries(parsed.fields)) {
      if (k === 'msg' || k === 'message' || k === 'time' || k === 'ts' || k === 'timestamp' || v.length > 60) continue
      const m = fields.get(k) ?? new Map<string, number>()
      m.set(v, (m.get(v) ?? 0) + 1)
      fields.set(k, m)
    }
  }
  const toGroup = (kind: 'label' | 'field', k: string, m: Map<string, number>): FacetGroup => ({
    key: kind === 'field' ? `field:${k}` : k,
    label: k,
    kind,
    values: [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, n]) => ({ value, n })),
    total: m.size,
  })
  const labelGroups = [...labels.entries()]
    .filter(([, m]) => m.size > 1 || labels.size <= 3)
    .map(([k, m]) => toGroup('label', k, m))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
    .slice(0, 8)
  const fieldGroups = [...fields.entries()]
    .filter(([, m]) => m.size > 1 && m.size < sample.length * 0.9)
    .map(([k, m]) => toGroup('field', k, m))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6)
  return [...labelGroups, ...fieldGroups]
}

function rank(label: string): number {
  const i = FACET_PRIORITY.indexOf(label)
  return i < 0 ? FACET_PRIORITY.length : i
}

function Facets({
  facets,
  active,
  onToggle,
  onPin,
  onClear,
}: {
  facets: FacetGroup[]
  active: FacetFilter
  onToggle(key: string, value: string): void
  onPin(label: string, value: string): void
  onClear(): void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const activeCount = [...active.values()].reduce((s, v) => s + v.size, 0)
  return (
    <aside className="hidden self-start overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm lg:block">
      <div className="flex items-center justify-between border-b border-edge-subtle px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Facets</span>
        {activeCount ? (
          <button type="button" onClick={onClear} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Clear {activeCount}</button>
        ) : null}
      </div>
      {facets.length === 0 ? (
        <p className="px-3 py-4 text-[11px] text-content-subtle">Facets appear once results have labels or structured fields.</p>
      ) : (
        <div className="max-h-[70vh] divide-y divide-edge-subtle overflow-y-auto">
          {facets.map((g) => {
            const max = Math.max(1, ...g.values.map((v) => v.n))
            const isCollapsed = collapsed.has(g.key)
            const set = active.get(g.key)
            return (
              <div key={g.key}>
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n })}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-surface-sunken/60"
                >
                  <span className={cn('text-content-subtle transition-transform', isCollapsed && '-rotate-90')}><IconChevron /></span>
                  <span className="truncate font-mono text-[11px] font-semibold text-content">{g.label}</span>
                  <span className={cn('rounded px-1 text-[9px] font-medium uppercase', g.kind === 'field' ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' : 'bg-surface-sunken text-content-subtle')}>{g.kind}</span>
                  <span className="ml-auto font-mono text-[10px] text-content-subtle">{g.total}</span>
                </button>
                {!isCollapsed ? (
                  <ul className="pb-1.5">
                    {g.values.map((v) => {
                      const on = set?.has(v.value) ?? false
                      return (
                        <li key={v.value} className="group relative">
                          <button
                            type="button"
                            onClick={() => onToggle(g.key, v.value)}
                            title={v.value}
                            className={cn('relative flex w-full items-center gap-2 px-3 py-1 text-left', on ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/60')}
                          >
                            <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-brand-500" style={{ opacity: on ? 1 : 0 }} />
                            <span className="relative min-w-0 flex-1">
                              <span className={cn('block truncate font-mono text-[11px]', on ? 'text-brand-700 dark:text-brand-300' : 'text-content-muted')}>{v.value || '∅'}</span>
                              <span className="mt-0.5 block h-0.5 rounded-full bg-surface-sunken"><span className="block h-full rounded-full bg-brand-400/60" style={{ width: `${(v.n / max) * 100}%` }} /></span>
                            </span>
                            <span className="font-mono text-[10px] tabular-nums text-content-subtle">{v.n}</span>
                          </button>
                          {g.kind === 'label' ? (
                            <button
                              type="button"
                              title={`Pin ${g.label}="${v.value}" in the query`}
                              aria-label={`Pin ${g.label}="${v.value}" in the query`}
                              onClick={() => onPin(g.label, v.value)}
                              className="absolute right-8 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded bg-surface-raised text-[11px] text-content-subtle ring-1 ring-edge-default hover:text-brand-700 group-hover:flex dark:hover:text-brand-300"
                            >
                              +
                            </button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}

/* ─────────── stream row ─────────── */

function LogRow({
  row,
  ts,
  wrap,
  showLabels,
  matcher,
  onOpen,
  onFacet,
}: {
  row: Row
  ts: TsFormat
  wrap: boolean
  showLabels: boolean
  matcher: RegExp | null
  onOpen(): void
  onFacet(key: string, value: string): void
}) {
  const e = row.entry
  const lvl = levelOf(e)
  const parts = useMemo(() => splitMatches(e.message, matcher), [e.message, matcher])
  const labels = showLabels ? Object.entries(labelsOf(e)).filter(([k]) => !k.startsWith('__') && k !== 'detected_level').slice(0, 4) : []
  return (
    <li className="group relative">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            onOpen()
          }
        }}
        className="grid cursor-pointer grid-cols-[3px_auto_auto_minmax(0,1fr)] items-start gap-x-2.5 px-3 py-1.5 transition-colors hover:bg-brand-50/40 focus:outline-none focus-visible:bg-brand-50/60 dark:hover:bg-brand-500/5"
      >
        <span className={cn('mt-0.5 h-[18px] w-[3px] rounded-full', LEVEL_BAR[lvl])} />
        <span className="pt-0.5 text-[10.5px] tabular-nums text-content-subtle" title={new Date(e.timestamp).toISOString()}>
          {formatTs(e.timestamp, ts)}
        </span>
        <StatusBadge kind={LEVEL_TONE[lvl]}>{lvl}</StatusBadge>
        <div className="min-w-0">
          <span className={cn('text-content', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-nowrap')}>
            {parts.map((p, i) =>
              p.hit ? (
                <mark key={i} className="rounded-sm bg-amber-200/80 px-0.5 text-content dark:bg-amber-400/40">{p.text}</mark>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </span>
          {row.repeats > 0 ? (
            <span className="ml-2 inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted" title="Repeated lines collapsed by dedup">
              ×{row.repeats + 1}
            </span>
          ) : null}
          {labels.length ? (
            <span className="mt-0.5 flex flex-wrap gap-1">
              {labels.map(([k, v]) => (
                <button
                  key={k}
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onFacet(k, v)
                  }}
                  title={`Filter by ${k}="${v}"`}
                  className="inline-flex max-w-64 items-center rounded bg-surface-sunken px-1.5 py-0.5 text-[9.5px] text-content-subtle hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-300"
                >
                  <span className="opacity-60">{k}=</span>
                  <span className="truncate">{v}</span>
                </button>
              ))}
            </span>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          copy(e.message)
        }}
        title="Copy line"
        aria-label="Copy line"
        className="absolute right-2 top-1.5 hidden h-6 w-6 items-center justify-center rounded bg-surface-raised text-content-subtle ring-1 ring-edge-default hover:text-content group-hover:flex"
      >
        <IconCopySmall />
      </button>
    </li>
  )
}

function IconCopySmall() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function StreamSkeleton() {
  return (
    <ol className="divide-y divide-edge-subtle">
      {Array.from({ length: 10 }).map((_, i) => (
        <li key={i} className="grid grid-cols-[3px_86px_48px_1fr] items-center gap-2.5 px-3 py-2">
          <span className="h-4 w-[3px] rounded-full bg-surface-sunken" />
          <span className="h-3 rounded bg-surface-sunken" />
          <span className="h-4 rounded-full bg-surface-sunken" />
          <span className="h-3 rounded bg-surface-sunken" style={{ width: `${45 + ((i * 37) % 50)}%` }} />
        </li>
      ))}
    </ol>
  )
}

/* ─────────── stats ─────────── */

function computeStats(all: lgtm.LogEntry[], buckets: HistogramBucket[], sel: TimeSelection) {
  const n = all.length || 1
  let err = 0
  let warn = 0
  const streams = new Set<string>()
  for (const l of all) {
    const lv = levelOf(l)
    if (lv === 'error' || lv === 'fatal') err++
    else if (lv === 'warn') warn++
    streams.add(JSON.stringify(labelsOf(l)))
  }
  const { start, end } = selectionToWindow(sel)
  const minutes = Math.max(1 / 60, (end.getTime() - start.getTime()) / 60_000)
  let peak: { n: number; at: string } | null = null
  for (const b of buckets) {
    const t = b.info + b.warn + b.error
    if (t > (peak?.n ?? 0)) {
      const d = new Date(b.start)
      const p = (x: number) => String(x).padStart(2, '0')
      peak = { n: t, at: `${p(d.getHours())}:${p(d.getMinutes())}` }
    }
  }
  const perMinRaw = all.length / minutes
  return {
    errorPct: all.length ? Math.round((err / n) * 100) : 0,
    warnPct: all.length ? Math.round((warn / n) * 100) : 0,
    perMin: perMinRaw >= 10 ? Math.round(perMinRaw).toLocaleString() : perMinRaw.toFixed(1),
    streams: streams.size,
    peak,
  }
}

function Stat({ label, value, hint, tone, warn = false }: { label: string; value: string; hint: string; tone?: 'rose' | 'amber'; warn?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('text-xl font-semibold leading-none tabular-nums tracking-tight', tone === 'rose' ? 'text-rose-600 dark:text-rose-300' : tone === 'amber' ? 'text-amber-600 dark:text-amber-300' : 'text-content')}>{value}</span>
      <span className={cn('truncate text-[10.5px]', warn ? 'text-amber-600 dark:text-amber-300' : 'text-content-subtle')} title={hint}>{hint}</span>
    </div>
  )
}

/* ─────────── level chips ─────────── */

function LevelChips({ levels, counts, onChange }: { levels: Set<string>; counts: Record<Level, number>; onChange(next: Set<string>): void }) {
  const only = (lvl: Level) => onChange(new Set([lvl]))
  const all = levels.size === LEVELS.length
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised p-0.5">
      {LEVELS.map((lvl) => {
        const on = levels.has(lvl)
        return (
          <button
            key={lvl}
            type="button"
            aria-pressed={on}
            onClick={(e) => {
              if (e.altKey || e.metaKey) return only(lvl)
              const next = new Set(levels)
              if (on) next.delete(lvl)
              else next.add(lvl)
              onChange(next)
            }}
            onDoubleClick={() => only(lvl)}
            title={`${lvl} — click to toggle, double-click for only ${lvl}`}
            className={cn('inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold ring-1 ring-inset transition-colors', on ? LEVEL_CHIP[lvl] : 'text-content-subtle ring-transparent hover:bg-surface-sunken')}
          >
            {lvl}
            <span className="font-mono text-[9.5px] tabular-nums opacity-70">{fmtNum(counts[lvl])}</span>
          </button>
        )
      })}
      {!all ? (
        <button type="button" onClick={() => onChange(new Set(LEVELS))} className="ml-0.5 h-7 rounded-md px-1.5 text-[10px] text-content-subtle hover:bg-surface-sunken hover:text-content" title="Show all levels">all</button>
      ) : null}
    </div>
  )
}

/* ─────────── history / save popovers ─────────── */

function HistoryMenu({
  history,
  saved,
  onPick,
  onDeleteSaved,
  onClearHistory,
  onClose,
}: {
  history: string[]
  saved: SavedQuery[]
  onPick(q: string): void
  onDeleteSaved(name: string): void
  onClearHistory(): void
  onClose(): void
}) {
  return (
    <Popover onClose={onClose} className="right-0 w-[28rem] max-w-[90vw]">
      <div className="max-h-96 overflow-y-auto">
        <div className="flex items-center justify-between px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          <span>Saved queries</span>
          <span>{saved.length}</span>
        </div>
        {saved.length === 0 ? (
          <p className="px-2 pb-2 text-[11px] text-content-subtle">Star a query to keep it here.</p>
        ) : (
          <ul className="pb-1">
            {saved.map((s) => (
              <li key={s.name} className="group flex items-center gap-1">
                <button type="button" onClick={() => onPick(s.query)} className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-content"><IconStar filled /> {s.name}</div>
                  <div className="truncate font-mono text-[10.5px] text-content-subtle">{s.query}</div>
                </button>
                <button type="button" onClick={() => onDeleteSaved(s.name)} aria-label={`Delete ${s.name}`} className="rounded p-1 text-content-subtle opacity-0 hover:bg-surface-sunken hover:text-rose-600 group-hover:opacity-100"><IconTrash /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex items-center justify-between border-t border-edge-subtle px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          <span>Recent</span>
          {history.length ? <button type="button" onClick={onClearHistory} className="font-medium normal-case tracking-normal text-content-subtle hover:text-rose-600">clear</button> : null}
        </div>
        {history.length === 0 ? (
          <p className="px-2 pb-2 text-[11px] text-content-subtle">Queries you run show up here.</p>
        ) : (
          <ul className="pb-1">
            {history.map((h) => (
              <li key={h}>
                <button type="button" onClick={() => onPick(h)} className="w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[11px] text-content-muted hover:bg-surface-sunken hover:text-content">{h}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  )
}

function SavePopover({ query, onSave, onClose }: { query: string; onSave(name: string): void; onClose(): void }) {
  const [name, setName] = useState('')
  const ok = !!name.trim() && !!query.trim()
  return (
    <Popover onClose={onClose} className="right-0 w-72">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onSave(name)
        }}
        className="space-y-2 p-1"
      >
        <div className="text-[11px] font-semibold text-content">Save this query</div>
        <div className="truncate rounded-md bg-surface-sunken px-2 py-1 font-mono text-[10.5px] text-content-subtle">{query.trim() || 'Type a query first'}</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. Billing errors"
          className="h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <div className="flex justify-end gap-1.5">
          <button type="button" onClick={onClose} className="h-7 rounded-md px-2 text-[11px] text-content-muted hover:bg-surface-sunken">Cancel</button>
          <button type="submit" disabled={!ok} className="h-7 rounded-md bg-brand-600 px-2.5 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50">Save</button>
        </div>
      </form>
    </Popover>
  )
}

/* ─────────── time range controls ─────────── */

function RangeSelect({ sel, onPreset }: { sel: TimeSelection; onPreset(v: TimeRangeId): void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised p-0.5">
      {TIME_RANGES.map((r) => {
        const active = sel.kind === 'preset' && sel.id === r.id
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPreset(r.id)}
            className={cn('h-7 rounded-md px-2 text-[11px] font-medium transition-colors', active ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
          >
            {r.label}
          </button>
        )
      })}
    </div>
  )
}

function CustomRange({ sel, onApply }: { sel: TimeSelection; onApply(from: string, to: string): void }) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Sync the inputs to the active window whenever it changes (preset click,
  // histogram zoom) so opening the editor starts from the current range.
  useEffect(() => {
    const w = selectionToWindow(sel)
    setFrom(toLocalInput(w.start))
    setTo(toLocalInput(w.end))
  }, [sel])

  const active = sel.kind === 'absolute'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors',
          active ? 'border-brand-300 bg-brand-50 font-semibold text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
        )}
      >
        <IconClock />
        {active ? selectionLabel(sel) : 'Custom range'}
      </button>
      {open ? (
        <Popover onClose={() => setOpen(false)} className="left-0 w-72">
          <div className="space-y-2 p-1">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              From
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block w-full rounded-md border border-edge-default bg-surface-app px-2 py-1 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none" />
            </label>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              To
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block w-full rounded-md border border-edge-default bg-surface-app px-2 py-1 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none" />
            </label>
            <div className="flex justify-end gap-1.5 pt-1">
              <button type="button" onClick={() => setOpen(false)} className="h-7 rounded-md px-2 text-[11px] text-content-muted hover:bg-surface-sunken">Cancel</button>
              <button
                type="button"
                disabled={!from || !to || new Date(from) >= new Date(to)}
                onClick={() => {
                  onApply(new Date(from).toISOString(), new Date(to).toISOString())
                  setOpen(false)
                }}
                className="h-7 rounded-md bg-brand-600 px-2.5 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Apply
              </button>
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  )
}

/* ─────────── generic bits ─────────── */

function Popover({ children, onClose, className }: { children: ReactNode; onClose(): void; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-30" aria-hidden onClick={onClose} />
      <div className={cn('absolute top-full z-40 mt-1.5 rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10', className)}>{children}</div>
    </>
  )
}

function Toggle({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn('h-8 min-w-8 rounded-lg border px-1.5 font-mono text-[11px] font-semibold transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-subtle hover:text-content')}
    >
      {children}
    </button>
  )
}

function Select({ value, onChange, options, title }: { value: string; onChange(v: string): void; options: Array<[string, string]>; title: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={title}
      aria-label={title}
      className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  )
}

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
