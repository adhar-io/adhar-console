import { useState } from 'react'
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { memberDisplayName, useCycles, useMembers, useModules, useProjects } from '../data/plane.ts'
import {
  alignableParents,
  type CheckIn,
  currentQuarter,
  type KeyResult,
  type KrLink,
  krProgress,
  type KrType,
  type LinkResolver,
  type Objective,
  type ObjectiveData,
  type OkrLevel,
  shiftQuarter,
  uid,
} from '../data/okrs.ts'
import { IssueSearch } from './issue-search.tsx'

/** Create / edit an objective with its key results, and record check-ins. */

const LEVELS: Array<{ value: OkrLevel; label: string }> = [
  { value: 'company', label: 'Company' },
  { value: 'team', label: 'Team' },
  { value: 'individual', label: 'Individual' },
]

const KR_TYPES: Array<{ value: KrType; label: string }> = [
  { value: 'metric', label: 'Metric (start → target)' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'milestone', label: 'Milestones (checklist)' },
]

export function quarterOptions(around = currentQuarter()): string[] {
  return [-2, -1, 0, 1, 2, 3].map((d) => shiftQuarter(around, d))
}

const blankKr = (): KeyResult => ({ id: uid('kr'), title: '', type: 'metric', unit: '', start: 0, target: 100, current: 0, weight: 1, links: [], checkIns: [], milestones: [] })

export function ObjectiveEditor({
  open,
  onClose,
  initial,
  projectId,
  all,
  onSave,
  saving,
}: {
  open: boolean
  onClose(): void
  initial?: Objective
  projectId?: string
  all: Objective[]
  onSave(data: ObjectiveData, id?: string): void
  saving?: boolean
}) {
  const members = useMembers()
  const [d, setD] = useState<ObjectiveData>(() =>
    initial
      ? { ...initial }
      : { project: projectId ?? '', level: 'team', title: '', description: '', ownerId: '', quarter: currentQuarter(), key_results: [blankKr()] }
  )
  const set = (patch: Partial<ObjectiveData>) => setD((x) => ({ ...x, ...patch }))
  const setKr = (id: string, patch: Partial<KeyResult>) => set({ key_results: d.key_results.map((k) => (k.id === id ? { ...k, ...patch } : k)) })
  const parents = alignableParents(initial ? { id: initial.id } : null, all).filter((o) => o.quarter === d.quarter)
  const valid = d.title.trim() && d.key_results.every((k) => k.title.trim())
  const memberOptions = [{ value: '', label: 'Unassigned' }, ...(members.data ?? []).map((m) => ({ value: m.member?.id ?? m.id, label: memberDisplayName(m) }))]

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xl"
      title={initial ? 'Edit objective' : 'New objective'}
      description="Objectives are stored by the console (Plane has no goals API)."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!valid}
            onClick={() => onSave({ ...d, project: d.level === 'company' ? '' : d.project || projectId || '', title: d.title.trim() }, initial?.id)}
          >
            {initial ? 'Save' : 'Create objective'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Objective" required>
          <Input value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Make onboarding effortless" autoFocus />
        </Field>
        <Field label="Why it matters">
          <Textarea rows={2} value={d.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Level">
            <Select value={d.level ?? 'team'} onChange={(e) => set({ level: e.target.value as OkrLevel })} options={LEVELS} />
          </Field>
          <Field label="Quarter">
            <Select value={d.quarter} onChange={(e) => set({ quarter: e.target.value })} options={quarterOptions(d.quarter).map((q) => ({ value: q, label: q }))} />
          </Field>
          <Field label="Owner">
            <Select value={d.ownerId} onChange={(e) => set({ ownerId: e.target.value })} options={memberOptions} />
          </Field>
          <Field label={d.level === 'team' ? 'Team' : 'Aligns to'} hint={d.level === 'team' ? 'Console team name (optional)' : undefined}>
            {d.level === 'team'
              ? <Input value={d.team ?? ''} onChange={(e) => set({ team: e.target.value })} placeholder="platform" />
              : <Select value={d.parentId ?? ''} onChange={(e) => set({ parentId: e.target.value || undefined })} options={[{ value: '', label: 'Nothing (top level)' }, ...parents.map((o) => ({ value: o.id, label: o.title }))]} />}
          </Field>
        </div>
        {d.level === 'team'
          ? (
            <Field label="Aligns to">
              <Select value={d.parentId ?? ''} onChange={(e) => set({ parentId: e.target.value || undefined })} options={[{ value: '', label: 'Nothing (top level)' }, ...parents.map((o) => ({ value: o.id, label: `${o.title}${o.level ? ` (${o.level})` : ''}` }))]} />
            </Field>
          )
          : null}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-content">Key results</h3>
            <Button size="sm" onClick={() => set({ key_results: [...d.key_results, blankKr()] })}>+ Key result</Button>
          </div>
          {d.key_results.length === 0 ? <p className="text-[12px] text-content-subtle">No key results — progress will roll up from aligned objectives.</p> : null}
          {d.key_results.map((kr, idx) => (
            <KrEditor
              key={kr.id}
              kr={kr}
              index={idx}
              projectId={d.project || projectId}
              memberOptions={memberOptions}
              onChange={(p) => setKr(kr.id, p)}
              onRemove={() => set({ key_results: d.key_results.filter((k) => k.id !== kr.id) })}
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}

function num(s: string, fallback = 0): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

function KrEditor({ kr, index, projectId, memberOptions, onChange, onRemove }: {
  kr: KeyResult
  index: number
  projectId?: string
  memberOptions: Array<{ value: string; label: string }>
  onChange(p: Partial<KeyResult>): void
  onRemove(): void
}) {
  const type = kr.type ?? 'metric'
  return (
    <div className="space-y-3 rounded-lg border border-edge-default bg-surface-sunken/30 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-2 text-[11px] font-semibold text-content-subtle">KR{index + 1}</span>
        <Input className="flex-1" value={kr.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="e.g. Cut time-to-first-deploy from 3 days to 1 hour" aria-label="Key result" />
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove key result">✕</Button>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
        <Field label="Type">
          <Select value={type} onChange={(e) => onChange({ type: e.target.value as KrType, ...(e.target.value === 'percentage' ? { unit: '%', start: 0, target: 100 } : {}) })} options={KR_TYPES} />
        </Field>
        {type !== 'milestone'
          ? (
            <>
              <Field label="Start"><Input type="number" value={kr.start} onChange={(e) => onChange({ start: num(e.target.value) })} /></Field>
              <Field label="Target"><Input type="number" value={kr.target} onChange={(e) => onChange({ target: num(e.target.value) })} /></Field>
              <Field label="Current"><Input type="number" value={kr.current} onChange={(e) => onChange({ current: num(e.target.value) })} /></Field>
              <Field label="Unit"><Input value={kr.unit} onChange={(e) => onChange({ unit: e.target.value })} placeholder="ms, %, users" /></Field>
            </>
          )
          : <div className="col-span-1 lg:col-span-4" />}
        <Field label="Weight"><Input type="number" min={0} step={0.5} value={kr.weight ?? 1} onChange={(e) => onChange({ weight: Math.max(0, num(e.target.value, 1)) })} /></Field>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Owner"><Select value={kr.ownerId ?? ''} onChange={(e) => onChange({ ownerId: e.target.value || undefined })} options={memberOptions} /></Field>
      </div>
      {type === 'milestone' ? <MilestonesEditor kr={kr} onChange={onChange} /> : null}
      <LinksEditor kr={kr} projectId={projectId} onChange={onChange} />
    </div>
  )
}

function MilestonesEditor({ kr, onChange }: { kr: KeyResult; onChange(p: Partial<KeyResult>): void }) {
  const [title, setTitle] = useState('')
  const ms = kr.milestones ?? []
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Milestones</div>
      {ms.map((m) => (
        <div key={m.id} className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={m.done} onChange={() => onChange({ milestones: ms.map((x) => (x.id === m.id ? { ...x, done: !x.done } : x)) })} aria-label={`Done: ${m.title}`} />
          <span className={cn('flex-1', m.done && 'text-content-subtle line-through')}>{m.title}</span>
          <button type="button" className="text-[11px] text-content-subtle hover:text-rose-600" onClick={() => onChange({ milestones: ms.filter((x) => x.id !== m.id) })}>Remove</button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim()) return
          onChange({ milestones: [...ms, { id: uid('ms'), title: title.trim(), done: false }] })
          setTitle('')
        }}
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a milestone" aria-label="New milestone" />
        <Button size="sm" type="submit">Add</Button>
      </form>
    </div>
  )
}

function LinksEditor({ kr, projectId, onChange }: { kr: KeyResult; projectId?: string; onChange(p: Partial<KeyResult>): void }) {
  const [kind, setKind] = useState<KrLink['kind']>('module')
  const projects = useProjects()
  const [pid, setPid] = useState(projectId ?? '')
  const modules = useModules(pid || undefined)
  const cycles = useCycles(pid || undefined)
  const links = kr.links ?? []
  const add = (l: KrLink) => {
    if (links.some((x) => x.kind === l.kind && x.id === l.id)) return
    onChange({ links: [...links, l] })
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Linked Plane work</div>
        <label className="inline-flex items-center gap-1.5 text-[12px] text-content-muted">
          <input type="checkbox" checked={!!kr.auto} onChange={(e) => onChange({ auto: e.target.checked })} disabled={!links.length} />
          Progress follows linked work
        </label>
      </div>
      {links.length
        ? (
          <div className="flex flex-wrap gap-1.5">
            {links.map((l) => (
              <span key={`${l.kind}:${l.id}`} className="inline-flex items-center gap-1 rounded-full border border-edge-default bg-surface-raised px-2 py-0.5 text-[11px] text-content">
                <span className="text-content-subtle">{l.kind === 'module' ? 'Epic' : l.kind === 'cycle' ? 'Sprint' : 'Issue'}</span> {l.label}
                <button type="button" aria-label={`Unlink ${l.label}`} className="text-content-subtle hover:text-rose-600" onClick={() => onChange({ links: links.filter((x) => x !== l), auto: links.length > 1 ? kr.auto : false })}>✕</button>
              </span>
            ))}
          </div>
        )
        : <p className="text-[11px] text-content-subtle">Link an epic, sprint or issues to track this key result from real delivery.</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_10rem_1fr]">
        <Select aria-label="Link kind" value={kind} onChange={(e) => setKind(e.target.value as KrLink['kind'])} options={[{ value: 'module', label: 'Epic (module)' }, { value: 'cycle', label: 'Sprint (cycle)' }, { value: 'issue', label: 'Issue' }]} />
        <Select aria-label="Project" value={pid} onChange={(e) => setPid(e.target.value)} options={[{ value: '', label: 'Project…' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        {kind === 'issue'
          ? <IssueSearch project={pid || undefined} onPick={(h) => add({ kind: 'issue', project: h.project_id, id: h.id, label: `${h.project__identifier}-${h.sequence_id}` })} exclude={links.map((l) => l.id)} placeholder="Find an issue…" />
          : (
            <Select
              aria-label={kind === 'module' ? 'Epic' : 'Sprint'}
              value=""
              disabled={!pid}
              onChange={(e) => {
                const list = kind === 'module' ? modules.data ?? [] : cycles.data ?? []
                const x = list.find((m) => m.id === e.target.value)
                if (x) add({ kind, project: pid, id: x.id, label: x.name })
              }}
              options={[{ value: '', label: pid ? `Add ${kind === 'module' ? 'an epic' : 'a sprint'}…` : 'Pick a project first' }, ...((kind === 'module' ? modules.data : cycles.data) ?? []).map((m) => ({ value: m.id, label: m.name }))]}
            />
          )}
      </div>
    </div>
  )
}

/* ───── check-in ───── */

export function CheckInModal({ open, onClose, kr, resolve, onSave, saving, by }: {
  open: boolean
  onClose(): void
  kr: KeyResult
  resolve?: LinkResolver
  onSave(next: KeyResult): void
  saving?: boolean
  by?: string
}) {
  const toast = useToast()
  const type = kr.type ?? 'metric'
  const [value, setValue] = useState(String(kr.current))
  const [ms, setMs] = useState(kr.milestones ?? [])
  const [confidence, setConfidence] = useState(kr.checkIns?.at(-1)?.confidence ?? 7)
  const [note, setNote] = useState('')
  const draft: KeyResult = { ...kr, current: num(value, kr.current), milestones: ms }
  const progress = krProgress(draft, resolve)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Check in"
      description={kr.title}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => {
              const c: CheckIn = { id: uid('ci'), at: new Date().toISOString(), by, value: type === 'milestone' ? progress : draft.current, progress, confidence, note: note.trim() || undefined }
              onSave({ ...draft, checkIns: [...(kr.checkIns ?? []), c] })
              toast.success('Check-in recorded')
            }}
          >
            Record check-in
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {kr.auto
          ? <p className="rounded-lg bg-surface-sunken/60 px-3 py-2 text-[12px] text-content-muted">Progress follows the linked Plane work ({progress}% now). The check-in records it with your confidence and note.</p>
          : type === 'milestone'
          ? (
            <div className="space-y-1.5">
              {ms.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={m.done} onChange={() => setMs(ms.map((x) => (x.id === m.id ? { ...x, done: !x.done } : x)))} />
                  <span className={cn(m.done && 'text-content-subtle line-through')}>{m.title}</span>
                </label>
              ))}
              {!ms.length ? <p className="text-[12px] text-content-subtle">No milestones defined — edit the objective to add some.</p> : null}
            </div>
          )
          : (
            <Field label={`Current value${kr.unit ? ` (${kr.unit})` : ''}`} hint={`Start ${kr.start} → target ${kr.target}`}>
              <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </Field>
          )}
        <div className="text-[12px] text-content-muted">Progress after this check-in: <span className="font-semibold tabular-nums text-content">{progress}%</span></div>
        <Field label={`Confidence: ${confidence}/10`} hint="How likely is the target by quarter end?">
          <input type="range" min={0} max={10} step={1} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} className="w-full accent-brand-600" aria-label="Confidence" />
        </Field>
        <Field label="Note">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What moved, what's blocking, what's next" />
        </Field>
      </div>
    </Modal>
  )
}

export function GradeModal({ open, onClose, objective, suggested, onSave, saving }: {
  open: boolean
  onClose(): void
  objective: Objective
  suggested: number
  onSave(score: number | undefined): void
  saving?: boolean
}) {
  const [score, setScore] = useState(objective.score ?? suggested)
  return (
    <Modal
      open={open}
      onClose={onClose}
      width="sm"
      title="Grade objective"
      description={objective.title}
      footer={
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => onSave(undefined)} disabled={objective.score === undefined}>Use computed score</Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => onSave(Math.round(score * 10) / 10)}>Save grade</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="text-3xl font-semibold tabular-nums text-content">{score.toFixed(1)}</div>
        <input type="range" min={0} max={1} step={0.1} value={score} onChange={(e) => setScore(Number(e.target.value))} className="w-full accent-brand-600" aria-label="Score" />
        <p className="text-[12px] text-content-muted">0.7–1.0 hit · 0.4–0.6 made progress · 0.0–0.3 missed. Computed from progress: {suggested.toFixed(1)}.</p>
      </div>
    </Modal>
  )
}
