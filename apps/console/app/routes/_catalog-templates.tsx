import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field as FormField,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useRegisterEntity, useCatalog, type Entity } from '~/data/catalog.ts'
import {
  buildCustomTemplate,
  entityFromTemplate,
  getGiteaStatus,
  getTemplate,
  getTemplates,
  isUserTemplate,
  LANGUAGE_LABEL,
  loadGiteaTemplates,
  registerTemplate,
  removeUserTemplate,
  subscribeUserTemplates,
  type CatalogTemplate,
  type GiteaTemplateStatus,
  type TemplateField,
  type TemplateFamily,
  type TemplateLanguage,
} from '~/data/catalog-templates.ts'

/**
 * Create New — clean two-pane explorer.
 *
 *   ┌─ Header (title + back link) ────────────────────────────────────────┐
 *   │ ┌────────────────────────┐ ┌──────────────────────────────────────┐ │
 *   │ │ Left pane              │ │ Right detail                          │ │
 *   │ │  search + family chips │ │  hero (glyph + title + badges + desc) │ │
 *   │ │  recents (if any)      │ │  stats row                            │ │
 *   │ │  grouped template list │ │  what you'll get (bullet list)        │ │
 *   │ │                        │ │  CTA                                  │ │
 *   │ └────────────────────────┘ └──────────────────────────────────────┘ │
 *   └──────────────────────────────────────────────────────────────────────┘
 */

const FAMILY_LABEL: Record<string, string> = {
  service: 'Backend services',
  website: 'Frontends & websites',
  library: 'Shared libraries',
  api: 'API contracts',
  mobile: 'Mobile apps',
  data: 'Data & ML',
  docs: 'Documentation',
  infra: 'Infrastructure',
}

const FAMILY_ORDER = [
  'service',
  'website',
  'library',
  'api',
  'mobile',
  'data',
  'docs',
  'infra',
] as const

export function CatalogTemplates({ onCreated }: { onCreated(): void }) {
  // Reactive snapshot — re-renders when the user registers a new template
  // via the modal (or removes one).
  const templates = useSyncExternalStore(
    subscribeUserTemplates,
    getTemplates,
    getTemplates,
  )
  // Gitea-hosted templates load lazily from the BFF and fold into the store.
  const gitea = useSyncExternalStore(subscribeUserTemplates, getGiteaStatus, getGiteaStatus)
  useEffect(() => {
    loadGiteaTemplates()
  }, [])
  const [familyFilter, setFamilyFilter] = useState<string>('all')
  const [langFilter, setLangFilter] = useState<TemplateLanguage | 'all'>('all')
  const [text, setText] = useState<string>('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [wizardFor, setWizardFor] = useState<CatalogTemplate | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)

  const filtered = useMemo(() => {
    const lower = text.trim().toLowerCase()
    return templates.filter((t) => {
      if (familyFilter !== 'all' && t.family !== familyFilter) return false
      if (langFilter !== 'all' && t.language !== langFilter) return false
      if (!lower) return true
      return (
        t.title.toLowerCase().includes(lower) ||
        t.description.toLowerCase().includes(lower) ||
        t.tags.some((g) => g.toLowerCase().includes(lower)) ||
        LANGUAGE_LABEL[t.language].toLowerCase().includes(lower)
      )
    })
  }, [templates, familyFilter, langFilter, text])

  // Default selection: pick the first template in the filtered list, but
  // only auto-update when the current selection isn't visible.
  const selected: CatalogTemplate = useMemo(() => {
    if (activeId) {
      const found = filtered.find((t) => t.id === activeId)
      if (found) return found
    }
    return filtered[0] ?? templates[0]
  }, [activeId, filtered, templates])

  const familyCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const t of templates) out[t.family] = (out[t.family] ?? 0) + 1
    return out
  }, [templates])

  const languages = useMemo(() => {
    const out = new Map<TemplateLanguage, number>()
    for (const t of templates) out.set(t.language, (out.get(t.language) ?? 0) + 1)
    return Array.from(out.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
  }, [templates])

  const filterCount = (familyFilter !== 'all' ? 1 : 0) + (langFilter !== 'all' ? 1 : 0)

  const grouped = useMemo(() => {
    return FAMILY_ORDER
      .map((id) => ({
        id,
        label: FAMILY_LABEL[id] ?? id,
        items: filtered.filter((t) => t.family === id),
      }))
      .filter((g) => g.items.length > 0)
  }, [filtered])

  const recentIds = useRecentTemplates()
  const recents = recentIds.map(getTemplate).filter((t): t is CatalogTemplate => Boolean(t))

  const launch = (t: CatalogTemplate) => {
    pushRecent(t.id)
    setWizardFor(t)
  }

  // Honest states when there are no templates at all — no built-in seed fallback.
  // While Gitea is still resolving (initial mount or in-flight) show a skeleton;
  // once it has loaded with nothing, show a clear empty state that points at the
  // Gitea templates repo rather than pretending starters exist.
  const noTemplates = templates.length === 0
  if (noTemplates) {
    return (
      <div className="space-y-6">
        <Header onRegister={() => setRegisterOpen(true)} />
        {gitea.loading || !gitea.loaded ? (
          <TemplatesLoading />
        ) : (
          <TemplatesEmpty gitea={gitea} onRetry={() => loadGiteaTemplates(true)} onRegister={() => setRegisterOpen(true)} />
        )}
        <RegisterTemplateModal
          open={registerOpen}
          onClose={() => setRegisterOpen(false)}
          onRegistered={(t) => {
            setRegisterOpen(false)
            setActiveId(t.id)
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header onRegister={() => setRegisterOpen(true)} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[22rem_1fr]">
        <TemplateList
          grouped={grouped}
          totalShown={filtered.length}
          totalAll={templates.length}
          activeId={selected?.id}
          onPick={(t) => setActiveId(t.id)}
          familyFilter={familyFilter}
          onFamily={setFamilyFilter}
          familyCounts={familyCounts}
          langFilter={langFilter}
          onLang={setLangFilter}
          languages={languages}
          filterCount={filterCount}
          recents={recents}
          onLaunchRecent={launch}
          text={text}
          onText={setText}
          gitea={gitea}
          onClearFilters={() => {
            setText('')
            setFamilyFilter('all')
            setLangFilter('all')
          }}
        />
        {selected ? (
          <TemplateDetail
            template={selected}
            onUse={() => launch(selected)}
            onRemove={
              isUserTemplate(selected.id)
                ? () => {
                    removeUserTemplate(selected.id)
                    setActiveId(null)
                  }
                : undefined
            }
          />
        ) : (
          <NoSelection />
        )}
      </div>

      {wizardFor ? (
        <ScaffoldWizard
          template={wizardFor}
          onClose={() => setWizardFor(null)}
          onComplete={() => {
            setWizardFor(null)
            onCreated()
          }}
        />
      ) : null}

      <RegisterTemplateModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={(t) => {
          setRegisterOpen(false)
          setActiveId(t.id)
        }}
      />
    </div>
  )
}

/* ─────────── header ─────────── */

function Header({ onRegister }: { onRegister(): void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
          Adhar Platform
        </div>
        <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-content">
          Create New
        </h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-content-muted">
          Spin up a new service, website, library, API, or infrastructure module from a golden-path
          template — repo scaffold, CI/CD, observability, and catalog registration in one click.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/catalog"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content-muted shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken hover:text-content"
        >
          ← Back to Catalog
        </Link>
        <button
          type="button"
          onClick={onRegister}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-semibold text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
        >
          <IconUpload />
          <span>Register template</span>
        </button>
      </div>
    </header>
  )
}

/* ─────────── template list (left pane) ─────────── */

/** Thin provenance row under the search bar: where the templates came from. */
function GiteaStatusRow({ gitea }: { gitea: GiteaTemplateStatus }) {
  let label: ReactNode = null
  if (gitea.loading) {
    label = (
      <>
        <Spinner size={12} /> Loading templates from Gitea…
      </>
    )
  } else if (gitea.configured && gitea.count > 0) {
    label = (
      <>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {gitea.count} template{gitea.count === 1 ? '' : 's'} from Gitea
      </>
    )
  } else if (gitea.loaded && gitea.configured && gitea.count === 0) {
    label = <>No template repositories found in Gitea.</>
  } else if (gitea.loaded && !gitea.configured) {
    label = <>Gitea not connected — showing your registered templates only.</>
  }
  if (!label) return null
  return (
    <div className="flex items-center gap-1.5 border-b border-edge-subtle px-3 py-1.5 text-[11px] text-content-subtle">
      {label}
    </div>
  )
}

function TemplateList({
  grouped,
  totalShown,
  totalAll,
  activeId,
  onPick,
  familyFilter,
  onFamily,
  familyCounts,
  langFilter,
  onLang,
  languages,
  filterCount,
  recents,
  onLaunchRecent,
  text,
  onText,
  gitea,
  onClearFilters,
}: {
  grouped: Array<{ id: string; label: string; items: CatalogTemplate[] }>
  totalShown: number
  totalAll: number
  activeId?: string
  onPick(t: CatalogTemplate): void
  familyFilter: string
  onFamily(v: string): void
  familyCounts: Record<string, number>
  langFilter: TemplateLanguage | 'all'
  onLang(v: TemplateLanguage | 'all'): void
  languages: Array<{ id: TemplateLanguage; count: number }>
  filterCount: number
  recents: CatalogTemplate[]
  onLaunchRecent(t: CatalogTemplate): void
  text: string
  onText(v: string): void
  gitea: GiteaTemplateStatus
  onClearFilters(): void
}) {
  const hasFilters = filterCount > 0 || text.length > 0
  return (
    <aside className="flex max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-center gap-2 border-b border-edge-subtle p-3">
        <div className="relative h-9 flex-1">
          <input
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && text) {
                e.stopPropagation()
                onText('')
              }
            }}
            placeholder="Search templates…"
            aria-label="Search templates"
            className="h-full w-full rounded-lg border border-edge-default bg-surface-raised pl-9 pr-9 text-sm text-content placeholder:text-content-subtle transition-shadow focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
            <IconSearch />
          </span>
          {text ? (
            <button
              type="button"
              onClick={() => onText('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
              aria-label="Clear search"
              title="Clear (Esc)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          ) : null}
        </div>
        <FilterButton
          familyFilter={familyFilter}
          onFamily={onFamily}
          familyCounts={familyCounts}
          langFilter={langFilter}
          onLang={onLang}
          languages={languages}
          filterCount={filterCount}
        />
      </div>

      <GiteaStatusRow gitea={gitea} />

      <div className="flex-1 overflow-y-auto">
        {recents.length > 0 && !hasFilters ? (
          <div className="border-b border-edge-subtle px-3 pb-3 pt-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
              Recently used
            </div>
            <div className="flex flex-wrap gap-1.5">
              {recents.slice(0, 4).map((t) => (
                <RecentChip key={t.id} template={t} onPick={() => onLaunchRecent(t)} />
              ))}
            </div>
          </div>
        ) : null}

        {grouped.length === 0 ? (
          <div className="space-y-2 p-8 text-center">
            <div className="text-[13px] font-medium text-content">No templates match.</div>
            <button
              type="button"
              onClick={onClearFilters}
              className="text-[11px] text-brand-700 dark:text-brand-300 underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ol className="divide-y divide-edge-subtle">
            {grouped.map((g) => (
              <li key={g.id}>
                <div className="px-3 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">
                  {g.label}
                </div>
                <ul>
                  {g.items.map((t) => (
                    <li key={t.id}>
                      <TemplateRow
                        template={t}
                        active={t.id === activeId}
                        onClick={() => onPick(t)}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px] text-content-subtle">
        <span className="font-mono tabular-nums">
          <span className="text-content">{totalShown}</span> / {totalAll} shown
        </span>
        <span>Pick a template to preview</span>
      </div>
    </aside>
  )
}

function TemplateRow({
  template,
  active,
  onClick,
}: {
  template: CatalogTemplate
  active: boolean
  onClick(): void
}) {
  const tone = TONES[template.tone]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'group relative flex w-full items-center gap-3 px-3 py-2 text-left transition',
        active
          ? 'bg-brand-50/60 dark:bg-brand-500/10'
          : 'hover:bg-surface-sunken/60',
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand-500"
        />
      ) : null}
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-white',
          tone.glyph,
        )}
      >
        <span className="text-[10px] font-bold tracking-wider">{template.glyph}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-[13px] font-semibold leading-tight',
              active ? 'text-brand-800 dark:text-brand-300' : 'text-content',
            )}
          >
            {template.title}
          </span>
          {template.isNew ? (
            <span className="rounded-full bg-emerald-100 dark:bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
              new
            </span>
          ) : null}
          {isUserTemplate(template.id) ? (
            <span className="rounded-full bg-violet-100 dark:bg-violet-500/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-violet-800 dark:text-violet-300">
              custom
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-content-subtle">
          <LangDot lang={template.language} />
          <span>{LANGUAGE_LABEL[template.language]}</span>
          <span>·</span>
          <span>~{template.estimateMinutes ?? '—'} min</span>
        </div>
      </div>
    </button>
  )
}

function FilterButton({
  familyFilter,
  onFamily,
  familyCounts,
  langFilter,
  onLang,
  languages,
  filterCount,
}: {
  familyFilter: string
  onFamily(v: string): void
  familyCounts: Record<string, number>
  langFilter: TemplateLanguage | 'all'
  onLang(v: TemplateLanguage | 'all'): void
  languages: Array<{ id: TemplateLanguage; count: number }>
  filterCount: number
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickAway = (e: MouseEvent) => {
      const a = anchorRef.current
      if (a && !a.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.addEventListener('mousedown', onClickAway)
    globalThis.addEventListener('keydown', onEsc)
    return () => {
      globalThis.removeEventListener('mousedown', onClickAway)
      globalThis.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const familyLabel = (id: string) =>
    id === 'all'
      ? 'all'
      : id === 'service'
        ? 'backend'
        : id === 'website'
          ? 'frontend'
          : id

  const families = (['all', ...FAMILY_ORDER] as const).filter(
    (id) => id === 'all' || (familyCounts[id] ?? 0) > 0,
  )
  const totalFamily = Object.values(familyCounts).reduce((a, b) => a + b, 0)
  const totalLang = languages.reduce((a, l) => a + l.count, 0)
  const clearAll = () => {
    onFamily('all')
    onLang('all')
  }

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition',
          filterCount > 0
            ? 'border-content bg-content text-surface-raised shadow-sm'
            : 'border-edge-default bg-surface-raised text-content hover:border-content',
        )}
      >
        <IconFilter />
        <span className="hidden sm:inline">Filter</span>
        {filterCount > 0 ? (
          <span className="rounded-full bg-surface-raised/20 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
            {filterCount}
          </span>
        ) : null}
        <span className="text-[10px] opacity-70">▾</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Filters"
          className="pop-in absolute right-0 top-full z-30 mt-2 w-80 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-edge-subtle bg-surface-sunken/40 px-4 py-2.5">
            <div className="flex items-center gap-2 text-[12px]">
              <IconFilter />
              <span className="font-semibold text-content">Filters</span>
              {filterCount > 0 ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="ml-1 text-[11px] text-content-subtle underline-offset-2 hover:text-content hover:underline"
                >
                  Clear all
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              ×
            </button>
          </div>

          <div className="space-y-3 px-4 py-3">
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
                Family
              </div>
              <div className="flex flex-wrap gap-1">
                {families.map((id) => {
                  const c = id === 'all' ? totalFamily : familyCounts[id] ?? 0
                  const active = familyFilter === id
                  return (
                    <PopoverChip
                      key={id}
                      active={active}
                      onClick={() => onFamily(id)}
                      label={familyLabel(id)}
                      count={c}
                    />
                  )
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
                Language
              </div>
              <div className="flex flex-wrap gap-1">
                <PopoverChip
                  active={langFilter === 'all'}
                  onClick={() => onLang('all')}
                  label="any"
                  count={totalLang}
                />
                {languages.map((l) => (
                  <PopoverChip
                    key={l.id}
                    active={langFilter === l.id}
                    onClick={() => onLang(l.id)}
                    icon={<LangDot lang={l.id} />}
                    label={LANGUAGE_LABEL[l.id]}
                    count={l.count}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PopoverChip({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick(): void
  icon?: React.ReactNode
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition',
        active
          ? 'bg-content text-surface-raised shadow-sm'
          : 'bg-surface-sunken text-content-muted hover:bg-surface-sunken/80 hover:text-content',
      )}
    >
      {icon}
      <span className="capitalize">{label}</span>
      <span
        className={cn(
          'rounded-full px-1 text-[9px] tabular-nums',
          active ? 'bg-surface-raised/20 text-surface-raised' : 'bg-surface-raised text-content-subtle',
        )}
      >
        {count}
      </span>
    </button>
  )
}

function RecentChip({
  template,
  onPick,
}: {
  template: CatalogTemplate
  onPick(): void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised py-0.5 pl-0.5 pr-2.5 text-left text-[11px] shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-brand-300/70 hover:shadow-md"
    >
      <span
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full bg-linear-to-br text-white',
          TONES[template.tone].glyph,
        )}
      >
        <span className="text-[8px] font-bold tracking-wider">{template.glyph}</span>
      </span>
      <span className="truncate font-medium text-content">{template.title}</span>
    </button>
  )
}

/* ─────────── template detail (right pane) ─────────── */

function TemplateDetail({
  template,
  onUse,
  onRemove,
}: {
  template: CatalogTemplate
  onUse(): void
  onRemove?(): void
}) {
  const tone = TONES[template.tone]
  const custom = isUserTemplate(template.id)
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
      <header className={cn('relative overflow-hidden bg-linear-to-br px-7 py-7', tone.card)}>
        <div className="flex items-start gap-5">
          <span
            className={cn(
              'inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br shadow-lg',
              tone.glyph,
            )}
          >
            <span className="text-[14px] font-bold tracking-wider">{template.glyph}</span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[22px] font-semibold tracking-tight text-content">
                    {template.title}
                  </h2>
                  <Badges template={template} />
                  {custom ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 dark:border-violet-500/25 bg-violet-50 dark:bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-800 dark:text-violet-300">
                      Custom
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-[11px] text-content-subtle">
                  produces {template.produces.kind.toLowerCase()}:{String(template.produces.type)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {onRemove ? (
                  <button
                    type="button"
                    onClick={onRemove}
                    className="inline-flex h-9 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2.5 text-[12px] font-medium text-content-muted shadow-sm transition-colors hover:border-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300"
                    title="Remove this custom template"
                  >
                    <IconTrash />
                    <span>Remove</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onUse}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-4 text-[13px] font-semibold text-white shadow-md transition-colors hover:bg-brand-700 hover:shadow-lg"
                >
                  <span className="text-white">
                    <IconWand />
                  </span>
                  <span className="text-white">Use this template</span>
                </button>
              </div>
            </div>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-content-muted">
              {template.description}
            </p>
          </div>
        </div>

        <dl className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-edge-subtle/70 pt-4 text-[11px]">
          <Stat
            icon={<LangDot lang={template.language} />}
            label="Language"
            value={LANGUAGE_LABEL[template.language]}
          />
          <Stat
            icon={<IconClock />}
            label="Time to scaffold"
            value={template.estimateMinutes ? `~${template.estimateMinutes} min` : '—'}
          />
          <Stat
            icon={<IconForm />}
            label="Wizard steps"
            value={String(template.steps.length)}
          />
          <Stat
            icon={<IconPlay />}
            label="Actions"
            value={String(template.actions.length)}
          />
          <Stat
            icon={<IconUsers />}
            label="Maintained by"
            value={template.owner}
            mono
          />
        </dl>
      </header>

      <div className="flex-1 overflow-y-auto">
        {template.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 border-b border-edge-subtle px-7 py-4">
            {template.tags.map((t) => (
              <span
                key={t}
                className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}

        <section className="px-7 py-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
            What you'll get
          </h3>
          <ul className="mt-3 space-y-1">
            {template.actions.map((a, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-sunken/40"
              >
                <span className="mt-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                <div className="min-w-0">
                  <div className="text-content">{a.title}</div>
                  {a.detail ? (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-content-subtle">
                      {a.detail}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </article>
  )
}

function Stat({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-content-subtle">{icon}</span>
      <span className="text-content-subtle">{label}</span>
      <span className={cn('font-semibold text-content', mono && 'font-mono text-[12px]')}>
        {value}
      </span>
    </div>
  )
}

function Badges({ template }: { template: CatalogTemplate }) {
  if (!template.popular && !template.isNew) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {template.popular ? (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300 ring-1 ring-amber-200">
          <IconStar /> popular
        </span>
      ) : null}
      {template.isNew ? (
        <span className="rounded-full bg-emerald-100 dark:bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-200">
          new
        </span>
      ) : null}
    </span>
  )
}

function NoSelection() {
  return (
    <div className="flex items-center justify-center rounded-2xl border border-dashed border-edge-default bg-surface-raised p-12 text-center text-sm text-content-muted shadow-sm">
      Pick a template from the left to preview it here.
    </div>
  )
}

/* ─────────── whole-page loading / empty states (no seed fallback) ─────────── */

/** Skeleton shown while Gitea templates are still being fetched. */
function TemplatesLoading() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[22rem_1fr]" aria-busy="true">
      <aside className="flex flex-col gap-3 rounded-2xl border border-edge-default bg-surface-raised p-3 shadow-sm">
        <div className="h-9 animate-pulse rounded-lg bg-surface-sunken" />
        <div className="flex items-center gap-1.5 text-[11px] text-content-subtle">
          <Spinner size={12} /> Loading templates from Gitea…
        </div>
        <ol className="mt-1 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-1 py-1">
              <span className="h-8 w-8 shrink-0 animate-pulse rounded-lg bg-surface-sunken" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-2/3 animate-pulse rounded bg-surface-sunken" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-surface-sunken" />
              </div>
            </li>
          ))}
        </ol>
      </aside>
      <div className="rounded-2xl border border-edge-default bg-surface-raised p-7 shadow-sm">
        <div className="flex items-start gap-5">
          <span className="h-16 w-16 shrink-0 animate-pulse rounded-2xl bg-surface-sunken" />
          <div className="flex-1 space-y-2.5">
            <div className="h-5 w-1/3 animate-pulse rounded bg-surface-sunken" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface-sunken" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-sunken" />
          </div>
        </div>
        <div className="mt-6 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 w-1/2 animate-pulse rounded bg-surface-sunken" />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Honest empty state once Gitea has loaded with zero templates. */
function TemplatesEmpty({
  gitea,
  onRetry,
  onRegister,
}: {
  gitea: GiteaTemplateStatus
  onRetry(): void
  onRegister(): void
}) {
  const detail = !gitea.configured
    ? 'The Gitea templates repository is not reachable (configured: false). Check that the platform BFF is running and the adhar/adhar-templates repo is connected.'
    : gitea.error
      ? `Gitea responded, but no templates could be loaded: ${gitea.error}`
      : 'No template repositories were found in Gitea. Add templates to the adhar/adhar-templates repo, or register one below.'
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-edge-default bg-surface-raised p-12 text-center shadow-sm">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-sunken text-content-subtle">
        <IconInbox />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-[15px] font-semibold text-content">No templates available</h2>
        <p className="mx-auto max-w-md text-[13px] leading-relaxed text-content-muted">
          Check that the Gitea templates repo is reachable. {detail}
        </p>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-semibold text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onRegister}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content-muted shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken hover:text-content"
        >
          <IconUpload />
          <span>Register template</span>
        </button>
      </div>
    </div>
  )
}

function IconInbox() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  )
}

/* ─────────── glyphs / language indicators ─────────── */

const TONES: Record<CatalogTemplate['tone'], { card: string; glyph: string; ring: string }> = {
  brand: {
    card: 'from-brand-50/70 dark:from-brand-500/10 to-surface-raised',
    glyph: 'from-brand-500 to-brand-700 text-white shadow-brand-500/20',
    ring: 'ring-brand-200/70',
  },
  emerald: {
    card: 'from-emerald-50/70 dark:from-emerald-500/10 to-surface-raised',
    glyph: 'from-emerald-500 to-emerald-700 text-white shadow-emerald-500/20',
    ring: 'ring-emerald-200/70',
  },
  sky: {
    card: 'from-sky-50/70 dark:from-sky-500/10 to-surface-raised',
    glyph: 'from-sky-500 to-sky-700 text-white shadow-sky-500/20',
    ring: 'ring-sky-200/70',
  },
  amber: {
    card: 'from-amber-50/70 dark:from-amber-500/10 to-surface-raised',
    glyph: 'from-amber-500 to-amber-700 text-white shadow-amber-500/20',
    ring: 'ring-amber-200/70',
  },
  violet: {
    card: 'from-violet-50/70 dark:from-violet-500/10 to-surface-raised',
    glyph: 'from-violet-500 to-violet-700 text-white shadow-violet-500/20',
    ring: 'ring-violet-200/70',
  },
  rose: {
    card: 'from-rose-50/70 dark:from-rose-500/10 to-surface-raised',
    glyph: 'from-rose-500 to-rose-700 text-white shadow-rose-500/20',
    ring: 'ring-rose-200/70',
  },
  slate: {
    card: 'from-slate-100/70 to-surface-raised',
    glyph: 'from-slate-600 to-slate-800 text-white dark:text-surface-raised shadow-slate-600/20',
    ring: 'ring-slate-300/70',
  },
}

const LANG_DOT: Record<TemplateLanguage, string> = {
  go: 'bg-sky-500',
  java: 'bg-emerald-500',
  kotlin: 'bg-violet-500',
  typescript: 'bg-brand-500',
  javascript: 'bg-amber-500',
  python: 'bg-amber-500',
  rust: 'bg-rose-500',
  scala: 'bg-rose-500',
  swift: 'bg-rose-500',
  shell: 'bg-slate-500',
  hcl: 'bg-violet-500',
  helm: 'bg-slate-500',
  mixed: 'bg-content-subtle',
}

function LangDot({ lang }: { lang: TemplateLanguage }) {
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full', LANG_DOT[lang])} />
}

/* ─────────── recents store ─────────── */

const RECENT_KEY = 'adhar.catalog.recent-templates'
const RECENT_MAX = 6
const EMPTY_RECENTS: readonly string[] = Object.freeze([])

const recentListeners = new Set<() => void>()
let cachedRaw: string | null = '__init__'
let cachedSnapshot: readonly string[] = EMPTY_RECENTS

function notifyRecents() {
  cachedRaw = '__init__'
  for (const l of Array.from(recentListeners)) l()
}

function pushRecent(id: string) {
  if (typeof localStorage === 'undefined') return
  let cur: string[] = []
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) cur = parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    /* ignore */
  }
  const next = [id, ...cur.filter((x) => x !== id)].slice(0, RECENT_MAX)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  notifyRecents()
}

function subscribeRecents(cb: () => void): () => void {
  recentListeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === RECENT_KEY) {
      cachedRaw = '__init__'
      cb()
    }
  }
  if (typeof globalThis !== 'undefined' && 'addEventListener' in globalThis) {
    globalThis.addEventListener('storage', onStorage)
  }
  return () => {
    recentListeners.delete(cb)
    if (typeof globalThis !== 'undefined' && 'removeEventListener' in globalThis) {
      globalThis.removeEventListener('storage', onStorage)
    }
  }
}

function getRecentsSnapshot(): readonly string[] {
  if (typeof localStorage === 'undefined') return EMPTY_RECENTS
  const raw = localStorage.getItem(RECENT_KEY)
  if (raw === cachedRaw) return cachedSnapshot
  cachedRaw = raw
  if (!raw) {
    cachedSnapshot = EMPTY_RECENTS
    return cachedSnapshot
  }
  try {
    const parsed = JSON.parse(raw)
    cachedSnapshot = Array.isArray(parsed)
      ? Object.freeze(parsed.filter((x): x is string => typeof x === 'string'))
      : EMPTY_RECENTS
  } catch {
    cachedSnapshot = EMPTY_RECENTS
  }
  return cachedSnapshot
}

function getRecentsServerSnapshot(): readonly string[] {
  return EMPTY_RECENTS
}

function useRecentTemplates(): readonly string[] {
  return useSyncExternalStore(subscribeRecents, getRecentsSnapshot, getRecentsServerSnapshot)
}

/* ─────────── scaffold wizard (modal) ─────────── */

type WizardStage = 'fields' | 'review' | 'run' | 'success'

interface ScaffoldRun {
  step: number
  done: boolean
  progress: number
  log: string[]
  startedAt: number
}

/* ─────────── owner/team source (GET /api/teams) ─────────── */

interface Team {
  name: string
  title?: string
}

/**
 * The two teams every organisation can always own components with. Used as the
 * honest fallback when the BFF/`/api/teams` endpoint is absent (dev SPA) or the
 * platform Gitea isn't connected — the picker is never empty.
 */
const DEFAULT_TEAMS: Team[] = [
  { name: 'default-platform', title: 'Platform Team' },
  { name: 'default-application', title: 'Application Team' },
]

/** Synthesize a `kind: Group` catalog Entity from a discovered team. */
function teamGroupEntity(t: Team): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name: t.name, namespace: 'default', title: t.title ?? t.name },
    spec: {},
  }
}

/**
 * Fetch the org's teams from the BFF (`GET /api/teams`) and expose them as
 * synthesized Group entities. Mirrors {@link loadGiteaTemplates}' honest
 * fallback: on any failure (no BFF, non-JSON, network) the two defaults stand,
 * so the Owner picker always offers at least default-platform + default-application.
 */
function useTeamGroups(): Entity[] {
  const [teams, setTeams] = useState<Team[]>(DEFAULT_TEAMS)
  useEffect(() => {
    let alive = true
    fetch('/api/teams', { credentials: 'include', headers: { accept: 'application/json' } })
      .then(async (res) => {
        const ct = res.headers.get('content-type') ?? ''
        if (!res.ok || !ct.includes('application/json')) return
        const json = (await res.json()) as { teams?: Team[] }
        if (alive && Array.isArray(json.teams) && json.teams.length > 0) setTeams(json.teams)
      })
      .catch(() => {
        /* keep the defaults */
      })
    return () => {
      alive = false
    }
  }, [])
  return useMemo(() => teams.map(teamGroupEntity), [teams])
}

/** Live-catalog Groups first, then any team Groups not already present (by name). */
function mergeGroups(catalog: Entity[], teamGroups: Entity[]): Entity[] {
  const base = catalog.filter((e) => e.kind === 'Group')
  const seen = new Set(base.map((e) => e.metadata.name))
  const extra = teamGroups.filter((t) => !seen.has(t.metadata.name))
  return [...base, ...extra]
}

function ScaffoldWizard({
  template,
  onClose,
  onComplete,
}: {
  template: CatalogTemplate
  onClose(): void
  onComplete(): void
}) {
  const register = useRegisterEntity()
  const catalog = useCatalog().data ?? []
  // Owner picker source: live catalog Groups ∪ the platform teams from
  // /api/teams (which always guarantees default-platform + default-application),
  // so Owner is never empty even when the live catalog defines no Group entity.
  const teamGroups = useTeamGroups()
  const ownerGroups = useMemo(() => mergeGroups(catalog, teamGroups), [catalog, teamGroups])
  const [stepIdx, setStepIdx] = useState(0)
  const [stage, setStage] = useState<WizardStage>('fields')
  const [values, setValues] = useState<Record<string, unknown>>(() => seedDefaults(template))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [run, setRun] = useState<ScaffoldRun | null>(null)
  const [registered, setRegistered] = useState<Entity | null>(null)

  const steps = template.steps
  const isLastStep = stepIdx === steps.length - 1

  const next = () => {
    const stepErrors = validateStep(steps[stepIdx].fields, values)
    setErrors(stepErrors)
    if (Object.keys(stepErrors).length > 0) return
    if (isLastStep) setStage('review')
    else setStepIdx((i) => i + 1)
  }
  const prev = () => {
    setErrors({})
    if (stage === 'review') setStage('fields')
    else if (stepIdx > 0) setStepIdx((i) => i - 1)
  }
  const launch = () => {
    setStage('run')
    runScaffoldReal(template, values, setRun, async (result) => {
      // The scaffolder created the real repo + GitOps app; also add a catalog
      // entry so it shows immediately (the live catalog will reconcile it too).
      const entity = entityFromTemplate(template, values)
      if (result?.repoUrl) {
        entity.metadata.annotations = {
          ...(entity.metadata.annotations ?? {}),
          'adhar.io/git-repo': result.repoUrl,
          ...(result.appName ? { 'argocd/app-name': result.appName } : {}),
        }
      }
      try {
        const saved = await register.mutateAsync(entity)
        setRegistered(saved)
      } catch {
        setRegistered(entity)
      }
      setStage('success')
    })
  }

  const reset = () => {
    setStepIdx(0)
    setStage('fields')
    setValues(seedDefaults(template))
    setErrors({})
    setRun(null)
    setRegistered(null)
  }

  return (
    <Modal
      open
      onClose={() => {
        if (stage === 'run') return
        onClose()
      }}
      title={
        <span className="inline-flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            Template
          </span>
          {template.title}
        </span>
      }
      description={
        <span className="font-mono text-[11px]">
          produces {template.produces.kind.toLowerCase()}:{String(template.produces.type)}
        </span>
      }
      width="xl"
      branded
      footer={
        <Footer
          stage={stage}
          stepIdx={stepIdx}
          totalSteps={steps.length}
          onPrev={prev}
          onNext={next}
          onLaunch={launch}
          onClose={onClose}
          onReset={reset}
          onComplete={onComplete}
          isLastStep={isLastStep}
          running={register.isPending}
          alreadyExists={Boolean(values.name) && catalog.some((e) => e.metadata.name === values.name && e.kind === template.produces.kind)}
        />
      }
    >
      <Stepper steps={steps} stage={stage} stepIdx={stepIdx} />
      <div className="mt-5">
        {stage === 'fields' && (
          <FieldStep
            step={steps[stepIdx]}
            values={values}
            onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
            errors={errors}
            groups={ownerGroups}
          />
        )}
        {stage === 'review' && <ReviewStep template={template} values={values} />}
        {stage === 'run' && run && <RunStep template={template} run={run} />}
        {stage === 'success' && registered && (
          <SuccessStep entity={registered} onOpenCatalog={onComplete} />
        )}
      </div>
    </Modal>
  )
}

function seedDefaults(template: CatalogTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const step of template.steps) {
    for (const f of step.fields) {
      if ('default' in f && f.default !== undefined) out[f.key] = f.default
    }
  }
  if (!out.owner) out.owner = `group:${template.owner}`
  return out
}

function validateStep(fields: TemplateField[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of fields) {
    const value = values[f.key]
    const required =
      ('required' in f && f.required) ||
      (f.kind === 'owner' && f.required)
    if (required && (value === undefined || value === null || value === '')) {
      errors[f.key] = 'Required.'
      continue
    }
    if (f.kind === 'string' && f.pattern && typeof value === 'string' && value && !f.pattern.regex.test(value)) {
      errors[f.key] = f.pattern.message
    }
  }
  return errors
}

/* ─────────── stepper ─────────── */

function Stepper({
  steps,
  stage,
  stepIdx,
}: {
  steps: CatalogTemplate['steps']
  stage: WizardStage
  stepIdx: number
}) {
  const lanes = [
    ...steps.map((s, i) => ({ id: s.key, title: s.title, complete: stage !== 'fields' || i < stepIdx, current: stage === 'fields' && i === stepIdx })),
    { id: '__review', title: 'Review', complete: stage === 'run' || stage === 'success', current: stage === 'review' },
    { id: '__run', title: 'Run', complete: stage === 'success', current: stage === 'run' },
  ]
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]">
      {lanes.map((l, i) => (
        <li key={l.id} className="inline-flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold',
              l.complete
                ? 'border-emerald-300 bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : l.current
                  ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300'
                  : 'border-edge-default bg-surface-raised text-content-subtle',
            )}
          >
            {l.complete ? <IconCheck /> : i + 1}
          </span>
          <span
            className={cn(
              'font-medium',
              l.current ? 'text-content' : l.complete ? 'text-content-muted' : 'text-content-subtle',
            )}
          >
            {l.title}
          </span>
          {i < lanes.length - 1 ? <span className="text-content-subtle">›</span> : null}
        </li>
      ))}
    </ol>
  )
}

/* ─────────── field step ─────────── */

function FieldStep({
  step,
  values,
  onChange,
  errors,
  groups,
}: {
  step: CatalogTemplate['steps'][number]
  values: Record<string, unknown>
  onChange(k: string, v: unknown): void
  errors: Record<string, string>
  groups: Entity[]
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold text-content">{step.title}</h3>
      <p className="text-sm text-content-muted">{step.description}</p>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {step.fields.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={values[f.key]}
            onChange={(v) => onChange(f.key, v)}
            error={errors[f.key]}
            groups={groups}
          />
        ))}
      </div>
    </div>
  )
}

function FieldRow({
  field,
  value,
  onChange,
  error,
  groups,
}: {
  field: TemplateField
  value: unknown
  onChange(v: unknown): void
  error?: string
  groups: Entity[]
}) {
  const id = `tpl-${field.key}`
  return (
    <div className={cn('flex flex-col gap-1', spanClass(field))}>
      <label htmlFor={id} className="text-xs font-semibold text-content">
        {field.label}
        {('required' in field && field.required) ? <span className="text-rose-600"> *</span> : null}
      </label>
      {renderInput(field, id, value, onChange, groups)}
      {error ? (
        <span className="text-[11px] text-rose-600">{error}</span>
      ) : 'help' in field && field.help ? (
        <span className="text-[11px] text-content-subtle">{field.help}</span>
      ) : null}
    </div>
  )
}

function spanClass(f: TemplateField): string {
  if (f.kind === 'string' && (f.key === 'description')) return 'md:col-span-2'
  if (f.kind === 'multiselect') return 'md:col-span-2'
  if (f.kind === 'owner') return 'md:col-span-2'
  return ''
}

function renderInput(
  field: TemplateField,
  id: string,
  value: unknown,
  onChange: (v: unknown) => void,
  groups: Entity[],
): React.ReactNode {
  switch (field.kind) {
    case 'string':
      return (
        <input
          id={id}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:outline-none"
        />
      )
    case 'select':
      return (
        <select
          id={id}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:outline-none"
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'multiselect': {
      const chosen = new Set((value as string[] | undefined) ?? [])
      return (
        <div className="flex flex-wrap gap-1.5 rounded-md border border-edge-default bg-surface-sunken p-2">
          {field.options.map((o) => {
            const active = chosen.has(o.value)
            return (
              <button
                type="button"
                key={o.value}
                onClick={() => {
                  const nextSet = new Set(chosen)
                  if (active) nextSet.delete(o.value)
                  else nextSet.add(o.value)
                  onChange(Array.from(nextSet))
                }}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium transition',
                  active
                    ? 'border-brand-300 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300'
                    : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
                )}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      )
    }
    case 'boolean':
      return (
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-content">Enabled</span>
        </label>
      )
    case 'owner':
      return (
        <select
          id={id}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:outline-none"
        >
          <option value="">— pick a group —</option>
          {groups.map((g) => (
            <option key={g.metadata.name} value={`group:${g.metadata.name}`}>
              {g.metadata.title ?? g.metadata.name} ({g.metadata.name})
            </option>
          ))}
        </select>
      )
  }
}

/* ─────────── review / run / success ─────────── */

function ReviewStep({
  template,
  values,
}: {
  template: CatalogTemplate
  values: Record<string, unknown>
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-content">Ready to scaffold</h3>
      <p className="text-sm text-content-muted">
        Review the values below — clicking <strong>Scaffold</strong> kicks off{' '}
        <code className="font-mono text-xs">{template.actions.length}</code> actions and
        registers the new entity in the catalog.
      </p>
      <Card>
        <CardHeader>
          <h4 className="text-sm font-semibold text-content">Values</h4>
        </CardHeader>
        <CardBody className="divide-y divide-edge-subtle text-sm">
          {Object.entries(values).map(([k, v]) => (
            <div key={k} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <span className="w-44 shrink-0 text-xs font-medium text-content-muted">{k}</span>
              <span className="min-w-0 flex-1 text-sm text-content">
                {Array.isArray(v) ? v.join(', ') || '—' : v === '' ? '—' : String(v)}
              </span>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <h4 className="text-sm font-semibold text-content">Actions</h4>
        </CardHeader>
        <CardBody>
          <ol className="space-y-2 text-sm">
            {template.actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-content-muted">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-content">
                  {i + 1}
                </span>
                <div>
                  <div className="text-content">{a.title}</div>
                  {a.detail ? <div className="text-[11px] text-content-subtle">{a.detail}</div> : null}
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </div>
  )
}

interface ScaffoldResult {
  ok: boolean
  repoUrl?: string
  appName?: string
  steps?: Array<{ name: string; ok: boolean; detail?: string }>
  error?: string
}

/**
 * Execute a REAL scaffold via the BFF (`POST /api/scaffold`): it creates a Gitea
 * repo (from the template's `scaffold.sourceRepo`), commits `catalog-info.yaml`,
 * and — for GitOps templates — creates an Argo CD Application. Progress in the
 * run log reflects the actual server step outcomes; nothing is simulated.
 */
function runScaffoldReal(
  template: CatalogTemplate,
  values: Record<string, unknown>,
  setRun: (r: ScaffoldRun | ((prev: ScaffoldRun | null) => ScaffoldRun)) => void,
  done: (result: ScaffoldResult | null) => void,
) {
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined)
  const body = {
    templateId: template.id,
    name: str('name'),
    title: str('title'),
    description: str('description'),
    owner: str('owner'),
    system: str('system'),
    domain: str('domain'),
    lifecycle: str('lifecycle') ?? 'experimental',
    type: template.produces.type,
    tags: template.tags,
    scaffold: template.scaffold,
    params: values,
  }

  setRun({ step: 0, done: false, progress: 0, log: ['▶ Scaffolding on the platform…'], startedAt: Date.now() })

  fetch('/api/scaffold', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
    .then(async (res) => {
      const data = (await res.json().catch(() => ({}))) as ScaffoldResult & { detail?: string }
      if (!res.ok || data.ok === false) {
        const steps = data.steps ?? []
        setRun((prev) =>
          prev
            ? {
                ...prev,
                done: true,
                progress: 1,
                log: [
                  ...prev.log,
                  ...steps.map((s) => `${s.ok ? '✔' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`),
                  `✗ Scaffold failed: ${data.error ?? data.detail ?? `HTTP ${res.status}`}`,
                ],
              }
            : prev,
        )
        done(null)
        return
      }
      const steps = data.steps ?? []
      setRun((prev) =>
        prev
          ? {
              ...prev,
              done: true,
              progress: 1,
              log: [
                ...prev.log,
                ...steps.map((s) => `${s.ok ? '✔' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`),
                `✔ Done — ${data.repoUrl ?? 'repository created'}`,
              ],
            }
          : prev,
      )
      done(data)
    })
    .catch((e) => {
      setRun((prev) =>
        prev
          ? { ...prev, done: true, progress: 1, log: [...prev.log, `✗ ${e instanceof Error ? e.message : 'network error'}`] }
          : prev,
      )
      done(null)
    })
}

function RunStep({ template, run }: { template: CatalogTemplate; run: ScaffoldRun }) {
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run.log])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-content">Scaffolding…</h3>
        <span className="font-mono text-xs text-content-muted">
          step {Math.min(run.step + 1, template.actions.length)} of {template.actions.length}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full bg-linear-to-r from-brand-400 to-brand-600 transition-[width]"
          style={{ width: `${Math.round(run.progress * 100)}%` }}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ol className="space-y-2 text-sm">
          {template.actions.map((a, i) => (
            <li key={i} className="flex items-start gap-2">
              {i < run.step ? (
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  <IconCheck />
                </span>
              ) : i === run.step ? (
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  <Spinner size={14} />
                </span>
              ) : (
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-content-subtle">
                  {i + 1}
                </span>
              )}
              <div>
                <div className={cn(i === run.step ? 'text-content' : 'text-content-muted')}>
                  {a.title}
                </div>
                {a.detail ? (
                  <div className="text-[11px] text-content-subtle">{a.detail}</div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        <pre
          ref={logRef}
          className="max-h-72 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100"
        >
          {run.log.join('\n')}
        </pre>
      </div>
    </div>
  )
}

function SuccessStep({
  entity,
  onOpenCatalog,
}: {
  entity: Entity
  onOpenCatalog(): void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4 rounded-xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/70 dark:bg-emerald-500/10 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
          <IconCheck />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-emerald-900">Scaffolded successfully</h3>
          <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-300">
            <code className="font-mono">{entity.kind.toLowerCase()}:{entity.metadata.name}</code> is
            registered in the catalog and the golden-path actions completed.
          </p>
        </div>
      </div>
      <Card>
        <CardHeader>
          <h4 className="text-sm font-semibold text-content">Next steps</h4>
        </CardHeader>
        <CardBody>
          <ul className="space-y-2 text-sm text-content-muted">
            <li className="flex items-start gap-2">
              <StatusBadge kind="info">1</StatusBadge>
              Clone the new repo and inspect the generated scaffold.
            </li>
            <li className="flex items-start gap-2">
              <StatusBadge kind="info">2</StatusBadge>
              Wire feature work and open a PR — CI will deploy to the development environment automatically.
            </li>
            <li className="flex items-start gap-2">
              <StatusBadge kind="info">3</StatusBadge>
              Promote to staging via the Deliver phase when the SLOs are met.
            </li>
          </ul>
        </CardBody>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onOpenCatalog}>Open in catalog</Button>
      </div>
    </div>
  )
}

/* ─────────── footer ─────────── */

function Footer({
  stage,
  stepIdx,
  totalSteps,
  onPrev,
  onNext,
  onLaunch,
  onClose,
  onReset,
  onComplete,
  isLastStep,
  running,
  alreadyExists,
}: {
  stage: WizardStage
  stepIdx: number
  totalSteps: number
  onPrev(): void
  onNext(): void
  onLaunch(): void
  onClose(): void
  onReset(): void
  onComplete(): void
  isLastStep: boolean
  running: boolean
  alreadyExists: boolean
}) {
  if (stage === 'success') {
    return (
      <div className="flex w-full items-center justify-between">
        <Button variant="secondary" onClick={onReset}>
          Scaffold another
        </Button>
        <Button onClick={onComplete}>Open catalog</Button>
      </div>
    )
  }
  if (stage === 'run') {
    return (
      <div className="flex w-full items-center justify-between text-[11px] text-content-muted">
        <span className="inline-flex items-center gap-2">
          <Spinner size={12} /> Running scaffold actions — this can't be cancelled in v1.
        </span>
        <Button variant="secondary" disabled>
          Working…
        </Button>
      </div>
    )
  }
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <div className="flex items-center gap-2">
        {stepIdx > 0 || stage === 'review' ? (
          <Button variant="secondary" onClick={onPrev}>
            Back
          </Button>
        ) : null}
        {stage === 'review' ? (
          <>
            {alreadyExists ? (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">An entity with this name already exists — it will be overwritten.</span>
            ) : null}
            <Button onClick={onLaunch} disabled={running}>
              {running ? 'Working…' : 'Scaffold'}
            </Button>
          </>
        ) : (
          <Button onClick={onNext}>
            {isLastStep ? 'Review' : 'Next'} ({stepIdx + 1}/{totalSteps})
          </Button>
        )}
      </div>
    </div>
  )
}

/* ─────────── icons ─────────── */

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconFilter() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

function IconStar() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

function IconUsers() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function IconForm() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </svg>
  )
}

function IconPlay() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="6 3 21 12 6 21 6 3" />
    </svg>
  )
}

function IconWand() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 4V2" />
      <path d="M15 16v-2" />
      <path d="M8 9h2" />
      <path d="M20 9h2" />
      <path d="m17.8 11.8 1.2 1.2" />
      <path d="m17.8 6.2 1.2-1.2" />
      <path d="m3 21 9-9" />
      <path d="m12.2 6.2-1.2-1.2" />
    </svg>
  )
}

function IconUpload() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

/* ─────────── register template modal ─────────── */

const FAMILY_OPTIONS: { value: TemplateFamily; label: string }[] = [
  { value: 'service', label: 'Service' },
  { value: 'website', label: 'Website / Frontend' },
  { value: 'library', label: 'Library' },
  { value: 'api', label: 'API' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'data', label: 'Data / ML' },
  { value: 'docs', label: 'Documentation' },
  { value: 'infra', label: 'Infrastructure' },
]

const LANGUAGE_OPTIONS: TemplateLanguage[] = [
  'go',
  'java',
  'kotlin',
  'typescript',
  'javascript',
  'python',
  'rust',
  'scala',
  'swift',
  'shell',
  'hcl',
  'helm',
  'mixed',
]

type RegisterMode = 'url' | 'manual'

/**
 * "Register a template" — Backstage-style import flow.
 *
 *   Mode 1 · From URL
 *     The flagship Backstage path: paste a URL pointing to a `template.yaml`
 *     in any repo, hit Import, the form below is pre-filled from the parsed
 *     content. (For now we simulate parse — a real impl would fetch + parse
 *     the YAML with `js-yaml` against the `scaffolder.backstage.io/v1beta3`
 *     schema. The simulation extracts the repo slug as title.)
 *
 *   Mode 2 · From scratch
 *     Quick form — title, description, family, language, owner, glyph.
 *     Backstage's `template.yaml` requires a lot of detail; this skips
 *     straight to a working template using sensible defaults.
 *
 * Either path produces a `CatalogTemplate` via `buildCustomTemplate()` and
 * persists it via `registerTemplate()`.
 */
function RegisterTemplateModal({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean
  onClose(): void
  onRegistered(t: CatalogTemplate): void
}) {
  const [mode, setMode] = useState<RegisterMode>('url')
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [family, setFamily] = useState<TemplateFamily>('service')
  const [language, setLanguage] = useState<TemplateLanguage>('typescript')
  const [owner, setOwner] = useState('team-platform')
  const [glyph, setGlyph] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  // Reset on open + autofocus the URL field for the fastest path.
  useEffect(() => {
    if (!open) return
    setMode('url')
    setUrl('')
    setImporting(false)
    setTitle('')
    setDescription('')
    setFamily('service')
    setLanguage('typescript')
    setOwner('team-platform')
    setGlyph('')
    setTags('')
    setError(null)
    requestAnimationFrame(() => firstFieldRef.current?.focus())
  }, [open])

  function importFromUrl() {
    if (!url.trim()) return
    setError(null)
    setImporting(true)
    // Simulate fetching + parsing the YAML. In production this is a BFF
    // round-trip (the browser can't fetch the raw URL cross-origin without
    // a proxy). We extract the repo slug as a friendly title and pre-fill
    // sensible defaults — the user can still edit before saving.
    setTimeout(() => {
      try {
        const u = new URL(url.trim())
        const segments = u.pathname.split('/').filter(Boolean)
        const slug = segments
          .filter((s) => s !== 'blob' && s !== 'main' && s !== 'master' && !s.endsWith('.yaml'))
          .pop() || ''
        const friendly = slug
          .replace(/-template$|-templates$/, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Imported template'
        setTitle((current) => current || friendly)
        setDescription(
          (current) =>
            current ||
            `Imported from ${u.hostname}${u.pathname.replace(/\/[^/]*$/, '')}.`,
        )
        if (slug.toLowerCase().includes('java')) setLanguage('java')
        else if (slug.toLowerCase().includes('go')) setLanguage('go')
        else if (slug.toLowerCase().includes('python')) setLanguage('python')
        if (slug.toLowerCase().includes('api')) setFamily('api')
        else if (slug.toLowerCase().includes('lib')) setFamily('library')
        else if (slug.toLowerCase().includes('infra') || slug.toLowerCase().includes('terra'))
          setFamily('infra')
        setMode('manual')
      } catch {
        setError('Couldn’t parse that URL — paste a full URL pointing to a template.yaml file.')
      } finally {
        setImporting(false)
      }
    }, 600)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    if (!description.trim()) {
      setError('A short description helps your team find this template later.')
      return
    }
    const built = buildCustomTemplate({
      title,
      description,
      family,
      language,
      owner,
      glyph,
      tags: tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      sourceUrl: url.trim() || undefined,
    })
    registerTemplate(built)
    onRegistered(built)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      branded
      title="Register a template"
      description="Bring your team’s scaffolding into the catalog. Import from a Git URL Backstage-style or build one from a few fields — both produce a real, runnable template."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form="register-template-form"
          >
            Register template
          </Button>
        </>
      }
    >
      <form id="register-template-form" onSubmit={submit} className="space-y-5">
        {/* Mode tabs. */}
        <div
          role="tablist"
          aria-label="Registration mode"
          className="inline-flex rounded-full border border-edge-default bg-surface-sunken/60 p-0.5 text-[12px] font-medium"
        >
          <ModeTab
            active={mode === 'url'}
            onClick={() => setMode('url')}
            label="From URL"
            sub="Backstage-style"
          />
          <ModeTab
            active={mode === 'manual'}
            onClick={() => setMode('manual')}
            label="From scratch"
            sub="Quick form"
          />
        </div>

        {mode === 'url' ? (
          <div className="rounded-xl border border-edge-default bg-surface-sunken/40 p-4">
            <FormField
              label="template.yaml URL"
              required
              hint="Backstage scaffolder.backstage.io/v1beta3 — paste a Git URL pointing at the file."
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  ref={firstFieldRef}
                  type="url"
                  placeholder="https://gitea.acme.io/team/templates/blob/main/template.yaml"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={importFromUrl}
                  loading={importing}
                  disabled={!url.trim()}
                >
                  Import
                </Button>
              </div>
            </FormField>
            <p className="mt-3 text-[11px] text-content-muted">
              We’ll fetch the file, parse the metadata, and pre-fill the fields below — you can
              still edit anything before registering.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Title" required>
            <Input
              ref={mode === 'manual' ? firstFieldRef : undefined}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Java Spring Boot service"
              required
            />
          </FormField>

          <FormField label="Owner">
            <Input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="team-platform"
            />
          </FormField>

          <FormField label="Family">
            <Select
              value={family}
              onChange={(e) => setFamily(e.target.value as TemplateFamily)}
            >
              {FAMILY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Primary language">
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value as TemplateLanguage)}
            >
              {LANGUAGE_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABEL[l]}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Glyph" hint="A short mark — 1–3 characters.">
            <Input
              value={glyph}
              onChange={(e) => setGlyph(e.target.value.slice(0, 3))}
              placeholder="JV"
              maxLength={3}
            />
          </FormField>

          <FormField label="Tags" hint="Comma-separated.">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="java, spring, recommended"
            />
          </FormField>
        </div>

        <FormField label="Description" required hint="One or two sentences — what does this template scaffold?">
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A production-ready Spring Boot service with health endpoints, OTel tracing, and a GitHub Actions CI baseline."
          />
        </FormField>

        {error ? (
          <div className="rounded-md border border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-[12px] font-medium text-rose-700 dark:text-rose-300">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  )
}

function ModeTab({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean
  onClick(): void
  label: string
  sub: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-full px-3 transition-all',
        active
          ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default'
          : 'text-content-muted hover:text-content',
      )}
    >
      <span>{label}</span>
      <span className="text-[10px] text-content-subtle">{sub}</span>
    </button>
  )
}
