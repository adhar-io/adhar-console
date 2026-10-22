import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../components/ui-bits.tsx'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  DrawerWidenButton,
  EmptyState,
  Modal,
  SearchInput,
  Select,
  useDrawerWidth,
  useOverlayDismiss,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  KIND,
  type Listed,
  useCollection,
  useCreate,
  useRemove,
  useRestoreDocs,
  useUpdate,
} from '../data/store.ts'
import { PERSONA_TEMPLATES } from '../data/persona-templates.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Journey, Persona } from '../data/types.ts'
import { useDesignParams, useGoDesign, useSetDesignParams } from '../data/nav.ts'
import { type DesignScope, useDesignScope } from '../data/design-scope.ts'
import { PersonaAiModal, PersonaEvidence, PersonaWorkItems, ProjectTagSelect } from '../components/ux-integrations.tsx'
import { AskAiButton } from '../components/integrations.tsx'
import { SharedChip } from '../components/scope-picker.tsx'
import {
  personaCompleteness,
  personaMatches,
  personasToMarkdown,
  personaToMarkdown,
  shortPersonaName,
} from '../data/ux-lib.ts'
import {
  AVATAR_COLORS,
  AVATAR_SWATCH,
  avatarColor,
  Chip,
  copyText,
  downloadText,
  fileSlug,
  IconArrowRight,
  IconColumns,
  IconCopy,
  IconDownload,
  IconDuplicate,
  IconGridView,
  IconPlus,
  IconTrash,
  IconX,
  InlineText,
  ListEditor,
  PersonaAvatar,
  Segmented,
  useDraft,
} from '../components/ux-kit.tsx'

const EMOJI_OPTIONS = ['', '👩🏽‍💻', '🧑🏽‍💼', '🎨', '👨🏿‍🔬', '🧑🏼‍🎤', '👩🏻‍🚀', '🧑🏽‍🚒', '👨🏽‍🏫', '🦊', '🐙', '🧑🏾‍🔧']

type Sort = 'name' | 'updated' | 'complete'
const MAX_COMPARE = 4

/**
 * Personas — the team's shared, living profiles of who they build for.
 *
 * Every persona is a document in the tenant document store (kind
 * `design.persona`). Profiles are edited in place in the detail drawer and
 * autosave; new ones start from a template. The open persona and the compare
 * set live in the URL (`?persona=…`, `?compare=a,b`) so either can be shared.
 */
export function Personas() {
  const scope = useDesignScope()
  const all = useCollection<Persona>(KIND.persona)
  const { isLoading, error, refetch } = all
  // Personas in the active Org → Team → Project scope (workspace-wide ones always).
  const items = useMemo(() => all.items.filter((p) => scope.matches(p)), [all.items, scope])
  const hidden = all.items.length - items.length
  const { items: journeys } = useCollection<Journey>(KIND.journey)
  const create = useCreate<Persona>(KIND.persona)
  const remove = useRemove(KIND.persona)
  const restore = useRestoreDocs<Persona>(KIND.persona)
  const toast = useToast()
  const params = useDesignParams()
  const setParams = useSetDesignParams()

  const [q, setQ] = useState(params.q ?? '')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('name')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  const compareIds = useMemo(() => (params.compare ? params.compare.split(',').filter(Boolean) : []), [params.compare])
  const view: 'grid' | 'compare' = params.tab === 'compare' ? 'compare' : 'grid'

  useEffect(() => {
    if (params.new === '1') {
      setTemplatesOpen(true)
      setParams({ new: undefined })
    }
  }, [params.new, setParams])

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of items) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  }, [items])

  const journeyCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const j of journeys) m.set(j.persona, (m.get(j.persona) ?? 0) + 1)
    return m
  }, [journeys])

  const visible = useMemo(() => {
    const list = items.filter((p) => personaMatches(p, q) && (!tag || (p.tags ?? []).includes(tag)))
    return list.sort((a, b) => {
      if (sort === 'updated') return (b._updatedAt ?? '').localeCompare(a._updatedAt ?? '')
      if (sort === 'complete') return personaCompleteness(b) - personaCompleteness(a)
      return a.name.localeCompare(b.name)
    })
  }, [items, q, tag, sort])

  // A deep link may name a persona outside the scope — still open it.
  const open = all.items.find((p) => p.id === params.persona) ?? null

  const toggleCompare = (id: string) => {
    const has = compareIds.includes(id)
    if (!has && compareIds.length >= MAX_COMPARE) {
      toast.info(`Compare up to ${MAX_COMPARE} personas at a time`)
      return
    }
    const next = has ? compareIds.filter((x) => x !== id) : [...compareIds, id]
    setParams({ compare: next.join(',') || undefined })
  }

  const createFrom = async (base: Omit<Persona, 'id'>) => {
    setTemplatesOpen(false)
    try {
      // New personas belong to the active project / team.
      const created = await create.mutateAsync({ id: '', ...scope.tag(), ...base } as Persona)
      setAiOpen(false)
      setParams({ persona: created.id })
      toast.success('Persona created', { description: 'Fill in the profile — changes save automatically.' })
    } catch (e) {
      toast.error('Could not create persona', { description: (e as Error).message })
    }
  }

  const duplicate = async (p: Persona) => {
    const { id: _id, planeLinks: _links, ...rest } = stripMeta(p)
    await createFrom({ ...rest, name: `${p.name} (copy)` })
  }

  const del = async (p: Listed<Persona>) => {
    try {
      await remove.mutateAsync(p.id)
      if (params.persona === p.id) setParams({ persona: undefined })
      if (compareIds.includes(p.id)) setParams({ compare: compareIds.filter((x) => x !== p.id).join(',') || undefined })
      toast.success(`Deleted “${shortPersonaName(p.name)}”`, {
        action: {
          label: 'Undo',
          onClick: () =>
            restore.mutate([stripMeta(p)], {
              onSuccess: () => toast.success('Persona restored'),
              onError: (e) => toast.error('Could not restore', { description: e.message }),
            }),
        },
      })
    } catch (e) {
      toast.error('Could not delete persona', { description: (e as Error).message })
    }
  }

  const exportAll = () => {
    const list = visible.length ? visible : items
    downloadText('personas.md', personasToMarkdown(list, journeys), 'text/markdown')
    toast.success(`Exported ${list.length} persona${list.length === 1 ? '' : 's'}`)
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading personas…" />

  const compared = compareIds.map((id) => items.find((p) => p.id === id)).filter(Boolean) as Listed<Persona>[]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search personas, goals, pains…" className="h-8 w-full sm:w-72" />
        <Select
          aria-label="Sort personas"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="h-8 py-1 text-xs"
          options={[
            { value: 'name', label: 'Sort: Name' },
            { value: 'updated', label: 'Sort: Recently edited' },
            { value: 'complete', label: 'Sort: Most complete' },
          ]}
        />
        <Segmented<'grid' | 'compare'>
          ariaLabel="View"
          value={view}
          onChange={(v) => setParams({ tab: v === 'compare' ? 'compare' : undefined })}
          options={[
            { value: 'grid', label: <><IconGridView size={12} /> Cards</> },
            {
              value: 'compare',
              label: (
                <>
                  <IconColumns size={12} /> Compare{compareIds.length ? ` (${compareIds.length})` : ''}
                </>
              ),
            },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          {items.length ? (
            <Button size="sm" variant="ghost" onClick={exportAll} leading={<IconDownload size={12} />}>
              Export
            </Button>
          ) : null}
          <AskAiButton onClick={() => setAiOpen(true)}>Draft with AI</AskAiButton>
          <Button size="sm" variant="primary" onClick={() => setTemplatesOpen(true)} leading={<IconPlus size={12} />}>
            New persona
          </Button>
        </div>
      </div>
      {hidden > 0 ? (
        <p className="text-[11px] text-content-subtle">
          Showing {items.length} of {all.items.length} personas — {scope.label}.{' '}
          {scope.project ? (
            <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => scope.setProject(undefined)}>
              Show all projects
            </button>
          ) : null}
        </p>
      ) : null}

      {tags.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-content-subtle">Segments</span>
          <Chip active={!tag} onClick={() => setTag(null)}>All</Chip>
          {tags.map((t) => (
            <Chip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </Chip>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={<Icon name="persona" size={22} />}
          title={all.items.length ? `No personas in ${scope.label}` : 'No personas yet'}
          description="Personas keep the whole team designing for real people. Create one blank, from a template, or drafted by Adhar AI from your research."
          action={
            <Button size="sm" variant="primary" onClick={() => setTemplatesOpen(true)} leading={<IconPlus size={12} />}>
              New persona
            </Button>
          }
        />
      ) : view === 'compare' ? (
        <CompareView
          personas={compared}
          all={items}
          journeyCount={journeyCount}
          onToggle={toggleCompare}
          onOpen={(id) => setParams({ persona: id })}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          compact
          title="No personas match"
          description="Try a different search or segment."
          action={
            <Button size="sm" onClick={() => { setQ(''); setTag(null) }}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => (
            <PersonaCard
              key={p.id}
              p={p}
              shared={!!scope.project && !p.project}
              journeys={journeyCount.get(p.id) ?? 0}
              comparing={compareIds.includes(p.id)}
              onToggleCompare={() => toggleCompare(p.id)}
              onOpen={() => setParams({ persona: p.id })}
            />
          ))}
        </div>
      )}

      <TemplatePicker open={templatesOpen} onClose={() => setTemplatesOpen(false)} onPick={createFrom} busy={create.isPending} />
      <PersonaAiModal open={aiOpen} onClose={() => setAiOpen(false)} onCreate={createFrom} busy={create.isPending} />

      {open ? (
        <PersonaDrawer
          key={open.id}
          persona={open}
          journeys={journeys}
          scope={scope}
          onClose={() => setParams({ persona: undefined })}
          onDuplicate={() => duplicate(open)}
          onDelete={() => del(open)}
        />
      ) : null}
    </div>
  )
}

function stripMeta<T extends object>(p: T): T {
  const { _createdAt: _a, _updatedAt: _b, _updatedBy: _c, ...rest } = p as T & {
    _createdAt?: string
    _updatedAt?: string
    _updatedBy?: string | null
  }
  return rest as T
}

/* ───────────────────────────── card ───────────────────────────── */

function PersonaCard({
  p,
  journeys,
  comparing,
  onToggleCompare,
  onOpen,
  shared,
}: {
  p: Listed<Persona>
  shared?: boolean
  journeys: number
  comparing: boolean
  onToggleCompare(): void
  onOpen(): void
}) {
  const complete = personaCompleteness(p)
  return (
    <Card interactive className={cn('group relative flex flex-col', comparing && 'ring-2 ring-brand-400/60')}>
      <label
        className={cn(
          'absolute right-3 top-3 z-10 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-content-muted transition-opacity hover:bg-surface-sunken',
          comparing ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        <input type="checkbox" checked={comparing} onChange={onToggleCompare} className="h-3.5 w-3.5 accent-brand-600" />
        Compare
      </label>
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col p-5 text-left">
        <div className="flex items-start gap-3 pr-16">
          <PersonaAvatar name={p.name} avatar={p.avatar} color={p.color} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-content">{p.name}</span>
              {shared ? <SharedChip /> : null}
            </div>
            <div className="mt-0.5 truncate text-xs text-content-muted">
              {p.role}
              {p.location ? ` · ${p.location}` : ''}
            </div>
          </div>
        </div>
        {p.quote ? (
          <p className="mt-3 line-clamp-2 border-l-2 border-edge-strong pl-3 text-xs italic leading-relaxed text-content-muted">
            “{p.quote}”
          </p>
        ) : p.bio ? (
          <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-content-muted">{p.bio}</p>
        ) : null}
        {p.tags?.length ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {p.tags.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}
          </div>
        ) : null}
        <div className="mt-auto pt-4">
          <dl className="grid grid-cols-4 gap-2 text-center">
            <Stat label="Jobs" value={p.jobs?.length ?? 0} />
            <Stat label="Goals" value={p.goals.length} />
            <Stat label="Pains" value={p.frustrations.length} />
            <Stat label="Journeys" value={journeys} />
          </dl>
          {p.planeLinks?.length || p.evidence?.cohortName ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-content-subtle">
              {p.planeLinks?.length ? <span>{p.planeLinks.filter((l) => !l.parent).length} work items in Plane</span> : null}
              {p.evidence?.cohortName ? <span className="truncate">Cohort · {p.evidence.cohortName}</span> : null}
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-2" title={`Profile ${Math.round(complete * 100)}% complete`}>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${complete * 100}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-content-subtle">{Math.round(complete * 100)}%</span>
          </div>
        </div>
      </button>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-sunken/60 py-1.5">
      <dd className="text-sm font-semibold tabular-nums text-content">{value}</dd>
      <dt className="text-[10px] text-content-subtle">{label}</dt>
    </div>
  )
}

/* ───────────────────────────── templates ───────────────────────────── */

function TemplatePicker({
  open,
  onClose,
  onPick,
  busy,
}: {
  open: boolean
  onClose(): void
  onPick(p: Omit<Persona, 'id'>): void
  busy: boolean
}) {
  const blank: Omit<Persona, 'id'> = {
    name: 'New persona',
    avatar: '',
    role: 'Role',
    bio: '',
    goals: [],
    frustrations: [],
    behaviors: [],
    needs: [],
    tech: [],
    jobs: [],
    tags: [],
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New persona"
      description="Start blank or from a template — everything is editable afterwards."
      width="lg"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <TemplateTile
          title="Blank persona"
          description="An empty profile."
          avatar={<PersonaAvatar name="New persona" color="slate" size={36} />}
          onClick={() => onPick(blank)}
          disabled={busy}
        />
        {PERSONA_TEMPLATES.map((t) => (
          <TemplateTile
            key={t.id}
            title={t.label}
            description={t.description}
            avatar={<PersonaAvatar name={t.label} color={t.persona.color} size={36} />}
            onClick={() => onPick(t.persona)}
            disabled={busy}
          />
        ))}
      </div>
    </Modal>
  )
}

function TemplateTile({
  title,
  description,
  avatar,
  onClick,
  disabled,
}: {
  title: string
  description: string
  avatar: ReactNode
  onClick(): void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-start gap-3 rounded-lg border border-edge-default bg-surface-raised p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-50/40 disabled:opacity-60 dark:hover:bg-brand-500/10"
    >
      {avatar}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-content">{title}</span>
        <span className="mt-0.5 block text-xs text-content-muted">{description}</span>
      </span>
    </button>
  )
}

/* ───────────────────────────── drawer ───────────────────────────── */

function PersonaDrawer({
  persona,
  journeys,
  scope,
  onClose,
  onDuplicate,
  onDelete,
}: {
  persona: Listed<Persona>
  journeys: Journey[]
  scope: DesignScope
  onClose(): void
  onDuplicate(): void
  onDelete(): void
}) {
  const update = useUpdate<Persona>(KIND.persona)
  const toast = useToast()
  const go = useGoDesign()
  const width = useDrawerWidth('design.persona', { base: 'max-w-3xl' })
  useOverlayDismiss(true, onClose)

  const { draft, update: edit, flush } = useDraft<Persona>(persona, (next) =>
    update.mutateAsync(next).catch((e: Error) => toast.error('Could not save persona', { description: e.message })))
  const [avatarOpen, setAvatarOpen] = useState(false)

  if (!draft || typeof document === 'undefined') return null
  const p = draft
  const set = (patch: Partial<Persona>) => edit((d) => ({ ...d, ...patch }))
  const linked = journeys.filter((j) => j.persona === p.id)

  const close = () => {
    flush()
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={p.name}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={close} />
      <aside className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl', width.className)}>
        <header className="flex items-start gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="relative">
            <button
              type="button"
              onClick={() => setAvatarOpen((o) => !o)}
              className="rounded-full focus-visible:ring-2 focus-visible:ring-brand-500/40"
              aria-label="Change avatar"
              title="Change avatar"
            >
              <PersonaAvatar name={p.name} avatar={p.avatar} color={p.color} size={56} />
            </button>
            {avatarOpen ? (
              <AvatarPicker
                persona={p}
                onChange={(patch) => set(patch)}
                onClose={() => setAvatarOpen(false)}
              />
            ) : null}
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <InlineText
              value={p.name}
              onCommit={(v) => set({ name: v.trim() || p.name })}
              ariaLabel="Name"
              className="text-lg font-semibold tracking-tight"
            />
            <div className="flex flex-wrap gap-1 sm:flex-nowrap">
              <InlineText value={p.role} onCommit={(v) => set({ role: v })} placeholder="Role" className="text-sm text-content-muted" />
              <InlineText
                value={p.location ?? ''}
                onCommit={(v) => set({ location: v || undefined })}
                placeholder="Location / context"
                className="text-sm text-content-muted"
              />
            </div>
            <div className="px-1.5 text-[11px] text-content-subtle">
              {persona._updatedAt ? `Edited ${formatRelative(persona._updatedAt)}${persona._updatedBy ? ` by ${persona._updatedBy}` : ''}` : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconBtn
              label="Export as Markdown"
              onClick={() => {
                downloadText(`${fileSlug(p.name)}.md`, personaToMarkdown(p, journeys), 'text/markdown')
                toast.success('Persona exported')
              }}
            >
              <IconDownload />
            </IconBtn>
            <IconBtn
              label="Copy as Markdown"
              onClick={() =>
                copyText(personaToMarkdown(p, journeys)).then(
                  () => toast.success('Markdown copied'),
                  () => toast.error('Could not copy'),
                )}
            >
              <IconCopy />
            </IconBtn>
            <IconBtn label="Duplicate" onClick={() => { flush(); onDuplicate() }}>
              <IconDuplicate />
            </IconBtn>
            <IconBtn label="Delete" onClick={onDelete} danger>
              <IconTrash />
            </IconBtn>
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <IconBtn label="Close" onClick={close}>
              <IconX />
            </IconBtn>
          </div>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section className="rounded-xl border border-edge-default bg-surface-raised p-4">
            <Label>Quote</Label>
            <div className="mt-1 flex gap-2">
              <span className="font-serif text-2xl leading-none text-content-subtle">“</span>
              <InlineText
                multiline
                value={p.quote ?? ''}
                onCommit={(v) => set({ quote: v.trim() || undefined })}
                placeholder="Something this person would actually say…"
                className="text-base italic"
              />
            </div>
            <Label className="mt-4">Bio</Label>
            <InlineText
              multiline
              value={p.bio}
              onCommit={(v) => set({ bio: v })}
              placeholder="Background, context, responsibilities…"
              className="mt-1 text-sm"
            />
            <Label className="mt-4">Segments</Label>
            <TagEditor tags={p.tags ?? []} onChange={(tags) => set({ tags })} placeholder="Add segment" />
          </section>

          <section>
            <Label>Jobs to be done</Label>
            <p className="mb-1.5 text-[11px] text-content-subtle">“When …, I want to …, so I can …”</p>
            <ListEditor items={p.jobs ?? []} onChange={(jobs) => set({ jobs })} placeholder="Add a job…" dotClass="bg-brand-500" />
          </section>

          <div className="grid grid-cols-1 gap-5 rounded-xl border border-edge-default bg-surface-raised p-4 lg:grid-cols-2">
            <PersonaWorkItems persona={p} scope={scope} onLinks={(planeLinks) => set({ planeLinks })} />
            <div className="space-y-5">
              <PersonaEvidence persona={p} onChange={(evidence) => set({ evidence })} />
              <section className="space-y-2">
                <Label>Project</Label>
                <ProjectTagSelect scope={scope} value={p.project} onChange={(project) => set({ project })} />
              </section>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
            <section>
              <Label>Goals</Label>
              <ListEditor items={p.goals} onChange={(goals) => set({ goals })} placeholder="Add a goal…" dotClass="bg-emerald-500" />
            </section>
            <section>
              <Label>Frustrations</Label>
              <ListEditor items={p.frustrations} onChange={(frustrations) => set({ frustrations })} placeholder="Add a frustration…" dotClass="bg-rose-500" />
            </section>
            <section>
              <Label>Behaviours</Label>
              <ListEditor items={p.behaviors} onChange={(behaviors) => set({ behaviors })} placeholder="Add a behaviour…" dotClass="bg-sky-500" />
            </section>
            <section>
              <Label>Needs</Label>
              <ListEditor items={p.needs} onChange={(needs) => set({ needs })} placeholder="Add a need…" dotClass="bg-violet-500" />
            </section>
          </div>

          <section>
            <Label>Tools &amp; tech</Label>
            <TagEditor tags={p.tech} onChange={(tech) => set({ tech })} placeholder="Add a tool" />
          </section>

          <section>
            <Label>Empathy map</Label>
            <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-edge-default bg-edge-default">
              <Quadrant label="Says" items={p.quote ? [p.quote] : []} />
              <Quadrant label="Thinks" items={p.goals} />
              <Quadrant label="Does" items={p.behaviors} />
              <Quadrant label="Feels" items={p.frustrations} />
            </div>
            <p className="mt-1.5 text-[11px] text-content-subtle">Derived from the quote, goals, behaviours and frustrations above.</p>
          </section>

          <section>
            <div className="flex items-center justify-between">
              <Label>Journey maps</Label>
              <Button
                size="xs"
                variant="ghost"
                leading={<IconPlus size={11} />}
                onClick={() => {
                  flush()
                  go('journeys', { new: '1', persona: p.id })
                }}
              >
                New journey
              </Button>
            </div>
            {linked.length ? (
              <ul className="mt-2 divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                {linked.map((j) => (
                  <li key={j.id}>
                    <button
                      type="button"
                      onClick={() => {
                        flush()
                        go('journeys', { journey: j.id })
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 flex-1 truncate text-content">{j.name}</span>
                      <span className="text-[11px] text-content-subtle">{j.stages.length} stages</span>
                      <IconArrowRight size={12} className="text-content-subtle" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
                No journey maps for this persona yet. Map how they move through the product to find the pain points worth fixing.
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function AvatarPicker({
  persona,
  onChange,
  onClose,
}: {
  persona: Persona
  onChange(patch: Partial<Persona>): void
  onClose(): void
}) {
  return (
    <div className="absolute left-0 top-full z-20 mt-2 w-64 rounded-xl border border-edge-default bg-surface-raised p-3 shadow-xl">
      <Label>Colour</Label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {AVATAR_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => onChange({ color: c })}
            className={cn(
              'h-6 w-6 rounded-full ring-offset-2 ring-offset-surface-raised',
              AVATAR_SWATCH[c],
              avatarColor(persona.color, persona.name) === c && 'ring-2 ring-content',
            )}
          />
        ))}
      </div>
      <Label className="mt-3">Avatar</Label>
      <div className="mt-1.5 grid grid-cols-6 gap-1">
        {EMOJI_OPTIONS.map((e) => (
          <button
            key={e || 'initials'}
            type="button"
            onClick={() => onChange({ avatar: e })}
            title={e ? undefined : 'Initials'}
            className={cn(
              'flex h-8 items-center justify-center rounded-md border text-base',
              (persona.avatar ?? '') === e ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/15' : 'border-edge-default hover:border-edge-strong',
            )}
          >
            {e || <span className="text-[10px] font-semibold text-content-muted">Aa</span>}
          </button>
        ))}
      </div>
      <div className="mt-3 text-right">
        <Button size="xs" onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}

function TagEditor({ tags, onChange, placeholder }: { tags: string[]; onChange(t: string[]): void; placeholder: string }) {
  const [v, setV] = useState('')
  const add = () => {
    const parts = v.split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !tags.includes(x))
    if (parts.length) onChange([...tags, ...parts])
    setV('')
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <Chip key={t} onRemove={() => onChange(tags.filter((x) => x !== t))}>
          {t}
        </Chip>
      ))}
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
          if (e.key === 'Backspace' && !v && tags.length) onChange(tags.slice(0, -1))
        }}
        onBlur={add}
        placeholder={`${placeholder}…`}
        aria-label={placeholder}
        className="min-w-[8rem] flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-content outline-none placeholder:text-content-subtle hover:border-edge-default focus:border-brand-400"
      />
    </div>
  )
}

function Quadrant({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="bg-surface-raised p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{label}</div>
      {items.length ? (
        <ul className="mt-1 space-y-1 text-xs leading-relaxed text-content">
          {items.slice(0, 4).map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      ) : (
        <div className="mt-1 text-xs text-content-subtle">—</div>
      )}
    </div>
  )
}

function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-[11px] font-semibold uppercase tracking-wide text-content-subtle', className)}>{children}</div>
}

function IconBtn({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick(): void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken',
        danger ? 'hover:text-rose-600' : 'hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ───────────────────────────── compare ───────────────────────────── */

function CompareView({
  personas,
  all,
  journeyCount,
  onToggle,
  onOpen,
}: {
  personas: Listed<Persona>[]
  all: Listed<Persona>[]
  journeyCount: Map<string, number>
  onToggle(id: string): void
  onOpen(id: string): void
}) {
  const available = all.filter((p) => !personas.some((x) => x.id === p.id))
  const rows: Array<{ label: string; render(p: Persona): ReactNode }> = [
    { label: 'Role', render: (p) => p.role },
    { label: 'Context', render: (p) => p.location || '—' },
    { label: 'Quote', render: (p) => (p.quote ? <span className="italic">“{p.quote}”</span> : '—') },
    { label: 'Jobs to be done', render: (p) => <Bullets items={p.jobs ?? []} /> },
    { label: 'Goals', render: (p) => <Bullets items={p.goals} /> },
    { label: 'Frustrations', render: (p) => <Bullets items={p.frustrations} /> },
    { label: 'Behaviours', render: (p) => <Bullets items={p.behaviors} /> },
    { label: 'Needs', render: (p) => <Bullets items={p.needs} /> },
    { label: 'Tools', render: (p) => (p.tech.length ? p.tech.join(', ') : '—') },
    { label: 'Journey maps', render: (p) => journeyCount.get(p.id) ?? 0 },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-content-subtle">Add to comparison</span>
        {available.length === 0 ? <span className="text-[11px] text-content-subtle">— all personas added</span> : null}
        {available.map((p) => (
          <Chip key={p.id} onClick={() => onToggle(p.id)}>
            <IconPlus size={10} /> {shortPersonaName(p.name)}
          </Chip>
        ))}
      </div>
      {personas.length < 2 ? (
        <EmptyState
          compact
          title={personas.length ? 'Add one more persona' : 'Pick personas to compare'}
          description="Tick “Compare” on persona cards, or add them above. Up to four side by side."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full min-w-[640px] table-fixed text-sm">
            <colgroup>
              <col className="w-36" />
              {personas.map((p) => <col key={p.id} />)}
            </colgroup>
            <thead>
              <tr className="border-b border-edge-default">
                <th className="sticky left-0 bg-surface-raised" />
                {personas.map((p) => (
                  <th key={p.id} className="px-4 py-3 text-left align-top font-normal">
                    <div className="flex items-start gap-2">
                      <button type="button" onClick={() => onOpen(p.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        <PersonaAvatar name={p.name} avatar={p.avatar} color={p.color} size={32} />
                        <span className="min-w-0 truncate text-sm font-semibold text-content hover:underline">{shortPersonaName(p.name)}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${p.name} from comparison`}
                        onClick={() => onToggle(p.id)}
                        className="rounded p-1 text-content-subtle hover:bg-surface-sunken hover:text-content"
                      >
                        <IconX size={12} />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {rows.map((r) => (
                <tr key={r.label}>
                  <th className="sticky left-0 bg-surface-raised px-4 py-3 text-left align-top text-[11px] font-semibold uppercase tracking-wide text-content-subtle">
                    {r.label}
                  </th>
                  {personas.map((p) => (
                    <td key={p.id} className="px-4 py-3 align-top text-xs leading-relaxed text-content">
                      {r.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-content-subtle">—</span>
  return (
    <ul className="list-disc space-y-1 pl-4">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ul>
  )
}
