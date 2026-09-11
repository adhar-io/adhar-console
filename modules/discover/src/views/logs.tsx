import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EmptyState, LokiIcon, Spinner } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import {
  DEFAULT_RANGE,
  TIME_RANGES,
  bucketLogsByLevel,
  presetSelection,
  selectionLabel,
  selectionToWindow,
  useLogLabelValues,
  useLogLabels,
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
  parseSelector,
  pushHistory,
  saveQuery,
  splitMatches,
  toExport,
  withLineFilter,
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
  IconPlay,
  IconReset,
  IconSearch,
  IconStar,
  IconTag,
  IconTrash,
  IconX,
  LEVELS,
  LEVEL_BAR,
  LEVEL_CHIP,
  LogDetailDrawer,
  copy,
  levelOf,
  type Level,
} from './logs-panels.tsx'

/**
 * Logs — a LogQL workbench on Loki, built for operators who live in it.
 *
 * Layout is a three-band workbench rather than a page of stacked cards: a
 * query band, a stats band that doubles as the filter control, and then a
 * full-height explorer split into a persistent **discovery rail** (stream
 * labels and detected fields, with live counts) and the **result pane**. The
 * result pane is the biggest thing on the screen, always.
 *
 * Three ways to read the same result set:
 *   • **Stream**  — the classic tail: level gutter, timestamps, label pills,
 *                   match highlighting, repeat counters, click for context.
 *   • **Table**   — parsed fields promoted to columns, chosen from whatever
 *                   JSON/logfmt keys actually appear in the result.
 *   • **Patterns**— lines collapsed by structural signature (numbers, ids,
 *                   hex and quoted strings normalised away), ranked by volume
 *                   with a per-pattern sparkline. This is how you find the one
 *                   error repeating 40,000 times behind the noise.
 *
 * Query      — LogQL bar with Run / ⌘⏎, history, saved queries, shareable
 *              permalinks (the query, window and refinements live in the URL).
 * Time       — presets, absolute range, histogram click-to-zoom, Live tail.
 * Refine     — level chips with counts, text filter (plain / regex / case /
 *              exclude), dedup, order, limit — all client-side over the
 *              returned window, so refining never re-queries Loki.
 *
 * Everything renders what Loki actually returned; nothing is synthesised.
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
type ViewMode = 'stream' | 'table' | 'patterns'

interface Prefs {
  wrap: boolean
  showLabels: boolean
  ts: TsFormat
  order: 'newest' | 'oldest'
  dedup: DedupMode
  limit: number
  view: ViewMode
  rail: boolean
  volume: boolean
}

const DEFAULT_PREFS: Prefs = {
  wrap: true,
  showLabels: true,
  ts: 'time',
  order: 'newest',
  dedup: 'none',
  limit: 500,
  view: 'stream',
  rail: true,
  volume: true,
}
const PREFS_KEY = 'adhar.discover.logs.prefs.v3'

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

/* ─────────────────────── permalink ─────────────────────── */

/** Read the query + window out of the URL so a log view can be shared. */
function readPermalink(): { query?: string; sel?: TimeSelection } {
  if (typeof location === 'undefined') return {}
  const p = new URLSearchParams(location.search)
  const query = p.get('q') ?? undefined
  const from = p.get('from')
  const to = p.get('to')
  const range = p.get('range') as TimeRangeId | null
  const sel: TimeSelection | undefined = from && to
    ? { kind: 'absolute', from, to }
    : range && TIME_RANGES.some((r) => r.id === range)
      ? presetSelection(range)
      : undefined
  return { query, sel }
}

function permalinkFor(query: string, sel: TimeSelection): string {
  if (typeof location === 'undefined') return ''
  const p = new URLSearchParams(location.search)
  p.set('section', 'logs')
  p.set('q', query)
  p.delete('from')
  p.delete('to')
  p.delete('range')
  if (sel.kind === 'absolute') {
    p.set('from', sel.from)
    p.set('to', sel.to)
  } else {
    p.set('range', sel.id)
  }
  return `${location.origin}${location.pathname}?${p.toString()}`
}

/* ─────────────────────────── view ─────────────────────────── */

export function Logs() {
  const boot = useMemo(readPermalink, [])

  /* ── query & time ── */
  const [draft, setDraft] = useState(boot.query ?? '')
  const [query, setQuery] = useState(boot.query ?? '')
  const [sel, setSel] = useState<TimeSelection>(boot.sel ?? presetSelection(DEFAULT_RANGE))
  const [live, setLive] = useState(false)
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSaved())

  /* ── refine ── */
  const [levels, setLevels] = useState<Set<string>>(new Set(LEVELS))
  const [text, setText] = useState<TextFilter>(EMPTY_TEXT_FILTER)
  const [facet, setFacet] = useState<FacetFilter>(new Map())
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch }
      try {
        globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        // private mode / quota
      }
      return next
    })
  }, [])

  /* ── ui ── */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [selected, setSelected] = useState<lgtm.LogEntry | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  /* ── streaming: the result pane owns its scroll; while tailing we pin it to
     the newest line unless the reader scrolled away, in which case arrivals
     are counted into a "jump to newest" pill. ── */
  const streamRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [unseen, setUnseen] = useState(0)

  const q = useLogs(query, sel, prefs.limit, { live, direction: prefs.order === 'oldest' ? 'forward' : 'backward' })
  const all = useMemo(() => q.data ?? [], [q.data])

  /* ── derive: level counts, facets, filtered rows ── */

  const levelCounts = useMemo(() => {
    const c: Record<Level, number> = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }
    for (const e of all) c[levelOf(e)]++
    return c
  }, [all])

  const facetGroups = useMemo(() => buildFacets(all), [all])

  const rows = useMemo<Row[]>(() => {
    const re = compileFilter(text)
    let list = all.filter((e) => levels.has(levelOf(e)))

    for (const [key, values] of facet) {
      if (!values.size) continue
      list = list.filter((e) => values.has(labelsOf(e)[key] ?? parseLine(e).fields[key] ?? ''))
    }

    if (re) {
      list = text.exclude ? list.filter((e) => !re.test(e.message)) : list.filter((e) => re.test(e.message))
    }

    const ordered = prefs.order === 'oldest'
      ? [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      : [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    if (prefs.dedup === 'none') return ordered.map((entry) => ({ entry, repeats: 1 }))

    const seen = new Map<string, Row>()
    const out: Row[] = []
    for (const entry of ordered) {
      const key = dedupKey(entry.message, prefs.dedup)
      const hit = seen.get(key)
      if (hit) {
        hit.repeats++
        continue
      }
      const row: Row = { entry, repeats: 1 }
      seen.set(key, row)
      out.push(row)
    }
    return out
  }, [all, levels, text, facet, prefs.order, prefs.dedup])

  const buckets = useMemo(() => {
    const { start, end } = selectionToWindow(sel)
    return bucketLogsByLevel(rows.map((r) => r.entry), start, end, 60)
  }, [rows, sel])

  const stats = useMemo(() => computeStats(all, rows, buckets, sel), [all, rows, buckets, sel])

  /* ── live tail follow / unseen ── */
  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    if (following) {
      el.scrollTop = prefs.order === 'newest' ? 0 : el.scrollHeight
      setUnseen(0)
    } else if (live) {
      setUnseen((n) => n + 1)
    }
    // Only react to new data, not to scroll state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length])

  // `/` focuses the query box from anywhere on the page, the way every log
  // tool does it — unless the operator is already typing into something.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  const run = useCallback(
    (next?: string) => {
      const text = (next ?? draft).trim()
      if (!text) return
      setQuery(text)
      setDraft(text)
      setHistory(pushHistory(text))
      setFollowing(true)
      setUnseen(0)
    },
    [draft],
  )

  const zoomTo = useCallback((b: HistogramBucket) => {
    setLive(false)
    setSel({ kind: 'absolute', from: new Date(b.start).toISOString(), to: new Date(b.end).toISOString() })
  }, [])

  const addMatcher = useCallback(
    (key: string, value: string, op: '=' | '!=' = '=') => {
      const next = withMatcher(query || draft || '{}', key, value, op)
      setDraft(next)
      run(next)
    },
    [query, draft, run],
  )

  const reset = () => {
    setLevels(new Set(LEVELS))
    setText(EMPTY_TEXT_FILTER)
    setFacet(new Map())
  }

  const refined = levels.size !== LEVELS.length || !!text.text || [...facet.values()].some((v) => v.size > 0)

  /* ── render ── */

  const rail = prefs.rail && !fullscreen

  return (
    <div className={cn('flex flex-col gap-3', fullscreen && 'fixed inset-0 z-50 bg-surface-app p-4')}>
      {/* ═══ query band ═══ */}
      <div className="rounded-xl border border-edge-default bg-surface-raised p-2.5 shadow-sm">
        <div className="flex flex-wrap items-start gap-2">
          <span className="mt-1.5 hidden items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-content-muted sm:inline-flex">
            <LokiIcon size={12} /> LogQL
          </span>
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
              }
            }}
            placeholder='{namespace="my-app"} |= "error"   — press / to focus, Enter to run'
            aria-label="LogQL query"
            className="min-h-[34px] flex-1 resize-none rounded-lg border border-edge-default bg-surface-app px-3 py-1.5 font-mono text-[12.5px] leading-5 text-content outline-none placeholder:text-content-subtle focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
            style={{ height: 'auto' }}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
          />
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <IconBtn label="Recent queries" onClick={() => setHistoryOpen((o) => !o)} active={historyOpen}>
                <IconHistory />
              </IconBtn>
              {historyOpen ? (
                <HistoryMenu
                  history={history}
                  saved={saved}
                  onPick={(x) => {
                    setHistoryOpen(false)
                    setDraft(x)
                    run(x)
                  }}
                  onClearHistory={() => setHistory(clearHistory())}
                  onDeleteSaved={(name) => setSaved(deleteSaved(name))}
                  onClose={() => setHistoryOpen(false)}
                />
              ) : null}
            </div>
            <div className="relative">
              <IconBtn label="Save this query" onClick={() => setSaveOpen((o) => !o)} active={saveOpen}>
                <IconStar />
              </IconBtn>
              {saveOpen ? (
                <SavePopover
                  query={draft || query}
                  onSave={(name) => {
                    setSaved(saveQuery(name, draft || query))
                    setSaveOpen(false)
                  }}
                  onClose={() => setSaveOpen(false)}
                />
              ) : null}
            </div>
            <IconBtn
              label={copiedLink ? 'Link copied' : 'Copy a shareable link to this view'}
              onClick={() => {
                copy(permalinkFor(query || draft, sel))
                setCopiedLink(true)
                setTimeout(() => setCopiedLink(false), 1600)
              }}
              active={copiedLink}
            >
              <IconLink />
            </IconBtn>
            <button
              type="button"
              onClick={() => run()}
              disabled={!draft.trim()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-40"
            >
              <IconPlay /> Run
            </button>
            <button
              type="button"
              onClick={() => {
                setLive((v) => !v)
                setFollowing(true)
              }}
              disabled={!query}
              aria-pressed={live}
              title="Tail the query — re-runs on a sliding window every few seconds"
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-semibold transition-colors disabled:opacity-40',
                live
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
              )}
            >
              <IconBolt /> {live ? 'Live' : 'Live'}
              {live ? <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> : null}
            </button>
          </div>
        </div>

        {/* time + refine */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <RangeSelect sel={sel} onPreset={(id) => { setSel(presetSelection(id)); setCustomOpen(false) }} />
          <div className="relative">
            <button
              type="button"
              onClick={() => setCustomOpen((o) => !o)}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors',
                sel.kind === 'absolute'
                  ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
                  : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
              )}
            >
              <IconClock /> {sel.kind === 'absolute' ? selectionLabel(sel) : 'Custom range'}
            </button>
            {customOpen ? (
              <CustomRange
                sel={sel}
                onApply={(from, to) => {
                  setSel({ kind: 'absolute', from, to })
                  setLive(false)
                  setCustomOpen(false)
                }}
                onClose={() => setCustomOpen(false)}
              />
            ) : null}
          </div>

          <span className="mx-0.5 h-5 w-px bg-edge-subtle" />
          <LevelChips levels={levels} counts={levelCounts} onChange={setLevels} />

          <span className="mx-0.5 h-5 w-px bg-edge-subtle" />
          <div className="relative min-w-[180px] flex-1">
            <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
              <IconSearch />
            </span>
            <input
              value={text.text}
              onChange={(e) => setText({ ...text, text: e.target.value })}
              placeholder="Filter lines in this result…"
              aria-label="Filter returned lines"
              className="h-7 w-full rounded-md border border-edge-default bg-surface-app pl-7 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
            />
          </div>
          <Toggle on={text.regex} onClick={() => setText({ ...text, regex: !text.regex })} title="Regular expression">.*</Toggle>
          <Toggle on={text.caseSensitive} onClick={() => setText({ ...text, caseSensitive: !text.caseSensitive })} title="Case sensitive">Aa</Toggle>
          <Toggle on={text.exclude} onClick={() => setText({ ...text, exclude: !text.exclude })} title="Exclude matching lines">≠</Toggle>

          {refined ? (
            <button type="button" onClick={reset} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
              <IconReset /> Clear
            </button>
          ) : null}

          <span className="ml-auto flex items-center gap-1.5">
            <Select value={prefs.dedup} onChange={(v) => setPrefs({ dedup: v as DedupMode })} title="Collapse repeated lines" options={[['none', 'No dedup'], ['exact', 'Dedup exact'], ['numbers', 'Dedup numbers'], ['signature', 'Dedup signature']]} />
            <Select value={prefs.order} onChange={(v) => setPrefs({ order: v as Prefs['order'] })} title="Sort order" options={[['newest', 'Newest first'], ['oldest', 'Oldest first']]} />
            <Select value={String(prefs.limit)} onChange={(v) => setPrefs({ limit: Number(v) })} title="Lines fetched from Loki" options={LIMITS.map((n) => [String(n), `${n} lines`])} />
            <div className="relative">
              <IconBtn label="Export these lines" onClick={() => setExportOpen((o) => !o)} active={exportOpen}>
                <IconDownload />
              </IconBtn>
              {exportOpen ? (
                <Popover onClose={() => setExportOpen(false)} className="right-0 w-44">
                  {(['txt', 'json', 'csv'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        download(`logs-${Date.now()}.${k}`, toExport(rows.map((r) => r.entry), k))
                        setExportOpen(false)
                      }}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-[12px] text-content-muted hover:bg-surface-sunken hover:text-content"
                    >
                      Download .{k} · {rows.length} lines
                    </button>
                  ))}
                </Popover>
              ) : null}
            </div>
            <IconBtn label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => setFullscreen((f) => !f)} active={fullscreen}>
              {fullscreen ? <IconCollapse /> : <IconExpand />}
            </IconBtn>
          </span>
        </div>
      </div>

      {/* ═══ stats band — doubles as the filter control ═══ */}
      {query ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          <StatTile label="Lines" value={fmtNum(rows.length)} hint={rows.length !== all.length ? `of ${fmtNum(all.length)} fetched` : `${selectionLabel(sel)}`} />
          <StatTile
            label="Errors"
            value={fmtNum(levelCounts.error + levelCounts.fatal)}
            tone={levelCounts.error + levelCounts.fatal > 0 ? 'bad' : 'ok'}
            hint="click to isolate"
            on={levels.size === 2 && levels.has('error') && levels.has('fatal')}
            onClick={() => setLevels(levels.size === 2 && levels.has('error') ? new Set(LEVELS) : new Set(['error', 'fatal']))}
          />
          <StatTile
            label="Warnings"
            value={fmtNum(levelCounts.warn)}
            tone={levelCounts.warn > 0 ? 'warn' : undefined}
            hint="click to isolate"
            on={levels.size === 1 && levels.has('warn')}
            onClick={() => setLevels(levels.size === 1 && levels.has('warn') ? new Set(LEVELS) : new Set(['warn']))}
          />
          <StatTile label="Streams" value={fmtNum(stats.streams)} hint={`${stats.namespaces} namespace${stats.namespaces === 1 ? '' : 's'}`} />
          <StatTile label="Rate" value={stats.rate} hint="lines / min in window" />
          <StatTile label="Patterns" value={fmtNum(stats.patterns)} hint="distinct line shapes" on={prefs.view === 'patterns'} onClick={() => setPrefs({ view: prefs.view === 'patterns' ? 'stream' : 'patterns' })} />
          <StatTile label="Structured" value={stats.structuredPct} hint={stats.formats} />
        </div>
      ) : null}

      {/* ═══ explorer ═══ */}
      {q.isError ? (
        <SourceError source="Loki" error={q.error} />
      ) : (
        <div
          className={cn(
            'grid min-h-0 gap-3',
            rail ? 'lg:grid-cols-[248px_minmax(0,1fr)]' : 'grid-cols-1',
            !query ? 'h-[calc(100vh-16rem)]' : fullscreen ? 'h-[calc(100vh-9rem)]' : 'h-[calc(100vh-19rem)]',
          )}
        >
          {/* discovery rail */}
          {rail ? (
            <DiscoveryRail
              sel={sel}
              query={query}
              draft={draft}
              facetGroups={facetGroups}
              facet={facet}
              onFacet={setFacet}
              onMatcher={addMatcher}
              onRun={run}
              onHide={() => setPrefs({ rail: false })}
            />
          ) : null}

          {/* result pane */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
            {!query ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Welcome onPick={(x) => { setDraft(x); run(x) }} onBrowse={() => setPrefs({ rail: true })} />
              </div>
            ) : (
              <>
            {/* volume */}
            {prefs.volume ? (
              <div className="border-b border-edge-subtle px-3 pb-1 pt-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                    Volume · {selectionLabel(sel)} · click a bar to zoom
                  </span>
                  <div className="flex items-center gap-2 text-[10px] text-content-subtle">
                    <Legend color={HIST_COLOR.error} label="error" />
                    <Legend color={HIST_COLOR.warn} label="warn" />
                    <Legend color={HIST_COLOR.info} label="info" />
                  </div>
                </div>
                <Histogram buckets={buckets} levels={levels} onZoom={zoomTo} height={64} />
              </div>
            ) : null}

            {/* view switch */}
            <div className="flex items-center gap-1 border-b border-edge-subtle px-2 py-1.5">
              {(['stream', 'table', 'patterns'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setPrefs({ view: v })}
                  className={cn(
                    'h-7 rounded-md px-2.5 text-[11.5px] font-medium capitalize transition-colors',
                    prefs.view === v ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                  )}
                >
                  {v}
                </button>
              ))}
              <span className="ml-2 text-[11px] text-content-subtle">
                {q.isFetching ? <span className="inline-flex items-center gap-1"><Spinner size={10} /> querying…</span> : `${fmtNum(rows.length)} shown`}
              </span>
              <span className="ml-auto flex items-center gap-1">
                {!rail ? <SmallToggle on={false} onClick={() => setPrefs({ rail: true })} title="Show the discovery rail"><IconTag /> Labels</SmallToggle> : null}
                <SmallToggle on={prefs.volume} onClick={() => setPrefs({ volume: !prefs.volume })} title="Toggle the volume histogram">Volume</SmallToggle>
                {prefs.view === 'stream' ? (
                  <>
                    <SmallToggle on={prefs.wrap} onClick={() => setPrefs({ wrap: !prefs.wrap })} title="Wrap long lines">Wrap</SmallToggle>
                    <SmallToggle on={prefs.showLabels} onClick={() => setPrefs({ showLabels: !prefs.showLabels })} title="Show stream labels on each line">Labels</SmallToggle>
                    <Select value={prefs.ts} onChange={(v) => setPrefs({ ts: v as TsFormat })} title="Timestamp format" options={[['time', 'Time'], ['iso', 'ISO'], ['relative', 'Relative']]} />
                  </>
                ) : null}
              </span>
            </div>

            {/* results */}
            <div
              ref={streamRef}
              onScroll={(e) => {
                const el = e.currentTarget
                const atNewest = prefs.order === 'newest'
                  ? el.scrollTop < 24
                  : el.scrollHeight - el.scrollTop - el.clientHeight < 24
                setFollowing(atNewest)
                if (atNewest) setUnseen(0)
              }}
              className="relative min-h-0 flex-1 overflow-auto"
            >
              {q.isLoading && !all.length ? (
                <StreamSkeleton />
              ) : rows.length === 0 ? (
                <EmptyState
                  title={all.length ? 'Everything is filtered out' : 'No lines in this window'}
                  description={all.length ? 'Widen the level, text or field filters to see the lines Loki returned.' : 'Loki returned nothing for this query and time range. Try a wider range or a broader selector.'}
                  action={all.length ? <button type="button" onClick={reset} className="rounded-md border border-edge-default px-2.5 py-1 text-[12px] font-medium text-content-muted hover:text-content">Clear refinements</button> : undefined}
                />
              ) : prefs.view === 'patterns' ? (
                <PatternsView rows={rows} buckets={buckets} sel={sel} onIsolate={(sample) => { const next = withLineFilter(query, sample); setDraft(next); run(next) }} onOpen={setSelected} />
              ) : prefs.view === 'table' ? (
                <TableView rows={rows} ts={prefs.ts} onOpen={setSelected} />
              ) : (
                <ol className="divide-y divide-edge-subtle/70">
                  {rows.map((r, i) => (
                    <LogRow
                      key={`${r.entry.timestamp}-${i}`}
                      row={r}
                      prefs={prefs}
                      filter={text}
                      onOpen={() => setSelected(r.entry)}
                      onMatcher={addMatcher}
                    />
                  ))}
                </ol>
              )}

              {/* jump-to-newest pill */}
              {live && !following && unseen > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    const el = streamRef.current
                    if (el) el.scrollTop = prefs.order === 'newest' ? 0 : el.scrollHeight
                    setFollowing(true)
                    setUnseen(0)
                  }}
                  className="sticky bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-lg"
                >
                  <IconChevron /> {unseen} new line{unseen === 1 ? '' : 's'}
                </button>
              ) : null}
            </div>

            {/* footer */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge-subtle px-3 py-1.5 text-[10.5px] text-content-subtle">
              <span>{fmtNum(rows.length)} shown · {fmtNum(all.length)} fetched · limit {prefs.limit}</span>
              {prefs.dedup !== 'none' ? <span>deduped by {prefs.dedup}</span> : null}
              {live ? <span className="text-emerald-600 dark:text-emerald-400">live · {following ? 'following' : 'paused (scrolled)'}</span> : null}
              <span className="ml-auto font-mono">{stats.window}</span>
            </div>
              </>
            )}
          </section>
        </div>
      )}

      {selected ? (
        <LogDetailDrawer
          entry={selected}
          query={query}
          onClose={() => setSelected(null)}
          onQuery={(next) => { setDraft(next); run(next); setSelected(null) }}
          onWindow={(from, to) => { setSel({ kind: 'absolute', from, to }); setLive(false) }}
        />
      ) : null}
    </div>
  )
}

/* ─────────────────────── discovery rail ─────────────────────── */

/**
 * The persistent left rail: Loki's label names and values for the current
 * window (click to add a matcher to the selector — a real Loki query change)
 * and, below, the fields actually present in the returned lines (click to
 * refine client-side). Labels narrow what Loki sends; fields narrow what you
 * are looking at. Keeping both in one rail is the whole point — you move from
 * "which streams" to "which lines" without leaving the page.
 */
function DiscoveryRail({
  sel,
  query,
  draft,
  facetGroups,
  facet,
  onFacet,
  onMatcher,
  onRun,
  onHide,
}: {
  sel: TimeSelection
  query: string
  draft: string
  facetGroups: FacetGroup[]
  facet: FacetFilter
  onFacet(next: FacetFilter): void
  onMatcher(key: string, value: string, op?: '=' | '!='): void
  onRun(next: string): void
  onHide(): void
}) {
  const [tab, setTab] = useState<'labels' | 'fields'>('labels')
  const labels = useLogLabels(sel)
  const [label, setLabel] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const selector = useMemo(() => {
    const m = /^\s*\{[^}]*\}/.exec(draft || query)
    return m ? m[0].trim() : ''
  }, [draft, query])
  const values = useLogLabelValues(label, sel, selector)
  const active = useMemo(() => parseSelector(draft || query), [draft, query])

  useEffect(() => {
    if (!label && labels.data?.length) {
      const preferred = ['namespace', 'app', 'service_name', 'job', 'pod', 'container']
      setLabel(preferred.find((p) => labels.data!.includes(p)) ?? labels.data[0])
    }
  }, [label, labels.data])

  const shownValues = useMemo(() => {
    const list = values.data ?? []
    const f = filter.trim().toLowerCase()
    return (f ? list.filter((v) => v.toLowerCase().includes(f)) : list).slice(0, 200)
  }, [values.data, filter])

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-center gap-1 border-b border-edge-subtle p-1.5">
        {(['labels', 'fields'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn('h-7 flex-1 rounded-md text-[11.5px] font-medium capitalize transition-colors', tab === t ? 'bg-surface-sunken text-content ring-1 ring-inset ring-edge-default' : 'text-content-muted hover:text-content')}
          >
            {t}
            {t === 'fields' && facetGroups.length ? <span className="ml-1 text-[10px] text-content-subtle">{facetGroups.length}</span> : null}
          </button>
        ))}
        <button type="button" onClick={onHide} aria-label="Hide the rail" className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
          <IconX />
        </button>
      </div>

      {tab === 'labels' ? (
        <>
          {active.length ? (
            <div className="flex flex-wrap gap-1 border-b border-edge-subtle p-2">
              {active.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 font-mono text-[10px] text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                  {m.key}{m.op}"{m.value}"
                </span>
              ))}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {labels.isLoading ? (
              <div className="flex items-center gap-2 p-3 text-[11.5px] text-content-subtle"><Spinner size={11} /> loading labels…</div>
            ) : !labels.data?.length ? (
              <p className="p-3 text-[11.5px] text-content-subtle">Loki reported no labels for this window.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1 border-b border-edge-subtle p-2">
                  {labels.data.slice(0, 40).map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => { setLabel(l); setFilter('') }}
                      className={cn('rounded-md px-1.5 py-0.5 font-mono text-[10.5px] transition-colors', label === l ? 'bg-brand-600 text-white' : 'bg-surface-sunken text-content-muted hover:text-content')}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="p-2">
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={label ? `Filter ${label} values…` : 'Pick a label'}
                    className="mb-1.5 h-7 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[11.5px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
                  />
                  {values.isLoading ? (
                    <div className="flex items-center gap-2 py-2 text-[11.5px] text-content-subtle"><Spinner size={11} /> loading values…</div>
                  ) : shownValues.length === 0 ? (
                    <p className="py-2 text-[11.5px] text-content-subtle">No values match.</p>
                  ) : (
                    <ul className="space-y-px">
                      {shownValues.map((v) => (
                        <li key={v} className="group flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => label && onMatcher(label, v)}
                            title={`Add ${label}="${v}" to the selector`}
                            className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left font-mono text-[11px] text-content-muted hover:bg-surface-sunken hover:text-content"
                          >
                            {v}
                          </button>
                          <button
                            type="button"
                            onClick={() => label && onMatcher(label, v, '!=')}
                            title={`Exclude ${label}="${v}"`}
                            className="rounded px-1 text-[11px] text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100"
                          >
                            ≠
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="border-t border-edge-subtle p-1.5">
            <button
              type="button"
              onClick={() => onRun(draft || query)}
              className="h-7 w-full rounded-md bg-surface-sunken text-[11.5px] font-medium text-content-muted hover:text-content"
            >
              Re-run with these labels
            </button>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {facetGroups.length === 0 ? (
            <p className="text-[11.5px] text-content-subtle">No repeated fields in this result yet.</p>
          ) : (
            <div className="space-y-3">
              {facetGroups.map((g) => (
                <FacetGroupView
                  key={g.key}
                  group={g}
                  chosen={facet.get(g.key) ?? new Set()}
                  onToggle={(value) => {
                    const next = new Map(facet)
                    const set = new Set(next.get(g.key) ?? [])
                    if (set.has(value)) set.delete(value)
                    else set.add(value)
                    if (set.size) next.set(g.key, set)
                    else next.delete(g.key)
                    onFacet(next)
                  }}
                  onPin={(value) => onMatcher(g.key, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function FacetGroupView({
  group,
  chosen,
  onToggle,
  onPin,
}: {
  group: FacetGroup
  chosen: Set<string>
  onToggle(v: string): void
  onPin(v: string): void
}) {
  const [open, setOpen] = useState(true)
  const max = Math.max(...group.values.map((v) => v.count), 1)
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="mb-1 flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle hover:text-content">
        <span className={cn('transition-transform', open ? '' : '-rotate-90')}><IconChevron /></span>
        <span className="font-mono normal-case tracking-normal">{group.key}</span>
        <span className="ml-auto font-normal normal-case tracking-normal">{group.values.length}</span>
      </button>
      {open ? (
        <ul className="space-y-px">
          {group.values.slice(0, 12).map((v) => {
            const on = chosen.has(v.value)
            return (
              <li key={v.value} className="group relative flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onToggle(v.value)}
                  className={cn('relative min-w-0 flex-1 overflow-hidden rounded px-1.5 py-1 text-left', on ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}
                >
                  <span className="absolute inset-y-0 left-0 bg-brand-500/10" style={{ width: `${(v.count / max) * 100}%` }} aria-hidden />
                  <span className="relative flex items-center justify-between gap-2">
                    <span className={cn('truncate font-mono text-[11px]', on ? 'text-brand-700 dark:text-brand-300' : 'text-content-muted')} title={v.value}>
                      {v.value || '∅'}
                    </span>
                    <span className="shrink-0 tabular-nums text-[10px] text-content-subtle">{v.count}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onPin(v.value)}
                  title={`Pin ${group.key}="${v.value}" into the query`}
                  className="absolute right-6 rounded px-1 text-[11px] text-content-subtle opacity-0 hover:text-brand-600 group-hover:opacity-100"
                >
                  ＋
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/* ─────────────────────── patterns view ─────────────────────── */

interface Pattern {
  key: string
  sample: lgtm.LogEntry
  count: number
  level: Level
  levels: Record<Level, number>
  first: number
  last: number
  spark: number[]
}

/**
 * Collapse the result set into line *shapes*. Two lines that differ only in a
 * request id, a duration or a pod suffix are the same pattern, so a flood of
 * 40k near-identical errors becomes one ranked row you can act on.
 */
function PatternsView({
  rows,
  buckets,
  sel,
  onIsolate,
  onOpen,
}: {
  rows: Row[]
  buckets: HistogramBucket[]
  sel: TimeSelection
  onIsolate(sample: string): void
  onOpen(entry: lgtm.LogEntry): void
}) {
  const patterns = useMemo(() => {
    const { start, end } = selectionToWindow(sel)
    const t0 = start.getTime()
    const span = Math.max(1, end.getTime() - t0)
    const slots = 24
    const map = new Map<string, Pattern>()
    for (const r of rows) {
      const key = dedupKey(r.entry.message, 'signature')
      const lvl = levelOf(r.entry)
      const at = new Date(r.entry.timestamp).getTime()
      let p = map.get(key)
      if (!p) {
        p = {
          key,
          sample: r.entry,
          count: 0,
          level: lvl,
          levels: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
          first: at,
          last: at,
          spark: new Array(slots).fill(0),
        }
        map.set(key, p)
      }
      p.count += r.repeats
      p.levels[lvl] += r.repeats
      if (at < p.first) p.first = at
      if (at > p.last) p.last = at
      // The worst level seen wins the row's colour.
      if (RANK[lvl] > RANK[p.level]) {
        p.level = lvl
        p.sample = r.entry
      }
      const slot = Math.min(slots - 1, Math.max(0, Math.floor(((at - t0) / span) * slots)))
      p.spark[slot] += r.repeats
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [rows, sel])

  void buckets

  return (
    <ul className="divide-y divide-edge-subtle/70">
      {patterns.map((p) => {
        const share = rows.length ? Math.round((p.count / rows.length) * 100) : 0
        return (
          <li key={p.key} className="group flex items-start gap-3 px-3 py-2 hover:bg-surface-sunken/40">
            <span className={cn('mt-1.5 h-8 w-1 shrink-0 rounded-full', LEVEL_BAR[p.level])} aria-hidden />
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => onOpen(p.sample)} className="block w-full text-left">
                <span className="line-clamp-2 font-mono text-[12px] leading-relaxed text-content">{p.sample.message}</span>
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-content-subtle">
                <span className="tabular-nums">{fmtNum(p.count)} × · {share}% of shown</span>
                <span>{new Date(p.first).toLocaleTimeString()} → {new Date(p.last).toLocaleTimeString()}</span>
                {LEVELS.filter((l) => p.levels[l] > 0).map((l) => (
                  <span key={l} className={cn('rounded px-1 ring-1 ring-inset', LEVEL_CHIP[l])}>{l} {p.levels[l]}</span>
                ))}
              </div>
            </div>
            <Sparkline values={p.spark} level={p.level} />
            <button
              type="button"
              onClick={() => onIsolate(longestToken(p.sample.message))}
              title="Add a line filter for this pattern to the query"
              className="mt-1 shrink-0 rounded-md border border-edge-default px-1.5 py-0.5 text-[10.5px] text-content-subtle opacity-0 transition-opacity hover:text-content group-hover:opacity-100"
            >
              isolate
            </button>
          </li>
        )
      })}
    </ul>
  )
}

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 }

/** The most distinctive literal in a line — used to build an `|=` filter. */
function longestToken(message: string): string {
  const words = message
    .replace(/[0-9a-f]{8,}/gi, ' ')
    .split(/[\s"'{}[\],;=()]+/)
    .filter((w) => w.length > 3 && !/^\d+$/.test(w))
  if (!words.length) return message.slice(0, 40)
  return words.sort((a, b) => b.length - a.length)[0].slice(0, 60)
}

function Sparkline({ values, level }: { values: number[]; level: Level }) {
  const max = Math.max(...values, 1)
  const color = level === 'error' || level === 'fatal' ? HIST_COLOR.error : level === 'warn' ? HIST_COLOR.warn : HIST_COLOR.info
  return (
    <span className="mt-1 hidden h-8 shrink-0 items-end gap-px sm:flex" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="w-1 rounded-sm" style={{ height: `${Math.max(2, (v / max) * 32)}px`, background: color, opacity: v ? 0.85 : 0.15 }} />
      ))}
    </span>
  )
}

/* ─────────────────────── table view ─────────────────────── */

/**
 * Promote the fields that actually appear in this result to columns. Chosen by
 * coverage, so a result of JSON logs gets its real schema and a result of
 * plain text falls back to timestamp + level + message.
 */
function TableView({ rows, ts, onOpen }: { rows: Row[]; ts: TsFormat; onOpen(e: lgtm.LogEntry): void }) {
  const columns = useMemo(() => {
    const freq = new Map<string, number>()
    for (const r of rows.slice(0, 500)) {
      const parsed = parseLine(r.entry)
      for (const k of Object.keys(parsed.fields)) {
        if (k === 'level' || k === 'msg' || k === 'message') continue
        freq.set(k, (freq.get(k) ?? 0) + 1)
      }
    }
    const min = Math.max(2, Math.floor(Math.min(rows.length, 500) * 0.25))
    return [...freq.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k)
  }, [rows])

  const now = Date.now()
  return (
    <table className="w-full text-left">
      <thead className="sticky top-0 z-10 bg-surface-raised text-[10px] font-semibold uppercase tracking-wider text-content-subtle shadow-[0_1px_0_0_var(--color-edge-subtle)]">
        <tr>
          <th className="px-3 py-1.5">Time</th>
          <th className="px-2 py-1.5">Level</th>
          {columns.map((c) => <th key={c} className="px-2 py-1.5 font-mono normal-case">{c}</th>)}
          <th className="px-2 py-1.5">Message</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-edge-subtle/70">
        {rows.map((r, i) => {
          const parsed = parseLine(r.entry)
          const lvl = levelOf(r.entry)
          return (
            <tr key={`${r.entry.timestamp}-${i}`} onClick={() => onOpen(r.entry)} className="cursor-pointer align-top hover:bg-surface-sunken/40">
              <td className="whitespace-nowrap px-3 py-1 font-mono text-[10.5px] text-content-subtle">{formatTs(r.entry.timestamp, ts, now)}</td>
              <td className="px-2 py-1">
                <span className={cn('rounded px-1 py-px text-[10px] font-medium uppercase ring-1 ring-inset', LEVEL_CHIP[lvl])}>{lvl}</span>
              </td>
              {columns.map((c) => (
                <td key={c} className="max-w-[12rem] truncate px-2 py-1 font-mono text-[11px] text-content-muted" title={parsed.fields[c] ?? ''}>
                  {parsed.fields[c] ?? '—'}
                </td>
              ))}
              <td className="px-2 py-1 font-mono text-[11.5px] text-content">
                <span className="line-clamp-2">{parsed.fields.msg ?? parsed.fields.message ?? r.entry.message}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* ─────────────────────── stream row ─────────────────────── */

function LogRow({
  row,
  prefs,
  filter,
  onOpen,
  onMatcher,
}: {
  row: Row
  prefs: Prefs
  filter: TextFilter
  onOpen(): void
  onMatcher(key: string, value: string, op?: '=' | '!='): void
}) {
  const { entry, repeats } = row
  const lvl = levelOf(entry)
  const labels = labelsOf(entry)
  const re = compileFilter(filter)
  const parts = useMemo(() => splitMatches(entry.message, filter.exclude ? null : re), [entry.message, re, filter.exclude])
  const pills = prefs.showLabels
    ? ['namespace', 'app', 'service_name', 'pod', 'container'].map((k) => (labels[k] ? [k, labels[k]] as const : null)).filter(Boolean).slice(0, 3)
    : []

  return (
    <li className="group flex gap-2 px-3 py-1 hover:bg-surface-sunken/40">
      <span className={cn('mt-1 h-[calc(100%-0.5rem)] w-0.5 shrink-0 rounded-full', LEVEL_BAR[lvl])} aria-hidden />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-content-subtle">{formatTs(entry.timestamp, prefs.ts)}</span>
          <span className={cn('shrink-0 rounded px-1 text-[9.5px] font-semibold uppercase ring-1 ring-inset', LEVEL_CHIP[lvl])}>{lvl}</span>
          {repeats > 1 ? (
            <span className="shrink-0 rounded bg-surface-sunken px-1 text-[9.5px] font-semibold text-content-muted" title={`${repeats} identical lines collapsed`}>×{repeats}</span>
          ) : null}
          <span className={cn('min-w-0 font-mono text-[12px] leading-relaxed text-content', prefs.wrap ? 'whitespace-pre-wrap break-words' : 'truncate')}>
            {parts.map((p, i) => (
              <span key={i} className={p.hit ? 'rounded-sm bg-amber-200/70 text-content dark:bg-amber-500/30' : undefined}>{p.text}</span>
            ))}
          </span>
        </span>
        {pills.length ? (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {pills.map(([k, v]) => (
              <span
                key={k}
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onMatcher(k, v) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onMatcher(k, v) } }}
                title={`Filter to ${k}="${v}"`}
                className="rounded bg-surface-sunken px-1 font-mono text-[9.5px] text-content-subtle hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-300"
              >
                {k}={v}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => copy(entry.message)}
        title="Copy this line"
        className="mt-0.5 shrink-0 self-start rounded p-1 text-content-subtle opacity-0 transition-opacity hover:text-content group-hover:opacity-100"
      >
        <IconCopySmall />
      </button>
    </li>
  )
}

/* ─────────────────────── welcome ─────────────────────── */

function Welcome({ onPick, onBrowse }: { onPick(q: string): void; onBrowse(): void }) {
  return (
    <div className="p-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-sunken text-content-muted">
            <LokiIcon size={20} />
          </span>
          <h2 className="mt-3 text-base font-semibold tracking-tight text-content">Search your logs</h2>
          <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-content-muted">
            Loki needs a stream selector to start. Pick a starter, browse the labels this cluster
            actually has, or write LogQL above.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={onBrowse} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12px] font-medium text-content-muted hover:border-brand-300 hover:text-content">
              <IconTag /> Browse labels
            </button>
            <span className="text-[11px] text-content-subtle">
              <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/</kbd> focus ·{' '}
              <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> run
            </span>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.query)}
              className="group rounded-lg border border-edge-default bg-surface-app p-2.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/5"
            >
              <div className="text-[12.5px] font-medium text-content">{s.label}</div>
              <code className="mt-1 block truncate font-mono text-[10.5px] text-brand-700 dark:text-brand-300">{s.query}</code>
              <div className="mt-0.5 text-[10.5px] text-content-subtle">{s.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────── facets ─────────────────────── */

interface FacetGroup {
  key: string
  values: Array<{ value: string; count: number }>
}

const FACET_PRIORITY = ['namespace', 'app', 'service_name', 'service', 'job', 'pod', 'container', 'instance', 'node', 'level', 'detected_level', 'status', 'method', 'route']

function buildFacets(all: lgtm.LogEntry[]): FacetGroup[] {
  if (!all.length) return []
  const counts = new Map<string, Map<string, number>>()
  const bump = (k: string, v: string) => {
    if (!v || v.length > 120) return
    const m = counts.get(k) ?? new Map<string, number>()
    m.set(v, (m.get(v) ?? 0) + 1)
    counts.set(k, m)
  }
  for (const e of all.slice(0, 1000)) {
    for (const [k, v] of Object.entries(labelsOf(e))) bump(k, v)
    const parsed = parseLine(e)
    for (const [k, v] of Object.entries(parsed.fields)) {
      if (k === 'msg' || k === 'message') continue
      bump(k, v)
    }
  }
  return [...counts.entries()]
    // A field with one value everywhere tells you nothing; neither does one
    // that is unique per line.
    .filter(([, m]) => m.size > 1 && m.size <= 60)
    .map(([key, m]) => ({ key, values: [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => rank(a.key) - rank(b.key) || b.values.length - a.values.length)
    .slice(0, 14)
}

function rank(label: string): number {
  const i = FACET_PRIORITY.indexOf(label)
  return i === -1 ? 99 : i
}

/* ─────────────────────── stats ─────────────────────── */

function computeStats(all: lgtm.LogEntry[], rows: Row[], buckets: HistogramBucket[], sel: TimeSelection) {
  const streams = new Set<string>()
  const namespaces = new Set<string>()
  let structured = 0
  const formats = new Map<string, number>()
  for (const e of all) {
    const l = labelsOf(e)
    streams.add(JSON.stringify(l))
    if (l.namespace) namespaces.add(l.namespace)
    const f = parseLine(e).format
    formats.set(f, (formats.get(f) ?? 0) + 1)
    if (f !== 'text') structured++
  }
  const patterns = new Set(rows.map((r) => dedupKey(r.entry.message, 'signature'))).size
  const { start, end } = selectionToWindow(sel)
  const minutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000)
  const topFormat = [...formats.entries()].sort((a, b) => b[1] - a[1])[0]
  void buckets
  return {
    streams: streams.size,
    namespaces: namespaces.size,
    patterns,
    // Per-minute reads as a flat 0 on low-volume windows, which looks broken
    // rather than quiet — fall back to per-hour when that happens.
    rate: rows.length / minutes >= 1
      ? `${fmtNum(Math.round(rows.length / minutes))}/min`
      : `${fmtNum(Math.round((rows.length / minutes) * 60))}/hr`,
    structuredPct: all.length ? `${Math.round((structured / all.length) * 100)}%` : '—',
    formats: topFormat ? `mostly ${topFormat[0]}` : 'no lines',
    window: `${start.toLocaleTimeString()} → ${end.toLocaleTimeString()}`,
  }
}

/* ─────────────────────── bits ─────────────────────── */

function StatTile({
  label,
  value,
  hint,
  tone,
  on = false,
  onClick,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'bad'
  on?: boolean
  onClick?(): void
}) {
  const color = tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content'
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? on : undefined}
      className={cn(
        'flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
        on ? 'border-brand-400 bg-brand-50/60 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised',
        onClick && 'hover:border-brand-300',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('truncate text-lg font-semibold leading-none tracking-tight tabular-nums', color)}>{value}</span>
      <span className="truncate text-[10.5px] text-content-subtle">{hint ?? ' '}</span>
    </Tag>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
    </span>
  )
}

function LevelChips({ levels, counts, onChange }: { levels: Set<string>; counts: Record<Level, number>; onChange(next: Set<string>): void }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {LEVELS.map((l) => {
        const on = levels.has(l)
        return (
          <button
            key={l}
            type="button"
            aria-pressed={on}
            onClick={() => {
              const next = new Set(levels)
              if (next.has(l)) next.delete(l)
              else next.add(l)
              onChange(next.size ? next : new Set(LEVELS))
            }}
            title={`${counts[l]} ${l} lines`}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium uppercase tracking-wide ring-1 ring-inset transition-colors',
              on ? LEVEL_CHIP[l] : 'bg-transparent text-content-subtle ring-edge-default hover:text-content',
            )}
          >
            {l}
            <span className="tabular-nums opacity-70">{counts[l]}</span>
          </button>
        )
      })}
    </span>
  )
}

function HistoryMenu({
  history,
  saved,
  onPick,
  onClearHistory,
  onDeleteSaved,
  onClose,
}: {
  history: string[]
  saved: SavedQuery[]
  onPick(q: string): void
  onClearHistory(): void
  onDeleteSaved(name: string): void
  onClose(): void
}) {
  return (
    <Popover onClose={onClose} className="right-0 w-[26rem]">
      {saved.length ? (
        <>
          <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Saved</div>
          {saved.map((s) => (
            <div key={s.name} className="group flex items-center gap-1">
              <button type="button" onClick={() => onPick(s.query)} className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken">
                <div className="truncate text-[12px] font-medium text-content">{s.name}</div>
                <code className="block truncate font-mono text-[10.5px] text-content-subtle">{s.query}</code>
              </button>
              <button type="button" onClick={() => onDeleteSaved(s.name)} aria-label={`Delete ${s.name}`} className="rounded p-1 text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100">
                <IconTrash />
              </button>
            </div>
          ))}
          <div className="my-1 border-t border-edge-subtle" />
        </>
      ) : null}
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        <span>Recent</span>
        {history.length ? <button type="button" onClick={onClearHistory} className="font-normal normal-case tracking-normal hover:text-rose-600">clear</button> : null}
      </div>
      {history.length === 0 ? (
        <p className="px-2 py-2 text-[11.5px] text-content-subtle">Queries you run land here.</p>
      ) : (
        history.map((h, i) => (
          <button key={`${h}-${i}`} type="button" onClick={() => onPick(h)} className="block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[11px] text-content-muted hover:bg-surface-sunken hover:text-content">
            {h}
          </button>
        ))
      )}
    </Popover>
  )
}

function SavePopover({ query, onSave, onClose }: { query: string; onSave(name: string): void; onClose(): void }) {
  const [name, setName] = useState('')
  return (
    <Popover onClose={onClose} className="right-0 w-72">
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Save query</div>
      <code className="mb-2 block max-h-16 overflow-auto rounded-md bg-surface-sunken p-1.5 font-mono text-[10.5px] text-content-muted">{query || '—'}</code>
      <div className="flex gap-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name) }}
          placeholder="Name it…"
          className="h-8 flex-1 rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none"
        />
        <button type="button" disabled={!name.trim() || !query} onClick={() => onSave(name)} className="h-8 rounded-md bg-brand-600 px-2.5 text-[12px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40">
          Save
        </button>
      </div>
    </Popover>
  )
}

function RangeSelect({ sel, onPreset }: { sel: TimeSelection; onPreset(v: TimeRangeId): void }) {
  return (
    <span className="inline-flex items-center rounded-md border border-edge-default bg-surface-raised p-0.5">
      {TIME_RANGES.map((r) => {
        const on = sel.kind === 'preset' && sel.id === r.id
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPreset(r.id)}
            className={cn('h-6 rounded px-1.5 text-[11px] font-medium transition-colors', on ? 'bg-brand-600 text-white' : 'text-content-muted hover:text-content')}
          >
            {r.label}
          </button>
        )
      })}
    </span>
  )
}

function CustomRange({ sel, onApply, onClose }: { sel: TimeSelection; onApply(from: string, to: string): void; onClose(): void }) {
  const w = selectionToWindow(sel)
  const [from, setFrom] = useState(toLocalInput(w.start))
  const [to, setTo] = useState(toLocalInput(w.end))
  return (
    <Popover onClose={onClose} className="left-0 w-72">
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Absolute range</div>
      <label className="mb-1.5 block">
        <span className="mb-0.5 block text-[10.5px] text-content-subtle">From</span>
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none" />
      </label>
      <label className="mb-2 block">
        <span className="mb-0.5 block text-[10.5px] text-content-subtle">To</span>
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none" />
      </label>
      <button
        type="button"
        onClick={() => {
          const f = new Date(from)
          const t = new Date(to)
          if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f >= t) return
          onApply(f.toISOString(), t.toISOString())
        }}
        className="h-8 w-full rounded-md bg-brand-600 text-[12px] font-semibold text-white hover:bg-brand-700"
      >
        Apply range
      </button>
    </Popover>
  )
}

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
      <div className={cn('absolute top-full z-40 mt-1 max-h-96 overflow-y-auto rounded-xl border border-edge-default bg-surface-raised p-1.5 shadow-xl', className)}>
        {children}
      </div>
    </>
  )
}

function SmallToggle({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn('inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors', on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:bg-surface-sunken hover:text-content')}
    >
      {children}
    </button>
  )
}

function Toggle({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn('inline-flex h-7 w-7 items-center justify-center rounded-md border font-mono text-[11px] transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-subtle hover:text-content')}
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
      className="h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[11px] text-content-muted focus:border-brand-400 focus:outline-none"
    >
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  )
}

function StreamSkeleton() {
  return (
    <ul className="animate-pulse space-y-1.5 p-3">
      {Array.from({ length: 14 }).map((_, i) => (
        <li key={i} className="flex gap-2">
          <span className="h-3 w-0.5 rounded bg-surface-sunken" />
          <span className="h-3 w-16 rounded bg-surface-sunken" />
          <span className="h-3 w-10 rounded bg-surface-sunken" />
          <span className="h-3 rounded bg-surface-sunken" style={{ width: `${35 + ((i * 13) % 50)}%` }} />
        </li>
      ))}
    </ul>
  )
}

function IconCopySmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

function IconLink() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  )
}

function download(filename: string, body: string) {
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export default Logs
