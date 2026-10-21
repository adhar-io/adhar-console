import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, useOptionalUser, useOverlayDismiss, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError, useCreateIssue, useMembers, useProjects } from '../data/plane.ts'
import { useScopeMeta } from '../data/work-hooks.ts'
import { useEstimatePoints } from '../data/planning-plane.ts'
import { useWorkRules, viewOf } from '../data/work-rules.ts'
import { BUILTIN_TEMPLATES, KINDS, type RequiredField, storeError, type TemplateDoc, useCreateDoc, useDocs } from '../data/work-store.ts'
import { markdownToHtml, withAttribution } from '../data/work-text.ts'
import { IssueSearch } from './issue-search.tsx'
import { RichView } from './rich-editor.tsx'
import { memberItems } from './issue-fields.tsx'
import { ConsoleSide, IconClose, LabelChip, PickButton, PRIORITIES, PRIORITY_LABEL, PriorityIcon, StateDot } from './work-ui.tsx'

/**
 * Create a work item: templates (Bug / Story / Task / Spike + saved ones),
 * project, type, parent, every Plane property, required-field validation per
 * template, Markdown description with preview, "create another", ⌘↵.
 *
 * Plane CE has no work-item types; the type is applied as the project's
 * matching label when one exists ("bug", "story"…) and said so.
 */

type Defaults = Partial<Pick<plane.Issue, 'state' | 'priority' | 'assignees' | 'labels' | 'cycle' | 'module' | 'parent' | 'target_date'>>

export function NewIssueModal({
  projectId,
  defaultState,
  defaults,
  onClose,
  onCreated,
}: {
  projectId: string
  defaultState?: string
  defaults?: Defaults
  onClose(): void
  onCreated?(issue: plane.Issue): void
}) {
  const [project, setProject] = useState(projectId)
  const projects = useProjects()
  const meta = useScopeMeta([project])
  const members = useMembers()
  const create = useCreateIssue(project)
  // Plane estimates when the project exposes points; otherwise console story points (define.points).
  const planePoints = useEstimatePoints(project)
  const planeEstimates = !!planePoints.data?.length
  const rules = useWorkRules([project], meta.states)
  const user = useOptionalUser()
  const toast = useToast()
  const saved = useDocs<TemplateDoc>(KINDS.template)
  const saveTemplate = useCreateDoc<TemplateDoc>(KINDS.template)

  const templates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...(saved.data ?? []).filter((t) => !t.data.projectId || t.data.projectId === project).map((t) => ({ ...t.data, id: t.id }))],
    [saved.data, project],
  )
  const [templateId, setTemplateId] = useState<string>('builtin-task')
  const template = templates.find((t) => t.id === templateId) ?? BUILTIN_TEMPLATES[2]

  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [preview, setPreview] = useState(false)
  const [state, setState] = useState(defaultState ?? defaults?.state ?? '')
  const [priority, setPriority] = useState<plane.Priority>(defaults?.priority ?? 'none')
  const [assignees, setAssignees] = useState<string[]>(defaults?.assignees ?? [])
  const [labels, setLabels] = useState<string[]>(defaults?.labels ?? [])
  const [estimate, setEstimate] = useState('')
  const [start, setStart] = useState('')
  const [due, setDue] = useState(defaults?.target_date ?? '')
  const [cycle, setCycle] = useState(defaults?.cycle ?? '')
  const [module, setModule] = useState(defaults?.module ?? '')
  const [parent, setParent] = useState<{ id: string; key: string } | null>(defaults?.parent ? { id: defaults.parent, key: 'parent' } : null)
  const [another, setAnother] = useState(false)
  const [touched, setTouched] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useOverlayDismiss(true, onClose)

  const states = meta.states.filter((s) => s.project === project)
  const projLabels = meta.labels.filter((l) => l.project === project)
  const cycles = meta.cycles.filter((c) => c.project === project && c.status !== 'completed')
  const modules = meta.modules.filter((m) => m.project === project)

  // Default state once the project's states arrive (or the project changes).
  useEffect(() => {
    if (state && states.some((s) => s.id === state)) return
    const d = states.find((s) => s.default)?.id ?? states[0]?.id
    if (d) setState(d)
  }, [states, state])

  // Apply a template: body, priority, matching labels.
  const applyTemplate = (id: string) => {
    setTemplateId(id)
    const t = templates.find((x) => x.id === id)
    if (!t) return
    if (t.description_md !== undefined && (!desc.trim() || templates.some((x) => x.description_md === desc))) setDesc(t.description_md ?? '')
    if (t.priority) setPriority(t.priority as plane.Priority)
    if (t.title && !name) setName(t.title)
    const names = (t.labelNames ?? []).map((n) => n.toLowerCase())
    const match = projLabels.filter((l) => names.includes(l.name.toLowerCase())).map((l) => l.id)
    if (match.length) setLabels((cur) => [...new Set([...cur, ...match])])
  }
  const typeLabel = projLabels.find((l) => (template.labelNames ?? []).map((n) => n.toLowerCase()).includes(l.name.toLowerCase()))

  const missing: RequiredField[] = (template.required ?? []).filter((f) =>
    f === 'description' ? !desc.trim() || desc.trim() === (template.description_md ?? '').trim()
      : f === 'priority' ? priority === 'none'
      : f === 'assignee' ? !assignees.length
      : f === 'estimate' ? estimate.trim() === ''
      : f === 'due' ? !due
      : f === 'labels' ? !labels.length
      : false
  )
  const canSubmit = !!name.trim() && !!state && !missing.length && !create.isPending

  const reset = () => {
    setName('')
    setDesc(template.description_md ?? '')
    setEstimate('')
    setTouched(false)
    titleRef.current?.focus()
  }

  const submit = () => {
    setTouched(true)
    if (!canSubmit) return
    const html = desc.trim() ? markdownToHtml(desc) : ''
    const body: Partial<plane.Issue> = {
      name: name.trim(),
      state,
      priority,
      assignees,
      labels,
      description_html: withAttribution(html, user, 'created via Adhar console'),
      estimate_point: planeEstimates && estimate.trim() !== '' ? Number(estimate) : null,
      start_date: start || null,
      target_date: due || null,
      cycle: cycle || null,
      module: module || null,
      parent: parent?.id ?? null,
    }
    create.mutate(body, {
      onSuccess: (issue) => {
        const pts = estimate.trim() === '' ? null : Number(estimate)
        if (!planeEstimates && pts !== null && Number.isFinite(pts)) rules.setPoints({ id: issue.id, project }, pts).catch((e) => toast.error(storeError(e)))
        rules.automate('created', undefined, viewOf({ ...issue, project }))
        const p = projects.data?.find((x) => x.id === project)
        toast.success(`Created ${p ? `${p.identifier}-${issue.sequence_id}` : issue.name}`)
        onCreated?.(issue)
        if (another) reset()
        else onClose()
      },
      onError: (e) => toast.error(planeError(e, "Couldn't create the work item.")),
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  })

  const field = 'h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[13px] text-content focus:border-brand-400 focus:outline-none'
  const req = (f: RequiredField) => (template.required ?? []).includes(f)
  const bad = (f: RequiredField) => touched && missing.includes(f)

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-60 flex items-end justify-center sm:items-start sm:px-4 sm:py-8" role="dialog" aria-modal="true" aria-label="New work item">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" />
      <form onSubmit={(e) => { e.preventDefault(); submit() }} className="relative flex max-h-[95dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-edge-default bg-surface-raised shadow-2xl sm:rounded-2xl">
        <header className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-5 py-3">
          <select value={project} onChange={(e) => { setProject(e.target.value); setState(''); setLabels([]); setCycle(''); setModule(''); setParent(null) }} aria-label="Project" className="h-8 max-w-[12rem] rounded-md border border-edge-default bg-surface-raised px-2 text-[12.5px] font-medium">
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.identifier} · {p.name}</option>)}
          </select>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Template">
            {templates.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} onClick={() => applyTemplate(t.id)} className={cn('rounded-full border px-2.5 py-0.5 text-[12px] font-medium', templateId === t.id ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'border-edge-default text-content-muted hover:text-content')}>
                {t.name}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"><IconClose /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <input ref={titleRef} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Title" aria-label="Title" aria-invalid={touched && !name.trim()} className={cn('block w-full border-0 bg-transparent px-0 text-lg font-semibold text-content placeholder:text-content-subtle focus:outline-none', touched && !name.trim() ? 'placeholder:text-rose-500' : '')} />
          <div className={cn('rounded-lg border', bad('description') ? 'border-rose-400' : 'border-edge-default')}>
            <div className="flex items-center gap-1 border-b border-edge-subtle px-2 pt-1">
              <button type="button" onClick={() => setPreview(false)} className={cn('px-2 pb-1 text-[11.5px] font-medium', !preview ? 'text-content' : 'text-content-subtle')}>Write</button>
              <button type="button" onClick={() => setPreview(true)} className={cn('px-2 pb-1 text-[11.5px] font-medium', preview ? 'text-content' : 'text-content-subtle')}>Preview</button>
              <span className="ml-auto pb-1 text-[11px] text-content-subtle">Markdown{req('description') ? ' · required' : ''}</span>
            </div>
            {preview ? <RichView html={markdownToHtml(desc) || '<p>Nothing to preview.</p>'} className="min-h-32 px-3 py-2" /> : (
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={7} placeholder="Description…" aria-label="Description" className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12.5px] text-content placeholder:font-sans placeholder:text-content-subtle focus:outline-none" />
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Status">
              <select value={state} onChange={(e) => setState(e.target.value)} className={field} aria-label="Status">
                {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Priority" required={req('priority')} invalid={bad('priority')}>
              <PickButton items={PRIORITIES.map((p) => ({ id: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))} selected={[priority]} onPick={(p) => setPriority(p as plane.Priority)} className={cn(field, 'flex items-center gap-2 text-left')} width={200}>
                <PriorityIcon priority={priority} /> {PRIORITY_LABEL[priority]}
              </PickButton>
            </Field>
            <Field label="Assignees" required={req('assignee')} invalid={bad('assignee')}>
              <PickButton items={memberItems(members.data ?? [])} selected={assignees} multi onPick={(id) => setAssignees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]))} className={cn(field, 'truncate text-left')}>
                {assignees.length ? `${assignees.length} assignee${assignees.length === 1 ? '' : 's'}` : <span className="text-content-subtle">Unassigned</span>}
              </PickButton>
            </Field>
            <Field label="Labels" required={req('labels')} invalid={bad('labels')}>
              <PickButton items={projLabels.map((l) => ({ id: l.id, label: l.name, icon: <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} /> }))} selected={labels} multi onPick={(id) => setLabels((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]))} className={cn(field, 'flex items-center gap-1 overflow-hidden text-left')}>
                {labels.length ? labels.slice(0, 2).map((id) => { const l = projLabels.find((x) => x.id === id); return l ? <LabelChip key={id} label={l} /> : null }) : <span className="text-content-subtle">None</span>}
                {labels.length > 2 ? <span className="text-[11px] text-content-subtle">+{labels.length - 2}</span> : null}
              </PickButton>
            </Field>
            <Field label="Estimate" required={req('estimate')} invalid={bad('estimate')}>
              <input inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder={planeEstimates ? 'Plane points' : 'Story points (console)'} className={field} aria-label="Estimate" />
            </Field>
            <Field label="Start">
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={field} aria-label="Start date" />
            </Field>
            <Field label="Due" required={req('due')} invalid={bad('due')}>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} aria-label="Due date" />
            </Field>
            <Field label="Sprint">
              <select value={cycle} onChange={(e) => setCycle(e.target.value)} className={field} aria-label="Sprint">
                <option value="">Backlog (no sprint)</option>
                {cycles.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.status}</option>)}
              </select>
            </Field>
            <Field label="Epic">
              <select value={module} onChange={(e) => setModule(e.target.value)} className={field} aria-label="Epic">
                <option value="">None</option>
                {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Parent">
            {parent ? (
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-mono text-[12px] text-content">{parent.key}</span>
                <button type="button" onClick={() => setParent(null)} className="text-[12px] text-content-subtle hover:text-rose-600">Remove</button>
              </div>
            ) : (
              <IssueSearch project={project} placeholder="Make this a sub-task of… (title or KEY-123)" onPick={(h) => setParent({ id: h.id, key: `${h.project__identifier}-${h.sequence_id} ${h.name}` })} />
            )}
          </Field>
          <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-content-subtle">
            <StateDot state={states.find((s) => s.id === state)} />
            Type <strong className="text-content-muted">{template.name}</strong>
            {template.type !== 'custom' ? (typeLabel ? <> — tagged with the project's “{typeLabel.name}” label (Plane CE has no work-item types).</> : <> — no matching label in this project, so the type isn't recorded in Plane.</>) : null}
          </p>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-5 py-3">
          {touched && missing.length ? <span className="text-[12px] text-rose-700 dark:text-rose-300">Required by {template.name}: {missing.join(', ')}</span> : (
            <label className="flex items-center gap-1.5 text-[12px] text-content-muted">
              <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} className="accent-brand-600" /> Create another
            </label>
          )}
          <button
            type="button"
            className="text-[12px] text-content-subtle hover:text-content"
            title="Save the current body, priority and labels as a template for this project (console-side)"
            onClick={() => {
              const tname = globalThis.prompt?.('Template name')
              if (!tname?.trim()) return
              saveTemplate.mutate({
                name: tname.trim(),
                type: 'custom',
                projectId: project,
                description_md: desc,
                priority,
                labelNames: labels.map((id) => projLabels.find((l) => l.id === id)?.name ?? '').filter(Boolean),
                required: [],
              }, { onSuccess: () => toast.success(`Saved template “${tname.trim()}”`), onError: (e) => toast.error(storeError(e)) })
            }}
          >
            Save as template <ConsoleSide />
          </button>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" loading={create.isPending} disabled={!name.trim() || !state}>Create <span className="ml-1 hidden text-[10px] opacity-75 sm:inline">⌘↵</span></Button>
          </div>
        </footer>
      </form>
    </div>,
    document.body,
  )
}

function Field({ label, children, required, invalid }: { label: string; children: React.ReactNode; required?: boolean; invalid?: boolean }) {
  return (
    <div>
      <span className={cn('mb-1 block text-[11px] font-semibold uppercase tracking-wider', invalid ? 'text-rose-600' : 'text-content-subtle')}>
        {label}{required ? ' *' : ''}
      </span>
      {children}
    </div>
  )
}
