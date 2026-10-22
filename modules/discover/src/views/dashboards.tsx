import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, GrafanaIcon, Modal, Spinner, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import {
  groupLibrary,
  isGoldenBoard,
  normalizePanels,
  parseImport,
  readBoardUrl,
  type SearchHit,
  tagCounts,
  writeBoardUrl,
} from '../data/grafana-board.ts'
import { getJson, useGrafanaFolders, useGrafanaLibrary, useImportDashboard, useStarDashboard } from '../data/grafana.ts'
import { GrafanaBoard } from './grafana-board.tsx'
import { LoadingCard, SourceError } from './states.tsx'

/**
 * Grafana boards — the dashboard library plus a native board renderer.
 *
 * The library is Grafana's own search (`/api/search?type=dash-db`, through the
 * console BFF): folders, tags and stars exactly as Grafana has them. Opening a
 * board renders it in the console (see `grafana-board.tsx`) because the
 * platform's Grafana refuses to be framed. `?board=<uid>` deep-links straight
 * to a board, with `from`, `to` and `var-*` alongside.
 */
export function Dashboards() {
  const grafanaBase = useToolPublicUrl('grafana')
  const [board, setBoard] = useState<string | null>(() =>
    typeof location !== 'undefined' ? readBoardUrl(location.search).board ?? null : null,
  )
  const lib = useGrafanaLibrary()

  // Back/forward and links that change `?board=` while mounted.
  useEffect(() => {
    const sync = () => setBoard(readBoardUrl(location.search).board ?? null)
    globalThis.addEventListener('popstate', sync)
    return () => globalThis.removeEventListener('popstate', sync)
  }, [])

  const open = (uid: string | null) => {
    setBoard(uid)
    if (typeof location === 'undefined') return
    const next = writeBoardUrl(location.search, { board: uid ?? undefined, vars: {} })
    // A new history entry per opened board so Back returns to the library.
    if (uid) history.pushState(history.state, '', `${location.pathname}${next}`)
    else history.replaceState(history.state, '', `${location.pathname}${next}`)
  }

  if (board) {
    const hit = lib.data?.find((h) => h.uid === board)
    return <GrafanaBoard key={board} uid={board} grafanaBase={grafanaBase} starred={hit?.isStarred} onBack={() => open(null)} />
  }
  return <Library lib={lib} grafanaBase={grafanaBase} onOpen={open} />
}

function Library({
  lib,
  grafanaBase,
  onOpen,
}: {
  lib: ReturnType<typeof useGrafanaLibrary>
  grafanaBase: string
  onOpen(uid: string): void
}) {
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [folder, setFolder] = useState('')
  const [starredOnly, setStarredOnly] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const star = useStarDashboard()
  const toast = useToast()
  const hits = lib.data ?? []

  const groups = useMemo(() => groupLibrary(hits, { query, tags, starredOnly, folder: folder || undefined }), [hits, query, tags, starredOnly, folder])
  const allTags = useMemo(() => tagCounts(hits), [hits])
  const folders = useMemo(() => [...new Set(hits.map((h) => h.folderTitle || 'General'))].sort(), [hits])
  const golden = useMemo(() => hits.filter(isGoldenBoard).slice(0, 6), [hits])
  const matchCount = groups.filter((g) => !g.folder.startsWith('★')).reduce((n, g) => n + g.items.length, 0)
  const searching = !!(query || tags.length || folder || starredOnly)

  if (lib.isLoading) return <LoadingCard label="Loading Grafana dashboards…" />
  if (lib.isError) {
    return <SourceError tool="Grafana" error={lib.error} onRetry={() => lib.refetch()} icon={<GrafanaIcon size={20} />} />
  }

  const toggleStar = (h: SearchHit) =>
    star.mutate(
      { uid: h.uid, star: !h.isStarred },
      {
        onSuccess: () => toast.success(h.isStarred ? `Unstarred “${h.title}”` : `Starred “${h.title}”`),
        onError: (e) => toast.error('Grafana refused the star', { description: (e as Error).message }),
      },
    )

  return (
    <div className="space-y-4">
      {/* Toolbar: filters left, actions right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"><SearchIcon /></span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${hits.length} dashboards, folders, tags…`}
            className="h-8 w-full rounded-md border border-edge-default bg-surface-raised pl-8 pr-2 text-xs text-content placeholder:text-content-subtle"
            aria-label="Search dashboards"
          />
        </div>
        <select
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          aria-label="Folder"
          className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content"
        >
          <option value="">All folders</option>
          {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setStarredOnly((s) => !s)}
          aria-pressed={starredOnly}
          className={cn(
            'inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium',
            starredOnly ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300' : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
          )}
        >
          ★ Starred
        </button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setImportOpen(true)}>Import JSON</Button>
          {grafanaBase ? (
            <a
              href={grafanaBase}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 text-sm font-medium text-content transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40"
            >
              <GrafanaIcon size={14} /> Open Grafana ↗
            </a>
          ) : null}
        </div>
      </div>

      {allTags.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {(showAllTags ? allTags : allTags.slice(0, 14)).map(([t, n]) => {
            const on = tags.includes(t)
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTags((cur) => (on ? cur.filter((x) => x !== t) : [...cur, t]))}
                aria-pressed={on}
                className={cn(
                  'rounded-full border px-2 py-0.5 font-mono text-[10px]',
                  on ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/15 dark:text-brand-300' : 'border-edge-subtle bg-surface-raised text-content-muted hover:text-content',
                )}
              >
                {t} <span className="text-content-subtle">{n}</span>
              </button>
            )
          })}
          {allTags.length > 14 ? (
            <button type="button" onClick={() => setShowAllTags((s) => !s)} className="px-1 text-[10px] text-content-subtle hover:text-content">
              {showAllTags ? 'fewer' : `+${allTags.length - 14} tags`}
            </button>
          ) : null}
          {searching ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setTags([])
                setFolder('')
                setStarredOnly(false)
              }}
              className="ml-1 text-[10px] font-medium text-brand-700 hover:underline dark:text-brand-300"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {!searching && golden.length ? (
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Golden signals</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {golden.map((h) => <BoardCard key={h.uid} hit={h} onOpen={onOpen} onStar={toggleStar} emphasis />)}
          </div>
        </section>
      ) : null}

      {hits.length === 0 ? (
        <EmptyState
          icon={<GrafanaIcon size={20} />}
          title="Grafana has no dashboards yet"
          description="Grafana answered, but its search returned nothing for the console’s account. Import a dashboard JSON, or provision boards through the platform’s Grafana sidecar."
          action={<Button size="sm" variant="primary" onClick={() => setImportOpen(true)}>Import JSON</Button>}
        />
      ) : matchCount === 0 ? (
        <EmptyState compact title="No dashboards match" description="Try a different search, folder or tag." />
      ) : (
        <div className="space-y-4">
          {searching ? <div className="text-[11px] text-content-muted">{matchCount} of {hits.length} dashboards</div> : null}
          {groups.map((g) => {
            const isCollapsed = collapsed[g.folder] ?? false
            return (
              <section key={g.folder} className="space-y-2">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [g.folder]: !isCollapsed }))}
                  className="flex w-full items-center gap-2 text-left"
                  aria-expanded={!isCollapsed}
                >
                  <span className={cn('inline-block text-[9px] text-content-subtle transition-transform', isCollapsed ? '' : 'rotate-90')}>▶</span>
                  <span className="text-[12px] font-semibold text-content">{g.folder}</span>
                  <span className="text-[11px] text-content-subtle">{g.items.length}</span>
                </button>
                {isCollapsed ? null : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {g.items.map((h) => <BoardCard key={`${g.folder}-${h.uid}`} hit={h} onOpen={onOpen} onStar={toggleStar} />)}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onOpenBoard={onOpen} />
    </div>
  )
}

interface DashSummary {
  panels: number
  rows: number
  types: Array<[string, number]>
  variables: string[]
}

function BoardCard({ hit, onOpen, onStar, emphasis = false }: { hit: SearchHit; onOpen(uid: string): void; onStar(h: SearchHit): void; emphasis?: boolean }) {
  const qc = useQueryClient()
  const [summary, setSummary] = useState<DashSummary | null>(null)
  // Panel summary on hover — the dashboard JSON is prefetched into the same
  // cache the board renderer reads, so opening the board is instant.
  const prefetch = () => {
    if (summary) return
    qc.fetchQuery({
      queryKey: ['grafana', 'dashboard', hit.uid],
      queryFn: () => getJson(`/api/svc/grafana/api/dashboards/uid/${encodeURIComponent(hit.uid)}`),
      staleTime: 5 * 60_000,
    }).then((res) => {
      const d = (res as { dashboard?: Parameters<typeof normalizePanels>[0] }).dashboard
      if (!d) return
      const flat = normalizePanels(d).flatMap((p) => (p.type === 'row' ? [p, ...(p.panels ?? [])] : [p]))
      const types = new Map<string, number>()
      for (const p of flat) if (p.type !== 'row') types.set(p.type, (types.get(p.type) ?? 0) + 1)
      setSummary({
        panels: flat.filter((p) => p.type !== 'row').length,
        rows: flat.filter((p) => p.type === 'row').length,
        types: [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
        variables: (d.templating?.list ?? []).filter((v) => (v.hide ?? 0) < 2).map((v) => v.label || v.name).slice(0, 4),
      })
    }).catch(() => {})
  }
  return (
    <div
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className={cn(
        'group relative flex flex-col rounded-lg border bg-surface-raised p-3 transition-colors hover:border-brand-300 dark:hover:border-brand-500/50',
        emphasis ? 'border-brand-200 dark:border-brand-500/30' : 'border-edge-default',
      )}
    >
      <button type="button" onClick={() => onOpen(hit.uid)} className="absolute inset-0 rounded-lg" aria-label={`Open ${hit.title}`} />
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-content-subtle"><BoardIcon /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-content">{hit.title}</div>
          <div className="truncate text-[11px] text-content-subtle">{hit.folderTitle || 'General'}</div>
        </div>
        <button
          type="button"
          onClick={() => onStar(hit)}
          aria-pressed={!!hit.isStarred}
          title={hit.isStarred ? 'Unstar' : 'Star'}
          className={cn('relative z-10 text-sm leading-none', hit.isStarred ? 'text-amber-500' : 'text-content-subtle opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-content')}
        >
          {hit.isStarred ? '★' : '☆'}
        </button>
      </div>
      {hit.tags.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {hit.tags.slice(0, 5).map((t) => (
            <span key={t} className="rounded-full bg-surface-sunken px-1.5 py-0.5 font-mono text-[9px] text-content-subtle">{t}</span>
          ))}
        </div>
      ) : null}
      <div className="mt-2 min-h-[14px] text-[10px] text-content-subtle">
        {summary ? (
          <>
            {summary.panels} panels{summary.rows ? ` · ${summary.rows} rows` : ''}
            {summary.types.length ? ` · ${summary.types.map(([t, n]) => `${n} ${t}`).join(', ')}` : ''}
            {summary.variables.length ? ` · vars: ${summary.variables.join(', ')}` : ''}
          </>
        ) : null}
      </div>
    </div>
  )
}

function ImportModal({ open, onClose, onOpenBoard }: { open: boolean; onClose(): void; onOpenBoard(uid: string): void }) {
  const [text, setText] = useState('')
  const [folderUid, setFolderUid] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const folders = useGrafanaFolders()
  const imp = useImportDashboard()
  const toast = useToast()
  const parsed = text.trim() ? parseImport(text) : null

  const reset = () => {
    setText('')
    setConfirming(false)
    setOverwrite(false)
    onClose()
  }

  const submit = () => {
    if (!parsed?.ok) return
    imp.mutate(
      { dashboard: parsed.dashboard, folderUid, overwrite },
      {
        onSuccess: (res) => {
          toast.success(`Imported “${String(parsed.dashboard.title)}”`, {
            action: res?.uid ? { label: 'Open', onClick: () => onOpenBoard(res.uid) } : undefined,
          } as never)
          reset()
        },
        onError: (e) => {
          setConfirming(false)
          const status = (e as { status?: number }).status
          toast.error(status === 412 ? 'A dashboard with this uid or title already exists' : 'Grafana rejected the import', {
            description: status === 412 ? 'Tick “Overwrite existing” to replace it.' : (e as Error).message,
          })
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={reset}
      title="Import a Grafana dashboard"
      description="Paste dashboard JSON (as exported from Grafana, or the {dashboard: …} API shape). It is saved to Grafana through the console."
      width="lg"
      footer={
        confirming ? (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-content-muted">
              Save “{parsed?.ok ? String(parsed.dashboard.title) : ''}” to Grafana{overwrite ? ', replacing any existing board with the same uid' : ''}?
            </span>
            <Button size="sm" onClick={() => setConfirming(false)}>Back</Button>
            <Button size="sm" variant={overwrite ? 'danger' : 'primary'} loading={imp.isPending} onClick={submit}>
              {overwrite ? 'Overwrite and import' : 'Import'}
            </Button>
          </div>
        ) : (
          <div className="flex w-full justify-end gap-2">
            <Button size="sm" onClick={reset}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!parsed?.ok} onClick={() => setConfirming(true)}>Continue</Button>
          </div>
        )
      }
    >
      <div className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setConfirming(false)
          }}
          rows={12}
          spellCheck={false}
          placeholder='{"title": "My board", "panels": [ … ]}'
          className="w-full rounded-md border border-edge-default bg-surface-sunken p-2 font-mono text-[11px] text-content"
        />
        <label className="block text-xs text-content-muted">
          or load a file{' '}
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) setText(await f.text())
            }}
            className="text-xs"
          />
        </label>
        {parsed && !parsed.ok ? <p className="text-xs text-rose-600 dark:text-rose-400">⚠ {parsed.error}</p> : null}
        {parsed?.ok ? (
          <p className="text-xs text-content-muted">
            “{String(parsed.dashboard.title)}” · {Array.isArray(parsed.dashboard.panels) ? (parsed.dashboard.panels as unknown[]).length : 0} panels
            {parsed.dashboard.uid ? ` · uid ${String(parsed.dashboard.uid)}` : ' · Grafana will assign a uid'}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-4">
          <label className="text-xs text-content-muted">
            Folder{' '}
            <select value={folderUid} onChange={(e) => setFolderUid(e.target.value)} className="ml-1 h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content">
              <option value="">General</option>
              {(folders.data ?? []).map((f) => <option key={f.uid} value={f.uid}>{f.title}</option>)}
            </select>
            {folders.isLoading ? <Spinner size={10} /> : null}
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs text-content-muted">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="h-3 w-3" />
            Overwrite existing
          </label>
        </div>
      </div>
    </Modal>
  )
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function BoardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
    </svg>
  )
}
