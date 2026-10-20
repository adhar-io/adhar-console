import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, SearchInput, Skeleton, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import {
  metabaseClient,
  rememberRecent,
  useBookmarks,
  useCard,
  useCardResult,
  useCards,
  useCollectionTree,
  useInvalidateBi,
  useMbUser,
  useToggleBookmark,
} from '../data/bi.ts'
import { biHref, useBiParams, useGoBi, useSetBiParams } from '../data/bi-nav.ts'
import { columnStats, formatValue, VIZ_OPTIONS, vizSupported } from '../data/bi-chart.ts'
import { datasetError, safeFilename, toCsv, toJson } from '../data/bi-sql.ts'
import { type VarType } from '../data/bi-params.ts'
import {
  cardTypeIcon,
  collectionIdForApi,
  ConfirmDialog,
  copyText,
  displayIcon,
  downloadText,
  ensureBiStyles,
  flattenCollections,
  Icon,
  IconButton,
  isTyping,
  Menu,
  Meta,
  Segmented,
  VerifiedBadge,
} from '../components/bi-kit.tsx'
import { CollectionRail } from '../components/bi-library.tsx'
import { MoveModal, SaveCardModal } from '../components/bi-dialogs.tsx'
import { mbLink, useMetabaseUrl, Visualization } from '../components/bi-viz.tsx'
import { DataGrid } from '../components/bi-table.tsx'
import { CodeEditor } from '../components/code-editor.tsx'
import { BiSkeletonRows, errorToast, InlineError, MetabaseUnavailable } from './bi-states.tsx'

/**
 * Saved questions, models and metrics — a browser (collections, search, type
 * filter, favourites) and a viewer that runs the card through Metabase with a
 * visualisation switcher, sortable / paginated results, column summaries,
 * parameters for native questions, save-as-new, move, trash and download.
 * Native SQL questions open in the SQL editor for editing.
 *
 * Deep link: `?section=questions&question=<id>`.
 */
export function Questions() {
  ensureBiStyles()
  const params = useBiParams()
  const id = params.question ? Number(params.question) : undefined
  if (id != null && Number.isFinite(id)) return <QuestionViewer key={id} id={id} />
  return <QuestionBrowser />
}

type TypeFilter = 'all' | 'question' | 'model' | 'metric'
type SortKey = 'recent' | 'views' | 'name'

function cardCollection(c: metabase.MbCard): number | 'root' {
  const id = c.collection_id ?? c.collection?.id ?? null
  return id == null || id === 'root' ? 'root' : Number(id)
}

function isVerified(c: metabase.MbCard): boolean {
  return !!c.moderation_reviews?.some((r) => r.most_recent && r.status === 'verified')
}

/* ═════════════════════════════ Browser ═════════════════════════════ */

function QuestionBrowser() {
  const params = useBiParams()
  const setParams = useSetBiParams()
  const go = useGoBi()
  const cards = useCards()
  const tree = useCollectionTree()
  const me = useMbUser()
  const bookmarks = useBookmarks()
  const toggleBm = useToggleBookmark()
  const toast = useToast()
  const [type, setType] = useState<TypeFilter>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const [onlyStarred, setOnlyStarred] = useState(false)
  const [trash, setTrash] = useState<metabase.MbCard | null>(null)
  const [move, setMove] = useState<metabase.MbCard | null>(null)
  const [busy, setBusy] = useState(false)
  const invalidate = useInvalidateBi()
  const mbUrl = useMetabaseUrl()

  const collection: number | 'root' | null = params.collection ? (params.collection === 'root' ? 'root' : Number(params.collection)) : null
  const q = params.q ?? ''
  const collections = useMemo(() => flattenCollections(tree.data, me.data?.id), [tree.data, me.data?.id])
  const all = useMemo(() => (cards.data ?? []).filter((c) => !c.archived), [cards.data])
  const starred = useMemo(() => new Set((bookmarks.data ?? []).filter((b) => b.type === 'card').map((b) => b.item_id)), [bookmarks.data])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of all) m.set(String(cardCollection(c)), (m.get(String(cardCollection(c))) ?? 0) + 1)
    return m
  }, [all])
  const typeCounts = useMemo(() => {
    const t = { question: 0, model: 0, metric: 0 }
    for (const c of all) t[(c.type ?? 'question') as keyof typeof t]++
    return t
  }, [all])

  const list = useMemo(() => {
    const f = q.trim().toLowerCase()
    const out = all
      .filter((c) => type === 'all' || (c.type ?? 'question') === type)
      .filter((c) => collection == null || String(cardCollection(c)) === String(collection))
      .filter((c) => !onlyStarred || starred.has(c.id))
      .filter((c) => !f || c.name.toLowerCase().includes(f) || (c.description ?? '').toLowerCase().includes(f))
    return out.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'views') return (b.view_count ?? 0) - (a.view_count ?? 0)
      return Date.parse(b.last_used_at ?? b.updated_at ?? '') - Date.parse(a.last_used_at ?? a.updated_at ?? '') || a.name.localeCompare(b.name)
    })
  }, [all, q, type, collection, onlyStarred, starred, sort])

  if (cards.isLoading) return <BiSkeletonRows rows={8} />
  if (cards.isError) return <MetabaseUnavailable resource="saved questions" error={cards.error} onRetry={() => cards.refetch()} retrying={cards.isFetching} />

  const open = (c: metabase.MbCard) => setParams({ question: String(c.id) }, { push: true })

  const doTrash = async () => {
    if (!trash) return
    setBusy(true)
    try {
      await metabaseClient.archiveCard(trash.id)
      invalidate(['cards'])
      toast.success(`Moved “${trash.name}” to the trash`, { description: 'Restore it from Metabase’s trash if needed.' })
      setTrash(null)
    } catch (e) {
      toast.error('Couldn’t move it to the trash', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }
  const doMove = async (to: number | 'root') => {
    if (!move) return
    setBusy(true)
    try {
      await metabaseClient.updateCard(move.id, { collection_id: collectionIdForApi(to) })
      invalidate(['cards'])
      toast.success(`Moved “${move.name}”`)
      setMove(null)
    } catch (e) {
      toast.error('Couldn’t move it', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-sm">
          <SearchInput value={q} onChange={(v) => setParams({ q: v || undefined })} placeholder="Search questions, models, metrics…" />
        </div>
        <Segmented<TypeFilter>
          ariaLabel="Type"
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: `All ${all.length}` },
            { value: 'question', label: <><Icon name="question" size={13} /> Questions {typeCounts.question}</> },
            { value: 'model', label: <><Icon name="model" size={13} /> Models {typeCounts.model}</> },
            { value: 'metric', label: <><Icon name="metric" size={13} /> Metrics {typeCounts.metric}</> },
          ]}
        />
        <IconButton icon="star" filled={onlyStarred} active={onlyStarred} label={onlyStarred ? 'Show all' : 'Favourites only'} onClick={() => setOnlyStarred((s) => !s)} />
        <div className="ml-auto flex items-center gap-2">
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-9 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content">
            <option value="recent">Recently used</option>
            <option value="views">Most viewed</option>
            <option value="name">Name</option>
          </select>
          <Button variant="primary" size="sm" leading={<Icon name="sql" size={14} />} onClick={() => go('sql')}>
            New SQL query
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <CollectionRail
          collections={collections}
          counts={counts}
          total={all.length}
          active={collection}
          filterActive={false}
          onPick={(c) => setParams({ collection: c === 'all' ? undefined : String(c) })}
          loading={tree.isLoading}
          allLabel="All saved items"
        />
        <div className="min-w-0">
          {list.length === 0 ? (
            <EmptyState
              icon={<Icon name="question" size={34} className="text-content-subtle" />}
              title={all.length === 0 ? 'No saved questions yet' : 'Nothing matches'}
              description={all.length === 0 ? 'Write a query in the SQL editor and save it — it shows up here and in Metabase.' : 'Try another search, type or collection.'}
              action={all.length === 0 ? <Button variant="primary" size="sm" onClick={() => go('sql')}>Open the SQL editor</Button> : undefined}
            />
          ) : (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
              {list.map((c) => {
                const native = c.query_type === 'native' || c.dataset_query?.type === 'native'
                const isStar = starred.has(c.id)
                const href = mbLink(mbUrl, c.type === 'model' ? 'model' : c.type === 'metric' ? 'metric' : 'question', c.id)
                return (
                  <li key={c.id} className="group flex items-center gap-3 px-3 py-2.5 hover:bg-surface-sunken/50 sm:px-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-content-muted">
                      <Icon name={c.type && c.type !== 'question' ? cardTypeIcon(c.type) : displayIcon(c.display)} size={16} />
                    </span>
                    <button type="button" onClick={() => open(c)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{c.name}</span>
                        {isVerified(c) ? <VerifiedBadge compact /> : null}
                        {c.type && c.type !== 'question' ? <TypePill type={c.type} /> : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <Meta icon="folder">{c.collection?.name ?? 'Our analytics'}</Meta>
                        <Meta icon={native ? 'sql' : 'filter'}>{native ? 'SQL' : 'Query builder'}</Meta>
                        <span className="hidden sm:inline"><Meta icon={displayIcon(c.display)}>{c.display}</Meta></span>
                        {c.updated_at ? <span className="hidden md:inline"><Meta icon="clock">{formatRelative(c.updated_at)}</Meta></span> : null}
                        {c.view_count != null ? <span className="hidden md:inline"><Meta>{c.view_count.toLocaleString()} views</Meta></span> : null}
                      </div>
                    </button>
                    <IconButton
                      icon="star"
                      filled={isStar}
                      label={isStar ? 'Remove from favourites' : 'Add to favourites'}
                      className={isStar ? 'text-amber-500 hover:text-amber-500' : 'opacity-60 group-hover:opacity-100'}
                      onClick={() =>
                        toggleBm.mutate({ type: 'card', id: c.id, on: !isStar, name: c.name }, { onError: (e) => toast.error('Couldn’t update favourites', { description: errorToast(e) }) })}
                    />
                    <Menu
                      trigger={(_o, t) => <IconButton icon="more" label={`Actions for ${c.name}`} onClick={t} />}
                      items={[
                        { label: 'Open', icon: 'play', onSelect: () => open(c) },
                        ...(native ? [{ label: 'Edit SQL', icon: 'sql' as const, onSelect: () => go('sql', { question: String(c.id) }) }] : []),
                        ...(href ? [{ label: 'Open in Metabase', icon: 'external' as const, onSelect: () => void globalThis.open(href, '_blank', 'noopener') }] : []),
                        'sep' as const,
                        { label: 'Move…', icon: 'move', onSelect: () => setMove(c), disabled: c.can_write === false },
                        { label: 'Move to trash…', icon: 'trash', danger: true, onSelect: () => setTrash(c), disabled: c.can_write === false },
                      ]}
                    />
                  </li>
                )
              })}
            </ul>
          )}
          <div className="mt-2 text-[11px] text-content-subtle">
            {list.length} of {all.length}
            {cards.isFetching ? ' · refreshing…' : ''}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={!!trash}
        title="Move to trash?"
        body={<>“{trash?.name}” will be moved to Metabase’s trash. Dashboards that use it will show it as missing until it’s restored.</>}
        confirmLabel="Move to trash"
        danger
        busy={busy}
        onConfirm={doTrash}
        onClose={() => setTrash(null)}
      />
      <MoveModal open={!!move} onClose={() => setMove(null)} itemName={move?.name ?? ''} current={move?.collection_id ?? null} busy={busy} onMove={doMove} />
    </div>
  )
}

function TypePill({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted ring-1 ring-inset ring-edge-default">
      <Icon name={cardTypeIcon(type)} size={11} />
      {type}
    </span>
  )
}

/* ═════════════════════════════ Viewer ═════════════════════════════ */

/** Template tags a viewer can fill in (variables, not snippets / card refs / field filters). */
function editableTags(card?: metabase.MbCard): metabase.MbTemplateTag[] {
  const tags = card?.dataset_query?.native?.['template-tags'] ?? {}
  return Object.values(tags).filter((t) => t.type === 'text' || t.type === 'number' || t.type === 'date')
}

function QuestionViewer({ id }: { id: number }) {
  const setParams = useSetBiParams()
  const go = useGoBi()
  const toast = useToast()
  const card = useCard(id)
  const me = useMbUser()
  const bookmarks = useBookmarks()
  const toggleBm = useToggleBookmark()
  const invalidate = useInvalidateBi()
  const mbUrl = useMetabaseUrl()
  const [refreshKey, setRefreshKey] = useState(0)
  const [vars, setVars] = useState<Record<string, string>>({})
  const [applied, setApplied] = useState<Record<string, string>>({})
  const [display, setDisplay] = useState<string | null>(null)
  const [panel, setPanel] = useState<'none' | 'stats' | 'query'>('none')
  const [saveAs, setSaveAs] = useState(false)
  const [moving, setMoving] = useState(false)
  const [trash, setTrash] = useState(false)
  const [busy, setBusy] = useState(false)

  const c = card.data
  const tags = editableTags(c)
  const parameters = useMemo<metabase.MbParameterValue[]>(
    () =>
      tags
        .filter((t) => (applied[t.name] ?? '').trim())
        .map((t) => ({
          type: t.type === 'number' ? 'number/=' : t.type === 'date' ? 'date/single' : 'category',
          value: t.type === 'number' ? Number(applied[t.name]) : applied[t.name],
          target: ['variable', ['template-tag', t.name]],
        })),
    [tags, applied],
  )
  const missing = tags.filter((t) => t.required && !(applied[t.name] ?? '').trim() && t.default == null)
  const result = useCardResult(c && !missing.length ? id : undefined, parameters, refreshKey)

  useEffect(() => {
    if (c) {
      const init = Object.fromEntries(editableTags(c).map((t) => [t.name, t.default != null ? String(t.default) : '']))
      setVars(init)
      setApplied(init)
      rememberRecent(me.data?.id, { model: 'card', id: c.id, name: c.name })
    }
  }, [c?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        setApplied(vars)
        setRefreshKey((k) => k + 1)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [vars])

  const back = () => setParams({ question: undefined }, { push: true })

  if (card.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton width={280} height={22} />
        <Skeleton width="100%" height={360} rounded="lg" />
      </div>
    )
  }
  if (card.isError || !c) {
    return (
      <div className="space-y-3">
        <BackLink onClick={back} />
        <MetabaseUnavailable resource="this question" error={card.error} onRetry={() => card.refetch()} retrying={card.isFetching} />
      </div>
    )
  }

  const native = c.query_type === 'native' || c.dataset_query?.type === 'native'
  const sql = c.dataset_query?.native?.query ?? ''
  const ds = result.data
  const err = datasetError(ds)
  const cols = ds?.data?.cols ?? []
  const rows = ds?.data?.rows ?? []
  const starred = !!bookmarks.data?.some((b) => b.type === 'card' && b.item_id === id)
  const kind = c.type === 'model' ? 'model' : c.type === 'metric' ? 'metric' : 'question'
  const mbHref = mbLink(mbUrl, kind, c.id)
  const activeDisplay = display ?? c.display
  const options = VIZ_OPTIONS.filter((o) => o.id === c.display || vizSupported(o.id, cols, rows))
  if (!options.some((o) => o.id === c.display)) options.unshift({ id: c.display, label: c.display })
  const truncated = (ds?.row_count ?? 0) >= 2000 || !!ds?.data?.rows_truncated
  const generatedSql = !native ? ds?.data?.native_form?.query : undefined

  const run = () => {
    setApplied(vars)
    setRefreshKey((k) => k + 1)
  }
  const exportAs = (fmt: 'csv' | 'json') => {
    if (!rows.length) return toast.warning('Nothing to export yet')
    const name = safeFilename(c.name)
    if (fmt === 'csv') downloadText(`${name}.csv`, toCsv(cols, rows), 'text/csv')
    else downloadText(`${name}.json`, toJson(cols, rows), 'application/json')
    toast.success(`Exported ${rows.length.toLocaleString()} rows`, truncated ? { description: 'This is the first 2,000 rows Metabase returned. Export from Metabase for the full result.' } : undefined)
  }
  const doSaveAs = async (v: { name: string; description: string | null; collection: number | 'root'; type: metabase.MbCardType }) => {
    if (!c.dataset_query) return
    setBusy(true)
    try {
      const created = await metabaseClient.createCard({
        name: v.name,
        description: v.description,
        type: v.type,
        display: display ?? c.display,
        collection_id: collectionIdForApi(v.collection),
        dataset_query: c.dataset_query,
        visualization_settings: c.visualization_settings ?? {},
        parameters: c.parameters,
      })
      invalidate(['cards'])
      setSaveAs(false)
      toast.success(`Saved “${created.name}”`, { action: { label: 'Open', onClick: () => setParams({ question: String(created.id) }, { push: true }) } })
    } catch (e) {
      toast.error('Couldn’t save', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }
  const doMove = async (to: number | 'root') => {
    setBusy(true)
    try {
      await metabaseClient.updateCard(c.id, { collection_id: collectionIdForApi(to) })
      invalidate(['cards'])
      setMoving(false)
      toast.success(`Moved “${c.name}”`)
    } catch (e) {
      toast.error('Couldn’t move it', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }
  const doTrash = async () => {
    setBusy(true)
    try {
      await metabaseClient.archiveCard(c.id)
      invalidate(['cards'])
      toast.success(`Moved “${c.name}” to the trash`)
      back()
    } catch (e) {
      toast.error('Couldn’t move it to the trash', { description: errorToast(e) })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <BackLink onClick={back} />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-content">{c.name}</h2>
            <TypePill type={kind} />
            {isVerified(c) ? <VerifiedBadge /> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Meta icon="folder">{c.collection?.name ?? 'Our analytics'}</Meta>
            <Meta icon={native ? 'sql' : 'filter'}>{native ? 'Native SQL' : 'Query builder'}</Meta>
            {c.creator?.common_name ? <Meta icon="user">{c.creator.common_name}</Meta> : null}
            {c.updated_at ? <Meta icon="clock">Updated {formatRelative(c.updated_at)}</Meta> : null}
            {c.view_count != null ? <Meta>{c.view_count.toLocaleString()} views</Meta> : null}
          </div>
          {c.description ? <p className="mt-2 max-w-3xl text-[13px] text-content-muted">{c.description}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <IconButton
            icon="star"
            filled={starred}
            className={starred ? 'text-amber-500 hover:text-amber-500' : ''}
            label={starred ? 'Remove from favourites' : 'Add to favourites'}
            onClick={() => toggleBm.mutate({ type: 'card', id: c.id, on: !starred, name: c.name }, { onError: (e) => toast.error('Couldn’t update favourites', { description: errorToast(e) }) })}
          />
          <IconButton
            icon="link"
            label="Copy link"
            onClick={async () => ((await copyText(biHref('questions', { question: String(c.id) }))) ? toast.success('Link copied') : toast.error('Clipboard is blocked'))}
          />
          <Menu
            trigger={(_o, t) => <IconButton icon="download" label="Download results" onClick={t} disabled={!rows.length} />}
            items={[
              { label: 'CSV', icon: 'download', onSelect: () => exportAs('csv') },
              { label: 'JSON', icon: 'download', onSelect: () => exportAs('json') },
            ]}
          />
          {native ? (
            <Button size="sm" leading={<Icon name="sql" size={14} />} onClick={() => go('sql', { question: String(c.id) })}>
              Edit SQL
            </Button>
          ) : mbHref ? (
            <a href={mbHref} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default px-2.5 text-xs font-medium text-content hover:bg-surface-sunken">
              Edit in Metabase <Icon name="external" size={13} />
            </a>
          ) : null}
          <Button variant="primary" size="sm" leading={<Icon name="play" size={13} />} onClick={run} loading={result.isFetching} title="Run (⌘↵)">
            Run
          </Button>
          <Menu
            trigger={(_o, t) => <IconButton icon="more" label="More" onClick={t} />}
            items={[
              { label: 'Save as new…', icon: 'save', onSelect: () => setSaveAs(true) },
              { label: 'Move…', icon: 'move', onSelect: () => setMoving(true), disabled: c.can_write === false },
              ...(mbHref ? [{ label: 'Open in Metabase', icon: 'external' as const, onSelect: () => void globalThis.open(mbHref, '_blank', 'noopener') }] : []),
              'sep' as const,
              { label: 'Move to trash…', icon: 'trash', danger: true, onSelect: () => setTrash(true), disabled: c.can_write === false },
            ]}
          />
        </div>
      </header>

      {tags.length ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-xl border border-edge-default bg-surface-sunken/40 p-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            run()
          }}
        >
          {tags.map((t) => (
            <label key={t.name} className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                {t['display-name']}
                {t.required ? ' *' : ''}
              </span>
              <input
                aria-label={t['display-name']}
                type={(t.type as VarType) === 'date' ? 'date' : 'text'}
                inputMode={t.type === 'number' ? 'decimal' : undefined}
                value={vars[t.name] ?? ''}
                onChange={(e) => setVars((v) => ({ ...v, [t.name]: e.target.value }))}
                className="h-8 w-44 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content"
              />
            </label>
          ))}
          <Button size="sm" type="submit">Apply</Button>
        </form>
      ) : null}

      <section className="rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-3 py-2">
          <Segmented ariaLabel="Visualization" value={activeDisplay} onChange={setDisplay} size="xs" options={options.map((o) => ({ value: o.id, label: o.label }))} />
          <div className="ml-auto flex items-center gap-3 text-[12px] text-content-muted">
            {result.isFetching ? <Spinner size={12} /> : null}
            {ds && !err ? (
              <>
                <span className="tabular-nums">
                  {(ds.row_count ?? rows.length).toLocaleString()} row{(ds.row_count ?? rows.length) === 1 ? '' : 's'}
                  {truncated ? ' (first 2,000)' : ''}
                </span>
                {ds.running_time != null ? <span className="tabular-nums">{ds.running_time.toLocaleString()} ms</span> : null}
              </>
            ) : null}
            <Segmented<'none' | 'stats' | 'query'>
              ariaLabel="Panel"
              size="xs"
              value={panel}
              onChange={(p) => setPanel((cur) => (cur === p ? 'none' : p))}
              options={[
                { value: 'stats', label: 'Summary' },
                { value: 'query', label: native ? 'SQL' : 'Query' },
              ]}
            />
          </div>
        </div>
        <div className="p-3">
          {missing.length ? (
            <div className="flex h-60 items-center justify-center text-sm text-content-muted">Fill in {missing.map((t) => t['display-name']).join(', ')} and run.</div>
          ) : result.isLoading ? (
            <Skeleton width="100%" height={380} rounded="lg" />
          ) : result.isError ? (
            <InlineError error={result.error} onRetry={run} className="h-60" />
          ) : ds ? (
            err ? (
              <InlineError message={err} className="h-60" />
            ) : activeDisplay === 'table' ? (
              <DataGrid cols={cols} rows={rows} height={460} pageSize={100} />
            ) : (
              <div style={{ height: 420 }}>
                <Visualization display={activeDisplay} dataset={ds} settings={display && display !== c.display ? {} : c.visualization_settings} height={420} metabaseHref={mbHref} />
              </div>
            )
          ) : null}
        </div>
        {panel === 'stats' && ds && !err ? <StatsPanel cols={cols} rows={rows} /> : null}
        {panel === 'query' ? (
          <div className="border-t border-edge-subtle p-3">
            {native || generatedSql ? (
              <CodeEditor value={native ? sql : generatedSql ?? ''} language="sql" readOnly height={220} title={native ? 'Query' : 'SQL generated by Metabase'} />
            ) : (
              <div className="text-[12px] text-content-muted">This question is built with Metabase’s query builder. Run it to see the SQL Metabase generates{mbHref ? <>, or <a className="text-brand-700 hover:underline dark:text-brand-300" href={mbHref} target="_blank" rel="noopener noreferrer">open it in Metabase</a></> : null}.</div>
            )}
          </div>
        ) : null}
      </section>

      <SaveCardModal open={saveAs} onClose={() => setSaveAs(false)} title="Save as new question" initialName={`${c.name} (copy)`} initialDescription={c.description} initialCollection={c.collection_id ?? null} busy={busy} onSave={doSaveAs} />
      <MoveModal open={moving} onClose={() => setMoving(false)} itemName={c.name} current={c.collection_id ?? null} busy={busy} onMove={doMove} />
      <ConfirmDialog
        open={trash}
        title="Move to trash?"
        body={<>“{c.name}” will be moved to Metabase’s trash. Dashboards that use it will show it as missing until it’s restored.</>}
        confirmLabel="Move to trash"
        danger
        busy={busy}
        onConfirm={doTrash}
        onClose={() => setTrash(false)}
      />
    </div>
  )
}

function BackLink({ onClick }: { onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[12px] font-medium text-content-muted hover:text-content">
      <Icon name="chevronLeft" size={14} /> Questions
    </button>
  )
}

function StatsPanel({ cols, rows }: { cols: metabase.MbColumn[]; rows: metabase.MbCell[][] }) {
  const stats = useMemo(() => columnStats(cols, rows), [cols, rows])
  return (
    <div className="border-t border-edge-subtle p-3">
      <div className="mb-2 text-[11px] text-content-subtle">Summary of the {rows.length.toLocaleString()} rows loaded.</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-content-subtle">
              {['Column', 'Type', 'Empty', 'Distinct', 'Min', 'Max', 'Average', 'Sum'].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => (
              <tr key={i} className="border-t border-edge-subtle">
                <td className="px-2 py-1 font-medium text-content">{s.name}</td>
                <td className="px-2 py-1 text-content-muted">{s.kind}</td>
                <td className={cn('px-2 py-1 tabular-nums', s.nulls ? 'text-content' : 'text-content-subtle')}>{s.nulls.toLocaleString()}</td>
                <td className="px-2 py-1 tabular-nums text-content">{s.distinct.toLocaleString()}</td>
                <td className="px-2 py-1 tabular-nums text-content">{s.min == null ? '—' : typeof s.min === 'number' ? formatValue(s.min, cols[i]) : s.min}</td>
                <td className="px-2 py-1 tabular-nums text-content">{s.max == null ? '—' : typeof s.max === 'number' ? formatValue(s.max, cols[i]) : s.max}</td>
                <td className="px-2 py-1 tabular-nums text-content">{s.avg == null ? '—' : formatValue(s.avg, cols[i])}</td>
                <td className="px-2 py-1 tabular-nums text-content">{s.sum == null ? '—' : formatValue(s.sum, cols[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
