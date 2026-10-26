import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Markdown, Modal, StatusBadge, useOptionalUser, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { KIND, type Listed, newId, useCollection, useCreate, useRemove, useUpdate } from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { ApiSpec } from '../data/types.ts'
import {
  componentSchemas,
  detectKind,
  diffSpecs,
  exampleFor,
  extractOperations,
  groupByTag,
  type Issue,
  KIND_LABEL,
  type OpenApiDoc,
  type Operation,
  parseSpec,
  type RawSchema,
  refName,
  resolvePointer,
  serversOf,
  type SnippetLang,
  snippetFor,
  SPEC_STARTERS,
  type SpecKind,
  specVersionLabel,
  toYaml,
  typeLabel,
  validateInstance,
  validateSpec,
} from '../data/openapi.ts'
import { designLink, useDesignParams, useNewFlag, useSetDesignParams } from '../data/deep-link.ts'
import { SourceEditor } from '../components/source-editor.tsx'
import { CommitToRepoModal, ImportFromRepoModal } from '../components/git-dialogs.tsx'
import { copyText, downloadText, pickTextFile } from '../components/export.ts'
import { useAutosave } from '../components/use-autosave.ts'
import { Icon, Menu, SaveDot, SearchBox, Segmented, useConfirm } from '../components/ui-bits.tsx'
import { slugify } from '../data/mermaid-util.ts'
import { type DesignScope, useNotifyOrg, usePlatformCatalog, useDesignScope } from '../data/platform.ts'
import { scopeFilter, type Scoped } from '../data/scope.ts'
import { CatalogApis, ClientPanel, RepoPanel } from '../components/api-platform.tsx'
import { AskAiModal, SparkIcon } from '../components/ai-draft.tsx'
import { EntityChip } from '../components/catalog-bits.tsx'
import { ScopeChip, ScopeModal } from '../components/scope-bits.tsx'
import { designHref } from '../data/deep-link.ts'

/**
 * API & Schemas — design OpenAPI 3.x / Swagger 2.0, AsyncAPI and JSON Schema
 * documents.
 *
 *   • Library with validity, endpoint / schema counts; import from URL, a
 *     Gitea repo file, a local file, or start from a starter.
 *   • Editor (`?spec=<id>&tab=…&op=…`): Monaco (YAML / JSON) with inline
 *     validation markers; an interactive endpoint browser grouped by tag with
 *     parameters, request / response schemas, generated examples (mock
 *     payloads) and cURL / fetch / Python snippets; component-schema trees;
 *     JSON Schema instance tester; problems list; named versions with a
 *     semantic diff that flags breaking changes; format / convert JSON ⇄ YAML;
 *     download or commit to Gitea.
 *
 * Persisted in the tenant document store (kind `design.api-spec`).
 */

interface SpecVersion {
  id: string
  version: string
  note?: string
  document: string
  at: string
  by: string
}

type SpecDoc = ApiSpec & {
  kind?: SpecKind
  versions?: SpecVersion[]
  source?: string
  git?: { repo: string; branch: string; path: string; sha?: string; at: string }
  updated_by?: string
  /** Catalog API entity this spec defines (canonical ref). */
  entity?: string
  project?: string
  team?: string
  pr?: { repo: string; number: number; branch: string; base: string; at: string }
}

type Tab = 'explorer' | 'schemas' | 'problems' | 'changes' | 'platform' | 'client'
type Layout = 'code' | 'split' | 'docs'

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  POST: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  PUT: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  PATCH: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  DELETE: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
  PUB: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  SEND: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  SUB: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  RECEIVE: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
}

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

function MethodPill({ m }: { m: string }) {
  return (
    <span className={`inline-flex w-16 shrink-0 justify-center rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-bold ${METHOD_TONE[m] ?? 'bg-surface-sunken text-content-muted'}`}>
      {m}
    </span>
  )
}

function analyse(text: string) {
  const parsed = parseSpec(text)
  const issues: Issue[] = parsed.error
    ? [{ severity: 'error', message: parsed.error, path: [], line: parsed.errorLine }]
    : validateSpec(parsed.doc, text)
  return { parsed, issues, kind: detectKind(parsed.doc) }
}

/* ─────────────────────────── page ─────────────────────────── */

export function ApiSchemas() {
  const { items: list, isLoading, error, refetch } = useCollection<SpecDoc>(KIND.apiSpec)
  const createSpec = useCreate<SpecDoc>(KIND.apiSpec)
  const removeSpec = useRemove(KIND.apiSpec)
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const toast = useToast()
  const user = useOptionalUser()
  const [ask, confirmDialog] = useConfirm()

  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | SpecKind>('all')
  const [newOpen, setNewOpen] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const scope = useDesignScope()
  const listTab = !params.spec && params.tab === 'catalog' ? 'catalog' : 'specs'
  const catalog = usePlatformCatalog(listTab === 'catalog' || !!params.spec)
  useNewFlag(() => setNewOpen(true), !isLoading)
  const scoped = useMemo(() => scopeFilter(list, scope.lens).shown, [list, scope.lens])

  const open = (id: string | undefined) => setParams({ spec: id, op: undefined, tab: undefined }, { push: true })

  const createFrom = (
    document: string,
    meta: { name?: string; version?: string; description?: string; source?: string; entity?: string; git?: SpecDoc['git'] } & Scoped = {},
  ) => {
    const { doc } = parseSpec(document)
    const info = (doc?.info ?? {}) as { title?: string; version?: string; description?: string }
    const now = new Date().toISOString()
    const spec: SpecDoc = {
      id: newId('api'),
      name: meta.name || info.title || (doc && typeof doc.title === 'string' ? doc.title : '') || 'Untitled API',
      version: meta.version || (info.version !== undefined ? String(info.version) : '0.1.0'),
      description: meta.description ?? info.description?.split('\n')[0] ?? '',
      document,
      kind: detectKind(doc),
      source: meta.source,
      created_at: now,
      updated_at: now,
      updated_by: user?.name,
      ...scope.initial,
      ...(meta.project !== undefined ? { project: meta.project } : {}),
      ...(meta.team !== undefined ? { team: meta.team } : {}),
      ...(meta.entity ? { entity: meta.entity } : {}),
      ...(meta.git ? { git: meta.git } : {}),
    }
    createSpec.mutate(spec, {
      onSuccess: (created) => {
        toast.success(meta.source ? 'Spec imported' : 'Spec created', { description: created.name })
        open(created.id)
      },
      onError: (e) => toast.error('Could not create spec', { description: e.message }),
    })
  }

  const summaries = useMemo(() => {
    const m = new Map<string, { kind: SpecKind; ops: number; schemas: number; errors: number; warnings: number; label: string }>()
    for (const s of list) {
      const a = analyse(s.document)
      m.set(s.id, {
        kind: a.kind,
        ops: extractOperations(a.parsed.doc).length,
        schemas: Object.keys(componentSchemas(a.parsed.doc)).length,
        errors: a.issues.filter((i) => i.severity === 'error').length,
        warnings: a.issues.filter((i) => i.severity === 'warning').length,
        label: specVersionLabel(a.parsed.doc),
      })
    }
    return m
  }, [list])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return scoped
      .filter((s) => kindFilter === 'all' || summaries.get(s.id)?.kind === kindFilter)
      .filter((s) => !q || [s.name, s.description, s.version].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (b._updatedAt ?? b.updated_at ?? '').localeCompare(a._updatedAt ?? a.updated_at ?? ''))
  }, [scoped, search, kindFilter, summaries])

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading API specs…" />

  if (params.spec) {
    const spec = list.find((s) => s.id === params.spec)
    if (!spec) {
      return (
        <EmptyState
          title="Spec not found"
          description="It may have been deleted, or the link is from another workspace."
          action={<Button size="sm" onClick={() => open(undefined)}>Back to API specs</Button>}
        />
      )
    }
    return (
      <>
        <SpecEditor
          key={spec.id}
          spec={spec}
          scope={scope}
          catalog={catalog}
          onBack={() => open(undefined)}
          onDuplicate={(document) => createFrom(document, { name: `${spec.name} (copy)`, version: spec.version, description: spec.description, project: spec.project, team: spec.team })}
          onDelete={() =>
            ask({
              title: `Delete “${spec.name}”?`,
              description: 'The document and its saved versions are removed for everyone.',
              onConfirm: () =>
                removeSpec.mutate(spec.id, {
                  onSuccess: () => {
                    toast.success('Spec deleted')
                    open(undefined)
                  },
                  onError: (e) => toast.error('Could not delete', { description: e.message }),
                }),
            })}
        />
        {confirmDialog}
      </>
    )
  }

  const kinds = (['openapi', 'swagger', 'asyncapi', 'jsonschema'] as SpecKind[]).filter((k) => [...summaries.values()].some((s) => s.kind === k))

  const listTabs = (
    <div className="flex items-center gap-1 border-b border-edge-subtle" role="tablist">
      {([['specs', 'Specs', scoped.length], ['catalog', 'Catalog APIs', catalog.entities.filter((e) => e.kind === 'API').length]] as const).map(([id, label, n]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={listTab === id}
          onClick={() => setParams({ tab: id === 'specs' ? undefined : id })}
          className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${listTab === id ? 'border-brand-500 font-semibold text-content' : 'border-transparent text-content-muted hover:text-content'}`}
        >
          {label}
          {id === 'specs' || !catalog.isLoading ? <span className="ml-1.5 rounded-full bg-surface-sunken px-1.5 font-mono text-[10px] text-content-subtle">{n}</span> : null}
        </button>
      ))}
    </div>
  )

  if (listTab === 'catalog') {
    return (
      <div className="space-y-4">
        {listTabs}
        <CatalogApis
          catalog={catalog}
          specs={list.map((s) => ({ id: s.id, name: s.name, entity: s.entity }))}
          onOpenSpec={(id) => open(id)}
          onImport={(sp) => createFrom(sp.document, { name: sp.name, source: sp.source, entity: sp.entity, git: sp.git })}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {listTabs}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(['all', ...kinds] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kindFilter === k}
              onClick={() => setKindFilter(k)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
                kindFilter === k
                  ? 'border-brand-300 bg-brand-50 font-semibold text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
                  : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content'
              }`}
            >
              {k === 'all' ? 'All' : KIND_LABEL[k]}
              <span className="font-mono text-[10px] opacity-60">
                {k === 'all' ? scoped.length : scoped.filter((s) => summaries.get(s.id)?.kind === k).length}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchBox value={search} onChange={setSearch} placeholder="Search specs…" className="w-56" />
          <Menu
            label="Import"
            icon={<Icon name="upload" />}
            items={[
              { label: 'From URL…', onSelect: () => setUrlOpen(true) },
              { label: 'From a Gitea repository…', onSelect: () => setRepoOpen(true) },
              {
                label: 'Upload a file…',
                onSelect: async () => {
                  const f = await pickTextFile('.yaml,.yml,.json')
                  if (f) createFrom(f.text, { source: `file:${f.name}` })
                },
              },
            ]}
          />
          <Button size="sm" leading={<SparkIcon />} onClick={() => setAiOpen(true)}>Ask Adhar AI</Button>
          <Button size="sm" variant="primary" leading={<Icon name="plus" />} onClick={() => setNewOpen(true)}>New spec</Button>
        </div>
      </div>

      {list.length === 0
        ? (
          <EmptyState
            icon={<Icon name="api" size={22} />}
            title="Design APIs contract-first"
            description="Write OpenAPI, AsyncAPI or JSON Schema with live validation, browse endpoints with generated examples and request snippets, and track breaking changes between versions."
            action={
              <Button size="sm" variant="primary" leading={<Icon name="plus" />} onClick={() => setNewOpen(true)}>New spec</Button>
            }
          />
        )
        : filtered.length === 0
        ? <EmptyState compact title="No matches" description="Try a different search or kind." />
        : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((s) => {
              const sum = summaries.get(s.id)!
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => open(s.id)}
                  className="group rounded-xl border border-edge-default bg-surface-raised p-4 text-left shadow-sm transition hover:border-edge-strong hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">
                        <span>{sum.label}</span>
                        <span className="font-mono normal-case">v{s.version}</span>
                      </div>
                      <h3 className="mt-1 truncate text-sm font-semibold text-content">{s.name}</h3>
                    </div>
                    <StatusBadge kind={sum.errors ? 'failed' : sum.warnings ? 'degraded' : 'healthy'}>
                      {sum.errors ? `${sum.errors} error${sum.errors === 1 ? '' : 's'}` : sum.warnings ? `${sum.warnings} warning${sum.warnings === 1 ? '' : 's'}` : 'valid'}
                    </StatusBadge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 min-h-8 text-[12px] leading-relaxed text-content-muted">{s.description || '—'}</p>
                  {s.entity || s.team || s.project
                    ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {s.entity ? <EntityChip entityRef={s.entity} entity={catalog.entities.find((e) => `${e.kind.toLowerCase()}:${e.namespace}/${e.name}` === s.entity)} /> : null}
                        <ScopeChip item={s} scope={scope} />
                      </div>
                    )
                    : null}
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-content-muted">
                    {sum.kind !== 'jsonschema'
                      ? <span><span className="font-semibold text-content">{sum.ops}</span> {sum.kind === 'asyncapi' ? 'operation' : 'endpoint'}{sum.ops === 1 ? '' : 's'}</span>
                      : null}
                    <span><span className="font-semibold text-content">{sum.schemas}</span> {sum.kind === 'jsonschema' ? 'definition' : 'schema'}{sum.schemas === 1 ? '' : 's'}</span>
                    {s.versions?.length ? <span>{s.versions.length} versions</span> : null}
                    <span className="ml-auto text-content-subtle">{formatRelative(s._updatedAt ?? s.updated_at)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}

      <NewSpecModal open={newOpen} onClose={() => setNewOpen(false)} busy={createSpec.isPending} onCreate={(doc, meta) => {
        setNewOpen(false)
        createFrom(doc, meta)
      }} />
      <UrlImportModal open={urlOpen} onClose={() => setUrlOpen(false)} onLoaded={(text, url) => createFrom(text, { source: url })} />
      <ImportFromRepoModal
        open={repoOpen}
        onClose={() => setRepoOpen(false)}
        title="Import a spec from Gitea"
        accept={/\.(ya?ml|json)$/i}
        onImport={(f) => createFrom(f.text, { source: `gitea:${f.repo}/${f.path}`, git: { repo: f.repo, branch: f.branch, path: f.path, at: new Date().toISOString() } })}
      />
      <AskAiModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        kind="api"
        title="Design an API with Adhar AI"
        description="Describe the API; Adhar AI drafts an OpenAPI 3.0 document you can then validate, diff and publish."
        placeholder="A REST API for orders: create an order, read it, list a customer's orders, cancel an order…"
        context={[{ description: 'Existing specs', value: list.map((s) => `${s.name} v${s.version}`).join('\n') || 'none' }]}
        fence={['yaml', 'yml', 'json']}
        applyLabel="Create spec"
        onApply={(doc) => createFrom(doc, { source: 'Adhar AI' })}
      />
      {confirmDialog}
    </div>
  )
}

/* ─────────────────────────── create / import ─────────────────────────── */

function NewSpecModal({
  open,
  onClose,
  busy,
  onCreate,
}: {
  open: boolean
  onClose(): void
  busy: boolean
  onCreate(document: string, meta: { name?: string; version?: string; description?: string }): void
}) {
  const [starter, setStarter] = useState(SPEC_STARTERS[0].id)
  const [name, setName] = useState('')
  const [paste, setPaste] = useState('')
  useEffect(() => {
    if (open) {
      setStarter(SPEC_STARTERS[0].id)
      setName('')
      setPaste('')
    }
  }, [open])
  const pasted = starter === 'paste'
  const check = useMemo(() => (pasted && paste.trim() ? parseSpec(paste) : null), [pasted, paste])
  const submit = () => {
    const doc = pasted ? paste : SPEC_STARTERS.find((s) => s.id === starter)!.document
    onCreate(doc, { name: name.trim() || undefined })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New API spec"
      description="Start from a starter or paste an existing document."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={busy || (pasted && !paste.trim())}>Create spec</Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Name (optional — defaults to info.title)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`mt-1.5 ${INPUT}`} placeholder="Orders API" />
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[...SPEC_STARTERS, { id: 'paste', label: 'Paste a document', description: 'JSON or YAML — OpenAPI, AsyncAPI or JSON Schema.' }].map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStarter(s.id)}
              className={`rounded-lg border p-3 text-left transition ${
                starter === s.id ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong'
              }`}
            >
              <div className="text-[13px] font-semibold text-content">{s.label}</div>
              <div className="mt-0.5 text-[11.5px] text-content-muted">{s.description}</div>
            </button>
          ))}
        </div>
        {pasted
          ? (
            <div>
              <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={10} className={`${INPUT} font-mono text-[12px]`} placeholder="openapi: 3.1.0…" autoFocus />
              {check
                ? (
                  <div className={`mt-1 text-[12px] ${check.error ? 'text-rose-600 dark:text-rose-400' : 'text-content-muted'}`}>
                    {check.error ? check.error : `Detected ${specVersionLabel(check.doc)} · ${extractOperations(check.doc).length} operations`}
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>
    </Modal>
  )
}

function UrlImportModal({ open, onClose, onLoaded }: { open: boolean; onClose(): void; onLoaded(text: string, url: string): void }) {
  const toast = useToast()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setUrl('')
  }, [open])
  const load = async () => {
    setBusy(true)
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const p = parseSpec(text)
      if (p.error) throw new Error(p.error)
      onLoaded(text, url)
      onClose()
    } catch (e) {
      toast.error('Could not load the URL', {
        description: `${(e as Error).message}. The server must allow cross-origin requests — otherwise download the file and use Upload.`,
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import from URL"
      description="Fetched directly by your browser; nothing is proxied."
      width="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={load} loading={busy} disabled={!/^https?:\/\//.test(url) || busy}>Import</Button>
        </>
      }
    >
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && /^https?:\/\//.test(url) && load()}
        placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
        className={`${INPUT} font-mono text-[12.5px]`}
      />
    </Modal>
  )
}

/* ─────────────────────────── editor ─────────────────────────── */

interface Draft {
  name: string
  version: string
  description: string
  document: string
  versions: SpecVersion[]
}

function SpecEditor({
  spec,
  scope,
  catalog,
  onBack,
  onDuplicate,
  onDelete,
}: {
  spec: Listed<SpecDoc>
  scope: DesignScope
  catalog: ReturnType<typeof usePlatformCatalog>
  onBack(): void
  onDuplicate(document: string): void
  onDelete(): void
}) {
  const update = useUpdate<SpecDoc>(KIND.apiSpec)
  const toast = useToast()
  const user = useOptionalUser()
  const { notify: notifyOrg } = useNotifyOrg()
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const [draft, setDraft] = useState<Draft>({
    name: spec.name,
    version: spec.version,
    description: spec.description ?? '',
    document: spec.document,
    versions: spec.versions ?? [],
  })
  const [layout, setLayout] = useState<Layout>('split')
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)
  const [snapOpen, setSnapOpen] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [ask, confirmDialog] = useConfirm()
  const [aiOpen, setAiOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [publishVersion, setPublishVersion] = useState<string | undefined>()
  const tab = (['explorer', 'schemas', 'problems', 'changes', 'platform', 'client'].includes(params.tab ?? '') ? params.tab : 'explorer') as Tab
  const setTab = (t: Tab) => setParams({ tab: t === 'explorer' ? undefined : t })

  const latest = useRef(spec)
  latest.current = spec
  const save = useCallback(
    (d: Draft) =>
      update.mutateAsync({
        ...latest.current,
        ...d,
        kind: detectKind(parseSpec(d.document).doc),
        updated_at: new Date().toISOString(),
        updated_by: user?.name,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.name],
  )
  const autosave = useAutosave(draft, save, { key: spec.id, delay: 1000, onError: (e) => toast.error('Autosave failed', { description: e.message }) })
  // Out-of-band writes (git link, scope) — a failure must surface, not become an unhandled rejection.
  const saveMeta = (next: Parameters<typeof update.mutateAsync>[0]) =>
    void update.mutateAsync(next).catch((e: Error) => toast.error('Could not save the spec', { description: e.message }))

  const deferred = useDeferredValue(draft.document)
  const { parsed, issues, kind } = useMemo(() => analyse(deferred), [deferred])
  const doc = parsed.doc
  const ops = useMemo(() => extractOperations(doc), [doc])
  const markers = useMemo(
    () => issues.filter((i) => i.line).map((i) => ({ line: i.line!, message: i.message, severity: i.severity })),
    [issues],
  )
  const errors = issues.filter((i) => i.severity === 'error').length
  const isJson = (parsed.format ?? (draft.document.trim().startsWith('{') ? 'json' : 'yaml')) === 'json'
  const base = slugify(draft.name, 'api')

  const setDocument = (document: string) => setDraft((d) => ({ ...d, document }))
  const convert = (to: 'json' | 'yaml') => {
    if (!doc) return toast.error('Fix the parse error first', { description: parsed.error ?? undefined })
    setDocument(to === 'json' ? JSON.stringify(doc, null, 2) + '\n' : toYaml(doc) + '\n')
    toast.success(to === 'json' ? 'Converted to JSON' : 'Converted to YAML', { description: to === 'yaml' ? 'Comments are not preserved. Undo with ⌘Z.' : 'Undo with ⌘Z.' })
  }
  const replaceFrom = (text: string, source: string) => {
    ask({
      title: 'Replace the document?',
      description: `The editor content is replaced with ${source}. Save a version first if you want to compare.`,
      confirmLabel: 'Replace',
      danger: false,
      onConfirm: () => {
        setDocument(text)
        toast.success('Document replaced', { description: source })
      },
    })
  }

  const selectOp = (key: string | undefined) => setParams({ op: key })
  const goLine = (line: number) => {
    if (layout === 'docs') setLayout('split')
    setReveal({ line, nonce: Date.now() })
  }

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[560px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} leading={<Icon name="back" />}>API specs</Button>
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          aria-label="Spec name"
          className="min-w-40 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold tracking-tight text-content hover:border-edge-default focus:border-edge-default focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <input
          value={draft.version}
          onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))}
          aria-label="Version"
          className="w-24 rounded-md border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[12px] text-content"
        />
        <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-content-muted">{specVersionLabel(doc)}</span>
        <SaveDot state={autosave.state} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented<Layout>
            value={layout}
            onChange={setLayout}
            options={[
              { id: 'code', label: <Icon name="code" />, title: 'Source only' },
              { id: 'split', label: <Icon name="split" />, title: 'Split' },
              { id: 'docs', label: <Icon name="eye" />, title: 'Explorer only' },
            ]}
          />
          <Button size="sm" leading={<SparkIcon />} onClick={() => setAiOpen(true)}>Ask AI</Button>
          <Button size="sm" leading={<Icon name="history" />} onClick={() => setSnapOpen(true)}>Save version</Button>
          <Menu
            label="Export"
            icon={<Icon name="download" />}
            items={[
              { label: isJson ? 'Download JSON' : 'Download YAML', onSelect: () => downloadText(draft.document, `${base}.${isJson ? 'json' : 'yaml'}`) },
              { label: 'Publish as pull request…', onSelect: () => setCommitOpen(true) },
              'separator',
              { label: 'Convert to YAML', onSelect: () => convert('yaml'), disabled: !isJson },
              { label: 'Convert to JSON', onSelect: () => convert('json'), disabled: isJson },
              { label: 'Format document', onSelect: () => convert(isJson ? 'json' : 'yaml') },
              'separator',
              {
                label: 'Copy link',
                onSelect: async () => ((await copyText(designLink({ spec: spec.id }))) ? toast.success('Link copied') : toast.error('Clipboard unavailable')),
              },
            ]}
          />
          <Menu
            ariaLabel="More actions"
            icon={<Icon name="more" />}
            items={[
              { label: 'Replace from URL…', onSelect: () => setUrlOpen(true) },
              { label: 'Replace from Gitea…', onSelect: () => setRepoOpen(true) },
              {
                label: 'Replace from file…',
                onSelect: async () => {
                  const f = await pickTextFile('.yaml,.yml,.json')
                  if (f) replaceFrom(f.text, f.name)
                },
              },
              'separator',
              { label: 'Project & owner…', onSelect: () => setScopeOpen(true) },
              { label: 'Duplicate', onSelect: () => onDuplicate(draft.document) },
              { label: 'Delete spec', onSelect: onDelete, danger: true },
            ]}
          />
        </div>
      </div>

      <div className={`grid min-h-0 flex-1 gap-3 ${layout === 'split' ? 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-1'}`}>
        {layout !== 'docs'
          ? (
            <div className="flex min-h-[300px] flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              <SourceEditor
                value={draft.document}
                onChange={setDocument}
                language={isJson ? 'json' : 'yaml'}
                markers={markers}
                reveal={reveal}
                onSave={() => void autosave.flush().then(() => toast.success('Saved'))}
                className="min-h-0 flex-1"
                ariaLabel="Spec source"
              />
              <button
                type="button"
                onClick={() => setTab('problems')}
                className={`flex items-center gap-3 border-t px-3 py-1.5 text-left text-[11.5px] ${
                  errors ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300' : 'border-edge-subtle text-content-subtle'
                }`}
              >
                <span>{errors ? `${errors} error${errors === 1 ? '' : 's'}` : 'No errors'}</span>
                <span>{issues.filter((i) => i.severity === 'warning').length} warnings</span>
                <span>{issues.filter((i) => i.severity === 'info').length} hints</span>
                <span className="ml-auto">{isJson ? 'JSON' : 'YAML'} · {draft.document.split('\n').length} lines · ⌘S saves</span>
              </button>
            </div>
          )
          : null}
        {layout !== 'code'
          ? (
            <div className="flex min-h-[300px] flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              <div className="flex items-center gap-1 border-b border-edge-subtle px-2 pt-1.5">
                {([
                  ['explorer', kind === 'jsonschema' ? 'Schema' : kind === 'asyncapi' ? 'Operations' : 'Endpoints', kind === 'jsonschema' ? null : ops.length],
                  ['schemas', kind === 'jsonschema' ? 'Definitions & test' : 'Schemas', Object.keys(componentSchemas(doc)).length],
                  ['problems', 'Problems', issues.length],
                  ['changes', 'Changes', draft.versions.length],
                  ['platform', 'Repo & catalog', null],
                  ['client', 'Client', null],
                ] as [Tab, string, number | null][]).map(([id, label, n]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12.5px] ${tab === id ? 'border-brand-500 font-semibold text-content' : 'border-transparent text-content-muted hover:text-content'}`}
                  >
                    {label}
                    {n !== null ? <span className={`ml-1.5 rounded-full px-1.5 font-mono text-[10px] ${id === 'problems' && errors ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300' : 'bg-surface-sunken text-content-subtle'}`}>{n}</span> : null}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {!doc && tab !== 'problems' && tab !== 'changes' && tab !== 'platform'
                  ? (
                    <EmptyState
                      compact
                      title="Can't read the document"
                      description={parsed.error ?? 'Empty document.'}
                      action={parsed.errorLine ? <Button size="sm" onClick={() => goLine(parsed.errorLine!)}>Go to line {parsed.errorLine}</Button> : undefined}
                    />
                  )
                  : tab === 'explorer'
                  ? kind === 'jsonschema'
                    ? <JsonSchemaPanel doc={doc!} />
                    : <Explorer doc={doc!} ops={ops} selected={params.op} onSelect={selectOp} />
                  : tab === 'schemas'
                  ? kind === 'jsonschema' ? <JsonSchemaPanel doc={doc!} defsOnly /> : <SchemasPanel doc={doc!} />
                  : tab === 'problems'
                  ? <Problems issues={issues} onReveal={goLine} />
                  : tab === 'platform'
                  ? (
                    <RepoPanel
                      git={spec.git}
                      pr={spec.pr}
                      entity={spec.entity}
                      catalog={catalog}
                      current={doc}
                      version={draft.version}
                      onReplace={replaceFrom}
                      onPublish={(v) => {
                        setPublishVersion(v)
                        setCommitOpen(true)
                      }}
                      onLinkFile={() => setLinkOpen(true)}
                    />
                  )
                  : tab === 'client'
                  ? <ClientPanel doc={doc} name={base} />
                  : (
                    <Changes
                      versions={draft.versions}
                      current={doc}
                      onRestore={(v) =>
                        ask({
                          title: `Restore version ${v.version}?`,
                          description: 'The editor content is replaced with this version (undo with ⌘Z in the editor).',
                          confirmLabel: 'Restore',
                          danger: false,
                          onConfirm: () => {
                            setDraft((d) => ({ ...d, document: v.document }))
                            toast.success(`Restored ${v.version}`)
                          },
                        })}
                      onDeleteVersion={(v) => setDraft((d) => ({ ...d, versions: d.versions.filter((x) => x.id !== v.id) }))}
                    />
                  )}
              </div>
            </div>
          )
          : null}
      </div>

      <SnapshotModal
        open={snapOpen}
        onClose={() => setSnapOpen(false)}
        version={draft.version}
        onSave={(version, note) => {
          const v: SpecVersion = { id: newId('ver'), version, note, document: draft.document, at: new Date().toISOString(), by: user?.name ?? 'someone' }
          setDraft((d) => ({ ...d, version, versions: [v, ...d.versions].slice(0, 20) }))
          setSnapOpen(false)
          toast.success(`Version ${version} saved`, { description: 'Compare against it in the Changes tab.' })
        }}
      />
      <CommitToRepoModal
        open={commitOpen}
        onClose={() => {
          setCommitOpen(false)
          setPublishVersion(undefined)
        }}
        title="Publish spec to Gitea"
        description={publishVersion ? `The diff against the default branch suggests version ${publishVersion}.` : 'Opens a pull request with the spec (or commits straight to the branch).'}
        initial={spec.git ? { repo: spec.git.repo, branch: spec.git.branch, folder: spec.git.path.split('/').slice(0, -1).join('/') } : undefined}
        defaultFolder="api"
        defaultMessage={`docs(api): ${draft.name} ${publishVersion ?? draft.version}`}
        prBody={`API spec “${draft.name}” published from Adhar Console → Design → API & Schemas.${spec.entity ? `\n\nCatalog API: ${spec.entity}` : ''}`}
        buildFiles={() => [{ path: spec.git?.path.split('/').pop() ?? `${base}.${isJson ? 'json' : 'yaml'}`, content: draft.document }]}
        onCommitted={(t) => {
          const at = new Date().toISOString()
          saveMeta({
            ...latest.current,
            ...draft,
            ...(publishVersion ? { version: publishVersion } : {}),
            git: { repo: t.repo, branch: t.branch, path: t.paths[0], sha: t.sha, at },
            ...(t.pr ? { pr: { repo: t.repo, number: t.pr.number, branch: t.pr.branch, base: t.branch, at } } : {}),
            updated_at: at,
          })
          if (publishVersion) setDraft((d) => ({ ...d, version: publishVersion }))
          if (t.pr) {
            void notifyOrg({
              title: `API change PR: ${draft.name}`,
              description: `${user?.name ?? 'Someone'} opened ${t.repo}#${t.pr.number}${publishVersion ? ` (${publishVersion})` : ''}.`,
              href: designHref('api-schemas', { spec: spec.id, tab: 'platform' }),
              key: `design-api-pr-${spec.id}-${t.pr.number}`,
            })
          }
        }}
      />
      <ImportFromRepoModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Link the spec file in Gitea"
        accept={/\.(ya?ml|json)$/i}
        onImport={(f) => {
          const at = new Date().toISOString()
          saveMeta({ ...latest.current, ...draft, git: { repo: f.repo, branch: f.branch, path: f.path, at }, updated_at: at })
          setTab('platform')
        }}
      />
      <ScopeModal
        open={scopeOpen}
        onClose={() => setScopeOpen(false)}
        value={{ project: spec.project, team: spec.team }}
        scope={scope}
        onSave={(v) => {
          setScopeOpen(false)
          saveMeta({ ...latest.current, ...draft, project: v.project, team: v.team, updated_at: new Date().toISOString() })
        }}
      />
      <AskAiModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        kind="api"
        title="Revise this spec with Adhar AI"
        description="Describe the change; the reply replaces the document when you apply it (undo with ⌘Z, or diff it in Changes after saving a version)."
        placeholder="Add pagination to every list operation and a 409 response to create…"
        context={[{ description: 'Current spec', value: draft.document.slice(0, 60_000) }]}
        fence={isJson ? ['json', 'yaml'] : ['yaml', 'yml', 'json']}
        applyLabel="Replace document"
        onApply={(text) => setDocument(text)}
      />
      <UrlImportModal open={urlOpen} onClose={() => setUrlOpen(false)} onLoaded={(text, url) => replaceFrom(text, url)} />
      <ImportFromRepoModal
        open={repoOpen}
        onClose={() => setRepoOpen(false)}
        title="Replace from a Gitea file"
        accept={/\.(ya?ml|json)$/i}
        onImport={(f) => replaceFrom(f.text, `${f.repo}/${f.path}`)}
      />
      {confirmDialog}
    </div>
  )
}

function SnapshotModal({ open, onClose, version, onSave }: { open: boolean; onClose(): void; version: string; onSave(version: string, note?: string): void }) {
  const [v, setV] = useState(version)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) {
      setV(version)
      setNote('')
    }
  }, [open, version])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save a version"
      description="Snapshots the current document so later edits can be diffed against it."
      width="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!v.trim()} onClick={() => onSave(v.trim(), note.trim() || undefined)}>Save version</Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Version</span>
          <input value={v} onChange={(e) => setV(e.target.value)} className={`mt-1.5 font-mono ${INPUT}`} autoFocus />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`mt-1.5 ${INPUT}`} placeholder="Released to staging" />
        </label>
      </div>
    </Modal>
  )
}

/* ─────────────────────────── explorer ─────────────────────────── */

function Explorer({ doc, ops, selected, onSelect }: { doc: OpenApiDoc; ops: Operation[]; selected?: string; onSelect(key: string | undefined): void }) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const servers = serversOf(doc)
  const [server, setServer] = useState(servers[0] ?? 'https://api.example.com')
  const info = (doc.info ?? {}) as { title?: string; description?: string; version?: string }
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase()
    return groupByTag(ops.filter((o) => !t || `${o.method} ${o.path} ${o.summary} ${o.operationId ?? ''}`.toLowerCase().includes(t)))
  }, [ops, q])
  const selRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[15px] font-semibold text-content">{info.title ?? 'Untitled'} <span className="font-mono text-[11px] text-content-subtle">v{String(info.version ?? '')}</span></div>
        {info.description ? <Markdown text={info.description} className="mt-1 text-[12.5px] text-content-muted" /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Filter operations…" className="min-w-40 flex-1" />
        {detectKind(doc) !== 'asyncapi'
          ? (
            <select value={server} onChange={(e) => setServer(e.target.value)} aria-label="Server" className="h-8 max-w-60 rounded-lg border border-edge-default bg-surface-raised px-2 font-mono text-[11.5px] text-content">
              {(servers.length ? servers : ['https://api.example.com']).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )
          : null}
      </div>
      {ops.length === 0
        ? <EmptyState compact title="No operations yet" description="Add paths (OpenAPI) or channels (AsyncAPI) in the editor." />
        : groups.map(([tag, list]) => (
          <section key={tag}>
            <button
              type="button"
              onClick={() => setCollapsed((s) => {
                const n = new Set(s)
                n.has(tag) ? n.delete(tag) : n.add(tag)
                return n
              })}
              className="flex w-full items-center gap-2 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle hover:text-content"
            >
              <span className={`transition ${collapsed.has(tag) ? '-rotate-90' : ''}`}>▾</span>
              {tag}
              <span className="font-mono font-normal">{list.length}</span>
            </button>
            {collapsed.has(tag)
              ? null
              : (
                <div className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-default">
                  {list.map((op) => {
                    const on = selected === op.key
                    return (
                      <div key={op.key} ref={on ? selRef : undefined}>
                        <button
                          type="button"
                          onClick={() => onSelect(on ? undefined : op.key)}
                          aria-expanded={on}
                          className={`flex w-full items-center gap-2 px-2.5 py-2 text-left ${on ? 'bg-surface-sunken/70' : 'hover:bg-surface-sunken/50'}`}
                        >
                          <MethodPill m={op.method} />
                          <span className={`truncate font-mono text-[12.5px] ${op.deprecated ? 'text-content-subtle line-through' : 'text-content'}`}>{op.path}</span>
                          <span className="ml-auto truncate pl-2 text-[12px] text-content-muted">{op.summary}</span>
                        </button>
                        {on ? <OperationDetail op={op} doc={doc} server={server} /> : null}
                      </div>
                    )
                  })}
                </div>
              )}
          </section>
        ))}
    </div>
  )
}

function OperationDetail({ op, doc, server }: { op: Operation; doc: OpenApiDoc; server: string }) {
  const [lang, setLang] = useState<SnippetLang>('curl')
  const isAsync = !!op.message || op.method === 'PUB' || op.method === 'SUB'
  const snippet = useMemo(() => (isAsync ? '' : snippetFor(lang, op, server, doc)), [lang, op, server, doc, isAsync])
  return (
    <div className="space-y-4 border-t border-edge-subtle bg-surface-canvas/40 px-3 py-3 text-[12.5px]">
      {op.description ? <Markdown text={op.description} className="text-content-muted" /> : null}
      <div className="flex flex-wrap gap-2 text-[11px] text-content-subtle">
        {op.operationId ? <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono">{op.operationId}</span> : null}
        {op.security?.length ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">auth: {op.security.join(', ')}</span> : null}
        {op.deprecated ? <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">deprecated</span> : null}
      </div>

      {op.parameters.length
        ? (
          <Block title="Parameters">
            <table className="w-full text-left text-[12px]">
              <thead className="text-[10.5px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="py-1 pr-2 font-semibold">Name</th>
                  <th className="py-1 pr-2 font-semibold">In</th>
                  <th className="py-1 pr-2 font-semibold">Type</th>
                  <th className="py-1 font-semibold">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {op.parameters.map((p) => (
                  <tr key={`${p.in}:${p.name}`} className="align-top">
                    <td className="py-1.5 pr-2 font-mono text-content">
                      {p.name}
                      {p.required ? <span className="ml-0.5 text-rose-600">*</span> : null}
                    </td>
                    <td className="py-1.5 pr-2 text-content-muted">{p.in}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11.5px] text-violet-700 dark:text-violet-300">{typeLabel(p.schema)}</td>
                    <td className="py-1.5 text-content-muted">
                      {p.description}
                      {p.schema?.enum ? <div className="font-mono text-[11px] text-content-subtle">{p.schema.enum.map(String).join(' | ')}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Block>
        )
        : null}

      {op.requestBody
        ? (
          <Block title={`Request body · ${op.requestBody.contentType}${op.requestBody.required ? ' · required' : ''}`}>
            <SchemaWithExample schema={op.requestBody.schema} example={op.requestBody.example} doc={doc} />
          </Block>
        )
        : null}

      {op.message
        ? (
          <Block title={`Message · ${op.message.contentType}`}>
            {op.message.description ? <p className="mb-2 text-content-muted">{op.message.description}</p> : null}
            <SchemaWithExample schema={op.message.schema} example={op.message.example} doc={doc} />
          </Block>
        )
        : null}

      {op.responses.length
        ? (
          <Block title="Responses">
            <div className="space-y-2">
              {op.responses.map((r) => <ResponseRow key={r.status} r={r} doc={doc} />)}
            </div>
          </Block>
        )
        : null}

      {!isAsync
        ? (
          <Block
            title="Try it"
            actions={
              <Segmented<SnippetLang>
                size="xs"
                value={lang}
                onChange={setLang}
                options={[{ id: 'curl', label: 'cURL' }, { id: 'fetch', label: 'fetch' }, { id: 'python', label: 'Python' }]}
              />
            }
          >
            <CodeBlock text={snippet} />
          </Block>
        )
        : null}
    </div>
  )
}

function ResponseRow({ r, doc }: { r: Operation['responses'][number]; doc: OpenApiDoc }) {
  const ok = r.status.startsWith('2')
  const [open, setOpen] = useState(ok)
  const tone = ok ? 'text-emerald-700 dark:text-emerald-300' : r.status.startsWith('4') || r.status.startsWith('5') ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted'
  return (
    <div className="rounded-lg border border-edge-subtle">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <span className={`font-mono text-[12px] font-bold ${tone}`}>{r.status}</span>
        <span className="truncate text-content-muted">{r.description}</span>
        {r.schema ? <span className="ml-auto font-mono text-[11px] text-violet-700 dark:text-violet-300">{typeLabel(r.schema)}</span> : null}
      </button>
      {open && (r.schema || r.example !== undefined)
        ? <div className="border-t border-edge-subtle p-2.5"><SchemaWithExample schema={r.schema} example={r.example} doc={doc} mock /></div>
        : null}
    </div>
  )
}

function SchemaWithExample({ schema, example, doc, mock }: { schema?: RawSchema; example?: unknown; doc: OpenApiDoc; mock?: boolean }) {
  const [view, setView] = useState<'schema' | 'example'>('schema')
  const ex = useMemo(() => (example !== undefined ? example : exampleFor(schema, doc)), [example, schema, doc])
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Segmented<'schema' | 'example'>
          size="xs"
          value={view}
          onChange={setView}
          options={[{ id: 'schema', label: 'Schema' }, { id: 'example', label: mock ? 'Mock response' : 'Example' }]}
        />
        {example === undefined && view === 'example' ? <span className="text-[11px] text-content-subtle">generated from the schema</span> : null}
      </div>
      {view === 'schema' ? (schema ? <SchemaTree schema={schema} doc={doc} /> : <span className="text-content-subtle">No schema.</span>) : <CodeBlock text={JSON.stringify(ex, null, 2)} />}
    </div>
  )
}

function Block({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{title}</span>
        {actions}
      </div>
      {children}
    </div>
  )
}

function CodeBlock({ text }: { text: string }) {
  const toast = useToast()
  return (
    <div className="group relative">
      <pre className="max-h-80 overflow-auto rounded-lg bg-code p-3 font-mono text-[11.5px] leading-relaxed text-code-fg">{text}</pre>
      <button
        type="button"
        onClick={async () => ((await copyText(text)) ? toast.success('Copied') : toast.error('Clipboard unavailable'))}
        className="absolute right-2 top-2 rounded-md bg-code-raised px-2 py-0.5 text-[10.5px] text-code-fg/80 opacity-0 transition hover:text-white group-hover:opacity-100"
      >
        Copy
      </button>
    </div>
  )
}

/* Recursive schema tree. */
function SchemaTree({ schema, doc, depth = 0, seen = [] }: { schema: RawSchema; doc: unknown; depth?: number; seen?: string[] }) {
  if (depth > 10) return <span className="text-content-subtle">…</span>
  let s = schema
  let refLabel: string | undefined
  if (s.$ref) {
    refLabel = refName(s.$ref)
    if (seen.includes(s.$ref)) return <span className="font-mono text-[11.5px] text-violet-700 dark:text-violet-300">{refLabel} (recursive)</span>
    const r = resolvePointer(doc, s.$ref) as RawSchema | undefined
    if (!r) return <span className="font-mono text-[11.5px] text-rose-600">unresolved {s.$ref}</span>
    seen = [...seen, s.$ref]
    s = r
  }
  const combos = s.allOf ?? s.oneOf ?? s.anyOf
  const props: [string, RawSchema][] = []
  const required = new Set(s.required ?? [])
  if (s.allOf) {
    for (const part of s.allOf) {
      const p = part.$ref ? (resolvePointer(doc, part.$ref) as RawSchema | undefined) : part
      for (const [k, v] of Object.entries(p?.properties ?? {})) props.push([k, v])
      for (const r of p?.required ?? []) required.add(r)
    }
  }
  for (const [k, v] of Object.entries(s.properties ?? {})) props.push([k, v])
  const items = s.type === 'array' || (Array.isArray(s.type) && s.type.includes('array')) ? s.items : undefined

  return (
    <div className={depth ? 'border-l border-edge-subtle pl-3' : ''}>
      {refLabel && depth === 0 ? <div className="mb-1 font-mono text-[11px] text-violet-700 dark:text-violet-300">{refLabel}</div> : null}
      {s.description && depth === 0 ? <p className="mb-1 text-[12px] text-content-muted">{s.description}</p> : null}
      {(s.oneOf || s.anyOf) && !props.length
        ? (
          <div className="space-y-1">
            <span className="text-[11px] text-content-subtle">{s.oneOf ? 'one of' : 'any of'}</span>
            {combos!.map((c, i) => <SchemaTree key={i} schema={c} doc={doc} depth={depth + 1} seen={seen} />)}
          </div>
        )
        : null}
      {props.length
        ? (
          <ul className="space-y-1">
            {props.map(([k, v]) => <PropRow key={k} name={k} schema={v} required={required.has(k)} doc={doc} depth={depth} seen={seen} />)}
          </ul>
        )
        : null}
      {items
        ? (
          <div>
            <span className="text-[11px] text-content-subtle">items: </span>
            <SchemaTree schema={items} doc={doc} depth={depth + 1} seen={seen} />
          </div>
        )
        : null}
      {!props.length && !items && !combos
        ? <span className="font-mono text-[11.5px] text-violet-700 dark:text-violet-300">{typeLabel(s)}</span>
        : null}
    </div>
  )
}

function PropRow({ name, schema, required, doc, depth, seen }: { name: string; schema: RawSchema; required: boolean; doc: unknown; depth: number; seen: string[] }) {
  const resolved = schema.$ref ? (resolvePointer(doc, schema.$ref) as RawSchema | undefined) : schema
  const nested = !!resolved && (!!resolved.properties || !!resolved.allOf || !!resolved.oneOf || !!resolved.anyOf ||
    (resolved.type === 'array' && !!resolved.items && (!!resolved.items.$ref || !!resolved.items.properties)))
  const [open, setOpen] = useState(depth < 1 && !schema.$ref)
  const constraints = [
    resolved?.minimum !== undefined ? `≥ ${resolved.minimum}` : '',
    resolved?.maximum !== undefined ? `≤ ${resolved.maximum}` : '',
    resolved?.minLength !== undefined ? `min ${resolved.minLength}` : '',
    resolved?.maxLength !== undefined ? `max ${resolved.maxLength}` : '',
    resolved?.pattern ? `/${resolved.pattern}/` : '',
    resolved?.default !== undefined ? `default ${JSON.stringify(resolved.default)}` : '',
  ].filter(Boolean)
  return (
    <li>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {nested
          ? <button type="button" onClick={() => setOpen((o) => !o)} className="w-3 text-content-subtle" aria-label={open ? 'Collapse' : 'Expand'}>{open ? '▾' : '▸'}</button>
          : <span className="w-3" />}
        <span className="font-mono text-[12px] text-content">{name}</span>
        {required ? <span className="text-[10px] font-semibold text-rose-600 dark:text-rose-400">required</span> : null}
        <span className="font-mono text-[11.5px] text-violet-700 dark:text-violet-300">{typeLabel(schema)}</span>
        {resolved?.deprecated ? <span className="text-[10px] text-amber-600">deprecated</span> : null}
        {constraints.length ? <span className="font-mono text-[10.5px] text-content-subtle">{constraints.join(' · ')}</span> : null}
      </div>
      {resolved?.description ? <div className="ml-5 text-[11.5px] text-content-muted">{resolved.description}</div> : null}
      {resolved?.enum ? <div className="ml-5 font-mono text-[11px] text-content-subtle">{resolved.enum.map((e) => JSON.stringify(e)).join(' | ')}</div> : null}
      {nested && open ? <div className="ml-1.5 mt-1"><SchemaTree schema={schema} doc={doc} depth={depth + 1} seen={seen} /></div> : null}
    </li>
  )
}

function SchemasPanel({ doc }: { doc: OpenApiDoc }) {
  const schemas = componentSchemas(doc)
  const [q, setQ] = useState('')
  const names = Object.keys(schemas).filter((n) => n.toLowerCase().includes(q.trim().toLowerCase())).sort()
  if (!Object.keys(schemas).length) return <EmptyState compact title="No component schemas" description="Define reusable models under components.schemas and reference them with $ref." />
  return (
    <div className="space-y-2">
      <SearchBox value={q} onChange={setQ} placeholder="Filter schemas…" />
      {names.map((n) => <SchemaCard key={n} name={n} schema={schemas[n]} doc={doc} />)}
    </div>
  )
}

function SchemaCard({ name, schema, doc }: { name: string; schema: RawSchema; doc: OpenApiDoc }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-edge-default">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="text-content-subtle">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-[12.5px] font-semibold text-content">{name}</span>
        <span className="font-mono text-[11px] text-violet-700 dark:text-violet-300">{typeLabel(schema)}</span>
        <span className="ml-auto text-[11px] text-content-subtle">{Object.keys(schema.properties ?? {}).length || ''}</span>
      </button>
      {open ? <div className="border-t border-edge-subtle p-3"><SchemaWithExample schema={schema} doc={doc} /></div> : null}
    </div>
  )
}

function JsonSchemaPanel({ doc, defsOnly }: { doc: OpenApiDoc; defsOnly?: boolean }) {
  const root = doc as unknown as RawSchema
  const [instance, setInstance] = useState(() => JSON.stringify(exampleFor(root, doc), null, 2))
  const result = useMemo(() => {
    try {
      return { errors: validateInstance(root, JSON.parse(instance), doc), parseError: null as string | null }
    } catch (e) {
      return { errors: [], parseError: (e as Error).message }
    }
  }, [instance, root, doc])
  if (defsOnly) return <SchemasPanel doc={doc} />
  return (
    <div className="space-y-4">
      <Block title={String(doc.title ?? 'Root schema')}>
        <SchemaWithExample schema={root} doc={doc} />
      </Block>
      <Block
        title="Test an instance"
        actions={<Button size="xs" onClick={() => setInstance(JSON.stringify(exampleFor(root, doc), null, 2))}>Reset to example</Button>}
      >
        <textarea value={instance} onChange={(e) => setInstance(e.target.value)} rows={8} spellCheck={false} className={`${INPUT} font-mono text-[12px]`} aria-label="Instance JSON" />
        <div className="mt-2 text-[12px]">
          {result.parseError
            ? <span className="text-rose-600 dark:text-rose-400">Invalid JSON — {result.parseError}</span>
            : result.errors.length
            ? (
              <ul className="space-y-0.5">
                {result.errors.map((e, i) => (
                  <li key={i} className="text-rose-700 dark:text-rose-300"><span className="font-mono">{e.path}</span> {e.message}</li>
                ))}
              </ul>
            )
            : <span className="text-emerald-700 dark:text-emerald-300">✓ The instance is valid against the schema.</span>}
        </div>
      </Block>
    </div>
  )
}

/* ─────────────────────────── problems & changes ─────────────────────────── */

function Problems({ issues, onReveal }: { issues: Issue[]; onReveal(line: number): void }) {
  if (!issues.length) return <EmptyState compact title="No problems" description="The document parses and passes structural checks." />
  const order = { error: 0, warning: 1, info: 2 }
  const tone = {
    error: 'bg-rose-600 text-white',
    warning: 'bg-amber-500 text-white',
    info: 'bg-sky-500 text-white',
  }
  return (
    <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
      {[...issues].sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0)).map((i, k) => (
        <li key={k}>
          <button
            type="button"
            disabled={!i.line}
            onClick={() => i.line && onReveal(i.line)}
            className="flex w-full items-start gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-surface-sunken/60 disabled:cursor-default"
          >
            <span className={`mt-0.5 rounded px-1.5 text-[10px] font-semibold uppercase ${tone[i.severity]}`}>{i.severity}</span>
            <span className="flex-1 text-content">{i.message}</span>
            {i.line ? <span className="font-mono text-[11px] text-content-subtle">L{i.line}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

function Changes({
  versions,
  current,
  onRestore,
  onDeleteVersion,
}: {
  versions: SpecVersion[]
  current: OpenApiDoc | null
  onRestore(v: SpecVersion): void
  onDeleteVersion(v: SpecVersion): void
}) {
  const [sel, setSel] = useState(versions[0]?.id ?? '')
  useEffect(() => {
    if (!versions.some((v) => v.id === sel)) setSel(versions[0]?.id ?? '')
  }, [versions, sel])
  const base = versions.find((v) => v.id === sel)
  const diff = useMemo(() => (base ? diffSpecs(parseSpec(base.document).doc, current) : null), [base, current])
  if (!versions.length) {
    return <EmptyState compact title="No saved versions" description="Use “Save version” to snapshot this document; then every edit is compared against it here, with breaking changes called out." />
  }
  const nothing = diff && !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.schemasAdded.length && !diff.schemasRemoved.length && !diff.schemasChanged.length
  return (
    <div className="space-y-4 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-content-muted">Compare current draft with</span>
        <select value={sel} onChange={(e) => setSel(e.target.value)} className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content">
          {versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.note ? ` — ${v.note}` : ''} ({formatRelative(v.at)})</option>)}
        </select>
        {base
          ? (
            <div className="ml-auto flex gap-1">
              <Button size="xs" onClick={() => onRestore(base)}>Restore</Button>
              <Button size="xs" variant="ghost" onClick={() => onDeleteVersion(base)}>Delete version</Button>
            </div>
          )
          : null}
      </div>
      {base ? <div className="text-[11px] text-content-subtle">Saved by {base.by} · {formatRelative(base.at)}</div> : null}
      {!current ? <div className="text-rose-600">The current draft does not parse — fix it to see changes.</div> : null}
      {diff && current
        ? nothing
          ? <EmptyState compact title="No API changes" description="Endpoints and schemas match this version." />
          : (
            <>
              {diff.breaking.length
                ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-500/30 dark:bg-rose-500/10">
                    <div className="mb-1 font-semibold text-rose-800 dark:text-rose-300">{diff.breaking.length} breaking change{diff.breaking.length === 1 ? '' : 's'}</div>
                    <ul className="list-disc space-y-0.5 pl-5 text-rose-800 dark:text-rose-300">
                      {diff.breaking.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  </div>
                )
                : (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                    No breaking changes detected — this looks backwards compatible.
                  </div>
                )}
              <DiffList title="Added operations" items={diff.added} tone="text-emerald-700 dark:text-emerald-300" sign="+" />
              <DiffList title="Removed operations" items={diff.removed} tone="text-rose-700 dark:text-rose-300" sign="−" />
              {diff.changed.length
                ? (
                  <Block title="Changed operations">
                    <ul className="space-y-2">
                      {diff.changed.map((c) => (
                        <li key={c.key}>
                          <div className="font-mono text-content">{c.key}</div>
                          <ul className="ml-4 list-disc text-content-muted">{c.changes.map((x, i) => <li key={i}>{x}</li>)}</ul>
                        </li>
                      ))}
                    </ul>
                  </Block>
                )
                : null}
              <DiffList title="Added schemas" items={diff.schemasAdded} tone="text-emerald-700 dark:text-emerald-300" sign="+" />
              <DiffList title="Removed schemas" items={diff.schemasRemoved} tone="text-rose-700 dark:text-rose-300" sign="−" />
              {diff.schemasChanged.length
                ? (
                  <Block title="Changed schemas">
                    <ul className="space-y-2">
                      {diff.schemasChanged.map((c) => (
                        <li key={c.key}>
                          <div className="font-mono text-content">{c.key}</div>
                          <ul className="ml-4 list-disc text-content-muted">{c.changes.map((x, i) => <li key={i}>{x}</li>)}</ul>
                        </li>
                      ))}
                    </ul>
                  </Block>
                )
                : null}
            </>
          )
        : null}
    </div>
  )
}

function DiffList({ title, items, tone, sign }: { title: string; items: string[]; tone: string; sign: string }) {
  if (!items.length) return null
  return (
    <Block title={title}>
      <ul className="space-y-0.5 font-mono">
        {items.map((x) => <li key={x} className={tone}>{sign} {x}</li>)}
      </ul>
    </Block>
  )
}
