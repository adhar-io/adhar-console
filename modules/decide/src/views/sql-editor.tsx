import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Field, Input, Modal, Spinner, Textarea, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import {
  metabaseClient,
  useCard,
  useDatabaseMetadata,
  useDatabasesFull,
  useInvalidateBi,
  useMbUser,
  useSnippets,
} from '../data/bi.ts'
import { useBiParams, useSetBiParams } from '../data/bi-nav.ts'
import { autoDisplay, colKind, VIZ_OPTIONS, vizSupported } from '../data/bi-chart.ts'
import {
  buildParameterValues,
  buildTemplateTags,
  invalidNumbers,
  missingRequired,
  parseSqlVariables,
  type SqlVariable,
  type VarType,
} from '../data/bi-params.ts'
import {
  datasetError,
  errorPosition,
  formatSql,
  type HistoryEntry,
  loadHistory,
  pushHistory,
  safeFilename,
  saveHistory,
  toCsv,
  toJson,
  toTsv,
} from '../data/bi-sql.ts'
import { collectionIdForApi, copyText, downloadText, ensureBiStyles, Icon, IconButton, Menu, Segmented } from '../components/bi-kit.tsx'
import { SaveCardModal } from '../components/bi-dialogs.tsx'
import { Visualization } from '../components/bi-viz.tsx'
import { DataGrid } from '../components/bi-table.tsx'
import { CodeEditor } from '../components/code-editor.tsx'
import type { languages } from 'monaco-editor'
import type { MonacoApi, MonacoEditorInstance } from '../components/monaco-loader.ts'
import { errorToast, InlineError, MetabaseUnavailable } from './bi-states.tsx'

/**
 * Native SQL workbench on Metabase.
 *
 *  • Monaco (bundled, worker-free) with schema-aware completion — tables and
 *    columns from `/api/database/:id/metadata`, Metabase snippets and SQL
 *    keywords; errors are marked at the position the database reports.
 *  • Schema browser: schema picker, table search, fields with types; click to
 *    insert, one-click preview.
 *  • ⌘↵ runs the selection, or the whole query; `{{variables}}` become inputs
 *    and are sent as Metabase template tags.
 *  • Results: virtualised sortable grid, chart view, row count and timings,
 *    CSV / JSON / clipboard export.
 *  • Per-user local history, Metabase snippets, format, explain, and save as
 *    a question (or back to the question being edited).
 *
 * Deep links: `?section=sql&db=<id>` and `?section=sql&question=<id>`.
 */

const DRAFT_KEY = 'adhar.decide.sql-draft'
const STARTER = '-- Write SQL here. ⌘↵ runs the selection or everything.\nSELECT 1 AS ok\n'

interface RunState {
  status: 'idle' | 'running' | 'done' | 'error'
  ds?: metabase.MbDataset
  error?: unknown
  sql?: string
  startedAt?: number
  elapsed?: number
}

const EXPLAIN_ENGINES = new Set(['postgres', 'mysql', 'redshift', 'snowflake', 'h2', 'sqlite', 'duckdb', 'clickhouse', 'presto-jdbc', 'starburst', 'trino', 'vertica'])

export function SqlEditor() {
  ensureBiStyles()
  const params = useBiParams()
  const setParams = useSetBiParams()
  const toast = useToast()
  const me = useMbUser()
  const dbs = useDatabasesFull()
  const snippets = useSnippets()
  const invalidate = useInvalidateBi()
  const editingId = params.question ? Number(params.question) : undefined
  const editing = useCard(editingId)

  const nativeDbs = useMemo(() => (dbs.data ?? []).filter((d) => d.native_permissions !== 'none'), [dbs.data])
  const dbId = params.db ? Number(params.db) : (editing.data?.dataset_query?.database ?? nativeDbs[0]?.id)
  const db = (dbs.data ?? []).find((d) => d.id === dbId)
  const meta = useDatabaseMetadata(dbId)

  const userKey = me.data?.id ?? me.data?.email
  const [sql, setSql] = useState<string>(() => {
    try {
      return globalThis.localStorage?.getItem(DRAFT_KEY) ?? STARTER
    } catch {
      return STARTER
    }
  })
  const [types, setTypes] = useState<Record<string, VarType>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [tick, setTick] = useState(0)
  const [view, setView] = useState<'results' | 'chart'>('results')
  const [chart, setChart] = useState<string | null>(null)
  const [side, setSide] = useState<'schema' | 'history' | 'snippets' | null>('schema')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newSnippet, setNewSnippet] = useState<string | null>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const loadedQuestion = useRef<number | null>(null)

  const vars = useMemo(() => parseSqlVariables(sql), [sql])

  // Per-user history + draft once we know who the user is.
  useEffect(() => {
    if (userKey == null) return
    setHistory(loadHistory(globalThis.localStorage, userKey))
  }, [userKey])
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        globalThis.localStorage?.setItem(DRAFT_KEY, sql)
      } catch { /* storage blocked */ }
    }, 400)
    return () => clearTimeout(t)
  }, [sql])

  // Opening a saved question loads its SQL, database and tag types once.
  useEffect(() => {
    const c = editing.data
    if (!c || loadedQuestion.current === c.id) return
    loadedQuestion.current = c.id
    const q = c.dataset_query?.native?.query
    if (q != null) setSql(q)
    const tags = c.dataset_query?.native?.['template-tags'] ?? {}
    setTypes(Object.fromEntries(Object.values(tags).filter((t) => t.type === 'text' || t.type === 'number' || t.type === 'date').map((t) => [t.name, t.type as VarType])))
    setValues(Object.fromEntries(Object.values(tags).filter((t) => t.default != null).map((t) => [t.name, String(t.default)])))
    if (c.dataset_query?.database && !params.db) setParams({ db: String(c.dataset_query.database) })
    if (c.display) setChart(c.display === 'table' ? null : c.display)
  }, [editing.data]) // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed timer while a query runs.
  useEffect(() => {
    if (run.status !== 'running') return
    const t = setInterval(() => setTick((x) => x + 1), 250)
    return () => clearInterval(t)
  }, [run.status])

  /* ─── completion provider (re-registered per mount; reads latest metadata via ref) ─── */
  const metaRef = useRef<metabase.MbDatabaseMetadata | undefined>(undefined)
  metaRef.current = meta.data
  const snippetsRef = useRef<metabase.MbSnippet[]>([])
  snippetsRef.current = snippets.data ?? []
  const disposers = useRef<Array<{ dispose(): void }>>([])
  useEffect(() => () => disposers.current.forEach((d) => d.dispose()), [])

  const runRef = useRef<(selectionOnly: boolean) => void>(() => {})

  const onMount = useCallback((ed: MonacoEditorInstance, m: MonacoApi) => {
    editorRef.current = ed
    monacoRef.current = m
    disposers.current.push(registerSqlCompletion(m, () => metaRef.current, () => snippetsRef.current))
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => runRef.current(true))
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.Enter, () => runRef.current(false))
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyF, () => doFormat())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearMarkers = () => {
    const m = monacoRef.current
    const model = editorRef.current?.getModel()
    if (m && model) m.editor.setModelMarkers(model, 'bi-sql', [])
  }

  const execute = async (text: string, label?: string) => {
    if (dbId == null) return toast.warning('Pick a database first')
    const runVars = parseSqlVariables(text)
    const missing = missingRequired(runVars, values)
    if (missing.length) return toast.warning(`Fill in ${missing.join(', ')}`, { description: 'Required variables are outside [[ … ]] optional clauses.' })
    const bad = invalidNumbers(runVars, values, types)
    if (bad.length) return toast.warning(`${bad.join(', ')} must be a number`)
    clearMarkers()
    const startedAt = performance.now()
    setRun({ status: 'running', sql: text, startedAt })
    try {
      const ds = await metabaseClient.runNative(dbId, text, {
        templateTags: buildTemplateTags(runVars, types, { prev: editing.data?.dataset_query?.native?.['template-tags'], snippets: snippets.data }),
        parameters: buildParameterValues(runVars, values, types),
      })
      const elapsed = Math.round(performance.now() - startedAt)
      const err = datasetError(ds)
      setRun({ status: 'done', ds, sql: text, elapsed })
      if (err) markError(err, text)
      else if (!chart) setChart(autoDisplay(ds.data?.cols ?? [], ds.data?.rows ?? []) === 'table' ? null : autoDisplay(ds.data?.cols ?? [], ds.data?.rows ?? []))
      if (!label) {
        const next = pushHistory(history, { sql: text, databaseId: dbId, at: Date.now(), ok: !err, rows: ds.row_count, ms: ds.running_time ?? elapsed })
        setHistory(next)
        saveHistory(globalThis.localStorage, userKey, next)
      }
    } catch (e) {
      setRun({ status: 'error', error: e, sql: text, elapsed: Math.round(performance.now() - startedAt) })
    }
  }

  /** Put a squiggle where the database says the error is. */
  const markError = (message: string, ran: string) => {
    const m = monacoRef.current
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!m || !ed || !model) return
    const pos = errorPosition(message, ran)
    if (!pos) return
    // A selection ran: shift the position to where that selection starts.
    const sel = ed.getSelection()
    const selected = sel && !sel.isEmpty() ? model.getValueInRange(sel) : ''
    const offsetLine = selected && selected === ran && sel ? sel.startLineNumber - 1 : 0
    const offsetCol = selected && selected === ran && sel && pos.line === 1 ? sel.startColumn - 1 : 0
    const line = Math.min(model.getLineCount(), pos.line + offsetLine)
    const col = pos.column + offsetCol
    const word = model.getWordAtPosition({ lineNumber: line, column: col })
    m.editor.setModelMarkers(model, 'bi-sql', [{
      startLineNumber: line,
      startColumn: col,
      endLineNumber: line,
      endColumn: word ? word.endColumn : Math.max(col + 1, model.getLineMaxColumn(line)),
      message: message.split('\n')[0],
      severity: m.MarkerSeverity.Error,
    }])
    ed.revealLineInCenterIfOutsideViewport(line)
  }

  runRef.current = (selectionOnly: boolean) => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const sel = ed?.getSelection()
    const selected = selectionOnly && model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : ''
    const text = (selected || sql).trim()
    if (!text) return
    void execute(text)
  }

  const doFormat = () => {
    const ed = editorRef.current
    const current = ed?.getValue() ?? sql
    const next = formatSql(current)
    if (next !== current) {
      if (ed) {
        // Through an edit, so ⌘Z undoes it.
        const model = ed.getModel()!
        ed.pushUndoStop()
        ed.executeEdits('format', [{ range: model.getFullModelRange(), text: next }])
        ed.pushUndoStop()
      }
      setSql(next)
    }
  }

  const insertText = (text: string) => {
    const ed = editorRef.current
    if (!ed) return setSql((s) => `${s}${text}`)
    const sel = ed.getSelection()
    if (!sel) return
    ed.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }])
    ed.focus()
  }

  const explain = () => void execute(`EXPLAIN ${sql.trim().replace(/;\s*$/, '')}`, 'explain')

  const saveExisting = async () => {
    const c = editing.data
    if (!c || dbId == null) return
    setBusy(true)
    try {
      await metabaseClient.updateCard(c.id, {
        dataset_query: {
          type: 'native',
          database: dbId,
          native: { query: sql, 'template-tags': buildTemplateTags(vars, types, { prev: c.dataset_query?.native?.['template-tags'], snippets: snippets.data }) },
        },
      })
      invalidate(['cards'])
      toast.success(`Saved “${c.name}”`)
    } catch (e) {
      toast.error('Couldn’t save the question', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }

  const saveNew = async (v: { name: string; description: string | null; collection: number | 'root'; type: metabase.MbCardType }) => {
    if (dbId == null) return
    setBusy(true)
    try {
      const created = await metabaseClient.createCard({
        name: v.name,
        description: v.description,
        type: v.type,
        display: view === 'chart' && chart ? chart : 'table',
        collection_id: collectionIdForApi(v.collection),
        dataset_query: { type: 'native', database: dbId, native: { query: sql, 'template-tags': buildTemplateTags(vars, types, { snippets: snippets.data }) } },
        visualization_settings: {},
      })
      invalidate(['cards'])
      setSaving(false)
      loadedQuestion.current = created.id
      setParams({ question: String(created.id) })
      toast.success(`Saved “${created.name}”`, { description: 'You are now editing the saved question.' })
    } catch (e) {
      toast.error('Couldn’t save the question', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }

  if (dbs.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading databases…
      </div>
    )
  }
  if (dbs.isError) {
    return (
      <div className="space-y-3">
        <MetabaseUnavailable resource="databases" error={dbs.error} onRetry={() => dbs.refetch()} retrying={dbs.isFetching} />
        <StudioLink />
      </div>
    )
  }
  if (!nativeDbs.length) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={<Icon name="database" size={34} className="text-content-subtle" />}
          title={(dbs.data ?? []).length ? 'No database allows native SQL for your account' : 'No databases connected to Metabase'}
          description={(dbs.data ?? []).length ? 'Ask a Metabase admin for native query permission on a database.' : 'Connect a database in Metabase (Admin → Databases) to query it here.'}
        />
        <StudioLink />
      </div>
    )
  }

  const ds = run.ds
  const err = run.status === 'done' ? datasetError(ds) : null
  const cols = ds?.data?.cols ?? []
  const rows = ds?.data?.rows ?? []
  const elapsed = run.status === 'running' && run.startedAt ? Math.round(performance.now() - run.startedAt) : run.elapsed
  void tick
  const chartOptions = VIZ_OPTIONS.filter((o) => o.id !== 'table' && vizSupported(o.id, cols, rows))
  const activeChart = chart && chartOptions.some((o) => o.id === chart) ? chart : chartOptions[0]?.id
  const truncated = (ds?.row_count ?? 0) >= 2000 || !!ds?.data?.rows_truncated

  const exportAs = (fmt: 'csv' | 'json' | 'tsv') => {
    if (!rows.length) return
    const name = safeFilename(editing.data?.name ?? `query-${new Date().toISOString().slice(0, 16)}`)
    if (fmt === 'csv') downloadText(`${name}.csv`, toCsv(cols, rows), 'text/csv')
    else if (fmt === 'json') downloadText(`${name}.json`, toJson(cols, rows), 'application/json')
    else {
      void copyText(toTsv(cols, rows)).then((ok) => (ok ? toast.success(`Copied ${rows.length.toLocaleString()} rows`) : toast.error('Clipboard is blocked')))
      return
    }
    toast.success(`Exported ${rows.length.toLocaleString()} rows`, truncated ? { description: 'Ad-hoc queries return at most 2,000 rows here.' } : undefined)
  }

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-1.5">
          <Icon name="database" size={15} className="text-content-subtle" />
          <select
            aria-label="Database"
            value={dbId ?? ''}
            onChange={(e) => setParams({ db: e.target.value })}
            className="h-9 max-w-56 rounded-md border border-edge-default bg-surface-raised px-2 text-[13px] text-content"
          >
            {nativeDbs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.engine}</option>)}
          </select>
        </label>
        {editing.data ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-brand-50 px-2 py-1 text-[12px] text-brand-800 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-200 dark:ring-brand-500/30">
            <Icon name="edit" size={12} />
            <span className="truncate">Editing “{editing.data.name}”</span>
            <button type="button" aria-label="Stop editing" title="Detach from the saved question" onClick={() => { loadedQuestion.current = null; setParams({ question: undefined }) }} className="ml-0.5 hover:text-content">
              <Icon name="x" size={12} />
            </button>
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <IconButton icon="wand" label="Format SQL (⇧⌘F)" onClick={doFormat} />
          {db && EXPLAIN_ENGINES.has(db.engine) ? <IconButton icon="info" label="Explain query plan" onClick={explain} /> : null}
          <IconButton icon="database" label="Schema" active={side === 'schema'} onClick={() => setSide((s) => (s === 'schema' ? null : 'schema'))} />
          <IconButton icon="history" label="History" active={side === 'history'} onClick={() => setSide((s) => (s === 'history' ? null : 'history'))} />
          <IconButton icon="pin" label="Snippets" active={side === 'snippets'} onClick={() => setSide((s) => (s === 'snippets' ? null : 'snippets'))} />
          {editing.data ? (
            <>
              <Button size="sm" leading={<Icon name="save" size={14} />} loading={busy} onClick={saveExisting} disabled={editing.data.can_write === false}>
                Save
              </Button>
              <Button size="sm" onClick={() => setSaving(true)}>Save as new</Button>
            </>
          ) : (
            <Button size="sm" leading={<Icon name="save" size={14} />} onClick={() => setSaving(true)}>
              Save as question
            </Button>
          )}
          <Button variant="primary" size="sm" leading={<Icon name="play" size={13} />} loading={run.status === 'running'} onClick={() => runRef.current(true)} title="Run selection or all (⌘↵)">
            Run
          </Button>
        </div>
      </div>

      <div className={cn('grid grid-cols-1 gap-3', side ? 'xl:grid-cols-[minmax(0,1fr)_300px]' : '')}>
        <div className="min-w-0 space-y-3">
          <CodeEditor
            value={sql}
            language="sql"
            readOnly={false}
            onChange={setSql}
            onSave={() => (editing.data ? void saveExisting() : setSaving(true))}
            onMount={onMount}
            height={300}
            title={editing.data?.name ?? 'Query'}
            filename={safeFilename(editing.data?.name ?? 'query')}
          />

          {vars.some((v) => v.kind === 'variable') ? (
            <VariablesBar vars={vars} types={types} values={values} onType={(k, t) => setTypes((s) => ({ ...s, [k]: t }))} onValue={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
          ) : null}

          <section className="rounded-xl border border-edge-default bg-surface-raised shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-3 py-2">
              <Segmented<'results' | 'chart'>
                ariaLabel="Result view"
                size="xs"
                value={view}
                onChange={setView}
                options={[
                  { value: 'results', label: <><Icon name="table" size={12} /> Results</> },
                  { value: 'chart', label: <><Icon name="bar" size={12} /> Chart</>, disabled: !chartOptions.length },
                ]}
              />
              {view === 'chart' && chartOptions.length ? (
                <select aria-label="Chart type" value={activeChart} onChange={(e) => setChart(e.target.value)} className="h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[12px] text-content">
                  {chartOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              ) : null}
              <div className="ml-auto flex items-center gap-3 text-[12px] text-content-muted">
                {run.status === 'running' ? (
                  <span className="inline-flex items-center gap-1.5"><Spinner size={12} /> Running… {((elapsed ?? 0) / 1000).toFixed(1)}s</span>
                ) : run.status === 'done' && !err ? (
                  <>
                    <span className="inline-flex items-center gap-1 text-content"><Icon name="check" size={13} className="text-emerald-600 dark:text-emerald-400" /> {(ds?.row_count ?? rows.length).toLocaleString()} row{(ds?.row_count ?? rows.length) === 1 ? '' : 's'}{truncated ? ' (first 2,000)' : ''}</span>
                    {ds?.running_time != null ? <span title="Time in the database" className="tabular-nums">db {ds.running_time.toLocaleString()} ms</span> : null}
                    {elapsed != null ? <span title="Round trip from the browser" className="tabular-nums">total {elapsed.toLocaleString()} ms</span> : null}
                  </>
                ) : run.status === 'done' || run.status === 'error' ? (
                  <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300"><Icon name="warning" size={13} /> Failed</span>
                ) : null}
                <Menu
                  trigger={(_o, t) => <IconButton icon="download" label="Export results" onClick={t} disabled={!rows.length || !!err} />}
                  items={[
                    { label: 'Download CSV', icon: 'download', onSelect: () => exportAs('csv') },
                    { label: 'Download JSON', icon: 'download', onSelect: () => exportAs('json') },
                    { label: 'Copy as TSV', icon: 'copy', onSelect: () => exportAs('tsv') },
                  ]}
                />
              </div>
            </div>
            <div className="p-3">
              {run.status === 'idle' ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-[13px] text-content-muted">
                  <Icon name="play" size={20} className="text-content-subtle" />
                  Run a query to see results here.
                  <span className="text-[11px] text-content-subtle">⌘↵ runs the selection (or everything) · ⇧⌘↵ always runs everything · ⇧⌘F formats</span>
                </div>
              ) : run.status === 'running' && !ds ? (
                <div className="flex h-56 items-center justify-center"><Spinner /></div>
              ) : run.status === 'error' ? (
                <InlineError error={run.error} onRetry={() => run.sql && void execute(run.sql)} className="h-56" />
              ) : err ? (
                <SqlErrorView message={err} sql={run.sql ?? ''} />
              ) : ds ? (
                view === 'chart' && activeChart ? (
                  <div style={{ height: 380 }}>
                    <Visualization display={activeChart} dataset={ds} height={380} />
                  </div>
                ) : rows.length ? (
                  <DataGrid cols={cols} rows={rows} height={380} />
                ) : (
                  <div className="flex h-40 items-center justify-center text-[13px] text-content-muted">The query ran and returned no rows.</div>
                )
              ) : null}
            </div>
          </section>
        </div>

        {side ? (
          <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            {side === 'schema' ? (
              <SchemaBrowser
                meta={meta.data}
                loading={meta.isLoading}
                error={meta.error}
                onRetry={() => meta.refetch()}
                onInsert={insertText}
                onPreview={(t) => {
                  const q = `SELECT *\nFROM ${qualified(t, db?.engine)}\nLIMIT 100`
                  setSql(q)
                  void execute(q)
                }}
              />
            ) : side === 'history' ? (
              <HistoryPanel
                history={history}
                dbs={dbs.data ?? []}
                onPick={(h) => {
                  setSql(h.sql)
                  if (h.databaseId !== dbId) setParams({ db: String(h.databaseId) })
                }}
                onClear={() => {
                  setHistory([])
                  saveHistory(globalThis.localStorage, userKey, [])
                  toast.success('History cleared')
                }}
              />
            ) : (
              <SnippetsPanel
                snippets={snippets.data ?? []}
                loading={snippets.isLoading}
                error={snippets.error}
                onInsert={(s) => insertText(`{{snippet: ${s.name}}}`)}
                onNew={() => {
                  const ed = editorRef.current
                  const model = ed?.getModel()
                  const sel = ed?.getSelection()
                  setNewSnippet(model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : '')
                }}
              />
            )}
          </aside>
        ) : null}
      </div>

      <SaveCardModal open={saving} onClose={() => setSaving(false)} title="Save as question" initialName={editing.data ? `${editing.data.name} (copy)` : ''} busy={busy} onSave={saveNew} />
      <NewSnippetModal
        content={newSnippet}
        onClose={() => setNewSnippet(null)}
        onCreated={(s) => {
          invalidate(['snippets'])
          toast.success(`Snippet “${s.name}” created`, { action: { label: 'Insert', onClick: () => insertText(`{{snippet: ${s.name}}}`) } })
          setNewSnippet(null)
        }}
      />
    </div>
  )
}

/* ─────────── completion ─────────── */

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN',
  'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT',
  'UNION ALL', 'WITH', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'DATE_TRUNC', 'CURRENT_DATE', 'NOW()', 'OVER', 'PARTITION BY', 'DESC', 'ASC',
]

/** Tables, columns, snippets and keywords — kept current through the getters. */
function registerSqlCompletion(
  m: MonacoApi,
  getMeta: () => metabase.MbDatabaseMetadata | undefined,
  getSnippets: () => metabase.MbSnippet[],
): { dispose(): void } {
  const K = m.languages.CompletionItemKind
  return m.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' ', '{'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      const before = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: word.startColumn })
      const meta = getMeta()
      const tables = meta?.tables ?? []
      const out: languages.CompletionItem[] = []

      // `{{` → snippets.
      if (/\{\{\s*(snippet:\s*)?$/i.test(before)) {
        for (const s of getSnippets()) {
          out.push({ label: `snippet: ${s.name}`, kind: K.Snippet, insertText: `snippet: ${s.name}}}`, detail: 'Metabase snippet', documentation: s.content, range })
        }
        return { suggestions: out }
      }
      // `alias.` / `table.` / `schema.` → columns or tables.
      const dot = /([A-Za-z_][\w$]*)\.$/.exec(before)
      if (dot) {
        const name = dot[1].toLowerCase()
        const full = model.getValue()
        const alias = new RegExp(`([\\w$.\"]+)\\s+(?:AS\\s+)?${dot[1]}\\b`, 'i').exec(full)
        const target = (alias?.[1] ?? dot[1]).replace(/"/g, '').split('.').pop()!.toLowerCase()
        const table = tables.find((t) => t.name.toLowerCase() === target) ?? tables.find((t) => t.name.toLowerCase() === name)
        if (table) {
          for (const f of table.fields ?? []) out.push({ label: f.name, kind: K.Field, insertText: f.name, detail: `${table.name} · ${f.database_type ?? f.base_type?.replace('type/', '') ?? ''}`, documentation: f.description ?? undefined, range })
          return { suggestions: out }
        }
        const inSchema = tables.filter((t) => (t.schema ?? '').toLowerCase() === name)
        if (inSchema.length) {
          for (const t of inSchema) out.push({ label: t.name, kind: K.Struct, insertText: t.name, detail: `table in ${t.schema}`, documentation: t.description ?? undefined, range })
          return { suggestions: out }
        }
      }
      for (const t of tables) {
        out.push({ label: t.name, kind: K.Struct, insertText: t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name, detail: t.schema ? `table · ${t.schema}` : 'table', documentation: t.description ?? undefined, range, sortText: `1${t.name}` })
      }
      // Columns of tables already mentioned in the query come first.
      const text = model.getValue().toLowerCase()
      for (const t of tables) {
        const mentioned = text.includes(t.name.toLowerCase())
        if (!mentioned && tables.length > 40) continue
        for (const f of t.fields ?? []) {
          out.push({ label: { label: f.name, description: t.name }, kind: K.Field, insertText: f.name, detail: `${t.name} · ${f.database_type ?? ''}`, range, sortText: `${mentioned ? '0' : '2'}${f.name}` })
        }
      }
      for (const kw of SQL_KEYWORDS) out.push({ label: kw, kind: K.Keyword, insertText: kw, range, sortText: `3${kw}` })
      return { suggestions: out }
    },
  })
}

function qualified(t: metabase.MbTable, engine?: string): string {
  const q = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : engine === 'mysql' || engine === 'bigquery-cloud-sdk' ? `\`${s}\`` : `"${s.replace(/"/g, '""')}"`)
  return t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name)
}

/* ─────────── panels ─────────── */

function VariablesBar({
  vars,
  types,
  values,
  onType,
  onValue,
}: {
  vars: SqlVariable[]
  types: Record<string, VarType>
  values: Record<string, string>
  onType(k: string, t: VarType): void
  onValue(k: string, v: string): void
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-edge-default bg-surface-sunken/40 p-2.5">
      <span className="flex h-8 items-center gap-1 text-[12px] font-medium text-content-muted"><Icon name="filter" size={13} /> Variables</span>
      {vars.filter((v) => v.kind === 'variable').map((v) => {
        const t = types[v.key] ?? 'text'
        return (
          <div key={v.key} className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              {v.name}
              {v.optional ? <span className="font-normal normal-case"> · optional</span> : ' *'}
            </span>
            <div className="flex">
              <select aria-label={`${v.name} type`} value={t} onChange={(e) => onType(v.key, e.target.value as VarType)} className="h-8 rounded-l-md border border-r-0 border-edge-default bg-surface-sunken px-1.5 text-[11px] text-content-muted">
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
              </select>
              <input
                aria-label={v.name}
                type={t === 'date' ? 'date' : 'text'}
                inputMode={t === 'number' ? 'decimal' : undefined}
                value={values[v.key] ?? ''}
                onChange={(e) => onValue(v.key, e.target.value)}
                className="h-8 w-40 rounded-r-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content"
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SqlErrorView({ message, sql }: { message: string; sql: string }) {
  const pos = errorPosition(message, sql)
  const line = pos ? sql.split('\n')[pos.line - 1] : undefined
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 dark:border-rose-500/30 dark:bg-rose-500/10">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-rose-800 dark:text-rose-200">
        <Icon name="warning" size={14} /> The database rejected the query{pos ? ` at line ${pos.line}, column ${pos.column}` : ''}
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[12px] text-rose-900 dark:text-rose-100">{message}</pre>
      {line != null && pos ? (
        <pre className="overflow-x-auto rounded bg-surface-raised p-2 font-mono text-[12px] text-content">
          {line}
          {'\n'}
          <span className="text-rose-600 dark:text-rose-300">{' '.repeat(Math.max(0, pos.column - 1))}^</span>
        </pre>
      ) : null}
    </div>
  )
}

function SchemaBrowser({
  meta,
  loading,
  error,
  onRetry,
  onInsert,
  onPreview,
}: {
  meta?: metabase.MbDatabaseMetadata
  loading: boolean
  error: unknown
  onRetry(): void
  onInsert(text: string): void
  onPreview(t: metabase.MbTable): void
}) {
  const [schema, setSchema] = useState<string>('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const schemas = useMemo(() => [...new Set((meta?.tables ?? []).map((t) => t.schema ?? ''))].sort(), [meta])
  const tables = useMemo(() => {
    const f = q.trim().toLowerCase()
    return (meta?.tables ?? [])
      .filter((t) => t.visibility_type == null || t.visibility_type === 'normal' || t.visibility_type === '')
      .filter((t) => !schema || (t.schema ?? '') === schema)
      .filter((t) => !f || t.name.toLowerCase().includes(f) || (t.fields ?? []).some((x) => x.name.toLowerCase().includes(f)))
      .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name))
  }, [meta, schema, q])
  return (
    <div className="flex max-h-[calc(100vh-10rem)] flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="space-y-2 border-b border-edge-subtle p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold text-content">Schema</span>
          <span className="text-[11px] text-content-subtle">{meta ? `${tables.length} tables` : ''}</span>
        </div>
        {schemas.length > 1 ? (
          <select aria-label="Schema" value={schema} onChange={(e) => setSchema(e.target.value)} className="h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content">
            <option value="">All schemas</option>
            {schemas.map((s) => <option key={s} value={s}>{s || '(default)'}</option>)}
          </select>
        ) : null}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a table or column…" aria-label="Find a table or column" className="h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content placeholder:text-content-subtle" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : error ? (
          <InlineError error={error} onRetry={onRetry} />
        ) : !tables.length ? (
          <div className="p-4 text-center text-[12px] text-content-muted">{meta?.tables.length ? 'No tables match.' : 'Metabase hasn’t synced any tables for this database yet.'}</div>
        ) : (
          tables.map((t) => {
            const isOpen = open.has(t.id)
            return (
              <div key={t.id}>
                <div className="group flex items-center rounded-md hover:bg-surface-sunken">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n })}
                    className="flex h-7 w-6 items-center justify-center text-content-subtle"
                    aria-label={isOpen ? `Collapse ${t.name}` : `Expand ${t.name}`}
                  >
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                  </button>
                  <button type="button" onClick={() => onInsert(t.schema ? `${t.schema}.${t.name}` : t.name)} title={`Insert ${t.schema ? `${t.schema}.` : ''}${t.name}${t.description ? ` — ${t.description}` : ''}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[12.5px] text-content">
                    <Icon name="table" size={13} className="text-content-subtle" />
                    <span className="truncate">{t.name}</span>
                    {t.schema && !schema ? <span className="truncate text-[10px] text-content-subtle">{t.schema}</span> : null}
                  </button>
                  <button type="button" onClick={() => onPreview(t)} className="mr-1 hidden rounded px-1.5 py-0.5 text-[10px] font-medium text-brand-700 hover:bg-brand-50 group-hover:block dark:text-brand-300 dark:hover:bg-brand-500/10" title="Run SELECT * … LIMIT 100">
                    Preview
                  </button>
                </div>
                {isOpen ? (
                  <ul className="mb-1 ml-6 border-l border-edge-subtle pl-2">
                    {(t.fields ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((f) => (
                      <li key={f.id}>
                        <button type="button" onClick={() => onInsert(f.name)} title={`Insert ${f.name}${f.description ? ` — ${f.description}` : ''}`} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-surface-sunken">
                          <Icon name={fieldIcon(f)} size={12} className="text-content-subtle" />
                          <span className="min-w-0 flex-1 truncate text-content">{f.name}</span>
                          <span className="shrink-0 font-mono text-[10px] text-content-subtle">{f.database_type ?? f.base_type?.replace('type/', '')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function fieldIcon(f: Pick<metabase.MbField, 'base_type' | 'semantic_type' | 'effective_type' | 'name'>): 'key' | 'link' | 'calendar' | 'hash' | 'toggle' | 'text' {
  if (f.semantic_type === 'type/PK') return 'key'
  if (f.semantic_type === 'type/FK') return 'link'
  const k = colKind({ name: f.name, base_type: f.base_type, effective_type: f.effective_type, semantic_type: f.semantic_type })
  return k === 'time' ? 'calendar' : k === 'number' ? 'hash' : k === 'boolean' ? 'toggle' : 'text'
}

function HistoryPanel({ history, dbs, onPick, onClear }: { history: HistoryEntry[]; dbs: metabase.MbDatabase[]; onPick(h: HistoryEntry): void; onClear(): void }) {
  return (
    <div className="flex max-h-[calc(100vh-10rem)] flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-center justify-between border-b border-edge-subtle p-2.5">
        <span className="text-[12px] font-semibold text-content">History <span className="font-normal text-content-subtle">· this browser</span></span>
        {history.length ? <button type="button" onClick={onClear} className="text-[11px] font-medium text-content-muted hover:text-content">Clear</button> : null}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-edge-subtle overflow-y-auto">
        {history.length === 0 ? (
          <li className="p-4 text-center text-[12px] text-content-muted">Queries you run appear here.</li>
        ) : (
          history.map((h, i) => (
            <li key={`${h.at}-${i}`}>
              <button type="button" onClick={() => onPick(h)} className="block w-full px-2.5 py-2 text-left hover:bg-surface-sunken">
                <pre className="line-clamp-3 whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-content">{h.sql}</pre>
                <div className="mt-1 flex items-center gap-2 text-[10.5px] text-content-subtle">
                  <span className={h.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-300'}>{h.ok ? '✓ ok' : '✕ failed'}</span>
                  <span className="truncate">{dbs.find((d) => d.id === h.databaseId)?.name ?? `db ${h.databaseId}`}</span>
                  {h.rows != null ? <span>{h.rows.toLocaleString()} rows</span> : null}
                  <span className="ml-auto shrink-0">{formatRelative(h.at)}</span>
                </div>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function SnippetsPanel({ snippets, loading, error, onInsert, onNew }: { snippets: metabase.MbSnippet[]; loading: boolean; error: unknown; onInsert(s: metabase.MbSnippet): void; onNew(): void }) {
  return (
    <div className="flex max-h-[calc(100vh-10rem)] flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-center justify-between border-b border-edge-subtle p-2.5">
        <span className="text-[12px] font-semibold text-content">Snippets <span className="font-normal text-content-subtle">· shared in Metabase</span></span>
        <button type="button" onClick={onNew} className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-edge-subtle overflow-y-auto">
        {loading ? (
          <li className="flex justify-center p-6"><Spinner /></li>
        ) : error ? (
          <li><InlineError error={error} /></li>
        ) : snippets.length === 0 ? (
          <li className="p-4 text-center text-[12px] text-content-muted">No snippets yet. Select SQL in the editor and choose New to save a reusable fragment.</li>
        ) : (
          snippets.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onInsert(s)} title="Insert {{snippet: …}}" className="block w-full px-2.5 py-2 text-left hover:bg-surface-sunken">
                <div className="text-[12.5px] font-medium text-content">{s.name}</div>
                {s.description ? <div className="text-[11px] text-content-muted">{s.description}</div> : null}
                <pre className="mt-1 line-clamp-2 whitespace-pre-wrap wrap-break-word font-mono text-[10.5px] text-content-subtle">{s.content}</pre>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function NewSnippetModal({ content, onClose, onCreated }: { content: string | null; onClose(): void; onCreated(s: metabase.MbSnippet): void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (content != null) {
      setName('')
      setBody(content)
      setDesc('')
    }
  }, [content])
  const submit = async () => {
    if (!name.trim() || !body.trim()) return
    setBusy(true)
    try {
      onCreated(await metabaseClient.createSnippet({ name: name.trim(), content: body, description: desc.trim() || undefined }))
    } catch (e) {
      toast.error('Couldn’t create the snippet', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={content != null}
      onClose={onClose}
      title="New snippet"
      description="Reusable SQL, inserted as {{snippet: name}} and shared with everyone in Metabase."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !body.trim()} onClick={submit}>Create</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. active customers" />
        </Field>
        <Field label="SQL" required>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="font-mono text-[12px]" />
        </Field>
        <Field label="Description">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** LibreDB Studio — the full DB client — when it's installed; it doesn't depend on Metabase. */
function StudioLink() {
  const studio = useToolPublicUrl('libredb')
  if (!studio) return null
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
      <Icon name="database" size={18} className="text-brand-600 dark:text-brand-300" />
      <div className="min-w-0 flex-1 text-[12.5px] text-content-muted">
        <span className="font-semibold text-content">LibreDB Studio</span> has direct connections to every platform database and works without Metabase.
      </div>
      <a href={studio} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default px-2.5 text-xs font-medium text-content hover:bg-surface-sunken">
        Open Studio <Icon name="external" size={13} />
      </a>
    </div>
  )
}
