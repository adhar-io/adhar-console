import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { KIND, newId, useCollection, useCreate, useRemove, useSeedExamples, useUpdate } from '../data/store.ts'
import { SEED_API_SPECS } from '../data/seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { ApiSpec } from '../data/types.ts'
import {
  extractEndpoints,
  extractSchemas,
  parseSpec,
  type Endpoint,
} from '../data/openapi.ts'

/**
 * API / Schema design surface. Manage a library of API specs, then open one to
 * paste/edit its OpenAPI document (JSON or best-effort YAML) and read it back
 * as grouped endpoints + component schemas. Persistence is localStorage keyed
 * `adhar.design.apiSpecs`, mirroring the ADR / Diagram views.
 */
export function ApiSchemas() {
  const { items: list, isLoading, error, refetch } = useCollection<ApiSpec>(KIND.apiSpec)
  const createSpec = useCreate<ApiSpec>(KIND.apiSpec)
  const updateSpec = useUpdate<ApiSpec>(KIND.apiSpec)
  const removeSpec = useRemove(KIND.apiSpec)
  const seed = useSeedExamples<ApiSpec>(KIND.apiSpec)

  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')

  const editing = useMemo(() => list.find((s) => s.id === openId) ?? null, [list, openId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return list
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.version.toLowerCase().includes(q),
      )
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  }, [list, search])

  if (editing) {
    return (
      <SpecEditor
        spec={editing}
        onBack={() => setOpenId(null)}
        onSave={(patch) => {
          updateSpec.mutate({ ...editing, ...patch, updated_at: new Date().toISOString() })
        }}
        onDelete={() => {
          if (!confirm(`Delete "${editing.name}"?`)) return
          removeSpec.mutate(editing.id)
          setOpenId(null)
        }}
      />
    )
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading API specs…" />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">
          {list.length} {list.length === 1 ? 'spec' : 'specs'} · OpenAPI 3.x
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SearchInput value={search} onChange={setSearch} />
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New spec
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={list.length === 0 ? 'No API specs yet' : 'No matches'}
          description={
            list.length === 0
              ? 'Create a spec, then paste an OpenAPI document to see endpoints and schemas.'
              : 'Try a different search term.'
          }
          action={
            list.length === 0 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => seed.mutate(SEED_API_SPECS)}
                disabled={seed.isPending}
              >
                {seed.isPending ? 'Loading…' : 'Load examples'}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => (
            <SpecCard key={s.id} spec={s} onOpen={() => setOpenId(s.id)} />
          ))}
        </div>
      )}

      <CreateSpecModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => {
          const now = new Date().toISOString()
          const next: ApiSpec = {
            id: newId('api'),
            created_at: now,
            updated_at: now,
            ...input,
          }
          createSpec.mutate(next, { onSuccess: (created) => setOpenId(created.id) })
        }}
      />
    </div>
  )
}

/* ─────────── Library ─────────── */

function SpecCard({ spec, onOpen }: { spec: ApiSpec; onOpen(): void }) {
  const summary = useMemo(() => {
    const { doc, error } = parseSpec(spec.document)
    if (error || !doc) return { endpoints: 0, schemas: 0, ok: false }
    const groups = extractEndpoints(doc)
    const endpoints = Object.values(groups).reduce((n, g) => n + g.length, 0)
    return { endpoints, schemas: extractSchemas(doc).length, ok: true }
  }, [spec.document])

  return (
    <Card interactive className="group">
      <button type="button" onClick={onOpen} className="block w-full p-5 text-left">
        <CardHeader className="!p-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                <span className="rounded-md bg-surface-sunken px-1.5 py-0.5">API</span>
                <span>v{spec.version}</span>
              </div>
              <h3 className="mt-1 truncate text-sm font-semibold text-content">{spec.name}</h3>
            </div>
            <StatusBadge kind={summary.ok ? 'healthy' : 'degraded'}>
              {summary.ok ? 'valid' : 'check'}
            </StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="!px-0 !pt-3">
          <p className="line-clamp-2 text-xs leading-relaxed text-content-muted">
            {spec.description || '—'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
            <span className="font-medium text-content">{summary.endpoints} endpoints</span>
            <span className="text-content-subtle">·</span>
            <span>{summary.schemas} schemas</span>
            <span className="ml-auto">{formatRelative(spec.updated_at)}</span>
          </div>
        </CardBody>
      </button>
    </Card>
  )
}

/* ─────────── Editor ─────────── */

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-sky-50 text-sky-700 ring-sky-200',
  POST: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  PUT: 'bg-amber-50 text-amber-700 ring-amber-200',
  PATCH: 'bg-violet-50 text-violet-700 ring-violet-200',
  DELETE: 'bg-rose-50 text-rose-700 ring-rose-200',
}

function SpecEditor({
  spec,
  onBack,
  onSave,
  onDelete,
}: {
  spec: ApiSpec
  onBack(): void
  onSave(patch: Partial<ApiSpec>): void
  onDelete(): void
}) {
  const [name, setName] = useState(spec.name)
  const [version, setVersion] = useState(spec.version)
  const [description, setDescription] = useState(spec.description)
  const [document, setDocument] = useState(spec.document)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    setName(spec.name)
    setVersion(spec.version)
    setDescription(spec.description)
    setDocument(spec.document)
    setDirty(false)
  }, [spec.id])

  // Auto-save 1.2s after the last edit.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => {
      onSave({ name, version, description, document })
      setDirty(false)
      setSavedAt(Date.now())
    }, 1200)
    return () => clearTimeout(t)
  }, [dirty, name, version, description, document, onSave])

  const parsed = useMemo(() => parseSpec(document), [document])
  const groups = useMemo(() => extractEndpoints(parsed.doc), [parsed.doc])
  const schemas = useMemo(() => extractSchemas(parsed.doc), [parsed.doc])
  const endpointCount = Object.values(groups).reduce((n, g) => n + g.length, 0)

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v)
    setDirty(true)
  }

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-white p-2 shadow-sm">
        <Button size="sm" variant="ghost" onClick={onBack} leading={<IconBack />}>
          Library
        </Button>
        <input
          value={name}
          onChange={(e) => touch(setName)(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold tracking-tight text-content focus:border-edge-default focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <div className="flex items-center gap-1 rounded-md border border-edge-default bg-white px-2 py-1">
          <span className="font-mono text-[10px] text-content-subtle">v</span>
          <input
            value={version}
            onChange={(e) => touch(setVersion)(e.target.value)}
            className="w-16 bg-transparent text-xs focus:outline-none"
            aria-label="Version"
          />
        </div>
        {parsed.format ? (
          <StatusBadge kind="info">{parsed.format.toUpperCase()}</StatusBadge>
        ) : (
          <StatusBadge kind="degraded">unparsed</StatusBadge>
        )}
        <SaveIndicator dirty={dirty} savedAt={savedAt} />
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigator.clipboard?.writeText(document)}
            leading={<IconClipboard />}
          >
            Copy
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </header>

      <Card>
        <CardBody>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
              Description
            </span>
            <input
              value={description}
              onChange={(e) => touch(setDescription)(e.target.value)}
              placeholder="What does this API do?"
              className="mt-1.5 block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </label>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">OpenAPI document</div>
                <div className="text-[11px] text-content-subtle">
                  Paste JSON (YAML best-effort). Renders live as you type.
                </div>
              </div>
              {parsed.error ? (
                <StatusBadge kind="failed">error</StatusBadge>
              ) : (
                <StatusBadge kind="healthy">{endpointCount} ops</StatusBadge>
              )}
            </div>
          </CardHeader>
          <CardBody className="!p-0">
            <textarea
              value={document}
              onChange={(e) => touch(setDocument)(e.target.value)}
              spellCheck={false}
              placeholder='{ "openapi": "3.0.3", "info": { … }, "paths": { … } }'
              className="block h-[62vh] w-full resize-none rounded-b-xl border-0 bg-slate-950 p-4 font-mono text-[12px] leading-relaxed text-slate-100 focus:outline-none"
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">Rendered view</div>
                <div className="text-[11px] text-content-subtle">
                  Endpoints grouped by tag · component schemas
                </div>
              </div>
              {parsed.doc?.info?.title ? (
                <StatusBadge kind="info">{parsed.doc.info.title}</StatusBadge>
              ) : null}
            </div>
          </CardHeader>
          <CardBody className="!p-3">
            <div className="h-[62vh] space-y-5 overflow-y-auto pr-1">
              {parsed.error ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs leading-relaxed text-rose-800">
                  {parsed.error}
                </div>
              ) : (
                <>
                  <EndpointGroups groups={groups} />
                  <SchemaList schemas={schemas} />
                </>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function EndpointGroups({ groups }: { groups: Record<string, Endpoint[]> }) {
  const tags = Object.keys(groups).sort()
  if (!tags.length) {
    return (
      <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-4 text-xs text-content-muted">
        No paths found in this document.
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
        Endpoints
      </div>
      {tags.map((tag) => (
        <div key={tag}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-semibold text-content">{tag}</span>
            <span className="font-mono text-[10px] text-content-subtle">
              {groups[tag].length}
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-edge-subtle">
            {groups[tag].map((ep, idx) => (
              <div
                key={`${ep.method}-${ep.path}-${idx}`}
                className="flex items-center gap-2 border-b border-edge-subtle bg-white px-2.5 py-2 last:border-0"
              >
                <span
                  className={`inline-flex w-16 shrink-0 justify-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ${
                    METHOD_TONE[ep.method] ?? 'bg-surface-sunken text-content-muted ring-edge-subtle'
                  }`}
                >
                  {ep.method}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-content">{ep.path}</span>
                {ep.summary ? (
                  <span className="ml-auto truncate text-[11px] text-content-muted">
                    {ep.summary}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function SchemaList({
  schemas,
}: {
  schemas: ReturnType<typeof extractSchemas>
}) {
  if (!schemas.length) return null
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
        Schemas
      </div>
      <div className="grid grid-cols-1 gap-2">
        {schemas.map((s) => (
          <div key={s.name} className="overflow-hidden rounded-lg border border-edge-subtle">
            <div className="flex items-center justify-between gap-2 border-b border-edge-subtle bg-surface-sunken/50 px-3 py-1.5">
              <span className="font-mono text-xs font-semibold text-content">{s.name}</span>
              <span className="font-mono text-[10px] text-content-subtle">{s.type}</span>
            </div>
            {s.fields.length ? (
              <div className="bg-white">
                {s.fields.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center gap-2 border-b border-edge-subtle px-3 py-1.5 last:border-0"
                  >
                    <span className="font-mono text-[11px] text-content">{f.name}</span>
                    {f.required ? (
                      <span className="font-mono text-[9px] font-bold uppercase text-rose-600">
                        req
                      </span>
                    ) : null}
                    <span className="ml-auto font-mono text-[11px] text-brand-700">{f.type}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white px-3 py-2 text-[11px] text-content-subtle">No fields.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SaveIndicator({ dirty, savedAt }: { dirty: boolean; savedAt: number | null }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!savedAt) return
    const id = setInterval(() => setTick((t) => t + 1), 5000)
    return () => clearInterval(id)
  }, [savedAt])

  if (dirty) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Saving…
      </span>
    )
  }
  if (savedAt) {
    const ago = Math.max(0, Date.now() - savedAt)
    const label =
      ago < 5_000
        ? 'just now'
        : ago < 60_000
          ? `${Math.round(ago / 1000)}s ago`
          : `${Math.round(ago / 60_000)}m ago`
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800"
        data-tick={tick}
      >
        <IconCheck /> Saved {label}
      </span>
    )
  }
  return null
}

/* ─────────── Create ─────────── */

const STARTER_SPEC = `{
  "openapi": "3.0.3",
  "info": {
    "title": "My API",
    "version": "0.1.0",
    "description": "Describe what this API does."
  },
  "paths": {
    "/things": {
      "get": { "tags": ["Things"], "summary": "List things" },
      "post": { "tags": ["Things"], "summary": "Create a thing" }
    }
  },
  "components": {
    "schemas": {
      "Thing": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" }
        },
        "required": ["id"]
      }
    }
  }
}`

function CreateSpecModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose(): void
  onCreate(input: Pick<ApiSpec, 'name' | 'version' | 'description' | 'document'>): void
}) {
  const [name, setName] = useState('')
  const [version, setVersion] = useState('0.1.0')
  const [description, setDescription] = useState('')

  const reset = () => {
    setName('')
    setVersion('0.1.0')
    setDescription('')
  }

  const submit = () => {
    const n = name.trim()
    if (!n) return
    onCreate({
      name: n,
      version: version.trim() || '0.1.0',
      description: description.trim(),
      document: STARTER_SPEC,
    })
    reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New API spec"
      description="Start from a minimal OpenAPI skeleton — paste your document once it's created."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>
            Create spec
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
              Name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Payments API"
              className="mt-1.5 block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
              Version
            </span>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="0.1.0"
              className="mt-1.5 block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </label>
        </div>
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What does this API do?"
            className="mt-1.5 block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </label>
      </div>
    </Modal>
  )
}

/* ─────────── shared atoms ─────────── */

function SearchInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
        <IconSearch />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search specs…"
        className="block h-9 w-44 rounded-lg border border-edge-default bg-white pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
      />
    </div>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
function IconBack() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}
function IconClipboard() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
    </svg>
  )
}
function IconCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
