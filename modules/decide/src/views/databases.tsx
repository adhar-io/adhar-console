import { useMemo, useState } from 'react'
import { Button, EmptyState, SearchInput, Skeleton, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import {
  metabaseClient,
  useDatabaseHealth,
  useDatabaseMetadata,
  useDatabasesFull,
  useInvalidateBi,
  useMbUser,
} from '../data/bi.ts'
import { useBiParams, useGoBi, useSetBiParams } from '../data/bi-nav.ts'
import { ConfirmDialog, ensureBiStyles, Icon, IconButton, Meta } from '../components/bi-kit.tsx'
import { mbLink, useMetabaseUrl } from '../components/bi-viz.tsx'
import { fieldIcon } from './sql-editor.tsx'
import { BiSkeletonGrid, classifyMbError, errorToast, InlineError, MetabaseUnavailable } from './bi-states.tsx'

/**
 * Databases connected to Metabase: engine, sync status, table / schema counts
 * and connection health; drill into schemas → tables → fields with their
 * types, semantic types and descriptions. Admins can trigger a schema sync or
 * a field-value re-scan (with a confirm) and edit table / field descriptions —
 * Metabase enforces the permission, and a 403 is reported as such.
 *
 * Deep links: `?section=databases&db=<id>&table=<id>`.
 */
export function Databases() {
  ensureBiStyles()
  const params = useBiParams()
  const id = params.db ? Number(params.db) : undefined
  if (id != null && Number.isFinite(id)) return <DatabaseDetail key={id} id={id} />
  return <DatabaseList />
}

const SYNC: Record<string, { label: string; icon: 'check' | 'sync' | 'warning'; cls: string }> = {
  complete: { label: 'Synced', icon: 'check', cls: 'text-emerald-700 dark:text-emerald-300' },
  incomplete: { label: 'Syncing', icon: 'sync', cls: 'text-sky-700 dark:text-sky-300' },
  aborted: { label: 'Sync failed', icon: 'warning', cls: 'text-rose-700 dark:text-rose-300' },
}

function SyncStatus({ status }: { status?: string }) {
  const s = SYNC[status ?? ''] ?? { label: status ? status : 'Unknown', icon: 'sync' as const, cls: 'text-content-muted' }
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] font-medium', s.cls)}>
      <Icon name={s.icon} size={13} className={status === 'incomplete' ? 'animate-spin [animation-duration:2.5s]' : ''} />
      {s.label}
    </span>
  )
}

function HealthBadge({ id, onRecheck }: { id: number; onRecheck?: boolean }) {
  const h = useDatabaseHealth(id)
  if (h.isLoading) return <span className="inline-flex items-center gap-1 text-[12px] text-content-muted"><Spinner size={11} /> Checking</span>
  if (h.isError) {
    const info = classifyMbError(h.error)
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-content-muted" title={info.kind === 'not-found' ? 'This Metabase has no connection health check endpoint' : info.detail}>
        <Icon name="info" size={13} /> Health unknown
      </span>
    )
  }
  const ok = h.data?.status === 'ok'
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-flex items-center gap-1 text-[12px] font-medium', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300')} title={h.data?.message}>
        <Icon name={ok ? 'check' : 'warning'} size={13} />
        {ok ? 'Reachable' : 'Unreachable'}
      </span>
      {onRecheck ? (
        <button type="button" onClick={() => h.refetch()} className="text-[11px] font-medium text-content-muted hover:text-content">
          {h.isFetching ? 'Checking…' : 'Re-check'}
        </button>
      ) : null}
    </span>
  )
}

function engineLabel(e: string): string {
  const map: Record<string, string> = {
    postgres: 'PostgreSQL',
    mysql: 'MySQL',
    h2: 'H2',
    snowflake: 'Snowflake',
    'bigquery-cloud-sdk': 'BigQuery',
    redshift: 'Redshift',
    sqlserver: 'SQL Server',
    clickhouse: 'ClickHouse',
    'presto-jdbc': 'Presto',
    starburst: 'Starburst / Trino',
    mongo: 'MongoDB',
    druid: 'Druid',
    oracle: 'Oracle',
    sqlite: 'SQLite',
    databricks: 'Databricks',
  }
  return map[e] ?? e
}

/* ═════════════════════════════ List ═════════════════════════════ */

function DatabaseList() {
  const dbs = useDatabasesFull()
  const setParams = useSetBiParams()
  const mbUrl = useMetabaseUrl()
  const me = useMbUser()
  if (dbs.isLoading) return <BiSkeletonGrid cards={3} />
  if (dbs.isError) return <MetabaseUnavailable resource="databases" error={dbs.error} onRetry={() => dbs.refetch()} retrying={dbs.isFetching} />
  const list = dbs.data ?? []
  if (!list.length) {
    return (
      <EmptyState
        icon={<Icon name="database" size={22} />}
        title="No databases connected to Metabase"
        description="Add one in Metabase → Admin → Databases. It shows up here once Metabase has synced it."
        action={mbUrl && me.data?.is_superuser ? <a className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300" href={`${mbUrl}/admin/databases/create`} target="_blank" rel="noopener noreferrer">Add a database in Metabase ↗</a> : undefined}
      />
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[12px] text-content-muted">
        <span>{list.length} database{list.length === 1 ? '' : 's'}</span>
        {mbUrl && me.data?.is_superuser ? (
          <a className="inline-flex items-center gap-1 font-medium text-content hover:underline" href={`${mbUrl}/admin/databases`} target="_blank" rel="noopener noreferrer">
            Manage in Metabase <Icon name="external" size={12} />
          </a>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {list.map((d) => {
          const tables = d.tables ?? []
          const schemas = new Set(tables.map((t) => t.schema ?? ''))
          return (
            <article key={d.id} className="relative flex flex-col gap-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm transition-[border-color,box-shadow] hover:border-brand-300 hover:shadow-md dark:hover:border-brand-500/50">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-700 dark:text-brand-300">
                  <Icon name="database" size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setParams({ db: String(d.id) }, { push: true })} className="block w-full truncate text-left text-[14px] font-semibold text-content after:absolute after:inset-0 after:content-[''] hover:text-brand-700 dark:hover:text-brand-300">
                    {d.name}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
                    <span>{engineLabel(d.engine)}</span>
                    {d.is_sample ? <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Sample</span> : null}
                  </div>
                </div>
              </div>
              {d.description ? <p className="line-clamp-2 text-[12px] text-content-muted">{d.description}</p> : null}
              <dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-sunken/60 p-2 text-center">
                <div><dt className="text-[10px] uppercase tracking-wide text-content-subtle">Tables</dt><dd className="text-[15px] font-semibold tabular-nums text-content">{tables.length.toLocaleString()}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wide text-content-subtle">Schemas</dt><dd className="text-[15px] font-semibold tabular-nums text-content">{tables.length ? schemas.size : 0}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wide text-content-subtle">SQL</dt><dd className="text-[12px] font-medium text-content">{d.native_permissions === 'write' ? 'Allowed' : 'No access'}</dd></div>
              </dl>
              <div className="relative z-[1] mt-auto flex flex-wrap items-center gap-x-3 gap-y-1">
                <SyncStatus status={d.initial_sync_status} />
                <HealthBadge id={d.id} />
                {d.updated_at ? <Meta icon="clock" title={new Date(d.updated_at).toLocaleString()}>{formatRelative(d.updated_at)}</Meta> : null}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

/* ═════════════════════════════ Detail ═════════════════════════════ */

function DatabaseDetail({ id }: { id: number }) {
  const params = useBiParams()
  const setParams = useSetBiParams()
  const go = useGoBi()
  const toast = useToast()
  const dbs = useDatabasesFull()
  const meta = useDatabaseMetadata(id)
  const me = useMbUser()
  const invalidate = useInvalidateBi()
  const mbUrl = useMetabaseUrl()
  const [confirm, setConfirm] = useState<'sync' | 'rescan' | null>(null)
  const [busy, setBusy] = useState(false)
  const [schema, setSchema] = useState('')
  const [q, setQ] = useState('')

  const summary = (dbs.data ?? []).find((d) => d.id === id)
  const db = meta.data ?? summary
  const admin = !!me.data?.is_superuser
  const tables = useMemo(() => meta.data?.tables ?? [], [meta.data])
  const schemas = useMemo(() => [...new Set(tables.map((t) => t.schema ?? ''))].sort(), [tables])
  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase()
    return tables
      .filter((t) => !schema || (t.schema ?? '') === schema)
      .filter((t) => !f || t.name.toLowerCase().includes(f) || (t.display_name ?? '').toLowerCase().includes(f) || (t.description ?? '').toLowerCase().includes(f))
      .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name))
  }, [tables, schema, q])
  const tableId = params.table ? Number(params.table) : undefined
  const table = tables.find((t) => t.id === tableId)

  const back = () => setParams({ db: undefined, table: undefined }, { push: true })

  const runAction = async () => {
    const what = confirm
    if (!what) return
    setBusy(true)
    try {
      if (what === 'sync') await metabaseClient.syncSchema(id)
      else await metabaseClient.rescanValues(id)
      toast.success(what === 'sync' ? 'Schema sync started' : 'Field-value re-scan started', { description: 'Metabase runs it in the background — new tables and fields appear when it finishes.' })
      setConfirm(null)
      setTimeout(() => invalidate(['databases']), 4000)
    } catch (e) {
      const info = classifyMbError(e)
      toast.error(info.kind === 'forbidden' ? 'Only Metabase admins can do this' : 'Couldn’t start it', { description: errorToast(e) })
    } finally {
      setBusy(false)
    }
  }

  if ((meta.isLoading && !summary) || dbs.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton width={240} height={22} />
        <BiSkeletonGrid cards={3} />
      </div>
    )
  }
  if (!db) {
    return (
      <div className="space-y-3">
        <BackLink onClick={back} />
        <MetabaseUnavailable resource="this database" error={meta.error ?? dbs.error ?? { status: 404 }} onRetry={() => meta.refetch()} retrying={meta.isFetching} />
      </div>
    )
  }

  const adminHint = admin ? undefined : 'Metabase admins only'

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <BackLink onClick={back} />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-content">{db.name}</h2>
            <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-content-muted ring-1 ring-inset ring-edge-default">{engineLabel(db.engine)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <SyncStatus status={summary?.initial_sync_status ?? db.initial_sync_status} />
            <HealthBadge id={id} onRecheck />
            <Meta icon="table">{tables.length.toLocaleString()} tables · {schemas.length} schemas</Meta>
            {db.timezone ? <Meta icon="clock">{db.timezone}</Meta> : null}
          </div>
          {db.description ? <p className="mt-2 max-w-3xl text-[13px] text-content-muted">{db.description}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button size="sm" leading={<Icon name="sync" size={14} />} disabled={!admin} title={adminHint} onClick={() => setConfirm('sync')}>
            Sync schema
          </Button>
          <Button size="sm" leading={<Icon name="refresh" size={14} />} disabled={!admin} title={adminHint} onClick={() => setConfirm('rescan')}>
            Re-scan values
          </Button>
          {mbUrl ? (
            <a href={admin ? mbLink(mbUrl, 'admin-db', id) : mbLink(mbUrl, 'browse-db', id)} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default px-2.5 text-xs font-medium text-content hover:bg-surface-sunken">
              Metabase <Icon name="external" size={13} />
            </a>
          ) : null}
          <Button variant="primary" size="sm" leading={<Icon name="sql" size={14} />} disabled={summary?.native_permissions === 'none'} title={summary?.native_permissions === 'none' ? 'No native SQL access to this database' : undefined} onClick={() => go('sql', { db: String(id) })}>
            Query
          </Button>
        </div>
      </header>

      {meta.isError ? (
        <InlineError error={meta.error} onRetry={() => meta.refetch()} className="rounded-xl border border-edge-default" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="flex max-h-[70vh] min-w-0 flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
            <div className="space-y-2 border-b border-edge-subtle p-2.5">
              {schemas.length > 1 ? (
                <select aria-label="Schema" value={schema} onChange={(e) => setSchema(e.target.value)} className="h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content">
                  <option value="">All schemas ({tables.length})</option>
                  {schemas.map((s) => <option key={s} value={s}>{s || '(default)'} ({tables.filter((t) => (t.schema ?? '') === s).length})</option>)}
                </select>
              ) : null}
              <SearchInput value={q} onChange={setQ} placeholder="Filter tables…" shortcut="/" />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1">
              {meta.isLoading ? (
                <li className="flex justify-center p-6"><Spinner /></li>
              ) : filtered.length === 0 ? (
                <li className="p-4 text-center text-[12px] text-content-muted">{tables.length ? 'No tables match.' : 'Metabase hasn’t synced any tables yet.'}</li>
              ) : (
                filtered.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setParams({ table: String(t.id) })}
                      aria-current={t.id === tableId ? 'true' : undefined}
                      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', t.id === tableId ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-surface-sunken')}
                    >
                      <Icon name="table" size={14} className="text-content-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-content">{t.display_name ?? t.name}</span>
                        <span className="block truncate font-mono text-[10.5px] text-content-subtle">{t.schema ? `${t.schema}.` : ''}{t.name}</span>
                      </span>
                      <span className="text-[11px] tabular-nums text-content-subtle">{t.fields?.length ?? 0}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="min-w-0">
            {table ? (
              <TableDetail key={table.id} table={table} admin={admin} engine={db.engine} dbId={id} />
            ) : (
              <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-edge-default p-6 text-center text-[13px] text-content-muted">
                <Icon name="table" size={22} className="text-content-subtle" />
                Pick a table to see its fields, types and descriptions.
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'sync' ? 'Sync database schema?' : 'Re-scan field values?'}
        body={
          confirm === 'sync'
            ? <>Metabase will re-read the schema of <b>{db.name}</b> to pick up new or changed tables and columns. It runs in the background and queries the database’s catalog.</>
            : <>Metabase will re-sample distinct values of <b>{db.name}</b>’s fields (used for filter dropdowns). On large tables this puts query load on the database.</>
        }
        confirmLabel={confirm === 'sync' ? 'Start sync' : 'Start re-scan'}
        busy={busy}
        onConfirm={runAction}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}

function BackLink({ onClick }: { onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[12px] font-medium text-content-muted hover:text-content">
      <Icon name="chevronLeft" size={14} /> Databases
    </button>
  )
}

const SEMANTIC_TYPES = [
  '', 'type/PK', 'type/FK', 'type/Name', 'type/Title', 'type/Description', 'type/Category', 'type/Email', 'type/URL', 'type/Quantity', 'type/Score',
  'type/Currency', 'type/Price', 'type/Percentage', 'type/CreationTimestamp', 'type/UpdatedTimestamp', 'type/City', 'type/State', 'type/Country',
  'type/ZipCode', 'type/Latitude', 'type/Longitude', 'type/Company', 'type/Source', 'type/Comment',
]

function TableDetail({ table, admin, engine, dbId }: { table: metabase.MbTable; admin: boolean; engine: string; dbId: number }) {
  const toast = useToast()
  const go = useGoBi()
  const invalidate = useInvalidateBi()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const fields = [...(table.fields ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  const save = async (fn: () => Promise<unknown>, what: string) => {
    setSaving(true)
    try {
      await fn()
      invalidate(['databases'])
      toast.success(`${what} updated`)
      setEditing(null)
    } catch (e) {
      const info = classifyMbError(e)
      toast.error(info.kind === 'forbidden' ? 'Only Metabase admins (data-model access) can edit this' : `Couldn’t update the ${what.toLowerCase()}`, { description: errorToast(e) })
    } finally {
      setSaving(false)
    }
  }

  const quote = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : engine === 'mysql' ? `\`${s}\`` : `"${s}"`)

  return (
    <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <header className="flex flex-col gap-2 border-b border-edge-subtle p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon name="table" size={16} className="text-content-subtle" />
            <h3 className="truncate text-[15px] font-semibold text-content">{table.display_name ?? table.name}</h3>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-content-subtle">{table.schema ? `${table.schema}.` : ''}{table.name} · {fields.length} fields{table.entity_type ? ` · ${table.entity_type.replace('entity/', '')}` : ''}</div>
          {editing === 'table' ? (
            <InlineEdit value={draft} onChange={setDraft} saving={saving} onCancel={() => setEditing(null)} onSave={() => save(() => metabaseClient.updateTable(table.id, { description: draft.trim() || null }), 'Table description')} />
          ) : (
            <div className="mt-1.5 flex items-start gap-1">
              <p className={cn('text-[12.5px]', table.description ? 'text-content-muted' : 'italic text-content-subtle')}>{table.description || 'No description'}</p>
              {admin ? <IconButton icon="edit" label="Edit table description" className="h-6 w-6" onClick={() => { setDraft(table.description ?? ''); setEditing('table') }} /> : null}
            </div>
          )}
        </div>
        <Button
          size="sm"
          leading={<Icon name="play" size={13} />}
          onClick={() => {
            try {
              globalThis.localStorage?.setItem('adhar.decide.sql-draft', `SELECT *\nFROM ${table.schema ? `${quote(table.schema)}.` : ''}${quote(table.name)}\nLIMIT 100\n`)
            } catch { /* storage blocked */ }
            go('sql', { db: String(dbId) })
          }}
        >
          Query table
        </Button>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead className="bg-surface-sunken/60 text-left text-[11px] text-content-subtle">
            <tr>
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Semantic type</th>
              <th className="px-3 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id} className="border-t border-edge-subtle align-top">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <Icon name={fieldIcon(f)} size={13} className="text-content-subtle" />
                    <span className="font-medium text-content">{f.display_name ?? f.name}</span>
                  </div>
                  {f.display_name && f.display_name !== f.name ? <div className="ml-5 font-mono text-[10.5px] text-content-subtle">{f.name}</div> : null}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-content-muted">{f.database_type ?? f.base_type?.replace('type/', '') ?? '—'}</td>
                <td className="px-3 py-2">
                  {admin ? (
                    <select
                      aria-label={`Semantic type of ${f.name}`}
                      value={f.semantic_type ?? ''}
                      disabled={saving}
                      onChange={(e) => void save(() => metabaseClient.updateField(f.id, { semantic_type: e.target.value || null }), 'Semantic type')}
                      className="h-7 max-w-44 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[12px] text-content"
                    >
                      {[...new Set([...SEMANTIC_TYPES, f.semantic_type ?? ''])].map((s) => <option key={s} value={s}>{s ? s.replace('type/', '') : '—'}</option>)}
                    </select>
                  ) : (
                    <span className="text-content-muted">{f.semantic_type?.replace('type/', '') ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {editing === `f${f.id}` ? (
                    <InlineEdit value={draft} onChange={setDraft} saving={saving} onCancel={() => setEditing(null)} onSave={() => save(() => metabaseClient.updateField(f.id, { description: draft.trim() || null }), 'Field description')} />
                  ) : (
                    <div className="flex items-start gap-1">
                      <span className={cn(f.description ? 'text-content-muted' : 'italic text-content-subtle')}>{f.description || '—'}</span>
                      {admin ? <IconButton icon="edit" label={`Edit description of ${f.name}`} className="h-6 w-6 shrink-0" onClick={() => { setDraft(f.description ?? ''); setEditing(`f${f.id}`) }} /> : null}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function InlineEdit({ value, onChange, saving, onSave, onCancel }: { value: string; onChange(v: string): void; saving: boolean; onSave(): void; onCancel(): void }) {
  return (
    <form
      className="mt-1 flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave()
        }}
        rows={2}
        className="w-full min-w-48 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[12.5px] text-content"
      />
      <div className="flex gap-1.5">
        <Button size="xs" variant="primary" type="submit" loading={saving}>Save</Button>
        <Button size="xs" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
