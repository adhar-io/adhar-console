import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Field, Input, Markdown, Modal, SearchInput, Skeleton, Spinner, Textarea, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import {
  metabaseClient,
  readLocalRecents,
  rememberRecent,
  useBookmarks,
  useCards,
  useCollectionTree,
  useDashboardDetail,
  useDashboardIndex,
  useDashcardResult,
  useInvalidateBi,
  useMbUser,
  useRecentViews,
  useToggleBookmark,
} from '../data/bi.ts'
import { biHref, useBiParams, useGoBi, useSetBiParams } from '../data/bi-nav.ts'
import {
  defaultFilterString,
  filterReach,
  filterWidget,
  parametersForDashcard,
  RELATIVE_DATES,
} from '../data/bi-params.ts'
import { gridMode, layout, ROW_PX } from '../data/bi-grid.ts'
import { safeFilename, toCsv, toJson } from '../data/bi-sql.ts'
import {
  cardTypeIcon,
  collectionIdForApi,
  CollectionSelect,
  copyText,
  displayIcon,
  downloadText,
  ensureBiStyles,
  type FlatCollection,
  flattenCollections,
  FullscreenPortal,
  Icon,
  IconButton,
  isTyping,
  Menu,
  Meta,
  OfficialBadge,
  Segmented,
  useWidth,
  VerifiedBadge,
} from '../components/bi-kit.tsx'
import { mbLink, useMetabaseUrl, Visualization } from '../components/bi-viz.tsx'
import { MiniTable } from '../components/bi-table.tsx'
import { CollectionRail } from '../components/bi-library.tsx'
import { BiSkeletonGrid, errorToast, InlineError, MetabaseUnavailable } from './bi-states.tsx'

/**
 * BI Dashboards — a library of every Metabase dashboard (collections tree,
 * search, favourites, recently viewed, verified) and a native viewer that runs
 * each card through Metabase and draws it in the console: Metabase's own grid
 * positions, dashboard filters wired per card, tabs, auto-refresh,
 * full-screen, CSV / JSON export per card, and links back to Metabase.
 *
 * Deep links: `?section=dashboards&dashboard=<id>&tab=<tabId>`.
 */
export function Dashboards() {
  ensureBiStyles()
  const params = useBiParams()
  const id = params.dashboard ? Number(params.dashboard) : undefined
  if (id != null && Number.isFinite(id)) return <DashboardViewer key={id} id={id} />
  return <DashboardLibrary />
}

/* ═════════════════════════════ Library ═════════════════════════════ */

type LibFilter = 'all' | 'favorites' | 'recent' | 'verified'

function itemCollectionId(d: metabase.MbSearchItem): number | 'root' {
  const id = d.collection?.id ?? d.collection_id ?? null
  return id == null || id === 'root' ? 'root' : Number(id)
}

function DashboardLibrary() {
  const params = useBiParams()
  const setParams = useSetBiParams()
  const index = useDashboardIndex()
  const tree = useCollectionTree()
  const me = useMbUser()
  const bookmarks = useBookmarks()
  const recents = useRecentViews()
  const toggleBm = useToggleBookmark()
  const toast = useToast()
  const mbUrl = useMetabaseUrl()
  const [creating, setCreating] = useState(false)
  const [sort, setSort] = useState<'updated' | 'name'>('updated')

  const filter: LibFilter = (['favorites', 'recent', 'verified'] as const).includes(params.collection as never) ? (params.collection as LibFilter) : 'all'
  const collection: number | 'root' | null = filter === 'all' && params.collection ? (params.collection === 'root' ? 'root' : Number(params.collection)) : null
  const q = params.q ?? ''

  const collections = useMemo(() => flattenCollections(tree.data, me.data?.id), [tree.data, me.data?.id])
  const all = index.data ?? []
  const starred = useMemo(() => new Set((bookmarks.data ?? []).filter((b) => b.type === 'dashboard').map((b) => b.item_id)), [bookmarks.data])
  const recentIds = useMemo(() => {
    const server = (recents.data ?? []).filter((r) => r.model === 'dashboard').map((r) => r.id)
    if (server.length) return server
    return readLocalRecents(me.data?.id).filter((r) => r.model === 'dashboard').map((r) => r.id)
  }, [recents.data, me.data?.id])

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const d of all) c.set(String(itemCollectionId(d)), (c.get(String(itemCollectionId(d))) ?? 0) + 1)
    return c
  }, [all])

  const list = useMemo(() => {
    const f = q.trim().toLowerCase()
    let out = all.filter((d) => !f || d.name.toLowerCase().includes(f) || (d.description ?? '').toLowerCase().includes(f) || (d.collection?.name ?? '').toLowerCase().includes(f))
    if (filter === 'favorites') out = out.filter((d) => starred.has(d.id) || d.bookmark)
    if (filter === 'verified') out = out.filter((d) => d.moderated_status === 'verified')
    if (filter === 'recent') {
      const pos = new Map(recentIds.map((id, i) => [id, i]))
      return out.filter((d) => pos.has(d.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
    }
    if (collection != null) out = out.filter((d) => String(itemCollectionId(d)) === String(collection))
    return [...out].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : Date.parse(b.updated_at ?? b.last_edited_at ?? '') - Date.parse(a.updated_at ?? a.last_edited_at ?? '') || a.name.localeCompare(b.name)
    )
  }, [all, q, filter, collection, starred, recentIds, sort])

  const recentStrip = useMemo(() => {
    if (filter !== 'all' || collection != null || q) return []
    const byId = new Map(all.map((d) => [d.id, d]))
    return recentIds.map((id) => byId.get(id)).filter((d): d is metabase.MbSearchItem => !!d).slice(0, 4)
  }, [filter, collection, q, all, recentIds])

  if (index.isLoading) return <BiSkeletonGrid cards={6} />
  if (index.isError) {
    return <MetabaseUnavailable resource="dashboards" error={index.error} onRetry={() => index.refetch()} retrying={index.isFetching} />
  }

  const onStar = (d: metabase.MbSearchItem) => {
    const on = !(starred.has(d.id) || d.bookmark)
    toggleBm.mutate(
      { type: 'dashboard', id: d.id, on, name: d.name },
      {
        onSuccess: () => toast.success(on ? `Added “${d.name}” to favourites` : `Removed “${d.name}” from favourites`),
        onError: (e) => toast.error('Couldn’t update favourites', { description: errorToast(e) }),
      },
    )
  }

  const setFilter = (f: LibFilter | number | 'root') => setParams({ collection: f === 'all' ? undefined : String(f) })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-sm">
          <SearchInput value={q} onChange={(v) => setParams({ q: v || undefined })} placeholder="Search dashboards…" />
        </div>
        <Segmented<LibFilter>
          ariaLabel="Filter dashboards"
          value={filter}
          onChange={(f) => setFilter(f)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'favorites', label: <><Icon name="star" size={13} /> Favourites</> },
            { value: 'recent', label: <><Icon name="clock" size={13} /> Recent</> },
            { value: 'verified', label: <><Icon name="verified" size={13} /> Verified</> },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label="Sort dashboards"
            value={sort}
            onChange={(e) => setSort(e.target.value as 'updated' | 'name')}
            className="h-9 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content"
          >
            <option value="updated">Recently updated</option>
            <option value="name">Name</option>
          </select>
          {mbUrl ? (
            <a href={mbUrl} target="_blank" rel="noopener noreferrer" className="hidden h-9 items-center gap-1.5 rounded-md border border-edge-default px-3 text-xs font-medium text-content hover:bg-surface-sunken sm:inline-flex">
              Metabase <Icon name="external" size={13} />
            </a>
          ) : null}
          <Button variant="primary" size="sm" leading={<Icon name="plus" size={14} />} onClick={() => setCreating(true)}>
            New dashboard
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <CollectionRail
          collections={collections}
          counts={counts}
          total={all.length}
          active={collection}
          filterActive={filter !== 'all'}
          onPick={(c) => setFilter(c)}
          loading={tree.isLoading}
        />

        <div className="min-w-0 space-y-4">
          {recentStrip.length ? (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Recently viewed</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {recentStrip.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setParams({ dashboard: String(d.id) }, { push: true })}
                    className="flex items-center gap-2 rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-left text-[13px] font-medium text-content shadow-sm hover:border-brand-300"
                  >
                    <Icon name="dashboard" size={15} className="text-brand-600 dark:text-brand-300" />
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {list.length === 0 ? (
            <EmptyState
              icon={<Icon name="dashboard" size={36} className="text-content-subtle" />}
              title={
                all.length === 0
                  ? 'No dashboards in Metabase yet'
                  : filter === 'favorites'
                  ? 'No favourites yet'
                  : filter === 'recent'
                  ? 'Nothing viewed recently'
                  : filter === 'verified'
                  ? 'No verified dashboards'
                  : 'No dashboards match'
              }
              description={
                all.length === 0
                  ? 'Create one here or in Metabase — it appears in this library straight away.'
                  : filter === 'favorites'
                  ? 'Star a dashboard to pin it here. Favourites are your Metabase bookmarks.'
                  : filter === 'verified'
                  ? 'Dashboards verified by a Metabase admin (Pro/Enterprise moderation) show here.'
                  : 'Try a different search or collection.'
              }
              action={all.length === 0 ? <Button variant="primary" size="sm" onClick={() => setCreating(true)}>New dashboard</Button> : undefined}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {list.map((d) => (
                <DashboardTile
                  key={d.id}
                  d={d}
                  starred={starred.has(d.id) || !!d.bookmark}
                  onOpen={() => setParams({ dashboard: String(d.id) }, { push: true })}
                  onStar={() => onStar(d)}
                />
              ))}
            </div>
          )}
          <div className="text-[11px] text-content-subtle">
            {list.length} of {all.length} dashboards{index.isFetching ? ' · refreshing…' : ''}
          </div>
        </div>
      </div>

      <CreateDashboardModal open={creating} onClose={() => setCreating(false)} collections={collections} defaultCollection={collection ?? 'root'} />
    </div>
  )
}

function DashboardTile({ d, starred, onOpen, onStar }: { d: metabase.MbSearchItem; starred: boolean; onOpen(): void; onStar(): void }) {
  const updated = d.updated_at ?? d.last_edited_at
  return (
    <article className="group relative flex flex-col gap-2 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm transition-[border-color,box-shadow] hover:border-brand-300 hover:shadow-md dark:hover:border-brand-500/50">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-700 dark:text-brand-300">
          <Icon name="dashboard" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onOpen} className="block w-full text-left text-[14px] font-semibold leading-snug text-content after:absolute after:inset-0 after:content-[''] hover:text-brand-700 dark:hover:text-brand-300">
            <span className="line-clamp-2">{d.name}</span>
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {d.moderated_status === 'verified' ? <VerifiedBadge /> : null}
            {d.collection?.authority_level === 'official' ? <OfficialBadge /> : null}
            <Meta icon="folder">{d.collection?.name ?? 'Our analytics'}</Meta>
          </div>
        </div>
        <button
          type="button"
          onClick={onStar}
          aria-pressed={starred}
          aria-label={starred ? 'Remove from favourites' : 'Add to favourites'}
          title={starred ? 'Remove from favourites' : 'Add to favourites'}
          className={cn('relative z-[1] -mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-sunken', starred ? 'text-amber-500' : 'text-content-subtle opacity-70 group-hover:opacity-100')}
        >
          <Icon name="star" filled={starred} />
        </button>
      </div>
      {d.description ? <p className="line-clamp-2 text-[12px] leading-relaxed text-content-muted">{d.description}</p> : null}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
        {d.dashboardcard_count != null ? <Meta icon="table">{d.dashboardcard_count} cards</Meta> : null}
        {updated ? <Meta icon="clock" title={new Date(updated).toLocaleString()}>Updated {formatRelative(updated)}</Meta> : null}
        {d.last_editor_common_name ? <Meta icon="user">{d.last_editor_common_name}</Meta> : null}
      </div>
    </article>
  )
}

function CreateDashboardModal({
  open,
  onClose,
  collections,
  defaultCollection,
}: {
  open: boolean
  onClose(): void
  collections: FlatCollection[]
  defaultCollection: number | 'root'
}) {
  const toast = useToast()
  const setParams = useSetBiParams()
  const invalidate = useInvalidateBi()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [coll, setColl] = useState<number | 'root'>(defaultCollection)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setName('')
      setDesc('')
      setColl(defaultCollection)
    }
  }, [open, defaultCollection])
  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const d = await metabaseClient.createDashboard({ name: name.trim(), description: desc.trim() || null, collection_id: collectionIdForApi(coll) })
      invalidate(['dashboards'])
      toast.success(`Created “${d.name}”`, { description: 'Add saved questions to it from the dashboard menu.' })
      onClose()
      setParams({ dashboard: String(d.id) }, { push: true })
    } catch (e) {
      toast.error('Couldn’t create the dashboard', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New dashboard"
      branded
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>
            Create
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Name" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly revenue" maxLength={254} />
        </Field>
        <Field label="Description">
          <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="What is this dashboard for?" />
        </Field>
        <Field label="Collection">
          <CollectionSelect collections={collections} value={coll} onChange={setColl} />
        </Field>
      </form>
    </Modal>
  )
}

/* ═════════════════════════════ Viewer ═════════════════════════════ */

const REFRESH_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Auto-refresh off' },
  { value: 60, label: 'Every minute' },
  { value: 300, label: 'Every 5 min' },
  { value: 900, label: 'Every 15 min' },
  { value: 1800, label: 'Every 30 min' },
  { value: 3600, label: 'Every hour' },
]

function DashboardViewer({ id }: { id: number }) {
  const params = useBiParams()
  const setParams = useSetBiParams()
  const toast = useToast()
  const detail = useDashboardDetail(id)
  const me = useMbUser()
  const bookmarks = useBookmarks()
  const toggleBm = useToggleBookmark()
  const mbUrl = useMetabaseUrl()
  const [values, setValues] = useState<Record<string, string>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [lastRefresh, setLastRefresh] = useState(() => Date.now())
  const [auto, setAuto] = useState(0)
  const [full, setFull] = useState(false)
  const [adding, setAdding] = useState(false)

  const d = detail.data
  const starred = !!bookmarks.data?.some((b) => b.type === 'dashboard' && b.item_id === id)

  // Filters start at their Metabase defaults.
  useEffect(() => {
    if (d) setValues(Object.fromEntries((d.parameters ?? []).map((p) => [p.id, defaultFilterString(p)])))
  }, [d?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (d) rememberRecent(me.data?.id, { model: 'dashboard', id: d.id, name: d.name })
  }, [d?.id, me.data?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
    setLastRefresh(Date.now())
  }, [])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(refresh, auto * 1000)
    return () => clearInterval(t)
  }, [auto, refresh])

  // Keyboard: r = refresh, f = full-screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'r') refresh()
      else if (e.key === 'f') setFull((f) => !f)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [refresh])

  const back = () => setParams({ dashboard: undefined, tab: undefined }, { push: true })

  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton width={260} height={22} />
        <BiSkeletonGrid cards={6} />
      </div>
    )
  }
  if (detail.isError || !d) {
    return (
      <div className="space-y-3">
        <BackLink onClick={back} />
        <MetabaseUnavailable resource="this dashboard" error={detail.error} onRetry={() => detail.refetch()} retrying={detail.isFetching} />
      </div>
    )
  }

  const tabs = [...(d.tabs ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const activeTab = tabs.length ? (tabs.find((t) => String(t.id) === params.tab) ?? tabs[0]) : null
  const cards = d.dashcards.filter((dc) => !activeTab || dc.dashboard_tab_id == null || dc.dashboard_tab_id === activeTab.id)
  const mbHref = mbLink(mbUrl, 'dashboard', d.id)
  const verified = d.moderation_reviews?.some((r) => r.most_recent && r.status === 'verified')
  const paramsList = d.parameters ?? []
  const reach = filterReach(paramsList, d.dashcards)
  const edited = d['last-edit-info']

  const copyLink = async () => {
    const ok = await copyText(biHref('dashboards', { dashboard: String(d.id), tab: activeTab ? String(activeTab.id) : undefined }))
    if (ok) toast.success('Link copied', { description: 'Opens this dashboard in the console.' })
    else toast.error('Clipboard is blocked by the browser')
  }

  return (
    <FullscreenPortal on={full} onExit={() => setFull(false)}>
      <div className="space-y-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {!full ? <BackLink onClick={back} /> : null}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight text-content">{d.name}</h2>
              {verified ? <VerifiedBadge /> : null}
              {d.collection?.authority_level === 'official' ? <OfficialBadge /> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Meta icon="folder">{d.collection?.name ?? 'Our analytics'}</Meta>
              <Meta icon="table">{d.dashcards.length} cards</Meta>
              {edited?.timestamp ? (
                <Meta icon="edit">
                  Edited {formatRelative(edited.timestamp)}
                  {edited.first_name ? ` by ${edited.first_name}` : ''}
                </Meta>
              ) : null}
              <Meta icon="refresh" title={new Date(lastRefresh).toLocaleString()}>
                Data as of {new Date(lastRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Meta>
            </div>
            {d.description ? <p className="mt-2 max-w-3xl text-[13px] text-content-muted">{d.description}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <IconButton
              icon="star"
              filled={starred}
              label={starred ? 'Remove from favourites' : 'Add to favourites'}
              className={starred ? 'text-amber-500 hover:text-amber-500' : ''}
              onClick={() =>
                toggleBm.mutate(
                  { type: 'dashboard', id: d.id, on: !starred, name: d.name },
                  { onError: (e) => toast.error('Couldn’t update favourites', { description: errorToast(e) }) },
                )}
            />
            <select
              aria-label="Auto-refresh"
              value={auto}
              onChange={(e) => setAuto(Number(e.target.value))}
              className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content"
            >
              {REFRESH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <IconButton icon="refresh" label="Refresh all cards (R)" onClick={refresh} />
            <IconButton icon={full ? 'shrink' : 'expand'} label={full ? 'Exit full-screen (Esc)' : 'Full-screen (F)'} onClick={() => setFull((f) => !f)} />
            <IconButton icon="link" label="Copy link" onClick={copyLink} />
            {mbHref ? (
              <a href={mbHref} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default px-2.5 text-xs font-medium text-content hover:bg-surface-sunken">
                <span className="hidden sm:inline">Open in Metabase</span>
                <Icon name="external" size={13} />
              </a>
            ) : null}
            <Menu
              trigger={(_open, toggle) => <IconButton icon="more" label="More" onClick={toggle} />}
              items={[
                { label: 'Add a saved question', icon: 'plus', onSelect: () => setAdding(true), disabled: d.can_write === false, hint: d.can_write === false ? 'You can’t edit this dashboard' : undefined },
                ...(mbHref
                  ? [{
                    label: 'Copy Metabase link',
                    icon: 'link' as const,
                    onSelect: async () => (await copyText(mbHref)) ? toast.success('Metabase link copied') : toast.error('Clipboard is blocked'),
                  }]
                  : []),
                ...(mbHref ? [{ label: 'Edit layout in Metabase', icon: 'edit' as const, onSelect: () => void globalThis.open(mbHref, '_blank', 'noopener') }] : []),
              ]}
            />
          </div>
        </header>

        {paramsList.length ? (
          <FilterBar
            params={paramsList}
            values={values}
            reach={reach}
            dashboardId={d.id}
            onChange={(id, v) => setValues((cur) => ({ ...cur, [id]: v }))}
            onReset={() => setValues(Object.fromEntries(paramsList.map((p) => [p.id, defaultFilterString(p)])))}
          />
        ) : null}

        {tabs.length > 1 ? (
          <div className="border-b border-edge-default">
            <div role="tablist" aria-label="Dashboard tabs" className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={activeTab?.id === t.id}
                  onClick={() => setParams({ tab: String(t.id) })}
                  className={cn(
                    'whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                    activeTab?.id === t.id ? 'border-brand-500 text-content' : 'border-transparent text-content-muted hover:text-content',
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {cards.length === 0 ? (
          <EmptyState
            icon={<Icon name="dashboard" size={32} className="text-content-subtle" />}
            title={activeTab ? 'This tab is empty' : 'This dashboard is empty'}
            description="Add saved questions to it here, or arrange cards in Metabase."
            action={d.can_write !== false ? <Button variant="primary" size="sm" onClick={() => setAdding(true)}>Add a saved question</Button> : undefined}
          />
        ) : (
          <DashboardGrid dashboard={d} cards={cards} values={values} refreshKey={refreshKey} mbUrl={mbUrl} />
        )}
      </div>
      <AddQuestionModal open={adding} onClose={() => setAdding(false)} dashboard={d} tabId={activeTab?.id ?? null} />
    </FullscreenPortal>
  )
}

function BackLink({ onClick }: { onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[12px] font-medium text-content-muted hover:text-content">
      <Icon name="chevronLeft" size={14} /> Dashboards
    </button>
  )
}

/* ─────────── filters ─────────── */

function FilterBar({
  params,
  values,
  reach,
  dashboardId,
  onChange,
  onReset,
}: {
  params: metabase.MbParameter[]
  values: Record<string, string>
  reach: Record<string, number>
  dashboardId: number
  onChange(id: string, v: string): void
  onReset(): void
}) {
  const dirty = params.some((p) => (values[p.id] ?? '') !== defaultFilterString(p))
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-edge-default bg-surface-sunken/40 p-2.5">
      <span className="flex h-8 items-center gap-1 pr-1 text-[12px] font-medium text-content-muted">
        <Icon name="filter" size={13} /> Filters
      </span>
      {params.map((p) => <FilterWidget key={p.id} p={p} value={values[p.id] ?? ''} reach={reach[p.id] ?? 0} dashboardId={dashboardId} onChange={(v) => onChange(p.id, v)} />)}
      {dirty ? (
        <button type="button" onClick={onReset} className="h-8 px-2 text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Reset
        </button>
      ) : null}
    </div>
  )
}

function FilterWidget({ p, value, reach, dashboardId, onChange }: { p: metabase.MbParameter; value: string; reach: number; dashboardId: number; onChange(v: string): void }) {
  const w = filterWidget(p.type)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => draft !== value && onChange(draft)
  const label = (
    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-content-subtle" title={reach ? `Applies to ${reach} card${reach === 1 ? '' : 's'}` : 'Not connected to any card'}>
      {p.name}
      {reach === 0 ? <span className="font-normal normal-case text-amber-700 dark:text-amber-300">· unconnected</span> : null}
    </span>
  )
  const cls = 'h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'
  if (w === 'date-relative') {
    const known = RELATIVE_DATES.some((r) => r.value === value)
    return (
      <label className="flex flex-col gap-0.5">
        {label}
        <select aria-label={p.name} value={known || !value ? value : '__custom'} onChange={(e) => e.target.value !== '__custom' && onChange(e.target.value)} className={cls}>
          <option value="">Any time</option>
          {RELATIVE_DATES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          {!known && value ? <option value="__custom">{value}</option> : null}
        </select>
      </label>
    )
  }
  if (w === 'date-single' || w === 'date-month') {
    return (
      <label className="flex flex-col gap-0.5">
        {label}
        <input aria-label={p.name} type={w === 'date-month' ? 'month' : 'date'} value={value} onChange={(e) => onChange(e.target.value)} className={cls} />
      </label>
    )
  }
  if (w === 'date-range') {
    const [a = '', b = ''] = value.split('~')
    return (
      <label className="flex flex-col gap-0.5">
        {label}
        <span className="flex items-center gap-1">
          <input aria-label={`${p.name} from`} type="date" value={a} onChange={(e) => onChange(e.target.value || b ? `${e.target.value}~${b}` : '')} className={cls} />
          <span className="text-content-subtle">–</span>
          <input aria-label={`${p.name} to`} type="date" value={b} onChange={(e) => onChange(a || e.target.value ? `${a}~${e.target.value}` : '')} className={cls} />
        </span>
      </label>
    )
  }
  return (
    <label className="flex flex-col gap-0.5">
      {label}
      <ValueInput
        dashboardId={dashboardId}
        p={p}
        className={cn(cls, 'w-44')}
        value={draft}
        inputMode={w === 'number' ? 'decimal' : undefined}
        placeholder={w === 'number' ? (p.type === 'number/between' ? 'min, max' : 'Number') : 'Any — comma-separate'}
        onChange={setDraft}
        onCommit={commit}
      />
    </label>
  )
}

/** Text filter input with suggestions from Metabase's field values (when it has them). */
function ValueInput({
  dashboardId,
  p,
  className,
  value,
  placeholder,
  inputMode,
  onChange,
  onCommit,
}: {
  dashboardId: number
  p: metabase.MbParameter
  className: string
  value: string
  placeholder: string
  inputMode?: 'decimal'
  onChange(v: string): void
  onCommit(): void
}) {
  const [options, setOptions] = useState<string[] | null>(null)
  const listId = `bi-param-${dashboardId}-${p.id}`
  const load = () => {
    if (options) return
    // Best-effort: list-backed filters have values; anything else simply has no suggestions.
    void metabaseClient.parameterValues(dashboardId, p.id).then((v) => setOptions(v.slice(0, 200))).catch(() => setOptions([]))
  }
  return (
    <>
      <input
        aria-label={p.name}
        list={options?.length ? listId : undefined}
        className={className}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onFocus={load}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === 'Enter' && onCommit()}
      />
      {options?.length ? (
        <datalist id={listId}>
          {options.map((o) => <option key={o} value={o} />)}
        </datalist>
      ) : null}
    </>
  )
}

/* ─────────── grid ─────────── */

function DashboardGrid({
  dashboard,
  cards,
  values,
  refreshKey,
  mbUrl,
}: {
  dashboard: metabase.MbDashboardDetail
  cards: metabase.MbDashcard[]
  values: Record<string, string>
  refreshKey: number
  mbUrl: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const mode = gridMode(width || 1200)
  const gap = mode === 'phone' ? 10 : 12
  const { columns, placements } = layout(cards, mode)
  const rowPx = ROW_PX[mode]
  return (
    <div
      ref={ref}
      className="grid"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: `${rowPx}px`, gap }}
    >
      {placements.map((p) => {
        const dc = cards.find((c) => c.id === p.id)!
        const px = p.span * rowPx + (p.span - 1) * gap
        return (
          <div key={dc.id} style={{ gridColumn: p.column, gridRow: p.row ?? `span ${p.span}`, order: p.order }} className="min-w-0">
            <DashcardView dashboard={dashboard} dc={dc} values={values} refreshKey={refreshKey} heightPx={px} mbUrl={mbUrl} />
          </div>
        )
      })}
    </div>
  )
}

function DashcardView({
  dashboard,
  dc,
  values,
  refreshKey,
  heightPx,
  mbUrl,
}: {
  dashboard: metabase.MbDashboardDetail
  dc: metabase.MbDashcard
  values: Record<string, string>
  refreshKey: number
  heightPx: number
  mbUrl: string
}) {
  const vs = { ...(dc.card?.visualization_settings ?? {}), ...(dc.visualization_settings ?? {}) }
  const virtual = vs.virtual_card as { display?: string } | undefined
  if (dc.card_id == null || virtual) return <VirtualCard dc={dc} display={virtual?.display ?? 'text'} settings={vs} />
  return <QueryCard dashboard={dashboard} dc={dc} settings={vs} values={values} refreshKey={refreshKey} heightPx={heightPx} mbUrl={mbUrl} />
}

function VirtualCard({ dc, display, settings }: { dc: metabase.MbDashcard; display: string; settings: Record<string, unknown> }) {
  const text = typeof settings.text === 'string' ? settings.text : ''
  if (display === 'heading') {
    return (
      <div className="flex h-full items-end border-b border-edge-default pb-1">
        <h3 className="truncate text-lg font-semibold text-content">{text}</h3>
      </div>
    )
  }
  if (display === 'text') {
    return (
      <div className="h-full overflow-auto rounded-xl px-1 text-[13px] text-content">
        <Markdown text={text} />
      </div>
    )
  }
  if (display === 'link') {
    const link = settings.link as { url?: string; entity?: { name?: string; model?: string } } | undefined
    return (
      <div className="flex h-full items-center rounded-xl border border-edge-default bg-surface-raised px-3 shadow-sm">
        {link?.url ? (
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 truncate text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300">
            <Icon name="link" size={14} /> {link.url}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-content">
            <Icon name="link" size={14} className="text-content-subtle" /> {link?.entity?.name ?? 'Link'}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-edge-default text-[12px] text-content-subtle">
      {display === 'action' ? 'Action buttons run in Metabase' : display === 'iframe' ? 'Embedded page — open in Metabase' : `“${display}” card`}
      <span className="sr-only">dashcard {dc.id}</span>
    </div>
  )
}

function QueryCard({
  dashboard,
  dc,
  settings,
  values,
  refreshKey,
  heightPx,
  mbUrl,
}: {
  dashboard: metabase.MbDashboardDetail
  dc: metabase.MbDashcard
  settings: Record<string, unknown>
  values: Record<string, string>
  refreshKey: number
  heightPx: number
  mbUrl: string
}) {
  const toast = useToast()
  const go = useGoBi()
  const [localKey, setLocalKey] = useState(0)
  const [asTable, setAsTable] = useState(false)
  const parameters = useMemo(() => parametersForDashcard(dashboard.parameters ?? [], dc, values), [dashboard.parameters, dc, values])
  const res = useDashcardResult(dashboard.id, dc.id, dc.card_id, parameters, refreshKey * 1000 + localKey)
  const card = dc.card
  const title = (typeof settings['card.title'] === 'string' && settings['card.title']) || card?.name || 'Untitled'
  const description = (typeof settings['card.description'] === 'string' && settings['card.description']) || card?.description || ''
  const display = card?.display ?? 'table'
  const bodyH = Math.max(40, heightPx - 44)
  const ds = res.data
  const cols = ds?.data?.cols ?? []
  const rows = ds?.data?.rows ?? []
  const mbHref = card ? mbLink(mbUrl, card.type === 'model' ? 'model' : card.type === 'metric' ? 'metric' : 'question', card.id) : ''
  const isScalar = ['scalar', 'smartscalar', 'progress', 'gauge'].includes(display)
  const truncated = (ds?.row_count ?? 0) >= 2000

  const exportAs = (fmt: 'csv' | 'json') => {
    if (!rows.length) return toast.warning('Nothing to export yet')
    const name = safeFilename(`${title}`)
    if (fmt === 'csv') downloadText(`${name}.csv`, toCsv(cols, rows), 'text/csv')
    else downloadText(`${name}.json`, toJson(cols, rows), 'application/json')
    toast.success(`Exported ${rows.length.toLocaleString()} rows`, truncated ? { description: 'Metabase returns at most 2,000 rows to a dashboard card — export from Metabase for the full result.' } : undefined)
  }

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm" aria-label={title}>
      <header className="flex h-10 shrink-0 items-center gap-2 pl-3 pr-1">
        <Icon name={displayIcon(display)} size={14} className="text-content-subtle" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-content" title={description ? `${title} — ${description}` : title}>
          {title}
        </h3>
        {res.isFetching && ds ? <Spinner size={12} /> : null}
        {(dc.series?.length ?? 0) > 0 ? <span className="text-[10px] text-content-subtle" title="Combined series are drawn in Metabase">+{dc.series!.length} series</span> : null}
        <Menu
          trigger={(_o, toggle) => <IconButton icon="more" label={`Actions for ${title}`} onClick={toggle} className="h-7 w-7" />}
          items={[
            { label: 'Refresh card', icon: 'refresh', onSelect: () => setLocalKey((k) => k + 1) },
            ...(!isScalar ? [{ label: asTable ? 'Show chart' : 'View as table', icon: (asTable ? 'bar' : 'table') as 'bar' | 'table', onSelect: () => setAsTable((t) => !t) }] : []),
            'sep' as const,
            { label: 'Download CSV', icon: 'download', onSelect: () => exportAs('csv'), disabled: !rows.length },
            { label: 'Download JSON', icon: 'download', onSelect: () => exportAs('json'), disabled: !rows.length },
            'sep' as const,
            ...(card ? [{ label: 'Open question', icon: cardTypeIcon(card.type), onSelect: () => go('questions', { question: String(card.id) }) }] : []),
            ...(mbHref ? [{ label: 'Open in Metabase', icon: 'external' as const, onSelect: () => void globalThis.open(mbHref, '_blank', 'noopener') }] : []),
          ]}
        />
      </header>
      <div className="min-h-0 flex-1 px-3 pb-3" style={{ height: bodyH }}>
        {res.isLoading ? (
          <div className="flex h-full flex-col justify-end gap-2">
            <Skeleton width="100%" height={Math.max(20, bodyH - 30)} rounded="lg" />
          </div>
        ) : res.isError ? (
          <InlineError error={res.error} onRetry={() => setLocalKey((k) => k + 1)} />
        ) : ds ? (
          asTable ? <MiniTable cols={cols} rows={rows} /> : <Visualization display={display} dataset={ds} settings={settings} height={bodyH} dense metabaseHref={mbHref} />
        ) : null}
      </div>
    </section>
  )
}

/* ─────────── add a question ─────────── */

function AddQuestionModal({ open, onClose, dashboard, tabId }: { open: boolean; onClose(): void; dashboard: metabase.MbDashboardDetail; tabId: number | null }) {
  const cards = useCards()
  const toast = useToast()
  const invalidate = useInvalidateBi()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [size, setSize] = useState<'half' | 'full' | 'small'>('half')
  const list = useMemo(() => {
    const f = q.trim().toLowerCase()
    return (cards.data ?? []).filter((c) => !c.archived && (!f || c.name.toLowerCase().includes(f))).slice(0, 100)
  }, [cards.data, q])
  const add = async (c: metabase.MbCard) => {
    setBusy(c.id)
    try {
      const dims = size === 'full' ? { sizeX: 24, sizeY: 8 } : size === 'small' ? { sizeX: 6, sizeY: 3 } : { sizeX: 12, sizeY: 6 }
      await metabaseClient.addCardToDashboard(dashboard.id, c.id, { tabId, ...dims })
      invalidate(['dashboards'])
      toast.success(`Added “${c.name}”`, { description: `Placed at the bottom of ${dashboard.name}.` })
      onClose()
    } catch (e) {
      toast.error('Couldn’t add the question', { description: errorToast(e) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add a saved question" description={`To “${dashboard.name}”`} width="lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchInput value={q} onChange={setQ} placeholder="Search questions…" shortcut={false} autoFocus />
          </div>
          <Segmented<'half' | 'full' | 'small'>
            ariaLabel="Card size"
            value={size}
            onChange={setSize}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'half', label: 'Half' },
              { value: 'full', label: 'Full width' },
            ]}
          />
        </div>
        {cards.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : cards.isError ? (
          <InlineError error={cards.error} onRetry={() => cards.refetch()} />
        ) : list.length === 0 ? (
          <div className="py-8 text-center text-sm text-content-muted">No saved questions match.</div>
        ) : (
          <ul className="max-h-[50vh] divide-y divide-edge-subtle overflow-y-auto rounded-lg border border-edge-default">
            {list.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                <Icon name={displayIcon(c.display)} size={15} className="text-content-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-content">{c.name}</div>
                  <div className="truncate text-[11px] text-content-subtle">
                    {c.collection?.name ?? 'Our analytics'} · {c.display}
                  </div>
                </div>
                <Button size="xs" loading={busy === c.id} disabled={busy != null} onClick={() => add(c)}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
