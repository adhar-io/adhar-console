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
import { KIND, newId, useCollection, useCreate, useRemove, useSeedExamples, useUpdate } from '../data/store.ts'
import { SEED_JOURNEYS } from '../data/seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Journey, JourneyEmotion, JourneyStage, Persona } from '../data/types.ts'

/**
 * Journey maps with full authoring. Tab strip at the top lets you flip
 * between journeys and create new ones; the open journey shows persona
 * context, an emotion curve, and an editable stage grid where every cell
 * (actions / thoughts / pains / opportunities) is in-place editable.
 *
 * All edits autosave to localStorage.
 */
export function Journeys() {
  const { items: list, isLoading, error, refetch } = useCollection<Journey>(KIND.journey)
  const { items: personas } = useCollection<Persona>(KIND.persona)
  const createJourney = useCreate<Journey>(KIND.journey)
  const updateJourney = useUpdate<Journey>(KIND.journey)
  const removeJourney = useRemove(KIND.journey)
  const seed = useSeedExamples<Journey>(KIND.journey)

  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  // Auto-select the first journey once the list has loaded.
  useEffect(() => {
    if (list.length && (openId == null || !list.some((j) => j.id === openId))) {
      setOpenId(list[0].id)
    }
  }, [list, openId])

  const open = list.find((j) => j.id === openId) ?? null
  const persona = open ? personas.find((p) => p.id === open.persona) : undefined

  const updateOpen = (patch: Partial<Journey>) => {
    if (!open) return
    updateJourney.mutate({ ...open, ...patch })
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading journey maps…" />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
          {list.map((j) => {
            const on = j.id === openId
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => setOpenId(j.id)}
                className={
                  on
                    ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                    : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
                }
              >
                {j.name}
              </button>
            )
          })}
          {list.length === 0 ? (
            <span className="px-2 py-1 text-[12px] text-content-subtle">No journeys yet</span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New journey
          </Button>
        </div>
      </div>

      {open ? (
        <JourneyMap
          journey={open}
          persona={persona}
          personas={personas}
          onUpdate={updateOpen}
          onDelete={() => {
            if (!confirm(`Delete journey "${open.name}"?`)) return
            const remaining = list.filter((j) => j.id !== open.id)
            removeJourney.mutate(open.id)
            setOpenId(remaining[0]?.id ?? null)
          }}
        />
      ) : (
        <EmptyState
          title="No journey maps yet"
          description="Map a user journey — stages, actions, emotions, opportunities."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => seed.mutate(SEED_JOURNEYS)}
              disabled={seed.isPending}
            >
              {seed.isPending ? 'Loading…' : 'Load examples'}
            </Button>
          }
        />
      )}

      <CreateJourneyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        personas={personas}
        onCreate={(input) => {
          const j: Journey = {
            id: newId('journey'),
            name: input.name,
            persona: input.persona,
            summary: input.summary,
            stages: blankStages(),
          }
          createJourney.mutate(j, { onSuccess: (created) => setOpenId(created.id) })
        }}
      />
    </div>
  )
}

function blankStages(): JourneyStage[] {
  const names = ['Discover', 'Try', 'Adopt', 'Win']
  return names.map((n, i) => ({
    id: `stage-${Date.now().toString(36)}-${i}`,
    name: n,
    emotion: 'curious',
    actions: [],
    thoughts: [],
    pains: [],
    opportunities: [],
  }))
}

const EMOTION_VALUE: Record<JourneyEmotion, number> = {
  frustrated: -2,
  stressed: -1.5,
  cautious: -0.5,
  reflective: 0,
  curious: 0.5,
  focused: 0.5,
  satisfied: 1.5,
  excited: 2,
  urgent: -1,
}

const EMOTION_EMOJI: Record<JourneyEmotion, string> = {
  curious: '🤔',
  cautious: '😟',
  focused: '🧐',
  excited: '😊',
  satisfied: '😌',
  stressed: '😰',
  urgent: '🚨',
  reflective: '🪞',
  frustrated: '😤',
}

const EMOTIONS: JourneyEmotion[] = [
  'curious',
  'cautious',
  'focused',
  'excited',
  'satisfied',
  'stressed',
  'urgent',
  'reflective',
  'frustrated',
]

function JourneyMap({
  journey,
  persona,
  personas,
  onUpdate,
  onDelete,
}: {
  journey: Journey
  persona?: Persona
  personas: Persona[]
  onUpdate(patch: Partial<Journey>): void
  onDelete(): void
}) {
  const stages = journey.stages

  const updateStage = (id: string, patch: Partial<JourneyStage>) => {
    onUpdate({
      stages: stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    })
  }

  const addStage = () => {
    const next: JourneyStage = {
      id: newId('stage'),
      name: `Stage ${stages.length + 1}`,
      emotion: 'curious',
      actions: [],
      thoughts: [],
      pains: [],
      opportunities: [],
    }
    onUpdate({ stages: [...stages, next] })
  }

  const removeStage = (id: string) => {
    if (!confirm('Remove this stage?')) return
    onUpdate({ stages: stages.filter((s) => s.id !== id) })
  }

  const moveStage = (id: string, delta: -1 | 1) => {
    const idx = stages.findIndex((s) => s.id === id)
    const next = idx + delta
    if (idx < 0 || next < 0 || next >= stages.length) return
    const copy = stages.slice()
    ;[copy[idx], copy[next]] = [copy[next], copy[idx]]
    onUpdate({ stages: copy })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          {persona ? (
            <>
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-linear-to-br from-brand-50 to-violet-50 text-xl ring-1 ring-inset ring-edge-subtle">
                {persona.avatar}
              </span>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  Persona
                </div>
                <div className="text-sm font-semibold text-content">{persona.name}</div>
              </div>
            </>
          ) : (
            <StatusBadge kind="unknown">unassigned persona</StatusBadge>
          )}
          <select
            value={journey.persona ?? ''}
            onChange={(e) => onUpdate({ persona: e.target.value })}
            className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs"
          >
            <option value="">— pick persona —</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            value={journey.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            className="ml-auto min-w-0 max-w-xs rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-content focus:border-edge-default focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
          <Button size="sm" variant="danger" onClick={onDelete}>
            Delete journey
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <input
            value={journey.summary}
            onChange={(e) => onUpdate({ summary: e.target.value })}
            placeholder="One-line summary of the journey"
            className="block w-full rounded-md border border-transparent bg-surface-sunken/40 px-3 py-2 text-sm text-content focus:border-edge-default focus:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-content">Emotion across stages</div>
              <div className="text-[11px] text-content-subtle">
                Where the experience peaks, dips, and recovers
              </div>
            </div>
            <StatusBadge kind="info">{stages.length} stages</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          <EmotionCurve stages={stages} />
        </CardBody>
      </Card>

      <div className="overflow-x-auto">
        <div
          className="grid gap-3 pb-2"
          style={{
            gridTemplateColumns: `160px repeat(${stages.length}, minmax(240px, 1fr)) 56px`,
          }}
        >
          <RowLabel label="Stage" sub="Phase of the experience" />
          {stages.map((s, i) => (
            <Card key={`h-${s.id}`} className="border-brand-200/60 bg-brand-50/40">
              <CardBody className="space-y-1.5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <input
                    value={s.name}
                    onChange={(e) => updateStage(s.id, { name: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold tracking-tight text-brand-800 focus:border-brand-400 focus:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                  />
                  <span className="text-base" title={s.emotion}>
                    {EMOTION_EMOJI[s.emotion]}
                  </span>
                </div>
                <select
                  value={s.emotion}
                  onChange={(e) =>
                    updateStage(s.id, { emotion: e.target.value as JourneyEmotion })
                  }
                  className="block w-full rounded-md border border-edge-subtle bg-surface-raised/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-content-muted focus:border-brand-400 focus:outline-none"
                >
                  {EMOTIONS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-end gap-0.5 pt-1 text-content-subtle">
                  <button
                    type="button"
                    onClick={() => moveStage(s.id, -1)}
                    disabled={i === 0}
                    className="rounded p-0.5 hover:bg-surface-raised/60 disabled:opacity-30"
                    aria-label="Move left"
                  >
                    <IconArrowLeft />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStage(s.id, 1)}
                    disabled={i === stages.length - 1}
                    className="rounded p-0.5 hover:bg-surface-raised/60 disabled:opacity-30"
                    aria-label="Move right"
                  >
                    <IconArrowRight />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStage(s.id)}
                    className="rounded p-0.5 text-rose-600 hover:bg-rose-50"
                    aria-label="Remove stage"
                  >
                    <IconTrash />
                  </button>
                </div>
              </CardBody>
            </Card>
          ))}
          <div className="flex items-start pt-7">
            <button
              type="button"
              onClick={addStage}
              aria-label="Add stage"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-edge-default bg-surface-raised text-content-subtle shadow-sm transition hover:border-brand-400 hover:text-brand-700"
            >
              <IconPlus />
            </button>
          </div>

          <RowLabel label="Actions" sub="What the user does" tone="brand" />
          {stages.map((s) => (
            <ListCell
              key={`a-${s.id}`}
              items={s.actions}
              onChange={(items) => updateStage(s.id, { actions: items })}
            />
          ))}
          <span />

          <RowLabel label="Thoughts" sub="What they're thinking" tone="violet" />
          {stages.map((s) => (
            <ListCell
              key={`t-${s.id}`}
              items={s.thoughts}
              onChange={(items) => updateStage(s.id, { thoughts: items })}
              italic
            />
          ))}
          <span />

          <RowLabel label="Pains" sub="Friction & blockers" tone="rose" />
          {stages.map((s) => (
            <ListCell
              key={`p-${s.id}`}
              items={s.pains}
              onChange={(items) => updateStage(s.id, { pains: items })}
              tone="rose"
            />
          ))}
          <span />

          <RowLabel label="Opportunities" sub="Where to invest" tone="emerald" />
          {stages.map((s) => (
            <ListCell
              key={`o-${s.id}`}
              items={s.opportunities}
              onChange={(items) => updateStage(s.id, { opportunities: items })}
              tone="emerald"
            />
          ))}
          <span />
        </div>
      </div>
    </div>
  )
}

function RowLabel({
  label,
  sub,
  tone,
}: {
  label: string
  sub: string
  tone?: 'brand' | 'violet' | 'rose' | 'emerald'
}) {
  const accent = {
    brand: 'border-l-brand-500',
    violet: 'border-l-violet-500',
    rose: 'border-l-rose-500',
    emerald: 'border-l-emerald-500',
  }[tone ?? 'brand']
  return (
    <div className={`flex flex-col justify-center border-l-2 pl-3 ${accent}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content">
        {label}
      </div>
      <div className="text-[10px] text-content-subtle">{sub}</div>
    </div>
  )
}

function ListCell({
  items,
  onChange,
  tone = 'slate',
  italic = false,
}: {
  items: string[]
  onChange(items: string[]): void
  tone?: 'slate' | 'rose' | 'emerald'
  italic?: boolean
}) {
  const [draft, setDraft] = useState('')
  const dot = {
    slate: 'bg-content-subtle',
    rose: 'bg-rose-500',
    emerald: 'bg-emerald-500',
  }[tone]

  const add = () => {
    const v = draft.trim()
    if (!v) return
    onChange([...items, v])
    setDraft('')
  }

  return (
    <Card>
      <CardBody className="p-3">
        {items.length === 0 ? (
          <div className="text-xs text-content-subtle">— empty</div>
        ) : (
          <ul className="space-y-1.5">
            {items.map((it, i) => (
              <li key={i} className="group/cell flex items-start gap-2">
                <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${dot}`} />
                <span
                  className={`flex-1 text-xs leading-relaxed ${
                    italic ? 'italic text-content-muted' : 'text-content'
                  }`}
                >
                  {it}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                  aria-label="Remove"
                  className="opacity-0 transition-opacity group-hover/cell:opacity-100"
                >
                  <IconClose />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-1.5 border-t border-edge-subtle pt-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="Add item…"
            className="block w-full rounded-md border border-transparent bg-surface-sunken/40 px-1.5 py-0.5 text-[11px] text-content placeholder:text-content-subtle focus:border-edge-default focus:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </div>
      </CardBody>
    </Card>
  )
}

function EmotionCurve({ stages }: { stages: JourneyStage[] }) {
  const values = useMemo(() => stages.map((s) => EMOTION_VALUE[s.emotion]), [stages])
  if (values.length < 2) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-content-subtle">
        Add more stages to see the emotion curve
      </div>
    )
  }
  const W = 800
  const H = 140
  const PAD_X = 24
  const PAD_Y = 18
  const max = 2
  const min = -2
  const usable = W - PAD_X * 2
  const step = usable / (values.length - 1)
  const ys = values.map(
    (v) => PAD_Y + ((max - v) / (max - min)) * (H - PAD_Y * 2),
  )
  const points = values.map((_, i) => `${PAD_X + i * step},${ys[i]}`)
  const path = points.map((p, i) => (i === 0 ? `M${p}` : `L${p}`)).join(' ')
  const area = `${path} L${PAD_X + (values.length - 1) * step},${H - PAD_Y} L${PAD_X},${H - PAD_Y} Z`
  const smooth = values
    .map((_, i) => {
      const x = PAD_X + i * step
      const y = ys[i]
      if (i === 0) return `M${x},${y}`
      const px = PAD_X + (i - 1) * step
      const py = ys[i - 1]
      const cx = (px + x) / 2
      return `Q${cx},${py} ${cx},${(py + y) / 2} T${x},${y}`
    })
    .join(' ')

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" height={H}>
        <defs>
          <linearGradient id="emo-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-400)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-brand-400)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={H / 2}
          y2={H / 2}
          stroke="var(--color-edge-subtle)"
          strokeDasharray="3 4"
        />
        <path d={area} fill="url(#emo-fill)" />
        <path d={smooth} fill="none" stroke="var(--color-brand-500)" strokeWidth="2.5" strokeLinecap="round" />
        {values.map((_, i) => (
          <circle
            key={i}
            cx={PAD_X + i * step}
            cy={ys[i]}
            r={5}
            fill="white"
            stroke="var(--color-brand-500)"
            strokeWidth="2"
          />
        ))}
      </svg>
      <div className="grid px-6 pb-3 text-center" style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}>
        {stages.map((s) => (
          <div
            key={s.id}
            className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle"
          >
            {s.name}
          </div>
        ))}
      </div>
    </div>
  )
}

function CreateJourneyModal({
  open,
  onClose,
  personas,
  onCreate,
}: {
  open: boolean
  onClose(): void
  personas: Persona[]
  onCreate(input: { name: string; persona: string; summary: string }): void
}) {
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [summary, setSummary] = useState('')

  const submit = () => {
    const n = name.trim()
    if (!n) return
    onCreate({ name: n, persona, summary: summary.trim() })
    setName('')
    setPersona('')
    setSummary('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New journey map"
      description="Picks a persona and seeds four blank stages — Discover, Try, Adopt, Win."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>
            Create journey
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Operator first-run onboarding"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Persona">
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Summary">
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="A new operator signs up, connects a cluster, and ships a workload — under 15 minutes."
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconArrowLeft() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}
function IconArrowRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
