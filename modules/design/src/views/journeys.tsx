import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  SearchInput,
  Select,
  Textarea,
  useClickOutside,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  KIND,
  type Listed,
  newId,
  useCollection,
  useCreate,
  useRemove,
  useRestoreDocs,
  useUpdate,
} from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Journey, JourneyEmotion, JourneyStage, Persona } from '../data/types.ts'
import { useDesignParams, useGoDesign, useSetDesignParams } from '../data/nav.ts'
import { type DesignScope, useDesignScope } from '../data/design-scope.ts'
import { scopedApps, useCatalogApps } from '../data/designer-repos.ts'
import { analyticsProblem, FUNNEL_RANGES, pct, useEventNames, useJourneyFunnel } from '../data/analytics.ts'
import { usePlaneIssueIndex } from '../data/plane.ts'
import { AskAiButton, CohortField, ComponentChips, IssueStateChip, type PickableApp, PlaneLinksList } from '../components/integrations.tsx'
import { JourneyAiModal, JourneyWorkItemsButton, ProjectTagSelect } from '../components/ux-integrations.tsx'
import { SharedChip } from '../components/scope-picker.tsx'
import {
  EMOTION_EMOJI,
  EMOTION_SCORE,
  EMOTIONS,
  JOURNEY_TEMPLATES,
  journeyToMarkdown,
  journeyToSvg,
  laneItems,
  LANES,
  type LaneKey,
  moveItem,
  shortPersonaName,
  stageScore,
} from '../data/ux-lib.ts'
import {
  copyText,
  downloadBlob,
  downloadText,
  fileSlug,
  IconChevron,
  IconDownload,
  IconDuplicate,
  IconGrip,
  IconPlus,
  IconTrash,
  IconWarning,
  InlineText,
  ListEditor,
  PersonaAvatar,
  svgToPng,
  useDraft,
} from '../components/ux-kit.tsx'

const LANE_DOT: Record<LaneKey, string> = {
  actions: 'bg-sky-500',
  touchpoints: 'bg-teal-500',
  thoughts: 'bg-violet-500',
  pains: 'bg-rose-500',
  opportunities: 'bg-emerald-500',
}

/**
 * Journey Maps — stages × lanes, with an emotion curve, persona link and
 * exports. Each journey is one document (kind `design.journey`); the open map
 * is a local draft that autosaves, so typing and dragging stay instant. The
 * open journey lives in the URL (`?journey=…`).
 */
export function Journeys() {
  const scope = useDesignScope()
  const all = useCollection<Journey>(KIND.journey)
  const { isLoading, error, refetch } = all
  const items = useMemo(() => all.items.filter((j) => scope.matches(j)), [all.items, scope])
  const { items: personas } = useCollection<Persona>(KIND.persona)
  const catalog = useCatalogApps()
  // Catalog components a stage can be linked to: the applications in scope.
  const apps = useMemo<PickableApp[]>(
    () => scopedApps(catalog.data ?? [], scope.inScope, scope.projects).map((a) => ({ name: a.name, project: a.project })),
    [catalog.data, scope.inScope, scope.projects],
  )
  const create = useCreate<Journey>(KIND.journey)
  const remove = useRemove(KIND.journey)
  const restore = useRestoreDocs<Journey>(KIND.journey)
  const toast = useToast()
  const params = useDesignParams()
  const setParams = useSetDesignParams()

  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createPersona, setCreatePersona] = useState<string>('')

  useEffect(() => {
    if (params.new === '1') {
      setCreatePersona(params.persona ?? '')
      setCreateOpen(true)
      setParams({ new: undefined, persona: undefined })
    }
  }, [params.new, params.persona, setParams])

  const sorted = useMemo(
    () => [...items].sort((a, b) => (b._updatedAt ?? '').localeCompare(a._updatedAt ?? '')),
    [items],
  )
  const visible = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return sorted
    return sorted.filter((j) => {
      const p = personas.find((x) => x.id === j.persona)
      return `${j.name} ${j.summary} ${j.goal ?? ''} ${p?.name ?? ''}`.toLowerCase().includes(n)
    })
  }, [sorted, q, personas])

  // A deep link may name a journey outside the scope — still open it.
  const open = all.items.find((j) => j.id === params.journey) ?? sorted[0] ?? null

  const doCreate = async (j: Journey) => {
    setCreateOpen(false)
    try {
      const created = await create.mutateAsync({ ...scope.tag(), ...j })
      setParams({ journey: created.id })
      toast.success('Journey created', { description: 'Click any cell to start mapping.' })
    } catch (e) {
      toast.error('Could not create journey', { description: (e as Error).message })
    }
  }

  const del = async (j: Listed<Journey>) => {
    try {
      await remove.mutateAsync(j.id)
      setParams({ journey: undefined })
      const { _createdAt: _a, _updatedAt: _b, _updatedBy: _c, ...plain } = j
      toast.success(`Deleted “${j.name}”`, {
        action: {
          label: 'Undo',
          onClick: () =>
            restore.mutate([plain as Journey], {
              onSuccess: () => {
                setParams({ journey: j.id })
                toast.success('Journey restored')
              },
              onError: (e) => toast.error('Could not restore', { description: e.message }),
            }),
        },
      })
    } catch (e) {
      toast.error('Could not delete journey', { description: (e as Error).message })
    }
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading journey maps…" />

  return (
    <div className="space-y-4">
      {all.items.length === 0 ? (
        <>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} leading={<IconPlus size={12} />}>
              New journey
            </Button>
          </div>
          <EmptyState
            title="No journey maps yet"
            description="Map how a persona moves through your product — what they do, think and feel at each stage — to find the pain points worth fixing."
            action={
              <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} leading={<IconPlus size={12} />}>
                New journey
              </Button>
            }
          />
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="space-y-2">
            <div className="flex items-center gap-2">
              <SearchInput value={q} onChange={setQ} placeholder="Find a journey" className="min-w-0 flex-1" shortcut={false} />
              <Button
                size="sm"
                variant="primary"
                onClick={() => setCreateOpen(true)}
                aria-label="New journey"
                title="New journey"
                className="px-2"
              >
                <IconPlus size={13} />
              </Button>
            </div>
            <nav className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-0.5 lg:overflow-visible lg:pb-0" aria-label="Journeys">
              {visible.map((j) => {
                const p = personas.find((x) => x.id === j.persona)
                const on = open?.id === j.id
                return (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setParams({ journey: j.id })}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'flex w-56 shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors lg:w-full',
                      on ? 'bg-brand-50 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:ring-brand-400/30' : 'hover:bg-surface-sunken',
                    )}
                  >
                    {p ? (
                      <PersonaAvatar name={p.name} avatar={p.avatar} color={p.color} size={28} />
                    ) : (
                      <span title="No persona linked" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200">
                        <IconWarning size={12} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('block truncate text-sm', on ? 'font-semibold text-content' : 'text-content')}>{j.name}</span>
                        {scope.project && !j.project ? <SharedChip /> : null}
                      </span>
                      <span className="block truncate text-[11px] text-content-subtle">
                        {j.stages.length} stages{p ? ` · ${shortPersonaName(p.name)}` : ' · no persona'}
                      </span>
                    </span>
                  </button>
                )
              })}
              {visible.length === 0 ? <p className="px-2 py-3 text-xs text-content-subtle">{items.length ? 'No journeys match.' : `No journeys in ${scope.label}.`}</p> : null}
            </nav>
          </aside>

          {open ? (
            <JourneyEditor
              key={open.id}
              journey={open}
              personas={personas}
              scope={scope}
              apps={apps}
              onDelete={() => del(open)}
              onDuplicate={() => {
                const { _createdAt: _a, _updatedAt: _b, _updatedBy: _c, ...plain } = open
                void doCreate({
                  ...plain,
                  id: '',
                  name: `${open.name} (copy)`,
                  stages: open.stages.map((s) => ({ ...s, id: newId('stage') })),
                })
              }}
            />
          ) : null}
        </div>
      )}

      <CreateJourneyModal
        open={createOpen}
        initialPersona={createPersona}
        onClose={() => {
          setCreateOpen(false)
          setCreatePersona('')
        }}
        personas={personas}
        busy={create.isPending}
        onCreate={doCreate}
      />
    </div>
  )
}

/* ───────────────────────────── editor ───────────────────────────── */

function blankStage(name: string): JourneyStage {
  return {
    id: newId('stage'),
    name,
    emotion: 'reflective',
    actions: [],
    touchpoints: [],
    thoughts: [],
    pains: [],
    opportunities: [],
  }
}

function JourneyEditor({
  journey,
  personas,
  scope,
  apps,
  onDelete,
  onDuplicate,
}: {
  journey: Listed<Journey>
  personas: Persona[]
  scope: DesignScope
  apps: PickableApp[]
  onDelete(): void
  onDuplicate(): void
}) {
  const update = useUpdate<Journey>(KIND.journey)
  const toast = useToast()
  const go = useGoDesign()
  const { draft, update: edit, saving } = useDraft<Journey>(journey, (next) =>
    update.mutateAsync(next).catch((e: Error) => toast.error('Could not save journey', { description: e.message })))
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  // Product analytics: a PostHog funnel over the events that mark each stage.
  // Reads the saved journey (autosaved), so typing an event name doesn't query per keystroke.
  const funnel = useJourneyFunnel(journey)
  const eventNames = useEventNames()
  const plane = usePlaneIssueIndex(draft?.planeLinks ?? [])

  if (!draft) return null
  const j = draft
  const persona = personas.find((p) => p.id === j.persona)
  const n = j.stages.length
  const conv = new Map((funnel.data ?? []).map((c) => [c.stageId, c]))
  const stepsNamed = j.stages.filter((s) => (s.events ?? []).some((e) => e.trim())).length
  const stageApps = j.project ? apps.filter((a) => !a.project || a.project === j.project || scope.projects.find((p) => p.slug === j.project)?.argoProject === a.project) : apps

  const set = (patch: Partial<Journey>) => edit((d) => ({ ...d, ...patch }))
  const setStages = (fn: (s: JourneyStage[]) => JourneyStage[]) => edit((d) => ({ ...d, stages: fn(d.stages) }))
  const setStage = (id: string, patch: Partial<JourneyStage>) =>
    setStages((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const insertAt = (idx: number) => setStages((ss) => [...ss.slice(0, idx), blankStage(`Stage ${ss.length + 1}`), ...ss.slice(idx)])

  const removeStage = (s: JourneyStage) => {
    const before = j.stages
    setStages((ss) => ss.filter((x) => x.id !== s.id))
    toast.success(`Removed stage “${s.name}”`, {
      action: { label: 'Undo', onClick: () => setStages(() => before) },
    })
  }

  const exportAs = async (kind: 'md' | 'md-copy' | 'svg' | 'png') => {
    setExportOpen(false)
    const base = fileSlug(j.name)
    try {
      if (kind === 'md') downloadText(`${base}.md`, journeyToMarkdown(j, persona), 'text/markdown')
      if (kind === 'md-copy') await copyText(journeyToMarkdown(j, persona))
      if (kind === 'svg') downloadText(`${base}.svg`, journeyToSvg(j, persona).svg, 'image/svg+xml')
      if (kind === 'png') {
        const { svg, width, height } = journeyToSvg(j, persona)
        downloadBlob(`${base}.png`, await svgToPng(svg, width, height))
      }
      toast.success(kind === 'md-copy' ? 'Markdown copied' : 'Journey exported')
    } catch (e) {
      toast.error('Export failed', { description: (e as Error).message })
    }
  }

  const cols = `150px repeat(${Math.max(1, n)}, minmax(210px, 1fr)) 52px`

  return (
    <div className="min-w-0 space-y-4">
      {/* Title + actions */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <InlineText value={j.name} onCommit={(v) => set({ name: v.trim() || j.name })} ariaLabel="Journey name" className="text-xl font-semibold tracking-tight" />
          <div className="px-1.5 text-[11px] text-content-subtle">
            {saving ? 'Saving…' : journey._updatedAt ? `Edited ${formatRelative(journey._updatedAt)}` : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <AskAiButton onClick={() => setAiOpen(true)}>Draft stages</AskAiButton>
          <JourneyWorkItemsButton journey={j} persona={persona} scope={scope} onLinks={(planeLinks) => set({ planeLinks })} />
          <ExportMenu open={exportOpen} setOpen={setExportOpen} onPick={exportAs} />
          <Button size="sm" variant="ghost" onClick={onDuplicate} leading={<IconDuplicate size={12} />}>
            Duplicate
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} leading={<IconTrash size={12} />} className="hover:text-rose-600">
            Delete
          </Button>
        </div>
      </div>

      {/* Context */}
      <div className="grid grid-cols-1 gap-4 rounded-xl border border-edge-default bg-surface-raised p-4 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="space-y-2">
          <Mini>Persona</Mini>
          <div className="flex items-center gap-2">
            {persona ? (
              <button type="button" onClick={() => go('personas', { persona: persona.id })} title="Open persona">
                <PersonaAvatar name={persona.name} avatar={persona.avatar} color={persona.color} size={36} />
              </button>
            ) : (
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200">
                <IconWarning size={14} />
              </span>
            )}
            <Select
              aria-label="Persona"
              value={persona ? j.persona : ''}
              onChange={(e) => set({ persona: e.target.value })}
              wrapperClassName="min-w-0 flex-1"
              className="h-9 py-1.5 text-sm"
            >
              <option value="">No persona</option>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          {persona?.quote ? <p className="text-xs italic text-content-muted">“{persona.quote}”</p> : null}
          {!personas.length ? (
            <button type="button" onClick={() => go('personas', { new: '1' })} className="text-xs text-brand-700 hover:underline dark:text-brand-300">
              Create a persona first →
            </button>
          ) : null}
        </div>
        <div className="space-y-2">
          <Mini>Goal</Mini>
          <InlineText value={j.goal ?? ''} onCommit={(v) => set({ goal: v.trim() || undefined })} placeholder="What is the persona trying to achieve?" className="text-sm" />
          <Mini>Summary</Mini>
          <InlineText multiline value={j.summary} onCommit={(v) => set({ summary: v })} placeholder="Scope and scenario of this journey…" className="text-sm text-content-muted" />
        </div>
        <div className="space-y-2 md:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <Mini>Evidence</Mini>
            <span className="text-[11px] text-content-subtle">PostHog funnel over the stage events{j.evidence?.cohortName ? `, narrowed to “${j.evidence.cohortName}”` : ''}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select
                aria-label="Funnel date range"
                value={j.evidence?.range ?? '-30d'}
                onChange={(e) => set({ evidence: { ...(j.evidence ?? {}), range: e.target.value } })}
                className="h-8 py-1 text-xs"
                options={FUNNEL_RANGES.map((r) => ({ value: r.id, label: `Last ${r.label}` }))}
              />
              <span className="text-[11px] text-content-subtle">Project</span>
              <ProjectTagSelect scope={scope} value={j.project} onChange={(project) => set({ project })} />
            </div>
          </div>
          <CohortField
            value={j.evidence?.cohortId}
            onChange={(c) => set({ evidence: { ...(j.evidence ?? {}), cohortId: c?.id, cohortName: c?.name } })}
          />
          <p className="text-[11px] text-content-muted">
            {stepsNamed < 2
              ? 'Name the PostHog event that marks each stage (Analytics row below) — conversion shows once two stages have one.'
              : funnel.error
              ? analyticsProblem(funnel.error)
              : funnel.isLoading
              ? 'Loading conversion from PostHog…'
              : funnel.data?.length
              ? `${funnel.data[0].count.toLocaleString()} people reached “${funnel.data[0].stageName}”; ${pct(funnel.data[funnel.data.length - 1].fromStart)} made it to “${funnel.data[funnel.data.length - 1].stageName}”.`
              : 'PostHog returned no funnel for these events in this range.'}
          </p>
        </div>
      </div>

      {/* Map */}
      <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
        <div className="grid min-w-max" style={{ gridTemplateColumns: cols }}>
          {/* Stage header row */}
          <RowLabel className="border-b border-edge-default">Stages</RowLabel>
          {j.stages.map((s, i) => (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => {
                setDragFrom(i)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', s.id)
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return
                e.preventDefault()
                setDragOver(i)
              }}
              onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null && dragFrom !== i) setStages((ss) => moveItem(ss, dragFrom, i))
                setDragFrom(null)
                setDragOver(null)
              }}
              onDragEnd={() => {
                setDragFrom(null)
                setDragOver(null)
              }}
              className={cn(
                'group/stage flex items-center gap-1 border-b border-l border-edge-default bg-surface-sunken/50 px-2 py-2',
                dragFrom === i && 'opacity-50',
                dragOver === i && dragFrom !== i && 'bg-brand-50 ring-2 ring-inset ring-brand-400 dark:bg-brand-500/15',
              )}
            >
              <span className="cursor-grab text-content-subtle active:cursor-grabbing" title="Drag to reorder">
                <IconGrip size={12} />
              </span>
              <span className="text-[11px] font-semibold tabular-nums text-content-subtle">{i + 1}</span>
              <InlineText value={s.name} onCommit={(v) => setStage(s.id, { name: v.trim() || s.name })} ariaLabel={`Stage ${i + 1} name`} className="text-sm font-semibold" />
              <StageMenu
                canLeft={i > 0}
                canRight={i < n - 1}
                onLeft={() => setStages((ss) => moveItem(ss, i, i - 1))}
                onRight={() => setStages((ss) => moveItem(ss, i, i + 1))}
                onInsertBefore={() => insertAt(i)}
                onInsertAfter={() => insertAt(i + 1)}
                onDelete={() => removeStage(s)}
              />
            </div>
          ))}
          <div className="flex items-center justify-center border-b border-l border-edge-default bg-surface-sunken/50">
            <button
              type="button"
              onClick={() => insertAt(n)}
              title="Add stage"
              aria-label="Add stage"
              className="rounded-md p-1.5 text-content-subtle hover:bg-surface-raised hover:text-content"
            >
              <IconPlus size={14} />
            </button>
          </div>

          {/* Emotion curve */}
          <RowLabel hint="How they feel">Emotion</RowLabel>
          <div className="relative border-l border-edge-default" style={{ gridColumn: `span ${Math.max(1, n)}` }}>
            <EmotionCurve stages={j.stages} />
          </div>
          <div className="border-l border-edge-default" />

          <RowLabel className="border-t border-edge-subtle" hint="−2 … +2">Feeling</RowLabel>
          {j.stages.map((s) => (
            <div key={s.id} className="space-y-1.5 border-l border-t border-edge-subtle px-3 py-2">
              <Select
                aria-label={`Emotion for ${s.name}`}
                value={s.emotion}
                onChange={(e) => {
                  const emotion = e.target.value as JourneyEmotion
                  setStage(s.id, { emotion, score: EMOTION_SCORE[emotion] })
                }}
                className="h-8 py-1 text-xs"
              >
                {EMOTIONS.map((em) => <option key={em} value={em}>{EMOTION_EMOJI[em]} {em}</option>)}
              </Select>
              <input
                type="range"
                min={-2}
                max={2}
                step={0.5}
                value={stageScore(s)}
                aria-label={`Emotion score for ${s.name}`}
                onChange={(e) => setStage(s.id, { score: Number(e.target.value) })}
                className="w-full accent-brand-600"
              />
            </div>
          ))}
          <div className="border-l border-t border-edge-subtle" />

          {/* Lanes */}
          {LANES.map((lane) => (
            <LaneRow key={lane.key} label={lane.label} hint={lane.hint}>
              {j.stages.map((s) => (
                <div key={s.id} className="border-l border-t border-edge-subtle px-2 py-2 align-top">
                  <ListEditor
                    compact
                    items={laneItems(s, lane.key)}
                    onChange={(next) => setStage(s.id, { [lane.key]: next } as Partial<JourneyStage>)}
                    placeholder="Add…"
                    dotClass={LANE_DOT[lane.key]}
                  />
                </div>
              ))}
              <div className="border-l border-t border-edge-subtle" />
            </LaneRow>
          ))}

          {/* Platform links: catalog components, analytics events, Plane items */}
          <LaneRow label="Components" hint="Catalog apps serving it">
            {j.stages.map((s) => (
              <div key={s.id} className="border-l border-t border-edge-subtle px-2 py-2">
                <ComponentChips apps={stageApps} value={s.components ?? []} onChange={(components) => setStage(s.id, { components })} emptyHint="No apps in scope" />
              </div>
            ))}
            <div className="border-l border-t border-edge-subtle" />
          </LaneRow>
          <LaneRow label="Analytics" hint="Event reaching it">
            {j.stages.map((s) => {
              const c = conv.get(s.id)
              return (
                <div key={s.id} className="space-y-1 border-l border-t border-edge-subtle px-2 py-2">
                  <input
                    value={s.events?.[0] ?? ''}
                    onChange={(e) => setStage(s.id, { events: e.target.value ? [e.target.value] : [] })}
                    list={`ph-events-${j.id}`}
                    placeholder="PostHog event…"
                    aria-label={`PostHog event for ${s.name}`}
                    className="h-7 w-full rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-[11px] text-content placeholder:font-sans placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
                  />
                  {c ? (
                    <div className="text-[11px] text-content-muted" title={`${pct(c.fromStart)} of the first stage`}>
                      <span className="font-semibold tabular-nums text-content">{c.count.toLocaleString()}</span> people
                      {c.stageId !== funnel.data?.[0]?.stageId ? <span> · {pct(c.fromPrevious)} from previous</span> : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
            <div className="border-l border-t border-edge-subtle" />
          </LaneRow>
          <LaneRow label="Work items" hint="Live from Plane">
            {j.stages.map((s) => {
              const mine = (j.planeLinks ?? []).filter((l) => l.source.includes(`:${s.id}:`))
              return (
                <div key={s.id} className="space-y-1 border-l border-t border-edge-subtle px-2 py-2">
                  {mine.length ? mine.map((l) => {
                    const info = plane.index.get(l.issueId)
                    return (
                      <div key={l.issueId} className="flex items-center gap-1.5 text-[11px]" title={info?.name ?? l.name}>
                        <span className="shrink-0 font-mono text-content-subtle">{info?.key ?? l.key ?? '—'}</span>
                        <span className="min-w-0 flex-1 truncate text-content">{info?.name ?? l.name}</span>
                        <IssueStateChip info={info} missing={!plane.loading && !plane.error && !info} />
                      </div>
                    )
                  }) : <span className="text-[11px] text-content-subtle">—</span>}
                </div>
              )
            })}
            <div className="border-l border-t border-edge-subtle" />
          </LaneRow>
        </div>
      </div>
      {n === 0 ? (
        <EmptyState
          compact
          title="No stages"
          description="Add the first stage of the journey."
          action={<Button size="sm" variant="primary" onClick={() => insertAt(0)} leading={<IconPlus size={12} />}>Add stage</Button>}
        />
      ) : null}
      <datalist id={`ph-events-${j.id}`}>
        {(eventNames.data ?? []).slice(0, 300).map((e) => <option key={e} value={e} />)}
      </datalist>
      {j.planeLinks?.length ? (
        <PlaneLinksList links={j.planeLinks} label="Work items in Plane" onUnlink={(l) => set({ planeLinks: (j.planeLinks ?? []).filter((x) => x.issueId !== l.issueId) })} />
      ) : null}
      <JourneyAiModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        journey={j}
        persona={persona}
        onApply={(stages, mode) => {
          setAiOpen(false)
          const before = j.stages
          setStages((ss) => (mode === 'replace' ? stages : [...ss, ...stages]))
          toast.success(mode === 'replace' ? `Drafted ${stages.length} stages` : `Appended ${stages.length} stages`, {
            action: { label: 'Undo', onClick: () => setStages(() => before) },
          })
        }}
      />
      <p className="text-[11px] text-content-subtle">
        Drag stage headers to reorder · click any item to edit · Enter to add the next one · changes save automatically.
      </p>
    </div>
  )
}

function Mini({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{children}</div>
}

function RowLabel({ children, hint, className }: { children: ReactNode; hint?: string; className?: string }) {
  return (
    <div className={cn('sticky left-0 z-10 bg-surface-raised px-3 py-2', className)}>
      <div className="text-xs font-semibold text-content">{children}</div>
      {hint ? <div className="text-[10px] text-content-subtle">{hint}</div> : null}
    </div>
  )
}

function LaneRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <>
      <RowLabel className="border-t border-edge-subtle" hint={hint}>{label}</RowLabel>
      {children}
    </>
  )
}

/* ─── emotion curve: thin line, recessive axis, hover tooltip ─── */

function EmotionCurve({ stages }: { stages: JourneyStage[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = stages.length
  const H = 120
  const PAD = 16
  if (!n) return <div style={{ height: H }} />
  const y = (score: number) => PAD + ((2 - score) / 4) * (H - PAD * 2)
  const xs = stages.map((_, i) => ((i + 0.5) / n) * 100)
  const pts = stages.map((s, i) => `${xs[i]},${y(stageScore(s))}`).join(' ')
  return (
    <div className="relative" style={{ height: H }} onMouseLeave={() => setHover(null)}>
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden>
        {[2, 0, -2].map((g) => (
          <line
            key={g}
            x1="0"
            x2="100"
            y1={y(g)}
            y2={y(g)}
            stroke="var(--color-edge-default)"
            strokeDasharray={g === 0 ? '4 4' : undefined}
            strokeOpacity={g === 0 ? 1 : 0.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {n > 1 ? (
          <polyline points={pts} fill="none" stroke="var(--color-brand-500)" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <span className="pointer-events-none absolute left-1 text-[10px] text-content-subtle" style={{ top: y(2) - 7 }}>+2</span>
      <span className="pointer-events-none absolute left-1 text-[10px] text-content-subtle" style={{ top: y(0) - 7 }}>0</span>
      <span className="pointer-events-none absolute left-1 text-[10px] text-content-subtle" style={{ top: y(-2) - 7 }}>−2</span>
      {stages.map((s, i) => {
        const sc = stageScore(s)
        return (
          <div key={s.id} className="absolute inset-y-0" style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }} onMouseEnter={() => setHover(i)}>
            <span
              className={cn(
                'absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand-500 bg-surface-raised transition-transform',
                hover === i && 'scale-125',
              )}
              style={{ left: '50%', top: y(sc) }}
            />
            {hover === i ? (
              <div
                className="pointer-events-none absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content shadow-lg"
                style={{ left: '50%', top: Math.max(0, y(sc) - 40) }}
              >
                <span className="font-semibold">{s.name}</span>
                <span className="text-content-muted"> · {EMOTION_EMOJI[s.emotion]} {s.emotion} · {sc > 0 ? '+' : ''}{sc}</span>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/* ─── menus ─── */

function StageMenu(props: {
  canLeft: boolean
  canRight: boolean
  onLeft(): void
  onRight(): void
  onInsertBefore(): void
  onInsertAfter(): void
  onDelete(): void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)
  const item = (label: string, fn: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <button
      type="button"
      disabled={opts.disabled}
      onClick={() => {
        setOpen(false)
        fn()
      }}
      className={cn(
        'block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-surface-sunken disabled:opacity-40',
        opts.danger ? 'text-rose-600 dark:text-rose-400' : 'text-content',
      )}
    >
      {label}
    </button>
  )
  return (
    <div ref={ref} className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label="Stage options"
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-content-subtle opacity-60 hover:bg-surface-raised hover:text-content group-hover/stage:opacity-100"
      >
        <IconChevron dir="down" size={12} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-xl">
          {item('Move left', props.onLeft, { disabled: !props.canLeft })}
          {item('Move right', props.onRight, { disabled: !props.canRight })}
          {item('Insert stage before', props.onInsertBefore)}
          {item('Insert stage after', props.onInsertAfter)}
          {item('Delete stage', props.onDelete, { danger: true })}
        </div>
      ) : null}
    </div>
  )
}

function ExportMenu({
  open,
  setOpen,
  onPick,
}: {
  open: boolean
  setOpen(v: boolean): void
  onPick(k: 'md' | 'md-copy' | 'svg' | 'png'): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)
  const item = (label: string, k: 'md' | 'md-copy' | 'svg' | 'png') => (
    <button type="button" onClick={() => onPick(k)} className="block w-full rounded px-2.5 py-1.5 text-left text-xs text-content hover:bg-surface-sunken">
      {label}
    </button>
  )
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} leading={<IconDownload size={12} />} trailing={<IconChevron dir="down" size={11} />}>
        Export
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-xl">
          {item('Download PNG', 'png')}
          {item('Download SVG', 'svg')}
          {item('Download Markdown', 'md')}
          {item('Copy as Markdown', 'md-copy')}
        </div>
      ) : null}
    </div>
  )
}

/* ───────────────────────────── create ───────────────────────────── */

function CreateJourneyModal({
  open,
  onClose,
  personas,
  initialPersona,
  onCreate,
  busy,
}: {
  open: boolean
  onClose(): void
  personas: Persona[]
  initialPersona: string
  onCreate(j: Journey): void
  busy: boolean
}) {
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [goal, setGoal] = useState('')
  const [summary, setSummary] = useState('')
  const [template, setTemplate] = useState('blank')

  useEffect(() => {
    if (!open) return
    setName('')
    setGoal('')
    setSummary('')
    setTemplate('blank')
    setPersona(initialPersona || personas[0]?.id || '')
  }, [open, initialPersona, personas])

  const submit = () => {
    if (!name.trim()) return
    const tpl = JOURNEY_TEMPLATES.find((t) => t.id === template) ?? JOURNEY_TEMPLATES[0]
    onCreate({
      id: '',
      name: name.trim(),
      persona,
      summary: summary.trim(),
      goal: goal.trim() || undefined,
      stages: tpl.stages.map((s) => blankStage(s)),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New journey map"
      description="Pick who it's for and a starting structure — stages are fully editable afterwards."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} disabled={!name.trim()} loading={busy}>
            Create journey
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Name" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="First deploy for a new team" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Persona">
            <Select value={persona} onChange={(e) => setPersona(e.target.value)}>
              <option value="">No persona</option>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Goal">
            <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Ship a first service" />
          </Field>
        </div>
        <Field label="Summary">
          <Textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Scope and scenario…" />
        </Field>
        <div>
          <div className="mb-1.5 text-sm font-medium text-content">Start from</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {JOURNEY_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                aria-pressed={template === t.id}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  template === t.id
                    ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10'
                    : 'border-edge-default hover:border-edge-strong',
                )}
              >
                <div className="text-sm font-medium text-content">{t.label}</div>
                <div className="mt-0.5 text-xs text-content-muted">{t.description}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.stages.map((s) => (
                    <span key={s} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted">{s}</span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  )
}
