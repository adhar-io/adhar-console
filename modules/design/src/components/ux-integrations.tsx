import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, Select, Textarea, useToast } from '@adhar/shell-ui'
import type { DesignScope } from '../data/design-scope.ts'
import type { Journey, JourneyStage, Persona, PlaneLink } from '../data/types.ts'
import { designHref } from '../data/nav.ts'
import { journeyDrafts, mergeLinks, parentDraft, personaDrafts } from '../data/plane-map.ts'
import { analyticsProblem, type Cohort, fetchCohortPersons, summarizePersons, useCohorts } from '../data/analytics.ts'
import { extractJson, JOURNEY_PROMPT, journeyContext, PERSONA_PROMPT, personaContext, toPersona, toStages } from '../data/ux-ai.ts'
import { askAdharAi } from '../data/ai.ts'
import { newId } from '../data/store.ts'
import { CohortField, CreateWorkItemsModal, PanelLabel, PlaneLinksList, Spark } from './integrations.tsx'
import { PersonaAvatar } from './ux-kit.tsx'

/* ───────────────────────────── project tag ───────────────────────────── */

/** Move an artifact between projects (or make it workspace-wide). */
export function ProjectTagSelect({ scope, value, onChange }: { scope: DesignScope; value?: string; onChange(project: string | undefined): void }) {
  const known = scope.projects.some((p) => p.slug === value)
  return (
    <Select
      aria-label="Project"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-8 py-1 text-xs"
      wrapperClassName="w-full sm:w-56"
      options={[
        { value: '', label: 'Workspace (all projects)' },
        ...(value && !known ? [{ value, label: value }] : []),
        ...scope.projects.map((p) => ({ value: p.slug, label: p.name || p.slug })),
      ]}
    />
  )
}

/* ───────────────────────────── persona → Plane ───────────────────────────── */

export function PersonaWorkItems({ persona, scope, onLinks }: { persona: Persona; scope: DesignScope; onLinks(next: PlaneLink[]): void }) {
  const [open, setOpen] = useState(false)
  const link = typeof location !== 'undefined' ? `${location.origin}${designHref('personas', { persona: persona.id, ...(persona.project ? { project: persona.project } : {}) })}` : undefined
  const drafts = useMemo(() => personaDrafts(persona, { link }), [persona, link])
  const project = scope.projects.find((p) => p.slug === persona.project)
  const links = persona.planeLinks ?? []
  return (
    <section className="space-y-2">
      <PanelLabel
        action={
          <Button size="xs" variant="ghost" disabled={!drafts.length} title={drafts.length ? undefined : (persona.jobs?.length ? 'Every job is already linked' : 'Add jobs to be done first')} onClick={() => setOpen(true)}>
            Create work items{drafts.length ? ` (${drafts.length})` : ''}
          </Button>
        }
      >
        Work items in Plane
      </PanelLabel>
      {links.length ? (
        <PlaneLinksList compact links={links} onUnlink={(l) => onLinks(links.filter((x) => x.issueId !== l.issueId))} />
      ) : (
        <p className="text-xs text-content-muted">None yet. Turn this persona's jobs to be done into Plane work items — each links back here and shows its live state.</p>
      )}
      <CreateWorkItemsModal
        open={open}
        onClose={() => setOpen(false)}
        title={`Work items from ${persona.name}'s jobs`}
        drafts={drafts}
        parent={parentDraft(`Persona: ${persona.name}`, `Jobs to be done for ${persona.name} (${persona.role}).`, 'parent:persona', link)}
        scope={project ? { slug: project.slug, name: project.name } : undefined}
        backLink={link}
        existingParent={links.find((l) => l.parent)}
        onCreated={(added) => onLinks(mergeLinks(links, added))}
      />
    </section>
  )
}

/* ───────────────────────────── persona ↔ PostHog ───────────────────────────── */

export function PersonaEvidence({ persona, onChange }: { persona: Persona; onChange(ev: Persona['evidence']): void }) {
  return (
    <section className="space-y-2">
      <PanelLabel>Evidence from product analytics</PanelLabel>
      <p className="text-[11px] text-content-subtle">The PostHog cohort this persona stands for — its live size shows here.</p>
      <CohortField
        value={persona.evidence?.cohortId}
        onChange={(c) => onChange(c ? { ...(persona.evidence ?? {}), cohortId: c.id, cohortName: c.name } : undefined)}
      />
    </section>
  )
}

/* ───────────────────────────── AI: persona ───────────────────────────── */

export function PersonaAiModal({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean
  onClose(): void
  onCreate(p: Omit<Persona, 'id'>): void
  busy: boolean
}) {
  const cohorts = useCohorts(open)
  const [brief, setBrief] = useState('')
  const [cohort, setCohort] = useState<Cohort | null>(null)
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState<Omit<Persona, 'id'> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [grounding, setGrounding] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(null)
    setErr(null)
    setGrounding(null)
  }, [open])

  const run = async () => {
    setRunning(true)
    setErr(null)
    try {
      const context = []
      if (cohort) {
        // Ground on real people: the cohort's size and the most common
        // properties across a sample of its members.
        const persons = await fetchCohortPersons(cohort.id, 50).catch(() => [])
        const sum = summarizePersons(persons)
        const lines = sum.props.map((p) => `${p.label}: ${p.top.map((t) => `${t.value} (${t.n}/${sum.sampled})`).join(', ')}`)
        setGrounding(sum.sampled ? `Grounded on ${sum.sampled} sampled member${sum.sampled === 1 ? '' : 's'} of “${cohort.name}”${cohort.count != null ? ` (cohort size ${cohort.count.toLocaleString()})` : ''}.` : `“${cohort.name}” returned no members to sample; the draft uses its name and description only.`)
        context.push({
          description: 'PostHog cohort (real product analytics)',
          value: JSON.stringify({ name: cohort.name, description: cohort.description, size: cohort.count ?? null, sampled: sum.sampled, properties: lines }),
        })
      }
      const prompt = `${PERSONA_PROMPT}\n\n${brief.trim() ? `Brief: ${brief.trim()}` : 'Base the persona on the cohort in context.'}`
      const out = toPersona(extractJson(await askAdharAi({ prompt, context })))
      setDraft({ ...out, ...(cohort ? { evidence: { cohortId: cohort.id, cohortName: cohort.name } } : {}) })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const cohortList = cohorts.data ?? []
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Draft a persona with Adhar AI"
      description="From a brief, a PostHog cohort, or both. You review the draft before it is saved."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          {draft ? (
            <>
              <Button size="sm" onClick={run} loading={running}>Regenerate</Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => onCreate(draft)}>Create persona</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={!brief.trim() && !cohort} loading={running} onClick={run} leading={<Spark />}>Draft</Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Textarea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Operations lead at a mid-size logistics company who approves deploys but rarely writes code…" />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Ground on a PostHog cohort (optional)</span>
          {cohorts.error ? (
            <span className="text-xs text-content-muted">{analyticsProblem(cohorts.error)}</span>
          ) : (
            <Select
              aria-label="Cohort"
              value={cohort ? String(cohort.id) : ''}
              onChange={(e) => setCohort(cohortList.find((c) => String(c.id) === e.target.value) ?? null)}
              className="h-9 py-1.5 text-sm"
              options={[
                { value: '', label: cohorts.isLoading ? 'Loading cohorts…' : cohortList.length ? 'No cohort' : 'No cohorts in PostHog' },
                ...cohortList.map((c) => ({ value: String(c.id), label: c.count != null ? `${c.name} · ${c.count.toLocaleString()} people` : c.name })),
              ]}
            />
          )}
        </label>
        {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
        {draft ? (
          <div className="space-y-2 rounded-lg border border-edge-default p-3">
            <div className="flex items-center gap-2">
              <PersonaAvatar name={draft.name} size={36} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content">{draft.name}</div>
                <div className="truncate text-xs text-content-muted">{draft.role}{draft.location ? ` · ${draft.location}` : ''}</div>
              </div>
            </div>
            {draft.quote ? <p className="text-xs italic text-content-muted">“{draft.quote}”</p> : null}
            <p className="text-xs text-content">{draft.bio}</p>
            <DraftList label="Jobs to be done" items={draft.jobs ?? []} />
            <DraftList label="Goals" items={draft.goals} />
            <DraftList label="Frustrations" items={draft.frustrations} />
            {grounding ? <p className="text-[11px] text-content-subtle">{grounding}</p> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

function DraftList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">{label}</div>
      <ul className="list-disc pl-4 text-xs text-content">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  )
}

/* ───────────────────────────── AI: journey stages ───────────────────────────── */

export function JourneyAiModal({
  open,
  onClose,
  journey,
  persona,
  onApply,
}: {
  open: boolean
  onClose(): void
  journey: Journey
  persona?: Persona
  onApply(stages: JourneyStage[], mode: 'replace' | 'append'): void
}) {
  const [running, setRunning] = useState(false)
  const [stages, setStages] = useState<JourneyStage[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) {
      setStages(null)
      setErr(null)
    }
  }, [open])
  const run = async () => {
    setRunning(true)
    setErr(null)
    try {
      const context = [journeyContext(journey), ...(persona ? [personaContext(persona)] : [])]
      const out = toStages(extractJson(await askAdharAi({ prompt: `${JOURNEY_PROMPT}${note.trim() ? `\n\nAlso: ${note.trim()}` : ''}`, context })), newId)
      if (!out.length) throw new Error('The draft had no stages.')
      setStages(out)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const has = journey.stages.length > 0
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Draft stages with Adhar AI"
      description={persona ? `From ${persona.name}'s profile and this journey's goal.` : 'Link a persona first for a better draft — the journey goal and summary are used.'}
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          {stages ? (
            <>
              {has ? <Button size="sm" onClick={() => onApply(stages, 'append')}>Append {stages.length}</Button> : null}
              <Button size="sm" variant="primary" onClick={() => onApply(stages, 'replace')}>{has ? 'Replace stages' : `Use ${stages.length} stages`}</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" loading={running} onClick={run} leading={<Spark />}>Draft</Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to focus on (optional) — e.g. the first week after sign-up" />
        {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
        {stages ? (
          <ol className="space-y-1.5">
            {stages.map((s, i) => (
              <li key={s.id} className="rounded-lg border border-edge-default px-3 py-2 text-xs">
                <div className="font-medium text-content">{i + 1}. {s.name} <span className="font-normal text-content-subtle">· {s.emotion}</span></div>
                {s.pains.length ? <div className="text-content-muted">Pains: {s.pains.join('; ')}</div> : null}
                {s.opportunities.length ? <div className="text-content-muted">Opportunities: {s.opportunities.join('; ')}</div> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </Modal>
  )
}

/* ───────────────────────────── journey → Plane ───────────────────────────── */

export function JourneyWorkItemsButton({ journey, persona, scope, onLinks }: { journey: Journey; persona?: Persona; scope: DesignScope; onLinks(next: PlaneLink[]): void }) {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const link = typeof location !== 'undefined' ? `${location.origin}${designHref('journeys', { journey: journey.id, ...(journey.project ? { project: journey.project } : {}) })}` : undefined
  const drafts = useMemo(() => journeyDrafts(journey, persona, { include: ['pain', 'opportunity'], link }), [journey, persona, link])
  const project = scope.projects.find((p) => p.slug === journey.project)
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => (drafts.length ? setOpen(true) : toast.info('Nothing to file', { description: 'Every pain point and opportunity is already linked — or add some first.' }))}
      >
        Work items{drafts.length ? ` (${drafts.length})` : ''}
      </Button>
      <CreateWorkItemsModal
        open={open}
        onClose={() => setOpen(false)}
        title={`Work items from “${journey.name}”`}
        drafts={drafts}
        parent={parentDraft(`Journey: ${journey.name}`, journey.goal ? `Goal: ${journey.goal}` : journey.summary || `Pain points and opportunities from the journey “${journey.name}”.`, 'parent:journey', link)}
        scope={project ? { slug: project.slug, name: project.name } : undefined}
        backLink={link}
        existingParent={journey.planeLinks?.find((l) => l.parent)}
        onCreated={(added) => onLinks(mergeLinks(journey.planeLinks, added))}
      />
    </>
  )
}
