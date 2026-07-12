import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  priorityKind,
  useCreateIssue,
  useCycles,
  useLabels,
  useMembers,
  useModules,
  useStates,
} from '../data/plane.ts'

const PRIORITIES: plane.Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

/**
 * Plane-style new-issue modal with every property a user typically wants to
 * fill in at creation time: title, description, state, priority, assignees,
 * labels, estimate, dates, cycle, module.
 */
export function NewIssueModal({
  projectId,
  defaultState,
  onClose,
  onCreated,
}: {
  projectId: string
  defaultState?: string
  onClose(): void
  onCreated?(issue: plane.Issue): void
}) {
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const cycles = useCycles(projectId)
  const modules = useModules(projectId)
  const create = useCreateIssue(projectId)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [state, setState] = useState<string>(defaultState ?? '')
  const [priority, setPriority] = useState<plane.Priority>('none')
  const [assignees, setAssignees] = useState<string[]>([])
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [estimate, setEstimate] = useState<string>('')
  const [startDate, setStartDate] = useState<string>('')
  const [targetDate, setTargetDate] = useState<string>('')
  const [cycle, setCycle] = useState<string>('')
  const [module, setModule] = useState<string>('')

  // Pre-select the project's default state once the query resolves.
  useEffect(() => {
    if (state) return
    const fallback = states.data?.find((s) => s.default)?.id ?? states.data?.[0]?.id
    if (fallback) setState(fallback)
  }, [state, states.data])

  // ESC closes; ⌘+Enter submits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, state, priority, assignees, labelIds, estimate, startDate, targetDate, cycle, module])

  const canSubmit = name.trim().length > 0 && !!state && !create.isPending

  const submit = () => {
    if (!canSubmit) return
    const body: Partial<plane.Issue> = {
      name: name.trim(),
      state,
      priority,
      assignees,
      labels: labelIds,
      description_html: description ? `<p>${escapeHtml(description)}</p>` : undefined,
      estimate_point: estimate === '' ? null : Number(estimate),
      start_date: startDate || null,
      target_date: targetDate || null,
      cycle: cycle || null,
      module: module || null,
    }
    create.mutate(body, {
      onSuccess: (issue) => {
        onCreated?.(issue)
        onClose()
      },
    })
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-60 flex items-start justify-center px-4 py-12">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-edge-default bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-edge-subtle bg-linear-to-br from-brand-50 to-white px-6 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-brand-700">
              New issue
            </div>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-content">
              Capture work
            </h2>
            <p className="mt-0.5 text-[11px] text-content-muted">
              ⌘ Enter to create · Esc to dismiss
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="space-y-4 px-6 py-5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Issue title"
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-base font-medium text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a description… (Markdown-flavoured plain text)"
            rows={4}
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="State">
              <select
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="h-9 w-full rounded-md border border-edge-default bg-white px-2 text-sm"
              >
                {(states.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <div className="flex flex-wrap gap-1">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={cn(
                      'inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium ring-1 ring-inset transition-colors',
                      priority === p
                        ? 'ring-brand-500'
                        : 'ring-edge-default hover:ring-edge-strong',
                    )}
                  >
                    <StatusBadge kind={priorityKind(p)} dot={false}>
                      {p}
                    </StatusBadge>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Assignees">
              <ChipPicker
                items={(members.data ?? []).map((m) => ({
                  id: m.member?.id ?? m.id,
                  label: memberDisplayName(m),
                  initials: memberInitials(m),
                }))}
                selected={assignees}
                onChange={setAssignees}
                placeholder="Unassigned"
              />
            </Field>
            <Field label="Labels">
              <ChipPicker
                items={(labels.data ?? []).map((l) => ({
                  id: l.id,
                  label: l.name,
                  color: l.color,
                }))}
                selected={labelIds}
                onChange={setLabelIds}
                placeholder="No labels"
              />
            </Field>
            <Field label="Estimate">
              <input
                type="number"
                min={0}
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                placeholder="0"
                className="h-9 w-full rounded-md border border-edge-default bg-white px-2 text-sm"
              />
            </Field>
            <Field label="Cycle">
              <select
                value={cycle}
                onChange={(e) => setCycle(e.target.value)}
                className="h-9 w-full rounded-md border border-edge-default bg-white px-2 text-sm"
              >
                <option value="">None</option>
                {(cycles.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Module">
              <select
                value={module}
                onChange={(e) => setModule(e.target.value)}
                className="h-9 w-full rounded-md border border-edge-default bg-white px-2 text-sm"
              >
                <option value="">None</option>
                {(modules.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start date">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 w-full rounded-md border border-edge-default bg-white px-2 text-sm"
              />
            </Field>
            <Field label="Target date">
              <input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="h-9 w-full rounded-md border border-edge-default bg-white px-2 text-sm"
              />
            </Field>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-6 py-3">
          <div className="text-[11px] text-content-muted">
            {create.isError
              ? `Failed: ${(create.error as Error).message}`
              : 'Issue lands in the picked state — you can refine in the drawer afterwards.'}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={create.isPending} disabled={!canSubmit}>
              Create issue
            </Button>
          </div>
        </footer>
      </form>
    </div>,
    document.body,
  )
}

/* ───── atoms ───── */

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

function ChipPicker({
  items,
  selected,
  onChange,
  placeholder,
}: {
  items: Array<{ id: string; label: string; color?: string; initials?: string }>
  selected: string[]
  onChange(next: string[]): void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-edge-default bg-white px-2 py-1 text-left text-sm"
      >
        {selected.length === 0 ? (
          <span className="text-content-subtle">{placeholder}</span>
        ) : (
          items
            .filter((it) => selected.includes(it.id))
            .map((it) => (
              <span
                key={it.id}
                className="inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content"
              >
                {it.color ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: it.color }}
                  />
                ) : it.initials ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-50 text-[9px] font-semibold text-brand-700">
                    {it.initials}
                  </span>
                ) : null}
                {it.label}
              </span>
            ))
        )}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul className="absolute left-0 top-full z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-edge-default bg-white py-1 shadow-xl ring-1 ring-black/5">
            {items.length === 0 ? (
              <li className="px-3 py-2 text-xs text-content-subtle">No options</li>
            ) : (
              items.map((it) => {
                const on = selected.includes(it.id)
                return (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onChange(on ? selected.filter((s) => s !== it.id) : [...selected, it.id])
                      }
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                        on ? 'bg-brand-50 text-brand-800' : 'hover:bg-surface-sunken',
                      )}
                    >
                      {it.color ? (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: it.color }}
                        />
                      ) : it.initials ? (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700">
                          {it.initials}
                        </span>
                      ) : null}
                      <span className="flex-1 truncate">{it.label}</span>
                      {on ? <IconCheck /> : null}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </>
      ) : null}
    </div>
  )
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-brand-700">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
