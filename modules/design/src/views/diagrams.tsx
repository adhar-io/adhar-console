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
import {
  SEED_DIAGRAMS,
  TEMPLATES,
  TYPE_COLOR,
  TYPE_DESCRIPTION,
  TYPE_LABEL,
} from '../data/diagrams-seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Diagram, DiagramType } from '../data/types.ts'
import { MermaidPreview, renderToSvg } from '../components/mermaid-render.tsx'

/**
 * Diagrams-as-a-Service — a full diagram authoring surface for architects.
 *
 * Two modes:
 *   1. **Library** — searchable, filter-by-type grid of every diagram in the
 *      workspace. Each card live-renders the Mermaid source as a thumbnail
 *      so operators can scan visually.
 *   2. **Editor** — split-pane source ↔ live preview, type switcher, template
 *      picker, save / clone / delete / export (SVG download, MD copy).
 *
 * Persistence is localStorage keyed `adhar.design.diagrams`. Mermaid is
 * lazy-loaded once on first render via the MermaidPreview component.
 */
export function Diagrams() {
  const { items: list, isLoading, error, refetch } = useCollection<Diagram>(KIND.diagram)
  const createDiag = useCreate<Diagram>(KIND.diagram)
  const updateDiag = useUpdate<Diagram>(KIND.diagram)
  const removeDiag = useRemove(KIND.diagram)
  const seed = useSeedExamples<Diagram>(KIND.diagram)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | DiagramType>('all')

  const editing = useMemo(
    () => list.find((d) => d.id === editingId) ?? null,
    [list, editingId],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return list
      .filter((d) => filter === 'all' || d.type === filter)
      .filter(
        (d) =>
          !q ||
          d.title.toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  }, [list, search, filter])

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: list.length }
    for (const d of list) out[d.type] = (out[d.type] ?? 0) + 1
    return out
  }, [list])

  if (editing) {
    return (
      <DiagramEditor
        diagram={editing}
        onBack={() => setEditingId(null)}
        onSave={(patch) => {
          updateDiag.mutate({ ...editing, ...patch, updated_at: new Date().toISOString() })
        }}
        onClone={() => {
          const clone: Diagram = {
            ...editing,
            id: newId('diag'),
            title: `${editing.title} (copy)`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          createDiag.mutate(clone, { onSuccess: (created) => setEditingId(created.id) })
        }}
        onDelete={() => {
          if (!confirm(`Delete "${editing.title}"?`)) return
          removeDiag.mutate(editing.id)
          setEditingId(null)
        }}
      />
    )
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading diagrams…" />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <TypeTabs filter={filter} setFilter={setFilter} counts={counts} />
        <div className="ml-auto flex items-center gap-2">
          <SearchInput value={search} onChange={setSearch} />
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New diagram
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={list.length === 0 ? 'No diagrams yet' : 'No matches'}
          description={
            list.length === 0
              ? 'Click New diagram to start from a template.'
              : 'Try a different type filter or search term.'
          }
          action={
            list.length === 0 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => seed.mutate(SEED_DIAGRAMS)}
                disabled={seed.isPending}
              >
                {seed.isPending ? 'Loading…' : 'Load examples'}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((d) => (
            <DiagramCard key={d.id} d={d} onOpen={() => setEditingId(d.id)} />
          ))}
        </div>
      )}

      <CreateDiagramModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={({ type, title, source }) => {
          const next: Diagram = {
            id: newId('diag'),
            title: title.trim() || `New ${TYPE_LABEL[type]}`,
            type,
            source,
            tags: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          createDiag.mutate(next, { onSuccess: (created) => setEditingId(created.id) })
        }}
      />
    </div>
  )
}

/* Soft dotted grid behind diagram previews — adds visual texture so the
   rendered SVG sits on a "canvas" instead of a flat white panel. */
const PREVIEW_GRID =
  'radial-gradient(circle at 1px 1px, rgba(99,102,241,0.18) 1px, transparent 0)'

/* ─────────── Library ─────────── */

function TypeTabs({
  filter,
  setFilter,
  counts,
}: {
  filter: 'all' | DiagramType
  setFilter(f: 'all' | DiagramType): void
  counts: Record<string, number>
}) {
  const types: { id: 'all' | DiagramType; label: string }[] = [
    { id: 'all', label: 'All' },
    ...(Object.keys(TYPE_LABEL) as DiagramType[]).map((id) => ({ id, label: TYPE_LABEL[id] })),
  ]
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
      {types.map((t) => {
        const on = filter === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setFilter(t.id)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {t.label}
            <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
              {counts[t.id] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function DiagramCard({ d, onOpen }: { d: Diagram; onOpen(): void }) {
  return (
    <Card interactive className="group overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left"
        aria-label={`Open ${d.title}`}
      >
        {/* Literal #fff on purpose (not bg-white): Mermaid renders a fixed
            light theme, so this canvas stays white paper in dark mode too. */}
        <div
          className="relative h-52 overflow-hidden bg-[#fff] bg-linear-to-br from-brand-50/40 via-[#fff] to-violet-50/30"
          style={{ backgroundImage: PREVIEW_GRID, backgroundSize: '24px 24px' }}
        >
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <MermaidPreview
              source={d.source}
              className="flex h-full w-full items-center justify-center [&_svg]:max-h-full [&_svg]:max-w-full"
              fallback={
                <div className="text-[11px] text-content-subtle">Preparing preview…</div>
              }
            />
          </div>
        </div>
        <CardHeader className="border-t border-edge-subtle">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-content">{d.title}</div>
              <div className="mt-0.5 text-[11px] text-content-subtle">
                Updated {formatRelative(d.updated_at)}
              </div>
            </div>
            <TypePill type={d.type} />
          </div>
        </CardHeader>
        {d.tags.length ? (
          <CardBody className="!pt-0">
            <div className="flex flex-wrap gap-1">
              {d.tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted"
                >
                  #{t}
                </span>
              ))}
            </div>
          </CardBody>
        ) : null}
      </button>
    </Card>
  )
}

function TypePill({ type }: { type: DiagramType }) {
  const tone = TYPE_COLOR[type]
  const cls =
    {
      brand: 'bg-brand-50 text-brand-700',
      violet: 'bg-violet-50 text-violet-700',
      amber: 'bg-amber-50 text-amber-700',
      emerald: 'bg-emerald-50 text-emerald-700',
      rose: 'bg-rose-50 text-rose-700',
      sky: 'bg-sky-50 text-sky-700',
    }[tone] ?? 'bg-surface-sunken text-content-muted'
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {TYPE_LABEL[type]}
    </span>
  )
}

/* ─────────── Editor ─────────── */

function DiagramEditor({
  diagram,
  onBack,
  onSave,
  onClone,
  onDelete,
}: {
  diagram: Diagram
  onBack(): void
  onSave(patch: Partial<Diagram>): void
  onClone(): void
  onDelete(): void
}) {
  const [title, setTitle] = useState(diagram.title)
  const [source, setSource] = useState(diagram.source)
  const [type, setType] = useState<DiagramType>(diagram.type)
  const [tags, setTags] = useState(diagram.tags.join(', '))
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Reflect prop changes if the parent reloads.
  useEffect(() => {
    setTitle(diagram.title)
    setSource(diagram.source)
    setType(diagram.type)
    setTags(diagram.tags.join(', '))
    setDirty(false)
  }, [diagram.id])

  // Auto-save 1.2s after the last edit.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => {
      onSave({
        title,
        source,
        type,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      })
      setDirty(false)
      setSavedAt(Date.now())
    }, 1200)
    return () => clearTimeout(t)
  }, [dirty, title, source, type, tags, onSave])

  const onChangeType = (next: DiagramType) => {
    if (
      diagram.type !== next &&
      !confirm(`Switch to ${TYPE_LABEL[next]}? This won't change the source — you'll need to update it manually.`)
    )
      return
    setType(next)
    setDirty(true)
  }

  const insertTemplate = (tpl: { label: string; source: string }) => {
    if (source.trim() && !confirm(`Replace current source with template "${tpl.label}"?`)) return
    setSource(tpl.source)
    setDirty(true)
  }

  const exportSvg = async () => {
    try {
      const svg = await renderToSvg(source)
      const blob = new Blob([svg], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/[^A-Za-z0-9-_]+/g, '_')}.svg`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const copyMd = () => {
    const md = '```mermaid\n' + source.trim() + '\n```'
    navigator.clipboard?.writeText(md)
  }

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
        <Button size="sm" variant="ghost" onClick={onBack} leading={<IconBack />}>
          Library
        </Button>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setDirty(true)
          }}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold tracking-tight text-content focus:border-edge-default focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <select
          value={type}
          onChange={(e) => onChangeType(e.target.value as DiagramType)}
          className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs"
          aria-label="Diagram type"
        >
          {(Object.keys(TYPE_LABEL) as DiagramType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <SaveIndicator dirty={dirty} savedAt={savedAt} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={copyMd} leading={<IconClipboard />}>
            Copy MD
          </Button>
          <Button size="sm" variant="secondary" onClick={exportSvg} leading={<IconDownload />}>
            Export SVG
          </Button>
          <Button size="sm" variant="ghost" onClick={onClone}>
            Clone
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">Source</div>
                <div className="text-[11px] text-content-subtle">
                  {TYPE_DESCRIPTION[type]}
                </div>
              </div>
              <TemplateMenu type={type} onPick={insertTemplate} />
            </div>
          </CardHeader>
          <CardBody className="!p-0">
            <textarea
              value={source}
              onChange={(e) => {
                setSource(e.target.value)
                setDirty(true)
              }}
              spellCheck={false}
              className="block h-[60vh] w-full resize-none rounded-b-xl border-0 bg-slate-950 p-4 font-mono text-[12px] leading-relaxed text-slate-100 focus:outline-none"
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">Live preview</div>
                <div className="text-[11px] text-content-subtle">
                  Auto-renders 150ms after the last keystroke
                </div>
              </div>
              <StatusBadge kind="info">{TYPE_LABEL[type]}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="!p-3">
            {/* Literal #fff on purpose (not bg-white): Mermaid renders a fixed
                light theme, so this canvas stays white paper in dark mode too. */}
            <div
              className="h-[60vh] overflow-auto rounded-lg border border-edge-subtle bg-[#fff] bg-linear-to-br from-brand-50/30 via-[#fff] to-violet-50/20 p-6 ring-1 ring-inset ring-edge-subtle"
              style={{ backgroundImage: PREVIEW_GRID, backgroundSize: '24px 24px' }}
            >
              <MermaidPreview source={source} className="flex w-full justify-center" />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
              Tags (comma-separated)
            </span>
            <input
              value={tags}
              onChange={(e) => {
                setTags(e.target.value)
                setDirty(true)
              }}
              placeholder="architecture, c4, security"
              className="mt-1.5 block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </label>
        </CardBody>
      </Card>
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

function TemplateMenu({
  type,
  onPick,
}: {
  type: DiagramType
  onPick(t: { label: string; source: string }): void
}) {
  const [open, setOpen] = useState(false)
  const templates = TEMPLATES[type] ?? []
  if (!templates.length) return null
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
        Templates
      </Button>
      {open ? (
        <div
          className="absolute right-0 z-10 mt-1 w-64 overflow-hidden rounded-lg border border-edge-default bg-surface-raised py-1 shadow-xl ring-1 ring-black/5"
          onMouseLeave={() => setOpen(false)}
        >
          {templates.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => {
                onPick(t)
                setOpen(false)
              }}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-surface-sunken"
            >
              <div className="font-semibold text-content">{t.label}</div>
              <div className="font-mono text-[10px] text-content-subtle">
                {t.source.split('\n')[0]}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── Create ─────────── */

function CreateDiagramModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose(): void
  onCreate(input: { type: DiagramType; title: string; source: string }): void
}) {
  const [type, setType] = useState<DiagramType>('flowchart')
  const [title, setTitle] = useState('')
  const [tplLabel, setTplLabel] = useState<string>('')

  const tplOptions = TEMPLATES[type] ?? []
  const tpl = tplOptions.find((t) => t.label === tplLabel) ?? tplOptions[0]

  const reset = () => {
    setType('flowchart')
    setTitle('')
    setTplLabel('')
  }

  const submit = () => {
    onCreate({ type, title, source: tpl?.source ?? '' })
    reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New diagram"
      description="Pick a type — start from a template or empty source."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            Create diagram
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Type
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(Object.keys(TYPE_LABEL) as DiagramType[]).map((t) => {
              const on = type === t
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setType(t)
                    setTplLabel('')
                  }}
                  className={
                    on
                      ? 'rounded-lg border border-brand-400 bg-brand-50 p-3 text-left ring-2 ring-brand-400/20'
                      : 'rounded-lg border border-edge-default bg-surface-raised p-3 text-left hover:border-edge-strong'
                  }
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-content">{TYPE_LABEL[t]}</div>
                    <TypePill type={t} />
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-content-muted">
                    {TYPE_DESCRIPTION[t]}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Title
          </span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`Untitled ${TYPE_LABEL[type].toLowerCase()}`}
            className="mt-1.5 block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </label>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Starter template
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {tplOptions.map((t) => {
              const on = (tpl?.label ?? tplOptions[0]?.label) === t.label
              return (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setTplLabel(t.label)}
                  className={
                    on
                      ? 'rounded-lg border border-brand-400 bg-brand-50 p-3 text-left ring-2 ring-brand-400/20'
                      : 'rounded-lg border border-edge-default bg-surface-raised p-3 text-left hover:border-edge-strong'
                  }
                >
                  <div className="text-sm font-semibold text-content">{t.label}</div>
                  <pre className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[10px] leading-snug text-content-muted">
                    {t.source}
                  </pre>
                </button>
              )
            })}
          </div>
        </div>
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
        placeholder="Search diagrams…"
        className="block h-9 w-44 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
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
function IconDownload() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
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
