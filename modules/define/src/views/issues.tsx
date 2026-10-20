import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Modal, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { usePlaneWorkspace } from '@adhar/shell-ui'
import { useMeMember, type WorkItem } from '../data/work-hooks.ts'
import { byUpdatedDesc, useWorkScope } from '../data/work-scope.ts'
import { andQuery, parse, setOrderBy, type SortField } from '../data/work-ql.ts'
import { issueParam, parseIssueParam, useSetWorkParams, useWorkParams } from '../data/work-nav.ts'
import { legacyQueryToWql, useSavedViews, type ViewDoc } from '../data/work-views.ts'
import { toCsv } from '../data/work-text.ts'
import { localDay } from '../data/work-time.ts'
import { memberDisplayName, useIssueSearch } from '../data/plane.ts'
import type { SavedIssueQuery } from '../data/view-query.ts'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { NewIssueModal } from '../components/new-issue-modal.tsx'
import { IssueQueryBar, QUICK_FILTERS } from '../components/issue-query-bar.tsx'
import { IssueBulkBar } from '../components/issue-bulk-bar.tsx'
import { ALL_COLUMNS, COLUMNS, type ColumnId, DEFAULT_COLUMNS, GROUP_OPTIONS, type GroupBy, IssueTable } from '../components/issue-table.tsx'
import { useItemEditor } from '../components/issue-fields.tsx'
import { ViewSaveModal } from '../components/view-save-modal.tsx'
import { IconColumns, IconDownload, IconKeyboard, IconPlus, IconStar, Kbd, PickMenu, PlaneErrorState, Popover, PRIORITY_LABEL, useHotkeys } from '../components/work-ui.tsx'

/**
 * Issues — the Jira-style navigator over Plane work items: WQL query bar with
 * autocomplete, quick filters, saved views, a virtualised spreadsheet with
 * inline editing, grouping, column picker, bulk edit, keyboard shortcuts and
 * CSV export. Deep links: `?issue=<project>/<id>`, `?view=<id>`, `?q=<WQL>`.
 */

interface Props {
  projectId?: string
  /** A legacy Saved View's filter set (from the old views page / shell). */
  appliedQuery?: SavedIssueQuery
}

const LS = (k: string) => `adhar.define.issues.${k}`
const readLs = <T,>(k: string, fallback: T): T => {
  try {
    const v = globalThis.localStorage?.getItem(LS(k))
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
const writeLs = (k: string, v: unknown) => {
  try {
    globalThis.localStorage?.setItem(LS(k), JSON.stringify(v))
  } catch { /* private mode */ }
}

export function Issues({ projectId, appliedQuery }: Props) {
  const params = useWorkParams()
  const setParams = useSetWorkParams()
  const toast = useToast()
  const slug = usePlaneWorkspace()
  const views = useSavedViews(projectId)
  const me = useMeMember()
  const edit = useItemEditor()

  const [jql, setJql] = useState<string>(() => params.q ?? '')
  const [quick, setQuick] = useState<string[]>([])
  const [groupBy, setGroupBy] = useState<GroupBy>(() => readLs('groupBy', 'none'))
  const [columns, setColumns] = useState<ColumnId[]>(() => readLs('columns', DEFAULT_COLUMNS))
  const [activeView, setActiveView] = useState<string | undefined>(params.view)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusedId, setFocusedId] = useState<string>()
  const [signal, setSignal] = useState<{ id: string; col: 'state' | 'assignees' | 'priority'; n: number } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState<'new' | 'update' | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [menu, setMenu] = useState<'views' | 'columns' | 'group' | null>(null)
  const queryInput = useRef<HTMLInputElement>(null)
  const viewsBtn = useRef<HTMLButtonElement>(null)
  const colsBtn = useRef<HTMLButtonElement>(null)
  const groupBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => writeLs('groupBy', groupBy), [groupBy])
  useEffect(() => writeLs('columns', columns), [columns])

  // Legacy saved-view filters handed over by the shell.
  const appliedKey = appliedQuery ? JSON.stringify(appliedQuery) : ''
  useEffect(() => {
    if (!appliedQuery) return
    const { jql: q, groupBy: g } = legacyQueryToWql(appliedQuery)
    setJql(q)
    if (g) setGroupBy(g as GroupBy)
    setActiveView(undefined)
  }, [appliedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ?view= → apply that view; else the project's default view on first load.
  const applyView = useCallback((v: ViewDoc) => {
    setActiveView(v.id)
    setJql(v.data.jql)
    if (v.data.groupBy) setGroupBy(v.data.groupBy as GroupBy)
    if (v.data.columns?.length) setColumns(v.data.columns as ColumnId[])
  }, [])
  const appliedViewRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!views.data) return
    const wanted = params.view ?? (!params.q && !appliedQuery && appliedViewRef.current === undefined ? views.defaultId : undefined)
    if (!wanted || appliedViewRef.current === wanted) return
    const v = views.views.find((x) => x.id === wanted)
    appliedViewRef.current = wanted
    if (v) applyView(v)
    else if (params.view) toast.warning('That saved view no longer exists, or is personal to someone else.')
  }, [views.data, views.defaultId, params.view]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (params.q !== undefined && params.q !== jql) setJql(params.q)
  }, [params.q]) // eslint-disable-line react-hooks/exhaustive-deps

  const effective = useMemo(() => andQuery(jql, QUICK_FILTERS.filter((f) => quick.includes(f.id)).map((f) => f.jql)), [jql, quick])
  const scope = useWorkScope(projectId, effective, byUpdatedDesc)
  const order = useMemo(() => parse(jql).orderBy[0], [jql])

  const run = (q: string) => {
    setJql(q)
    setActiveView(undefined)
    setSelected(new Set())
    setParams({ q: q || undefined, view: undefined })
  }

  const open = (i: Pick<WorkItem, 'id' | 'project'>) => setParams({ issue: issueParam(i.project, i.id) }, { push: true })
  const openTarget = parseIssueParam(params.issue, projectId)
  const close = () => setParams({ issue: undefined })

  const items = scope.items
  const focusIdx = focusedId ? items.findIndex((i) => i.id === focusedId) : -1
  const focused = focusIdx >= 0 ? items[focusIdx] : undefined
  const move = (d: number) => {
    if (!items.length) return
    const next = items[Math.max(0, Math.min(items.length - 1, (focusIdx < 0 ? (d > 0 ? -1 : 0) : focusIdx) + d))]
    setFocusedId(next.id)
  }

  useHotkeys({
    c: () => setCreateOpen(true),
    '/': () => queryInput.current?.focus(),
    j: () => move(1),
    k: () => move(-1),
    Enter: () => focused && open(focused),
    o: () => focused && open(focused),
    e: () => focused && open(focused),
    a: () => focused && setSignal({ id: focused.id, col: 'assignees', n: Date.now() }),
    s: () => focused && setSignal({ id: focused.id, col: 'state', n: Date.now() }),
    p: () => focused && setSignal({ id: focused.id, col: 'priority', n: Date.now() }),
    m: () => {
      if (!focused) return
      if (!me.id) return toast.warning("Your console account's email doesn't match a Plane member, so the console can't assign you.")
      const on = focused.assignees.includes(me.id)
      edit.patch(focused, { assignees: on ? focused.assignees.filter((x) => x !== me.id) : [...focused.assignees, me.id] }, on ? 'Unassigned you' : 'Assigned to you')
    },
    x: () => {
      if (!focused) return
      const n = new Set(selected)
      if (n.has(focused.id)) n.delete(focused.id)
      else n.add(focused.id)
      setSelected(n)
    },
    Escape: () => selected.size && setSelected(new Set()),
    '?': () => setHelpOpen(true),
  }, !!projectId)

  const exportCsv = (rows: WorkItem[]) => {
    const head = columns.map((c) => COLUMNS[c].label)
    const val = (i: WorkItem, c: ColumnId): string | number | null => {
      switch (c) {
        case 'key':
          return scope.keyOf(i)
        case 'title':
          return i.name
        case 'state':
          return scope.stateById.get(i.state)?.name ?? ''
        case 'priority':
          return PRIORITY_LABEL[i.priority]
        case 'assignees':
          return i.assignees.map((a) => memberDisplayName(scope.memberById.get(a))).join('; ')
        case 'labels':
          return i.labels.map((l) => scope.labelById.get(l)?.name ?? '').join('; ')
        case 'estimate':
          return i.estimate_point ?? ''
        case 'start':
          return i.start_date?.slice(0, 10) ?? ''
        case 'due':
          return i.target_date?.slice(0, 10) ?? ''
        case 'sprint':
          return i.cycle ? scope.cycleById.get(i.cycle)?.name ?? '' : ''
        case 'epic':
          return i.module ? scope.moduleById.get(i.module)?.name ?? '' : ''
        case 'parent': {
          const p = i.parent ? scope.itemById.get(i.parent) : undefined
          return p ? scope.keyOf(p) : ''
        }
        case 'subtasks':
          return scope.all.filter((x) => x.parent === i.id).length
        case 'project':
          return scope.projectById.get(i.project)?.identifier ?? ''
        case 'created':
          return i.created_at
        case 'updated':
          return i.updated_at ?? ''
      }
    }
    const csv = toCsv([head, ...rows.map((i) => columns.map((c) => val(i, c)))])
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${slug}-work-items-${localDay()}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    toast.success(`Exported ${rows.length} item${rows.length === 1 ? '' : 's'} to CSV`)
  }

  if (!projectId) return <EmptyState title="Pick a project" description="Choose one from the project picker above to see its work items." />

  const view = views.views.find((v) => v.id === activeView)
  const dirty = !!view && (view.data.jql !== jql || (!!view.data.groupBy && view.data.groupBy !== groupBy))
  const selectedItems = items.filter((i) => selected.has(i.id))
  const firstError = scope.errors.find((e) => e.projectId === scope.primary) ?? scope.errors[0]

  const onSort = (f: SortField) => {
    const dir = order?.field === f && order.dir === 'asc' ? 'desc' : 'asc'
    run(setOrderBy(jql, f, dir))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button ref={viewsBtn} type="button" onClick={() => setMenu('views')} className="inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12.5px] font-medium text-content hover:bg-surface-sunken">
          <IconStar filled={!!view && view.data.starredBy?.includes(views.me)} />
          <span className="truncate">{view ? view.data.name : 'All work items'}</span>
          {dirty ? <span className="text-[11px] text-amber-600">edited</span> : null}
          <span className="text-content-subtle">▾</span>
        </button>
        {view && dirty ? <Button size="sm" variant="ghost" onClick={() => setSaveOpen('update')}>Update view</Button> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button ref={groupBtn} type="button" onClick={() => setMenu('group')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12px] text-content-muted hover:text-content">
            Group: <span className="font-medium text-content">{GROUP_OPTIONS.find((g) => g.id === groupBy)?.label}</span>
          </button>
          <button ref={colsBtn} type="button" onClick={() => setMenu('columns')} className="inline-flex h-8 items-center gap-1 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12px] text-content-muted hover:text-content" aria-label="Columns"><IconColumns /> <span className="hidden sm:inline">Columns</span></button>
          <Button size="sm" leading={<IconDownload />} onClick={() => exportCsv(items)} disabled={!items.length}>CSV</Button>
          <Button size="sm" variant="ghost" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts" leading={<IconKeyboard />}><span className="hidden sm:inline">Shortcuts</span></Button>
          <Button size="sm" onClick={() => setSaveOpen('new')}>Save view</Button>
          <Button size="sm" variant="primary" leading={<IconPlus />} onClick={() => setCreateOpen(true)}>New item <Kbd>C</Kbd></Button>
        </div>
      </div>

      <IssueQueryBar value={jql} onRun={run} ctx={scope.ctx} compiled={scope.compiled} inputRef={queryInput} quick={quick} onQuick={setQuick} count={items.length} total={scope.all.length} busy={scope.isFetching && !scope.isLoading} />

      {scope.liteProjects.length ? (
        <p className="text-[11.5px] text-content-subtle">Cross-project query: {scope.liteProjects.map((p) => scope.projectById.get(p)?.identifier ?? p).join(', ')} {scope.liteProjects.length === 1 ? 'is' : 'are'} loaded without sprint/epic membership (one Plane request per project instead of one per sprint and epic) — sprint and epic filters only match {scope.projectById.get(scope.primary ?? '')?.identifier ?? 'the primary project'}.</p>
      ) : null}

      <ElsewhereHits terms={scope.compiled.textTerms} raw={jql} loaded={scope.projectIds} onOpen={(p, id) => setParams({ issue: issueParam(p, id) }, { push: true })} />

      {selected.size ? <IssueBulkBar selected={selectedItems} scope={scope} onClear={() => setSelected(new Set())} onExport={exportCsv} /> : null}

      {firstError && !scope.all.length ? (
        <PlaneErrorState error={firstError.error} />
      ) : !scope.isLoading && !items.length ? (
        <EmptyState
          title={scope.all.length ? 'No work items match' : 'No work items yet'}
          description={scope.all.length ? 'Loosen the query or clear the quick filters.' : 'Create the first one — press C.'}
          action={scope.all.length ? <Button size="sm" onClick={() => { run(''); setQuick([]) }}>Clear query</Button> : <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>New item</Button>}
        />
      ) : (
        <IssueTable
          items={items}
          scope={scope}
          columns={columns}
          groupBy={groupBy}
          order={order}
          onSort={onSort}
          selected={selected}
          onSelect={setSelected}
          onOpen={open}
          focusedId={focusedId}
          onFocus={setFocusedId}
          signal={signal}
          loading={scope.isLoading}
        />
      )}
      {firstError && scope.all.length ? <p className="text-[11.5px] text-amber-700 dark:text-amber-300">Some projects failed to refresh — showing the last loaded data. {(firstError.error as Error)?.message}</p> : null}

      {/* views menu */}
      <Popover anchor={viewsBtn} open={menu === 'views'} onClose={() => setMenu(null)} width={300}>
        <PickMenu
          items={[{ id: '_all', label: 'All work items' }, ...views.views.map((v) => ({ id: v.id, label: v.data.name, hint: `${v.data.starredBy?.includes(views.me) ? '★ ' : ''}${v.data.visibility === 'personal' ? 'personal' : v.data.projectId ? '' : 'cross-project'}${views.defaultId === v.id ? ' · default' : ''}` }))]}
          selected={[activeView ?? '_all']}
          onPick={(id) => {
            if (id === '_all') {
              setActiveView(undefined)
              run('')
              return
            }
            const v = views.views.find((x) => x.id === id)
            if (v) {
              applyView(v)
              setParams({ view: v.id, q: undefined })
            }
          }}
          onClose={() => setMenu(null)}
          placeholder="Find a view…"
          empty={views.isError ? 'Saved views are unavailable (console store).' : 'No saved views.'}
          footer={<a href="/define?section=views" onClick={(e) => { e.preventDefault(); history.pushState(history.state, '', '/define?section=views'); dispatchEvent(new PopStateEvent('popstate')) }} className="block rounded-md px-2 py-1 text-[12px] text-content-muted hover:bg-surface-sunken hover:text-content">Manage views →</a>}
        />
      </Popover>
      <Popover anchor={groupBtn} open={menu === 'group'} onClose={() => setMenu(null)} width={200}>
        <PickMenu items={GROUP_OPTIONS.map((g) => ({ id: g.id, label: g.label }))} selected={[groupBy]} onPick={(id) => setGroupBy(id as GroupBy)} onClose={() => setMenu(null)} />
      </Popover>
      <Popover anchor={colsBtn} open={menu === 'columns'} onClose={() => setMenu(null)} width={220} align="end">
        <PickMenu
          multi
          items={ALL_COLUMNS.filter((c) => c !== 'title').map((c) => ({ id: c, label: COLUMNS[c].label }))}
          selected={columns}
          onPick={(id) => setColumns((cs) => (cs.includes(id as ColumnId) ? cs.filter((x) => x !== id) : ALL_COLUMNS.filter((c) => c === id || cs.includes(c))))}
          onClose={() => setMenu(null)}
          footer={<button type="button" onClick={() => setColumns(DEFAULT_COLUMNS)} className="w-full rounded-md px-2 py-1 text-left text-[12px] text-content-muted hover:bg-surface-sunken">Reset columns</button>}
        />
      </Popover>

      {createOpen ? (
        <NewIssueModal projectId={scope.primary ?? projectId} onClose={() => setCreateOpen(false)} onCreated={(i) => setFocusedId(i.id)} />
      ) : null}

      <ViewSaveModal
        open={!!saveOpen}
        onClose={() => setSaveOpen(null)}
        projectId={projectId}
        existing={saveOpen === 'update' ? view : undefined}
        isDefault={saveOpen === 'update' && !!view && views.defaultId === view.id}
        draft={{ jql, layout: 'list', groupBy, columns }}
        onSaved={(id) => {
          setActiveView(id)
          appliedViewRef.current = id
        }}
      />

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      {openTarget ? (
        <IssueDrawer
          key={params.issue}
          projectId={openTarget.projectId}
          issueId={openTarget.issueId}
          onClose={close}
          onPick={(id) => setParams({ issue: issueParam(openTarget.projectId, id) }, { push: true })}
          onPickIn={(p, id) => setParams({ issue: issueParam(p, id) }, { push: true })}
        />
      ) : null}
    </div>
  )
}

export const SHORTCUTS: Array<[string, string]> = [
  ['C', 'Create a work item'],
  ['/', 'Focus the query bar'],
  ['J / K', 'Move between rows'],
  ['Enter / O / E', 'Open the focused item'],
  ['A', 'Assign the focused item'],
  ['S', 'Change its status'],
  ['P', 'Change its priority'],
  ['M', 'Assign / unassign me'],
  ['X', 'Select the focused row (shift-click a checkbox selects a range)'],
  ['Esc', 'Clear the selection / close'],
  ['⌘ ↵', 'Save (create dialog, description, comment)'],
  ['?', 'This help'],
]

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width="sm">
      <table className="w-full text-[13px]">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k} className="border-b border-edge-subtle last:border-0">
              <td className="whitespace-nowrap py-1.5 pr-3"><Kbd>{k}</Kbd></td>
              <td className={cn('py-1.5 text-content-muted')}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

/**
 * Plane's workspace search for the query's free text (or a bare KEY-123),
 * listing matches in projects the page has not loaded — so a search never
 * silently misses work in other projects.
 */
function ElsewhereHits({ terms, raw, loaded, onOpen }: { terms: string[]; raw: string; loaded: string[]; onOpen(projectId: string, id: string): void }) {
  const bareKey = /^\s*[A-Za-z][A-Za-z0-9]*-\d+\s*$/.test(raw) ? raw.trim() : ''
  const q = bareKey || terms.join(' ')
  const search = useIssueSearch(q, { limit: 8 })
  const hits = (search.data ?? []).filter((h) => !loaded.includes(h.project_id))
  if (q.trim().length < 2 || !hits.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-content-muted">
      <span>Also in other projects (Plane search):</span>
      {hits.map((h) => (
        <button key={h.id} type="button" onClick={() => onOpen(h.project_id, h.id)} className="rounded-md border border-edge-default px-1.5 py-0.5 hover:bg-surface-sunken hover:text-content">
          <span className="font-mono text-[11px]">{h.project__identifier}-{h.sequence_id}</span> {h.name}
        </button>
      ))}
    </div>
  )
}
