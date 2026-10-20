import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Modal, useOptionalUser, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  KIND,
  type Listed,
  newId,
  useCollection,
  useCreate,
  useRemove,
  useSeedExamples,
  useUpdate,
} from '../data/store.ts'
import {
  GALLERY,
  type GalleryCategory,
  type GalleryTemplate,
  SEED_DIAGRAMS,
  TEMPLATES,
  TYPE_COLOR,
  TYPE_LABEL,
} from '../data/diagrams-seed.ts'
import { detectSyntax, slugify, SYNTAX_LABEL } from '../data/mermaid-util.ts'
import { designHref, designLink, useDesignParams, useNewFlag, useSetDesignParams } from '../data/deep-link.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Diagram, DiagramType } from '../data/types.ts'
import { MermaidPreview, renderToSvg, useMermaidSvg } from '../components/mermaid-render.tsx'
import { SourceEditor } from '../components/source-editor.tsx'
import { PanZoom } from '../components/pan-zoom.tsx'
import { copyText, downloadBlob, downloadText, svgToPng } from '../components/export.ts'
import { useAutosave } from '../components/use-autosave.ts'
import { Icon, Menu, SaveDot, SearchBox, Segmented, TagInput, useConfirm } from '../components/ui-bits.tsx'
import { type DesignScope, notifyOrg, usePlatformCatalog, usePlatformSnapshot, useDesignScope } from '../data/platform.ts'
import { generateDiagram, type GeneratorInfo, type GeneratorKind, type GeneratorParams, GENERATOR_LABEL, lineDiff } from '../data/platform-model.ts'
import { scopeFilter, type Scoped } from '../data/scope.ts'
import type { AdrDoc } from '../data/adr.ts'
import { formatAdrNumber } from '../data/adr.ts'
import { GenerateDiagramModal, RegenerateModal } from '../components/diagram-platform.tsx'
import { AskAiModal, SparkIcon } from '../components/ai-draft.tsx'
import { EntityChips, EntityPickerModal } from '../components/catalog-bits.tsx'
import { DesignScopeBar, ScopeChip, ScopeFields } from '../components/scope-bits.tsx'
import { CommitToRepoModal } from '../components/git-dialogs.tsx'
import { PrBadge } from '../components/work-bits.tsx'

/**
 * Diagrams — Mermaid (incl. C4) diagrams-as-code.
 *
 *   • Library: search, type filter, sort, live thumbnails, duplicate / delete.
 *   • Template gallery with ready-made Adhar architecture diagrams.
 *   • Editor (`?diagram=<id>`): Monaco with a Mermaid grammar and inline error
 *     markers, live pan/zoom preview that keeps the last good render while
 *     you type, error line jump, autosave, export SVG / PNG / .mmd / Markdown.
 *
 * Persisted in the tenant document store (kind `design.diagram`).
 */

/** Stored diagram plus the optional fields this editor adds. */
type DiagramDoc = Diagram & {
  /** Mermaid header keyword (`pie`, `C4Container`…) for exact labelling. */
  syntax?: string
  description?: string
  updated_by?: string
  /** Workspace project / owner team. */
  project?: string
  team?: string
  /** Catalog entities this diagram documents (canonical refs). */
  entities?: string[]
  /** ADRs this diagram illustrates (ids). */
  adrs?: string[]
  /** Set when generated from platform data — enables Regenerate. */
  generator?: GeneratorInfo
  /** Last publish to a repository. */
  git?: { repo: string; branch: string; path: string; at: string }
  pr?: { repo: string; number: number; branch: string; base: string; at: string }
}

type SortKey = 'updated' | 'title' | 'created'

const PAPER_BG: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(99,102,241,0.16) 1px, transparent 0)',
  backgroundSize: '22px 22px',
}

function syntaxLabel(d: DiagramDoc): string {
  const kw = d.syntax ?? detectSyntax(d.source)?.keyword
  if (kw && SYNTAX_LABEL[kw]) return SYNTAX_LABEL[kw]
  return TYPE_LABEL[d.type] ?? d.type
}

function typeFromSource(source: string, fallback: DiagramType): { type: DiagramType; syntax?: string } {
  const s = detectSyntax(source)
  return { type: s?.type ?? fallback, syntax: s?.keyword }
}

export function Diagrams() {
  const { items: list, isLoading, error, refetch } = useCollection<DiagramDoc>(KIND.diagram)
  const createDiag = useCreate<DiagramDoc>(KIND.diagram)
  const removeDiag = useRemove(KIND.diagram)
  const seed = useSeedExamples<DiagramDoc>(KIND.diagram)
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const toast = useToast()
  const user = useOptionalUser()
  const [ask, confirmDialog] = useConfirm()

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | DiagramType>('all')
  const [sort, setSort] = useState<SortKey>('updated')
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const scope = useDesignScope()
  const catalog = usePlatformCatalog(aiOpen || !!params.diagram)
  useNewFlag(() => setGalleryOpen(true), !isLoading)
  const scoped = useMemo(() => scopeFilter(list, scope.lens).shown, [list, scope.lens])

  const open = (id: string | undefined) => setParams({ diagram: id }, { push: true })

  const create = (input: { title: string; source: string; type: DiagramType; tags?: string[]; description?: string; generator?: GeneratorInfo } & Scoped) => {
    const now = new Date().toISOString()
    const { type, syntax } = typeFromSource(input.source, input.type)
    const next: DiagramDoc = {
      id: newId('diag'),
      title: input.title,
      type,
      syntax,
      source: input.source,
      tags: input.tags ?? [],
      description: input.description ?? '',
      created_at: now,
      updated_at: now,
      updated_by: user?.name,
      ...scope.initial,
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.team !== undefined ? { team: input.team } : {}),
      ...(input.generator ? { generator: input.generator } : {}),
    }
    createDiag.mutate(next, {
      onSuccess: (created) => {
        toast.success('Diagram created', { description: created.title })
        open(created.id)
      },
      onError: (e) => toast.error('Could not create diagram', { description: e.message }),
    })
  }

  const duplicate = (d: DiagramDoc) =>
    create({ title: `${d.title} (copy)`, source: d.source, type: d.type, tags: d.tags, description: d.description, project: d.project, team: d.team })

  const remove = (d: DiagramDoc, after?: () => void) =>
    ask({
      title: `Delete “${d.title}”?`,
      description: 'The diagram source is removed for everyone in this workspace.',
      onConfirm: () =>
        removeDiag.mutate(d.id, {
          onSuccess: () => {
            toast.success('Diagram deleted')
            after?.()
          },
          onError: (e) => toast.error('Could not delete', { description: e.message }),
        }),
    })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = scoped
      .filter((d) => filter === 'all' || d.type === filter)
      .filter(
        (d) =>
          !q ||
          d.title.toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q)) ||
          d.source.toLowerCase().includes(q),
      )
    const by: Record<SortKey, (a: DiagramDoc, b: DiagramDoc) => number> = {
      updated: (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
      created: (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''),
      title: (a, b) => a.title.localeCompare(b.title),
    }
    return out.sort(by[sort])
  }, [scoped, search, filter, sort])

  const counts = useMemo(() => {
    const out: Partial<Record<DiagramType, number>> = {}
    for (const d of scoped) out[d.type] = (out[d.type] ?? 0) + 1
    return out
  }, [scoped])

  const aiContext = [
    {
      description: 'Service catalog',
      value: catalog.entities.slice(0, 80).map((e) => `${e.kind} ${e.name}${e.system ? ` (system ${e.system})` : ''}${e.providesApis.length ? ` provides ${e.providesApis.join(', ')}` : ''}${e.consumesApis.length ? ` consumes ${e.consumesApis.join(', ')}` : ''}`).join('\n') || 'empty',
    },
  ]

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading diagrams…" />

  if (params.diagram) {
    const d = list.find((x) => x.id === params.diagram)
    if (!d) {
      return (
        <EmptyState
          title="Diagram not found"
          description="It may have been deleted, or the link is from another workspace."
          action={<Button size="sm" onClick={() => open(undefined)}>Back to diagrams</Button>}
        />
      )
    }
    return (
      <>
        <DiagramEditor
          key={d.id}
          diagram={d}
          scope={scope}
          aiContext={aiContext}
          onBack={() => open(undefined)}
          onDuplicate={() => duplicate(d)}
          onDelete={() => remove(d, () => open(undefined))}
        />
        {confirmDialog}
      </>
    )
  }

  const types = (Object.keys(TYPE_LABEL) as DiagramType[]).filter((t) => counts[t])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip on={filter === 'all'} onClick={() => setFilter('all')} label="All" count={scoped.length} />
          {types.map((t) => (
            <FilterChip key={t} on={filter === t} onClick={() => setFilter(t)} label={TYPE_LABEL[t]} count={counts[t] ?? 0} />
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchBox value={search} onChange={setSearch} placeholder="Search diagrams…" className="w-56" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort"
            className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content"
          >
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="title">Title A–Z</option>
          </select>
          <Button size="sm" onClick={() => setGalleryOpen(true)} leading={<Icon name="template" />}>
            Templates
          </Button>
          <Button size="sm" onClick={() => setAiOpen(true)} leading={<SparkIcon />}>
            Ask Adhar AI
          </Button>
          <Button size="sm" onClick={() => setGenerateOpen(true)} leading={<Icon name="split" />}>
            Generate from platform
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => create({ title: 'Untitled diagram', source: TEMPLATES.flowchart[2].source, type: 'flowchart' })}
            leading={<Icon name="plus" />}
            loading={createDiag.isPending}
          >
            New diagram
          </Button>
        </div>
      </div>

      <DesignScopeBar scope={scope} shown={scoped.length} total={list.length} noun="diagrams" />
      {list.length === 0
        ? (
          <EmptyState
            title="Diagrams as code"
            description="Write Mermaid — flowcharts, sequences, C4, ER, state machines — and see it render live. Generate C4, deployment and tenancy views from your live platform, or start from a template."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="primary" onClick={() => setGenerateOpen(true)}>
                  Generate from platform
                </Button>
                <Button size="sm" onClick={() => setGalleryOpen(true)} leading={<Icon name="template" />}>
                  Browse templates
                </Button>
                <Button
                  size="sm"
                  onClick={() => seed.mutate(SEED_DIAGRAMS as DiagramDoc[], {
                    onSuccess: () => toast.success('Example diagrams added'),
                    onError: (e) => toast.error('Could not load examples', { description: e.message }),
                  })}
                  loading={seed.isPending}
                >
                  Load examples
                </Button>
              </div>
            }
          />
        )
        : filtered.length === 0
        ? <EmptyState compact title="No matches" description="Try a different type filter or search term." />
        : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((d) => (
              <DiagramCard
                key={d.id}
                d={d}
                scope={scope}
                onOpen={() => open(d.id)}
                onDuplicate={() => duplicate(d)}
                onDelete={() => remove(d)}
                onCopyLink={async () => {
                  const ok = await copyText(designLink({ diagram: d.id }))
                  ok ? toast.success('Link copied') : toast.error('Clipboard unavailable')
                }}
              />
            ))}
          </div>
        )}

      <GalleryModal
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onPick={(t) => {
          setGalleryOpen(false)
          create({ title: t.title, source: t.source, type: t.type, tags: t.tags, description: t.description })
        }}
      />
      <GenerateDiagramModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        initialProject={scope.initial.project}
        busy={createDiag.isPending}
        onCreate={(g) => {
          setGenerateOpen(false)
          create({
            title: g.title,
            source: g.source,
            type: 'flowchart',
            tags: ['generated', g.kind],
            description: `Generated from the platform (${GENERATOR_LABEL[g.kind]}).`,
            ...(g.params.project ? { project: g.params.project } : {}),
            generator: { kind: g.kind, params: g.params, at: new Date().toISOString(), output: g.source },
          })
        }}
      />
      <AskAiModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        kind="diagram"
        title="Draw a diagram with Adhar AI"
        description="Describe what to show; Adhar AI writes Mermaid using your catalog's names."
        placeholder="Sequence of a checkout: storefront calls orders-api, which reserves stock and charges payments…"
        context={aiContext}
        fence="mermaid"
        applyLabel="Create diagram"
        renderPreview={(text) => (
          <div className="flex h-[40vh] items-center justify-center overflow-hidden rounded-lg border border-edge-default p-3" style={PAPER_BG}>
            <MermaidPreview source={text} className="flex h-full w-full items-center justify-center [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none" />
          </div>
        )}
        onApply={(source) => create({ title: 'AI diagram', source, type: 'flowchart', tags: ['ai'] })}
      />
      {confirmDialog}
    </div>
  )
}

function FilterChip({ on, onClick, label, count }: { on: boolean; onClick(): void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
        on
          ? 'border-brand-300 bg-brand-50 font-semibold text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content'
      }`}
    >
      {label}
      <span className="font-mono text-[10px] tabular-nums opacity-60">{count}</span>
    </button>
  )
}

/** Render thumbnails only once the card scrolls into view. */
function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') return setSeen(true)
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true)
        io.disconnect()
      }
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

function TypePill({ d }: { d: DiagramDoc }) {
  const tone = TYPE_COLOR[d.type]
  const cls = {
    brand: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
    sky: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  }[tone] ?? 'bg-surface-sunken text-content-muted'
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {syntaxLabel(d)}
    </span>
  )
}

function DiagramCard({
  d,
  scope,
  onOpen,
  onDuplicate,
  onDelete,
  onCopyLink,
}: {
  d: Listed<DiagramDoc>
  scope: DesignScope
  onOpen(): void
  onDuplicate(): void
  onDelete(): void
  onCopyLink(): void
}) {
  const [ref, inView] = useInView<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className="group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm transition hover:border-edge-strong hover:shadow-md"
    >
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`Open ${d.title}`}>
        {/* White paper in both themes: Mermaid renders a fixed light theme. */}
        <div className="relative h-48 overflow-hidden border-b border-edge-subtle" style={PAPER_BG}>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            {inView
              ? (
                <MermaidPreview
                  source={d.source}
                  quietErrors
                  className="flex h-full w-full items-center justify-center [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none"
                  fallback="Rendering…"
                />
              )
              : null}
          </div>
        </div>
        <div className="space-y-1.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 truncate text-sm font-semibold text-content">{d.title}</div>
            <TypePill d={d} />
          </div>
          {d.description
            ? <p className="line-clamp-1 text-[12px] text-content-muted">{d.description}</p>
            : null}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-content-subtle">
            <ScopeChip item={d} scope={scope} />
            {d.generator ? <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">generated</span> : null}
            <span>
              Updated {formatRelative(d.updated_at)}
              {d.updated_by || d._updatedBy ? ` by ${d.updated_by ?? d._updatedBy}` : ''}
            </span>
            {d.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted">
                #{t}
              </span>
            ))}
          </div>
        </div>
      </button>
      <div className="absolute right-2 top-2 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
        <Menu
          variant="secondary"
          ariaLabel="Diagram actions"
          icon={<Icon name="more" />}
          items={[
            { label: 'Open', onSelect: onOpen },
            { label: 'Duplicate', onSelect: onDuplicate },
            { label: 'Copy link', onSelect: onCopyLink },
            'separator',
            { label: 'Delete', onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  )
}

/* ─────────── Template gallery ─────────── */

function GalleryModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose(): void
  onPick(t: GalleryTemplate): void
}) {
  const cats: ('All' | GalleryCategory)[] = ['All', ...Array.from(new Set(GALLERY.map((g) => g.category)))]
  const [cat, setCat] = useState<'All' | GalleryCategory>('All')
  const [sel, setSel] = useState<GalleryTemplate>(GALLERY[0])
  const shown = GALLERY.filter((g) => cat === 'All' || g.category === cat)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Diagram templates"
      description="Adhar architecture starters — every one is plain Mermaid you can edit."
      branded
      width="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => onPick(sel)}>
            Use “{sel.title}”
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {cats.map((c) => (
            <FilterChip
              key={c}
              on={cat === c}
              onClick={() => setCat(c)}
              label={c}
              count={c === 'All' ? GALLERY.length : GALLERY.filter((g) => g.category === c).length}
            />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <ul className="max-h-[52vh] space-y-1 overflow-auto pr-1">
            {shown.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => setSel(g)}
                  onDoubleClick={() => onPick(g)}
                  className={`w-full rounded-lg border p-2.5 text-left transition ${
                    sel.id === g.id
                      ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10'
                      : 'border-edge-default bg-surface-raised hover:border-edge-strong'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-content">{g.title}</span>
                    <span className="text-[10px] uppercase tracking-wider text-content-subtle">{g.category}</span>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-content-muted">{g.description}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex h-[52vh] items-center justify-center overflow-hidden rounded-lg border border-edge-default p-4" style={PAPER_BG}>
            <MermaidPreview key={sel.id} source={sel.source} className="flex h-full w-full items-center justify-center [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none" />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ─────────── Editor ─────────── */

type Layout = 'code' | 'split' | 'preview'

interface Draft {
  title: string
  source: string
  tags: string[]
  description: string
}

function DiagramEditor({
  diagram,
  scope,
  aiContext,
  onBack,
  onDuplicate,
  onDelete,
}: {
  diagram: Listed<DiagramDoc>
  scope: DesignScope
  aiContext: { description: string; value: string }[]
  onBack(): void
  onDuplicate(): void
  onDelete(): void
}) {
  const update = useUpdate<DiagramDoc>(KIND.diagram)
  const toast = useToast()
  const user = useOptionalUser()
  const [draft, setDraft] = useState<Draft>({
    title: diagram.title,
    source: diagram.source,
    tags: diagram.tags ?? [],
    description: diagram.description ?? '',
  })
  const [layout, setLayout] = useState<Layout>('split')
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null)
  const [tplOpen, setTplOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [entityOpen, setEntityOpen] = useState(false)
  const [regen, setRegen] = useState<{ source: string } | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const snapshot = usePlatformSnapshot(regenerating || entityOpen || (diagram.entities ?? []).length > 0)
  const { items: adrs } = useCollection<AdrDoc>(KIND.adr)
  const render = useMermaidSvg(draft.source, 250)
  const syntax = detectSyntax(draft.source)

  const latest = useRef(diagram)
  latest.current = diagram
  const save = useCallback(
    (d: Draft) => {
      const { type, syntax } = typeFromSource(d.source, latest.current.type)
      return update.mutateAsync({
        ...latest.current,
        ...d,
        type,
        syntax,
        updated_at: new Date().toISOString(),
        updated_by: user?.name,
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.name],
  )
  const autosave = useAutosave(draft, save, {
    key: diagram.id,
    onError: (e) => toast.error('Autosave failed', { description: e.message }),
  })

  const name = slugify(draft.title, 'diagram')
  const patchMeta = (patch: Partial<DiagramDoc>) =>
    update.mutateAsync({ ...latest.current, ...draft, ...patch, updated_at: new Date().toISOString(), updated_by: user?.name })
      .catch((e: Error) => toast.error('Could not save', { description: e.message }))

  // Regenerate once the snapshot is ready.
  useEffect(() => {
    if (!regenerating || !snapshot.ready || !diagram.generator) return
    setRegenerating(false)
    const next = generateDiagram(diagram.generator.kind as GeneratorKind, diagram.generator.params as GeneratorParams, snapshot.data)
    if (next.trim() === draft.source.trim()) {
      toast.success('Up to date', { description: 'The platform matches this diagram.' })
      void patchMeta({ generator: { ...diagram.generator, at: new Date().toISOString(), output: next } })
    } else setRegen({ source: next })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenerating, snapshot.ready])

  const exportSvg = async () => {
    try {
      downloadText(await renderToSvg(draft.source), `${name}.svg`, 'image/svg+xml')
    } catch (e) {
      toast.error('SVG export failed', { description: (e as Error).message })
    }
  }
  const exportPng = async () => {
    try {
      const svg = await renderToSvg(draft.source, { raster: true })
      downloadBlob(await svgToPng(svg, { scale: 2 }), `${name}.png`)
    } catch (e) {
      toast.error('PNG export failed', { description: (e as Error).message })
    }
  }
  const copyMd = async () => {
    const ok = await copyText('```mermaid\n' + draft.source.trim() + '\n```\n')
    ok ? toast.success('Markdown copied', { description: 'Paste into a README, ADR or PR.' }) : toast.error('Clipboard unavailable')
  }

  const fallbackType = syntax?.type ?? diagram.type
  const templates = TEMPLATES[fallbackType] ?? []

  const issue = render.issue
  const markers = useMemo(() => (issue ? [{ line: issue.line, message: issue.message }] : []), [issue])

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[520px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} leading={<Icon name="back" />}>
          Diagrams
        </Button>
        <input
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          aria-label="Diagram title"
          className="min-w-40 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold tracking-tight text-content hover:border-edge-default focus:border-edge-default focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <TypePill d={{ ...diagram, type: fallbackType, syntax: syntax?.keyword }} />
        <SaveDot state={autosave.state} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented<Layout>
            value={layout}
            onChange={setLayout}
            options={[
              { id: 'code', label: <Icon name="code" />, title: 'Source only' },
              { id: 'split', label: <Icon name="split" />, title: 'Split view' },
              { id: 'preview', label: <Icon name="eye" />, title: 'Preview only' },
            ]}
          />
          {diagram.generator
            ? (
              <Button size="sm" onClick={() => setRegenerating(true)} loading={regenerating} title={`Generated ${formatRelative(diagram.generator.at)} — ${GENERATOR_LABEL[diagram.generator.kind]}`}>
                Regenerate
              </Button>
            )
            : null}
          <Button size="sm" onClick={() => setAiOpen(true)} leading={<SparkIcon />}>Ask AI</Button>
          <Button size="sm" onClick={() => setTplOpen(true)} leading={<Icon name="template" />}>
            Templates
          </Button>
          <Menu
            label="Export"
            icon={<Icon name="download" />}
            items={[
              { label: 'SVG image', onSelect: exportSvg },
              { label: 'PNG image (2×)', onSelect: exportPng },
              { label: 'Mermaid source (.mmd)', onSelect: () => downloadText(draft.source, `${name}.mmd`) },
              { label: 'Publish to repo docs (PR)…', onSelect: () => setPublishOpen(true) },
              'separator',
              { label: 'Copy as Markdown', onSelect: copyMd },
              {
                label: 'Copy link',
                onSelect: async () => {
                  ;(await copyText(designLink({ diagram: diagram.id }))) ? toast.success('Link copied') : toast.error('Clipboard unavailable')
                },
              },
            ]}
          />
          <Menu
            ariaLabel="More actions"
            icon={<Icon name="more" />}
            items={[
              { label: 'Duplicate', onSelect: onDuplicate },
              'separator',
              { label: 'Delete diagram', onSelect: onDelete, danger: true },
            ]}
          />
        </div>
      </div>

      <div
        className={`grid min-h-0 flex-1 gap-3 ${
          layout === 'split' ? 'grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]' : 'grid-cols-1'
        }`}
      >
        {layout !== 'preview'
          ? (
            <div className="flex min-h-[280px] flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              <SourceEditor
                value={draft.source}
                onChange={(source) => setDraft((d) => ({ ...d, source }))}
                language="mermaid"
                markers={markers}
                reveal={reveal}
                onSave={() =>
                  void autosave.flush().then(() => toast.success('Saved'))}
                className="min-h-0 flex-1"
                ariaLabel="Mermaid source"
              />
              {issue
                ? (
                  <button
                    type="button"
                    onClick={() => setReveal({ line: issue.line, nonce: Date.now() })}
                    className="flex items-start gap-2 border-t border-rose-200 bg-rose-50 px-3 py-2 text-left text-[12px] text-rose-800 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
                  >
                    <span className="shrink-0 rounded bg-rose-600 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
                      L{issue.line}
                    </span>
                    <span className="line-clamp-2 font-mono">{issue.message}</span>
                  </button>
                )
                : (
                  <div className="flex items-center justify-between border-t border-edge-subtle px-3 py-1.5 text-[11px] text-content-subtle">
                    <span>{draft.source.split('\n').length} lines · ⌘S saves · autosaves as you type</span>
                    <a
                      href="https://mermaid.js.org/intro/syntax-reference.html"
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-content"
                    >
                      Syntax reference ↗
                    </a>
                  </div>
                )}
            </div>
          )
          : null}
        {layout !== 'code'
          ? (
            <div className="relative min-h-[280px] overflow-hidden rounded-xl border border-edge-default">
              <PanZoom fitKey={`${diagram.id}:${layout}`} contentKey={render.svg ? String(render.svg.length) : ''} className="h-full w-full" background={PAPER_BG}>
                {render.svg
                  ? <div className="p-4" dangerouslySetInnerHTML={{ __html: render.svg }} />
                  : <div className="p-10 text-sm text-slate-500">{render.loading ? 'Rendering…' : 'Nothing to render yet.'}</div>}
              </PanZoom>
              {issue && render.svg
                ? (
                  <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-rose-600/90 px-2 py-1 text-[11px] font-medium text-white shadow">
                    Showing last valid render
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ScopeFields compact value={{ project: diagram.project, team: diagram.team }} onChange={(v) => void patchMeta({ project: v.project, team: v.team })} scope={scope} />
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Catalog entities</span>
          <div className="flex flex-wrap items-center gap-1">
            <EntityChips refs={diagram.entities ?? []} entities={snapshot.catalog.entities} loaded={snapshot.catalog.settled} onChange={(entities) => void patchMeta({ entities })} />
            <button type="button" onClick={() => setEntityOpen(true)} className="text-[11.5px] text-brand-700 hover:underline dark:text-brand-300">Link…</button>
          </div>
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Decisions (ADRs)</span>
          <div className="flex flex-wrap items-center gap-1">
            {(diagram.adrs ?? []).map((id) => {
              const a = adrs.find((x) => x.id === id)
              return (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11.5px] text-content">
                  <a href={designHref('adrs', { adr: id })} className="hover:underline">{a ? `${formatAdrNumber(a.number)} ${a.title}` : 'missing ADR'}</a>
                  <button type="button" aria-label="Unlink" className="opacity-60 hover:opacity-100" onClick={() => void patchMeta({ adrs: (diagram.adrs ?? []).filter((x) => x !== id) })}>×</button>
                </span>
              )
            })}
            <select
              value=""
              onChange={(e) => e.target.value && void patchMeta({ adrs: [...(diagram.adrs ?? []), e.target.value] })}
              className="h-7 max-w-40 rounded-lg border border-dashed border-edge-default bg-transparent px-2 text-[12px] text-content-muted"
              aria-label="Link ADR"
            >
              <option value="">+ Link ADR…</option>
              {adrs.filter((a) => !(diagram.adrs ?? []).includes(a.id)).sort((a, b) => b.number - a.number).map((a) => (
                <option key={a.id} value={a.id}>{formatAdrNumber(a.number)} · {a.title}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="text-[11px] text-content-subtle">
          <span className="mb-1 block font-semibold uppercase tracking-[0.06em]">Activity</span>
          Last saved {formatRelative(diagram._updatedAt ?? diagram.updated_at)}{diagram.updated_by || diagram._updatedBy ? ` by ${diagram.updated_by ?? diagram._updatedBy}` : ''}
          {diagram.generator ? <div>Generated {formatRelative(diagram.generator.at)} · {GENERATOR_LABEL[diagram.generator.kind]}</div> : null}
          {diagram.pr ? <div className="mt-0.5"><PrBadge repo={diagram.pr.repo} number={diagram.pr.number} /></div> : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Tags</span>
          <TagInput value={draft.tags} onChange={(tags) => setDraft((d) => ({ ...d, tags }))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Description</span>
          <input
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="What does this diagram explain?"
            className="block h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-3 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </label>
      </div>

      <AskAiModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        kind="diagram"
        title="Rework this diagram with Adhar AI"
        description="Describe the change; the reply replaces the source when you apply it (undo with ⌘Z)."
        placeholder="Add the payments service and show which calls are asynchronous…"
        context={[{ description: 'Current diagram', value: draft.source }, ...aiContext]}
        fence="mermaid"
        applyLabel="Replace source"
        renderPreview={(text) => (
          <div className="flex h-[40vh] items-center justify-center overflow-hidden rounded-lg border border-edge-default p-3" style={PAPER_BG}>
            <MermaidPreview source={text} className="flex h-full w-full items-center justify-center [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none" />
          </div>
        )}
        onApply={(source) => setDraft((d) => ({ ...d, source }))}
      />
      <RegenerateModal
        open={!!regen}
        onClose={() => setRegen(null)}
        diff={regen ? lineDiff(draft.source, regen.source) : []}
        handEdited={!!diagram.generator && diagram.generator.output.trim() !== draft.source.trim()}
        onReplace={() => {
          if (!regen || !diagram.generator) return
          const source = regen.source
          setDraft((d) => ({ ...d, source }))
          void patchMeta({ source, generator: { ...diagram.generator, at: new Date().toISOString(), output: source } })
          setRegen(null)
          toast.success('Diagram regenerated', { description: 'Updated from live platform data.' })
        }}
      />
      <EntityPickerModal
        open={entityOpen}
        onClose={() => setEntityOpen(false)}
        entities={snapshot.catalog.entities}
        sources={snapshot.catalog.sources}
        selected={diagram.entities ?? []}
        title="Attach to catalog entities"
        onSave={(entities) => {
          setEntityOpen(false)
          void patchMeta({ entities })
        }}
      />
      <CommitToRepoModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="Publish diagram to repository docs"
        description="Writes the Mermaid source (.mmd) and a rendered SVG next to it."
        initial={diagram.git ? { repo: diagram.git.repo, branch: diagram.git.branch, folder: diagram.git.path.split('/').slice(0, -1).join('/') } : undefined}
        defaultFolder="docs/diagrams"
        defaultMessage={`docs(diagrams): ${draft.title}`}
        prBody={`Diagram “${draft.title}” published from Adhar Console → Design → Diagrams.${diagram.generator ? `\n\nGenerated from the platform (${GENERATOR_LABEL[diagram.generator.kind]}).` : ''}`}
        buildFiles={async () => [
          { path: `${name}.mmd`, content: draft.source.trimEnd() + '\n' },
          { path: `${name}.svg`, content: await renderToSvg(draft.source) },
        ]}
        onCommitted={(t) => {
          const at = new Date().toISOString()
          void patchMeta({
            git: { repo: t.repo, branch: t.branch, path: t.paths[0], at },
            ...(t.pr ? { pr: { repo: t.repo, number: t.pr.number, branch: t.pr.branch, base: t.branch, at } } : {}),
          })
          if (t.pr) void notifyOrg({ title: `Diagram PR: ${draft.title}`, description: `${user?.name ?? 'Someone'} opened ${t.repo}#${t.pr.number}.`, href: designHref('diagrams', { diagram: diagram.id }), key: `design-diagram-pr-${diagram.id}-${t.pr.number}` })
        }}
      />
      <InsertTemplateModal
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        current={templates}
        onPick={(source) => {
          setDraft((d) => ({ ...d, source }))
          setTplOpen(false)
          toast.info('Template applied', { description: 'Undo with ⌘Z in the editor.' })
        }}
      />
    </div>
  )
}

function InsertTemplateModal({
  open,
  onClose,
  current,
  onPick,
}: {
  open: boolean
  onClose(): void
  current: { label: string; source: string }[]
  onPick(source: string): void
}) {
  const all = useMemo(
    () => [
      ...current.map((t) => ({ id: `cur-${t.label}`, title: t.label, group: 'Same type', source: t.source })),
      ...GALLERY.map((g) => ({ id: g.id, title: g.title, group: g.category, source: g.source })),
    ],
    [current],
  )
  const [sel, setSel] = useState(0)
  useEffect(() => {
    if (open) setSel(0)
  }, [open])
  const pick = all[sel] ?? all[0]
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Replace source with a template"
      description="The current source is replaced — undo with ⌘Z."
      width="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!pick} onClick={() => pick && onPick(pick.source)}>
            Apply template
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <ul className="max-h-[50vh] space-y-1 overflow-auto pr-1">
          {all.map((t, i) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setSel(i)}
                onDoubleClick={() => onPick(t.source)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${
                  i === sel ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content hover:bg-surface-sunken'
                }`}
              >
                {t.title}
                <span className="text-[10px] uppercase tracking-wider text-content-subtle">{t.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex h-[50vh] items-center justify-center overflow-hidden rounded-lg border border-edge-default p-4" style={PAPER_BG}>
          {pick ? <MermaidPreview key={pick.id} source={pick.source} className="flex h-full w-full items-center justify-center [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none" /> : null}
        </div>
      </div>
    </Modal>
  )
}
