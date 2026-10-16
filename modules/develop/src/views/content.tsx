import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  useIntegration,
  useToast,
  useToolPublicUrl,
  type Column,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  coerce,
  type ContentType,
  type EntryRow,
  type EntryState,
  isEditable,
  prettyLabel,
  strapiError,
  summaryFields,
  titleField,
  useContentTypes,
  useDeleteEntry,
  useEntries,
  useEntry,
  useLocales,
  useMediaFiles,
  useSaveEntry,
} from '../data/strapi.ts'

/**
 * Content — the platform's Strapi, from the console.
 *
 * Three tabs: Entries (browse, search, edit, save as draft, publish, delete),
 * Media (the upload library) and API (the endpoints a service reads, per
 * content type). Schema design stays in Strapi's Content-Type Builder, and so
 * does anything a plain form cannot edit faithfully — relations, media,
 * components and dynamic zones open there with one click.
 */
type Tab = 'entries' | 'media' | 'api'

const STATE_BADGE: Record<EntryState, { kind: StatusKind; label: string }> = {
  published: { kind: 'healthy', label: 'Published' },
  modified: { kind: 'progressing', label: 'Changed' },
  draft: { kind: 'unknown', label: 'Draft' },
}

export function Content() {
  const connected = useIntegration('strapi')
  const strapiUrl = useToolPublicUrl('strapi')
  const adminUrl = strapiUrl ? `${strapiUrl}/admin` : ''
  const [tab, setTab] = useState<Tab>('entries')
  const types = useContentTypes(connected !== false)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const selected = types.data?.find((t) => t.uid === selectedUid) ?? types.data?.[0]

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1">
        {([['entries', 'Entries'], ['media', 'Media'], ['api', 'API']] as Array<[Tab, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
              tab === id ? 'bg-brand-600 text-white' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {adminUrl ? (
        <a
          href={adminUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong"
        >
          Open Strapi admin ↗
        </a>
      ) : null}
    </div>
  )

  if (connected === false) {
    return (
      <div className="space-y-4">
        {header}
        <NotConnected adminUrl={adminUrl} />
      </div>
    )
  }

  if (types.isLoading) {
    return (
      <div className="space-y-4">
        {header}
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
          <Spinner size={14} /> Loading content types…
        </div>
      </div>
    )
  }
  if (types.isError) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState title="Couldn't reach Strapi" description={strapiError(types.error)} />
      </div>
    )
  }

  const all = types.data ?? []
  return (
    <div className="space-y-4">
      {header}
      {tab === 'entries' ? (
        all.length === 0 ? (
          <EmptyState
            title="No content types yet"
            description="Create one in Strapi's Content-Type Builder; it appears here as soon as Strapi has restarted with it."
            action={adminUrl
              ? (
                <a href={`${adminUrl}/plugins/content-type-builder`} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                  Open the Content-Type Builder ↗
                </a>
              )
              : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <TypeList types={all} selected={selected?.uid} onSelect={setSelectedUid} />
            {selected ? <Entries key={selected.uid} ct={selected} adminUrl={adminUrl} /> : null}
          </div>
        )
      ) : null}
      {tab === 'media' ? <Media /> : null}
      {tab === 'api' ? <ApiReference types={all} /> : null}
    </div>
  )
}

/* ───────────── not connected ───────────── */

function NotConnected({ adminUrl }: { adminUrl: string }) {
  return (
    <div className="rounded-xl border border-dashed border-edge-strong bg-surface-sunken/40 px-6 py-8">
      <div className="text-base font-medium text-content">Strapi isn't connected to this console</div>
      <p className="mt-1 max-w-2xl text-[13px] text-content-muted">
        The console reads and writes content through Strapi's Content API, which needs an API token. The Strapi package
        generates one for the console (the <code className="rounded bg-surface-sunken px-1 font-mono text-[12px]">strapi-api-token</code> Secret),
        registers it in Strapi once Strapi has started, and restarts the console to pick it up.
      </p>
      <ol className="mt-4 max-w-2xl list-decimal space-y-1.5 pl-5 text-[13px] text-content-muted">
        <li>
          If Strapi was installed before the platform did this, upgrade the platform
          (<code className="rounded bg-surface-sunken px-1 font-mono text-[12px]">adhar upgrade</code>). Strapi's first start takes a few minutes.
        </li>
        <li>
          Or set one by hand: in Strapi admin open Settings → API Tokens, create a Full access token with an unlimited
          duration, and give it to the console as <code className="rounded bg-surface-sunken px-1 font-mono text-[12px]">STRAPI_TOKEN</code>.
        </li>
      </ol>
      {adminUrl ? (
        <a
          href={`${adminUrl}/settings/api-tokens`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block rounded-lg bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white shadow-sm hover:bg-brand-700"
        >
          Create a token in Strapi ↗
        </a>
      ) : null}
    </div>
  )
}

/* ───────────── content type list ───────────── */

function TypeList({ types, selected, onSelect }: { types: ContentType[]; selected?: string; onSelect(uid: string): void }) {
  const groups: Array<[string, ContentType[]]> = [
    ['Collection types', types.filter((t) => t.schema.kind === 'collectionType')],
    ['Single types', types.filter((t) => t.schema.kind === 'singleType')],
  ]
  return (
    <nav className="space-y-4 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm" aria-label="Content types">
      {groups.map(([label, list]) =>
        list.length ? (
          <div key={label}>
            <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
            <ul className="space-y-0.5">
              {list.map((t) => (
                <li key={t.uid}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.uid)}
                    aria-current={t.uid === selected ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                      t.uid === selected ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'text-content hover:bg-surface-sunken',
                    )}
                  >
                    <span className="truncate">{t.schema.displayName}</span>
                    {t.schema.draftAndPublish ? (
                      <span className="shrink-0 text-[10px] text-content-subtle" title="Draft & publish">D&amp;P</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null
      )}
    </nav>
  )
}

/* ───────────── entries ───────────── */

function Entries({ ct, adminUrl }: { ct: ContentType; adminUrl: string }) {
  const single = ct.schema.kind === 'singleType'
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState<'all' | 'published'>('all')
  const [editing, setEditing] = useState<{ documentId: string | null } | null>(null)
  const pageSize = 25

  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const q = useEntries(ct, { page, pageSize, search: term, status })
  const title = titleField(ct)
  const extra = summaryFields(ct)
  const dp = Boolean(ct.schema.draftAndPublish)

  const columns = useMemo<Column<EntryRow>[]>(() => {
    const cols: Column<EntryRow>[] = [
      {
        key: 'title',
        header: title ? prettyLabel(title) : 'Entry',
        cell: (e) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-content">{title && e[title] ? String(e[title]) : <span className="text-content-subtle">Untitled</span>}</div>
            <div className="truncate font-mono text-[10px] text-content-subtle">{e.documentId}</div>
          </div>
        ),
      },
    ]
    if (dp) {
      cols.push({
        key: 'state',
        header: 'Status',
        width: 120,
        cell: (e) => (e._state ? <StatusBadge kind={STATE_BADGE[e._state].kind}>{STATE_BADGE[e._state].label}</StatusBadge> : null),
      })
    }
    for (const f of extra) {
      cols.push({
        key: f,
        header: prettyLabel(f),
        cell: (e) => <span className="text-[12px] text-content-muted">{formatValue(e[f])}</span>,
      })
    }
    cols.push({
      key: 'updated',
      header: 'Updated',
      width: 130,
      cell: (e) => <span className="text-[12px] text-content-muted">{e.updatedAt ? formatRelative(String(e.updatedAt)) : '—'}</span>,
    })
    return cols
  }, [title, extra, dp])

  if (single) {
    return <EntryEditor ct={ct} documentId={null} adminUrl={adminUrl} inline onClose={() => {}} />
  }

  const data = q.data
  const total = data?.pagination.total ?? 0
  const pages = data?.pagination.pageCount ?? 1
  return (
    <section className="min-w-0 space-y-3" aria-label={ct.schema.displayName}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-content">{ct.schema.displayName}</div>
          <div className="text-[11px] text-content-subtle">
            {total} {total === 1 ? 'entry' : 'entries'}
            {ct.schema.description ? ` · ${ct.schema.description}` : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${ct.schema.displayName.toLowerCase()}…`}
            aria-label="Search entries"
            className="h-8 w-52 rounded-md border border-edge-default bg-surface-raised px-2.5 text-[12px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
          {dp ? (
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as 'all' | 'published')
                setPage(1)
              }}
              aria-label="Status"
              className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px]"
            >
              <option value="all">All entries</option>
              <option value="published">Published only</option>
            </select>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => setEditing({ documentId: null })}>New entry</Button>
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
          <Spinner size={14} /> Loading entries…
        </div>
      ) : q.isError ? (
        <EmptyState title="Couldn't load entries" description={strapiError(q.error)} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
          <DataTable
            tableId={`develop.content.${ct.apiID}`}
            columns={columns}
            rows={data?.data ?? []}
            rowKey={(e) => e.documentId}
            onRowClick={(e) => setEditing({ documentId: e.documentId })}
            empty={<EmptyState compact title={term ? 'No matches' : 'No entries yet'} description={term ? `Nothing matches "${term}".` : 'Click New entry to add the first one.'} />}
          />
          {pages > 1 ? (
            <div className="flex items-center justify-between border-t border-edge-subtle px-3 py-2 text-[12px] text-content-muted">
              <span>Page {page} of {pages}</span>
              <div className="flex gap-1">
                <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="xs" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {editing ? (
        <EntryEditor ct={ct} documentId={editing.documentId} adminUrl={adminUrl} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  )
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`
  if (typeof v === 'object') {
    // A populated relation or media file: name it the way Strapi would.
    const o = v as Record<string, unknown>
    for (const k of ['name', 'title', 'label', 'headline', 'slug']) if (typeof o[k] === 'string' && o[k]) return o[k] as string
    if (typeof o.url === 'string') return o.url.split('/').pop() || o.url
    return typeof o.documentId === 'string' ? o.documentId : 'Set'
  }
  return String(v)
}

/* ───────────── editor ───────────── */

function EntryEditor({
  ct,
  documentId,
  adminUrl,
  inline = false,
  onClose,
}: {
  ct: ContentType
  documentId: string | null
  adminUrl: string
  inline?: boolean
  onClose(): void
}) {
  const single = ct.schema.kind === 'singleType'
  const isNew = !single && !documentId
  const entry = useEntry(ct, documentId)
  const save = useSaveEntry(ct)
  const remove = useDeleteEntry(ct)
  const toast = useToast()
  const dp = Boolean(ct.schema.draftAndPublish)
  const attrs = Object.entries(ct.schema.attributes)
  const editable = attrs.filter(([, a]) => isEditable(a))
  const readOnly = attrs.filter(([, a]) => !isEditable(a) && !a.private)
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Seed the form from the entry once it loads (or from defaults when new).
  useEffect(() => {
    const src = entry.data ?? {}
    const next: Record<string, unknown> = {}
    for (const [k, a] of editable) {
      const v = (src as Record<string, unknown>)[k] ?? (isNew ? a.default : undefined)
      next[k] = a.type === 'json' ? (v === undefined || v === null ? '' : JSON.stringify(v, null, 2)) : v ?? (a.type === 'boolean' ? false : '')
    }
    setForm(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.data, ct.uid, isNew])

  useEffect(() => {
    if (inline) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [inline, onClose])

  const submit = (publish: boolean) => {
    const data: Record<string, unknown> = {}
    try {
      for (const [k, a] of editable) data[k] = coerce(a, form[k])
    } catch {
      toast.error('One of the JSON fields is not valid JSON.')
      return
    }
    save.mutate(
      { documentId: single ? null : documentId, data, publish },
      {
        onSuccess: () => {
          toast.success(publish && dp ? 'Published.' : dp ? 'Draft saved.' : 'Saved.')
          if (!inline) onClose()
        },
        onError: (e) => toast.error(strapiError(e, 'Couldn\'t save the entry.')),
      },
    )
  }

  const studioLink = adminUrl
    ? single
      ? `${adminUrl}/content-manager/single-types/${ct.uid}`
      : documentId
        ? `${adminUrl}/content-manager/collection-types/${ct.uid}/${documentId}`
        : `${adminUrl}/content-manager/collection-types/${ct.uid}/create`
    : ''

  const body = (
    <>
      {entry.isLoading && !isNew ? (
        <div className="flex items-center gap-2 p-6 text-sm text-content-muted">
          <Spinner size={14} /> Loading…
        </div>
      ) : entry.isError ? (
        <div className="p-6">
          <EmptyState compact title="Couldn't load the entry" description={strapiError(entry.error)} />
        </div>
      ) : (
        <div className="space-y-4 p-5">
          {single && !entry.data ? (
            <p className="text-[12px] text-content-subtle">This single type has no content yet. Saving creates it.</p>
          ) : null}
          {editable.map(([k, a]) => (
            <FieldInput key={k} name={k} attr={a} value={form[k]} onChange={(v) => setForm((f) => ({ ...f, [k]: v }))} />
          ))}
          {readOnly.length ? (
            <div className="rounded-lg border border-edge-subtle bg-surface-sunken/50 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">Edited in Strapi</div>
              <ul className="mt-2 space-y-1 text-[12px] text-content-muted">
                {readOnly.map(([k, a]) => (
                  <li key={k} className="flex justify-between gap-3">
                    <span>{prettyLabel(k)} <span className="text-content-subtle">· {a.type}{a.relation ? ` (${a.relation})` : ''}</span></span>
                    <span className="truncate">{formatValue((entry.data as Record<string, unknown> | null)?.[k])}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </>
  )

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge-default bg-surface-raised px-5 py-3">
      <div className="flex items-center gap-2">
        {!isNew && !single ? (
          confirmDelete ? (
            <>
              <span className="text-[12px] text-content-muted">Delete this entry?</span>
              <Button
                size="sm"
                variant="danger"
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(documentId, {
                    onSuccess: () => {
                      toast.success('Entry deleted.')
                      onClose()
                    },
                    onError: (e) => toast.error(strapiError(e, 'Couldn\'t delete the entry.')),
                  })}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button>
          )
        ) : null}
        {studioLink ? (
          <a href={studioLink} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
            Open in Strapi ↗
          </a>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {!inline ? <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button> : null}
        {dp ? (
          <Button size="sm" variant="secondary" loading={save.isPending && save.variables?.publish === false} onClick={() => submit(false)}>
            Save draft
          </Button>
        ) : null}
        <Button size="sm" variant="primary" loading={save.isPending && save.variables?.publish !== false} onClick={() => submit(true)}>
          {dp ? 'Publish' : 'Save'}
        </Button>
      </div>
    </div>
  )

  if (inline) {
    return (
      <section className="min-w-0 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm" aria-label={ct.schema.displayName}>
        <div className="border-b border-edge-subtle px-5 py-3">
          <div className="text-sm font-semibold text-content">{ct.schema.displayName}</div>
          <div className="text-[11px] text-content-subtle">Single type{entry.data?.updatedAt ? ` · updated ${formatRelative(String(entry.data.updatedAt))}` : ''}</div>
        </div>
        {body}
        {footer}
      </section>
    )
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`${ct.schema.displayName} entry`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-canvas shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{ct.schema.displayName}</div>
            <div className="truncate text-base font-semibold text-content">
              {isNew ? 'New entry' : (() => {
                const t = titleField(ct)
                const v = t ? (entry.data as Record<string, unknown> | null)?.[t] : undefined
                return v ? String(v) : documentId
              })()}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        {footer}
      </aside>
    </div>,
    document.body,
  )
}

const INPUT = 'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

function FieldInput({ name, attr, value, onChange }: { name: string; attr: ContentType['schema']['attributes'][string]; value: unknown; onChange(v: unknown): void }) {
  const label = (
    <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
      {prettyLabel(name)}
      {attr.required ? <span className="text-rose-600"> *</span> : null}
      <span className="ml-1 font-normal normal-case tracking-normal text-content-subtle">{attr.type}</span>
    </span>
  )
  const str = value === null || value === undefined ? '' : String(value)
  let control: React.ReactNode
  switch (attr.type) {
    case 'text':
    case 'richtext':
    case 'json':
      control = (
        <textarea
          value={str}
          onChange={(e) => onChange(e.target.value)}
          rows={attr.type === 'text' ? 3 : 8}
          className={cn(INPUT, (attr.type === 'json' || attr.type === 'richtext') && 'font-mono text-[12px]')}
        />
      )
      break
    case 'boolean':
      control = (
        <label className="inline-flex items-center gap-2 text-sm text-content">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {value ? 'Yes' : 'No'}
        </label>
      )
      break
    case 'enumeration':
      control = (
        <select value={str} onChange={(e) => onChange(e.target.value)} className={INPUT}>
          <option value="">—</option>
          {(attr.enum ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
      break
    case 'integer':
    case 'biginteger':
    case 'decimal':
    case 'float':
      control = (
        <input
          type="number"
          step={attr.type === 'integer' || attr.type === 'biginteger' ? 1 : 'any'}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      )
      break
    case 'date':
      control = <input type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value)} className={INPUT} />
      break
    case 'datetime':
      control = (
        <input
          type="datetime-local"
          value={str ? toLocalInput(str) : ''}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
          className={INPUT}
        />
      )
      break
    case 'time':
      control = <input type="time" step={1} value={str.slice(0, 8)} onChange={(e) => onChange(e.target.value ? `${e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value}.000` : '')} className={INPUT} />
      break
    default:
      control = (
        <input
          type={attr.type === 'email' ? 'email' : 'text'}
          value={str}
          maxLength={attr.maxLength}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      )
  }
  return (
    <label className="block space-y-1.5">
      {label}
      {control}
    </label>
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ───────────── media ───────────── */

function Media() {
  const files = useMediaFiles(true)
  if (files.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading media…
      </div>
    )
  }
  if (files.isError) return <EmptyState title="Couldn't load media" description={strapiError(files.error)} />
  const list = files.data ?? []
  if (!list.length) {
    return <EmptyState title="No media yet" description="Files uploaded in Strapi's Media Library appear here." />
  }
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-content-muted">
        {list.length} file{list.length === 1 ? '' : 's'} · {formatBytes(list.reduce((n, f) => n + (f.size ?? 0) * 1024, 0))}
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {list.map((f) => {
          const thumb = f.formats?.thumbnail?.url ?? (f.mime.startsWith('image/') ? f.url : '')
          return (
            <li key={f.id} className="overflow-hidden rounded-lg border border-edge-default bg-surface-raised shadow-sm">
              <MediaThumb src={thumb ? mediaSrc(thumb) : ''} alt={f.alternativeText ?? f.name} label={(f.ext ?? f.mime).replace('.', '')} />
              <div className="space-y-0.5 px-2 py-1.5">
                <div className="truncate text-[12px] font-medium text-content" title={f.name}>{f.name}</div>
                <div className="text-[10px] text-content-subtle">
                  {formatBytes((f.size ?? 0) * 1024)}
                  {f.width && f.height ? ` · ${f.width}×${f.height}` : ''}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function MediaThumb({ src, alt, label }: { src: string; alt: string; label: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="flex aspect-[4/3] items-center justify-center bg-surface-sunken">
      {src && !failed ? (
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <span className="font-mono text-[11px] uppercase text-content-subtle">{label}</span>
      )}
    </div>
  )
}

/** Strapi serves uploads from its own host; relative URLs go through the console's proxy. */
function mediaSrc(url: string): string {
  return /^https?:\/\//.test(url) ? url : `/api/svc/strapi${url}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/* ───────────── API reference ───────────── */

const IN_CLUSTER = 'http://strapi.adhar-system.svc.cluster.local:1337'

function ApiReference({ types }: { types: ContentType[] }) {
  const locales = useLocales(true)
  const toast = useToast()
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied.'),
      () => toast.error('Couldn\'t copy to the clipboard.'),
    )
  }
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] text-content-muted">
        Services in the cluster read content from Strapi's Content API at{' '}
        <code className="rounded bg-surface-sunken px-1 font-mono text-[12px]">{IN_CLUSTER}</code>, with an API token
        sent as <code className="rounded bg-surface-sunken px-1 font-mono text-[12px]">Authorization: Bearer …</code>.
        Give each service its own read-only token from Strapi's API Tokens settings.
        {locales.data?.length ? ` Locales: ${locales.data.map((l) => l.code + (l.isDefault ? ' (default)' : '')).join(', ')}.` : ''}
      </p>
      {types.length === 0 ? <EmptyState compact title="No content types yet" /> : null}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {types.map((t) => {
          const base = t.schema.kind === 'singleType' ? `/api/${t.schema.singularName}` : `/api/${t.schema.pluralName}`
          const curl = `curl -H "Authorization: Bearer $STRAPI_TOKEN" "${IN_CLUSTER}${base}${t.schema.kind === 'collectionType' ? '?pagination[pageSize]=25' : ''}"`
          const routes = t.schema.kind === 'singleType'
            ? [['GET', base], ['PUT', base], ['DELETE', base]]
            : [['GET', base], ['GET', `${base}/:documentId`], ['POST', base], ['PUT', `${base}/:documentId`], ['DELETE', `${base}/:documentId`]]
          return (
            <div key={t.uid} className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-content">{t.schema.displayName}</div>
                  <div className="font-mono text-[11px] text-content-subtle">{t.uid}</div>
                </div>
                <StatusBadge kind="info">{t.schema.kind === 'singleType' ? 'single' : 'collection'}</StatusBadge>
              </div>
              <ul className="mt-3 space-y-1 font-mono text-[12px]">
                {routes.map(([m, p]) => (
                  <li key={m + p} className="flex gap-2">
                    <span className={cn('w-14 shrink-0 font-semibold', m === 'GET' ? 'text-emerald-600 dark:text-emerald-400' : m === 'DELETE' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400')}>{m}</span>
                    <span className="truncate text-content">{p}</span>
                  </li>
                ))}
              </ul>
              {t.schema.draftAndPublish ? (
                <p className="mt-2 text-[11px] text-content-subtle">Reads return published content; add <code className="font-mono">status=draft</code> for drafts.</p>
              ) : null}
              <div className="mt-3 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded bg-surface-sunken px-2 py-1 font-mono text-[11px] text-content-muted" title={curl}>{curl}</span>
                <Button size="xs" variant="ghost" onClick={() => copy(curl)}>Copy</Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
