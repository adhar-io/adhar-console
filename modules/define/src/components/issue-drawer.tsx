import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import type { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  priorityKind,
  useActivities,
  useComments,
  useCreateComment,
  useCreateIssue,
  useCycles,
  useDeleteIssue,
  useIssue,
  useLabels,
  useMembers,
  useModules,
  useStates,
  useSubIssues,
  useUpdateIssue,
} from '../data/plane.ts'

/**
 * Plane-style issue detail drawer.
 *
 * Sticks to the right side of the viewport and lets the operator do
 * everything you'd otherwise do in Plane:
 *   • Inline-edit title (Enter to save, Esc to revert).
 *   • Change state (dropdown), priority, assignees (multi), labels (multi),
 *     start_date / target_date, estimate, cycle, module — every change PATCHes
 *     and invalidates the right query keys so the board re-renders.
 *   • View / add / delete comments (rich-text → server stores HTML).
 *   • Read activity log.
 *   • Browse sub-issues + jump into them.
 */

interface Props {
  projectId: string
  issueId: string
  onClose(): void
  onPick(id: string): void
}

export function IssueDrawer({ projectId, issueId, onClose, onPick }: Props) {
  const issue = useIssue(projectId, issueId)
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const cycles = useCycles(projectId)
  const modules = useModules(projectId)
  const subs = useSubIssues(projectId, issueId)
  const update = useUpdateIssue(projectId)
  const remove = useDeleteIssue(projectId)
  const create = useCreateIssue(projectId)

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stateMap = useMemo(
    () => new Map((states.data ?? []).map((s) => [s.id, s])),
    [states.data],
  )
  const memberMap = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m])),
    [members.data],
  )

  const i = issue.data
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              {i?.sequence_id ? `#${i.sequence_id}` : 'issue'}
              {update.isPending ? (
                <span className="inline-flex items-center gap-1 text-content-muted">
                  <Spinner size={11} /> saving
                </span>
              ) : null}
            </div>
            {i ? (
              <TitleField
                value={i.name}
                onSave={(name) => update.mutate({ id: i.id, patch: { name } })}
              />
            ) : (
              <div className="mt-1 h-6 w-72 animate-pulse rounded bg-edge-default/40" />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {i ? (
              <IssueActionsMenu
                issue={i}
                onCopyLink={() => {
                  const url =
                    typeof window !== 'undefined'
                      ? `${window.location.origin}/define?section=issues&issue=${i.id}`
                      : i.id
                  navigator.clipboard?.writeText(url)
                }}
                onDuplicate={() => {
                  create.mutate(
                    {
                      name: `${i.name} (copy)`,
                      state: i.state,
                      priority: i.priority,
                      assignees: i.assignees,
                      labels: i.labels,
                      description_html: i.description_html,
                      estimate_point: i.estimate_point ?? null,
                      cycle: i.cycle ?? null,
                      module: i.module ?? null,
                    } as Partial<plane.Issue>,
                    { onSuccess: (next) => onPick(next.id) },
                  )
                }}
                onDelete={() => {
                  if (!confirm(`Delete "${i.name}"? This can't be undone.`)) return
                  remove.mutate(i.id, { onSuccess: onClose })
                }}
              />
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[1fr_280px]">
          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <DescriptionBlock
              issue={i}
              onSave={(description_html) =>
                i ? update.mutate({ id: i.id, patch: { description_html } }) : null
              }
            />

            <SubIssuesBlock
              issues={subs.data ?? []}
              loading={subs.isLoading}
              onPick={onPick}
              stateMap={stateMap}
            />

            <CommentsBlock projectId={projectId} issueId={issueId} memberMap={memberMap} />
            <ActivityBlock projectId={projectId} issueId={issueId} memberMap={memberMap} />
          </div>

          <aside className="border-t border-edge-subtle bg-white px-5 py-5 md:border-l md:border-t-0 md:overflow-y-auto">
            {!i ? (
              <div className="space-y-4">
                {Array.from({ length: 8 }).map((_, idx) => (
                  <div key={idx} className="h-6 animate-pulse rounded bg-edge-default/40" />
                ))}
              </div>
            ) : (
              <PropertiesPanel
                issue={i}
                states={states.data ?? []}
                labels={labels.data ?? []}
                members={members.data ?? []}
                cycles={cycles.data ?? []}
                modules={modules.data ?? []}
                onPatch={(patch) => update.mutate({ id: i.id, patch })}
              />
            )}
          </aside>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ───── title editor ───── */

function TitleField({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-0.5 -ml-1 truncate rounded px-1 py-0.5 text-left text-lg font-semibold tracking-tight text-content hover:bg-surface-sunken"
      >
        {value}
      </button>
    )
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft !== value) onSave(draft.trim())
        setEditing(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
      className="mt-0.5 -ml-1 w-full rounded border border-brand-400 bg-white px-1 py-0.5 text-lg font-semibold tracking-tight text-content focus:outline-none focus:ring-2 focus:ring-brand-400/25"
    />
  )
}

/* ───── description ───── */

function DescriptionBlock({
  issue,
  onSave,
}: {
  issue?: plane.Issue
  onSave(html: string): void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    setDraft(issue?.description_html ?? '')
  }, [issue?.id])
  if (!issue) return null
  return (
    <Section
      title="Description"
      action={
        editing ? (
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(issue.description_html ?? '')
                setEditing(false)
              }}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              onClick={() => {
                onSave(draft)
                setEditing(false)
              }}
            >
              Save
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 font-mono text-xs text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          placeholder="Plane stores HTML — paste rich text or write Markdown-flavoured prose."
        />
      ) : issue.description_stripped || issue.description_html ? (
        <div
          className="prose prose-sm max-w-none text-sm leading-relaxed text-content"
          dangerouslySetInnerHTML={{
            __html:
              issue.description_html ||
              `<p>${escapeHtml(issue.description_stripped ?? '')}</p>`,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full rounded-lg border border-dashed border-edge-default bg-surface-sunken/40 px-3 py-4 text-left text-sm text-content-subtle hover:bg-surface-sunken hover:text-content-muted"
        >
          Add a description…
        </button>
      )}
    </Section>
  )
}

/* ───── sub-issues ───── */

function SubIssuesBlock({
  issues,
  loading,
  onPick,
  stateMap,
}: {
  issues: plane.Issue[]
  loading: boolean
  onPick(id: string): void
  stateMap: Map<string, plane.State>
}) {
  if (loading) return null
  if (!issues.length) return null
  const done = issues.filter((i) => i.completed_at).length
  return (
    <Section
      title="Sub-issues"
      action={
        <span className="text-[11px] text-content-subtle">
          {done}/{issues.length} done
        </span>
      }
    >
      <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default bg-white">
        {issues.map((s) => {
          const st = stateMap.get(s.state)
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s.id)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-brand-50/40"
              >
                {st ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: st.color }}
                  />
                ) : null}
                <span className="font-mono text-[10px] uppercase text-content-subtle">
                  #{s.sequence_id}
                </span>
                <span className="flex-1 truncate text-content">{s.name}</span>
                <StatusBadge kind={priorityKind(s.priority)} dot={false}>
                  {s.priority}
                </StatusBadge>
              </button>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/* ───── comments ───── */

function CommentsBlock({
  projectId,
  issueId,
  memberMap,
}: {
  projectId: string
  issueId: string
  memberMap: Map<string, plane.Member>
}) {
  const q = useComments(projectId, issueId)
  const create = useCreateComment(projectId, issueId)
  const [draft, setDraft] = useState('')
  return (
    <Section
      title="Comments"
      action={<span className="text-[11px] text-content-subtle">{q.data?.length ?? 0}</span>}
    >
      <div className="space-y-3">
        <ul className="space-y-2">
          {(q.data ?? []).map((c) => {
            const m =
              memberMap.get(c.actor) ??
              ({
                member: c.actor_detail
                  ? {
                      id: c.actor,
                      display_name: c.actor_detail.display_name,
                      email: c.actor_detail.email ?? '',
                      avatar: c.actor_detail.avatar ?? null,
                    }
                  : undefined,
              } as plane.Member)
            return (
              <li
                key={c.id}
                className="flex items-start gap-2.5 rounded-lg border border-edge-subtle bg-white p-3"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                  {memberInitials(m)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-content">
                      {memberDisplayName(m)}
                    </span>
                    <span className="text-[11px] text-content-subtle">
                      {formatRelative(c.created_at)}
                    </span>
                  </div>
                  <div
                    className="mt-1 text-sm leading-relaxed text-content"
                    dangerouslySetInnerHTML={{
                      __html: c.comment_html ?? `<p>${escapeHtml(c.comment_stripped ?? '')}</p>`,
                    }}
                  />
                </div>
              </li>
            )
          })}
          {(q.data?.length ?? 0) === 0 && !q.isLoading ? (
            <li className="rounded-lg border border-dashed border-edge-default bg-surface-sunken/40 px-3 py-6 text-center text-xs text-content-subtle">
              No comments yet.
            </li>
          ) : null}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const text = draft.trim()
            if (!text) return
            const html = `<p>${escapeHtml(text)}</p>`
            create.mutate({ comment_html: html })
            setDraft('')
          }}
          className="flex flex-col gap-2 rounded-lg border border-edge-default bg-white p-2"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Leave a comment…"
            rows={2}
            className="block w-full resize-none rounded border-0 bg-transparent px-1 py-1 text-sm focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="text-[11px] text-content-subtle">
              Markdown-flavoured plain text
            </span>
            <Button
              size="xs"
              type="submit"
              disabled={!draft.trim() || create.isPending}
              loading={create.isPending}
            >
              Comment
            </Button>
          </div>
        </form>
      </div>
    </Section>
  )
}

/* ───── activity ───── */

function ActivityBlock({
  projectId,
  issueId,
  memberMap,
}: {
  projectId: string
  issueId: string
  memberMap: Map<string, plane.Member>
}) {
  const q = useActivities(projectId, issueId)
  if (q.isLoading || !q.data?.length) return null
  return (
    <Section title="Activity">
      <ol className="relative space-y-3 border-l border-edge-default pl-5">
        {q.data
          .slice()
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          .map((act) => {
            const actor =
              memberMap.get(act.actor) ??
              ({
                member: act.actor_detail
                  ? {
                      id: act.actor,
                      display_name: act.actor_detail.display_name,
                      email: act.actor_detail.email ?? '',
                      avatar: act.actor_detail.avatar ?? null,
                    }
                  : undefined,
              } as plane.Member)
            return (
              <li key={act.id} className="relative">
                <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-500 ring-4 ring-white" />
                <div className="text-xs text-content-muted">
                  <span className="font-medium text-content">{memberDisplayName(actor)}</span>{' '}
                  {act.verb}
                  {act.field ? <> the {act.field}</> : null}
                  {act.old_value && act.new_value ? (
                    <>
                      {' '}
                      from{' '}
                      <code className="rounded bg-surface-sunken px-1 py-0.5 text-[10px]">
                        {act.old_value}
                      </code>{' '}
                      to{' '}
                      <code className="rounded bg-surface-sunken px-1 py-0.5 text-[10px]">
                        {act.new_value}
                      </code>
                    </>
                  ) : act.new_value ? (
                    <>
                      {' '}
                      to{' '}
                      <code className="rounded bg-surface-sunken px-1 py-0.5 text-[10px]">
                        {act.new_value}
                      </code>
                    </>
                  ) : null}
                  <span className="ml-2 text-[11px] text-content-subtle">
                    {formatRelative(act.created_at)}
                  </span>
                </div>
              </li>
            )
          })}
      </ol>
    </Section>
  )
}

/* ───── properties panel ───── */

const PRIORITIES: plane.Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

function PropertiesPanel({
  issue,
  states,
  labels,
  members,
  cycles,
  modules,
  onPatch,
}: {
  issue: plane.Issue
  states: plane.State[]
  labels: plane.Label[]
  members: plane.Member[]
  cycles: plane.Cycle[]
  modules: plane.Module[]
  onPatch(patch: Partial<plane.Issue>): void
}) {
  return (
    <div className="space-y-4">
      <PropRow
        label="State"
        control={
          <select
            value={issue.state}
            onChange={(e) => onPatch({ state: e.target.value })}
            className="h-7 rounded-md border border-edge-default bg-white px-2 text-xs"
          >
            {states.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        }
      />
      <PropRow
        label="Priority"
        control={
          <select
            value={issue.priority}
            onChange={(e) => onPatch({ priority: e.target.value as plane.Priority })}
            className="h-7 rounded-md border border-edge-default bg-white px-2 text-xs"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        }
      />
      <PropRow
        label="Assignees"
        control={
          <MultiPicker
            items={members.map((m) => ({
              id: m.member?.id ?? m.id,
              label: memberDisplayName(m),
            }))}
            selected={issue.assignees}
            onChange={(assignees) => onPatch({ assignees })}
            placeholder="Unassigned"
          />
        }
      />
      <PropRow
        label="Labels"
        control={
          <MultiPicker
            items={labels.map((l) => ({ id: l.id, label: l.name, color: l.color }))}
            selected={issue.labels}
            onChange={(labels) => onPatch({ labels })}
            placeholder="No labels"
          />
        }
      />
      <PropRow
        label="Estimate"
        control={
          <input
            type="number"
            min={0}
            value={issue.estimate_point ?? ''}
            onChange={(e) =>
              onPatch({ estimate_point: e.target.value === '' ? null : Number(e.target.value) })
            }
            placeholder="—"
            className="h-7 w-20 rounded-md border border-edge-default bg-white px-2 text-xs"
          />
        }
      />
      <PropRow
        label="Start date"
        control={
          <input
            type="date"
            value={iso(issue.start_date)}
            onChange={(e) => onPatch({ start_date: e.target.value || null })}
            className="h-7 rounded-md border border-edge-default bg-white px-2 text-xs"
          />
        }
      />
      <PropRow
        label="Target date"
        control={
          <input
            type="date"
            value={iso(issue.target_date)}
            onChange={(e) => onPatch({ target_date: e.target.value || null })}
            className="h-7 rounded-md border border-edge-default bg-white px-2 text-xs"
          />
        }
      />
      <PropRow
        label="Cycle"
        control={
          <select
            value={issue.cycle ?? ''}
            onChange={(e) => onPatch({ cycle: e.target.value || null })}
            className="h-7 max-w-full rounded-md border border-edge-default bg-white px-2 text-xs"
          >
            <option value="">None</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        }
      />
      <PropRow
        label="Module"
        control={
          <select
            value={issue.module ?? ''}
            onChange={(e) => onPatch({ module: e.target.value || null })}
            className="h-7 max-w-full rounded-md border border-edge-default bg-white px-2 text-xs"
          >
            <option value="">None</option>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        }
      />
      <hr className="border-edge-subtle" />
      <PropRow
        label="Created"
        control={
          <span className="text-xs text-content-muted">{formatRelative(issue.created_at)}</span>
        }
      />
      {issue.updated_at ? (
        <PropRow
          label="Updated"
          control={
            <span className="text-xs text-content-muted">{formatRelative(issue.updated_at)}</span>
          }
        />
      ) : null}
    </div>
  )
}

function MultiPicker({
  items,
  selected,
  onChange,
  placeholder,
}: {
  items: Array<{ id: string; label: string; color?: string }>
  selected: string[]
  onChange(next: string[]): void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-auto min-h-7 w-full flex-wrap items-center gap-1 rounded-md border border-edge-default bg-white px-2 py-0.5 text-left text-xs"
      >
        {selected.length === 0 ? (
          <span className="text-content-subtle">{placeholder}</span>
        ) : (
          items
            .filter((it) => selected.includes(it.id))
            .map((it) => (
              <span
                key={it.id}
                className="inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content"
              >
                {it.color ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: it.color }}
                  />
                ) : null}
                {it.label}
              </span>
            ))
        )}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <ul className="absolute right-0 top-full z-20 mt-1 max-h-60 w-56 overflow-y-auto rounded-lg border border-edge-default bg-white py-1 shadow-xl ring-1 ring-black/5">
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
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                        on ? 'bg-brand-50 text-brand-800' : 'hover:bg-surface-sunken',
                      )}
                    >
                      {it.color ? (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: it.color }}
                        />
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

/* ───── atoms ───── */

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
            {title}
          </h4>
          {action}
        </div>
        {children}
      </CardBody>
    </Card>
  )
}

function PropRow({ label, control }: { label: string; control: ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_1fr] items-start gap-2">
      <span className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </span>
      <div className="min-w-0">{control}</div>
    </div>
  )
}

function iso(date?: string | null) {
  if (!date) return ''
  return date.slice(0, 10)
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
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="text-brand-700"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/* ───── action menu (copy link / duplicate / delete) ───── */

function IssueActionsMenu({
  issue,
  onCopyLink,
  onDuplicate,
  onDelete,
}: {
  issue: plane.Issue
  onCopyLink(): void
  onDuplicate(): void
  onDelete(): void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-issue-actions]')) setOpen(false)
    }
    window.addEventListener('mousedown', onClickOutside)
    return () => window.removeEventListener('mousedown', onClickOutside)
  }, [open])
  return (
    <div data-issue-actions className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Issue actions"
        className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-lg border border-edge-default bg-white py-1 shadow-xl ring-1 ring-black/5">
          <ActionItem
            onClick={() => {
              onCopyLink()
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
            icon={<IconLink />}
          >
            {copied ? 'Link copied' : 'Copy issue link'}
          </ActionItem>
          <ActionItem
            onClick={() => {
              onDuplicate()
              setOpen(false)
            }}
            icon={<IconDuplicate />}
          >
            Duplicate issue
          </ActionItem>
          <div className="my-1 border-t border-edge-subtle" />
          <ActionItem
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            icon={<IconTrash />}
            danger
          >
            Delete issue · #{issue.sequence_id ?? ''}
          </ActionItem>
        </div>
      ) : null}
    </div>
  )
}

function ActionItem({
  onClick,
  icon,
  danger,
  children,
}: {
  onClick(): void
  icon: ReactNode
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
        danger ? 'text-rose-700 hover:bg-rose-50' : 'text-content hover:bg-surface-sunken'
      }`}
    >
      <span className="text-content-subtle">{icon}</span>
      {children}
    </button>
  )
}

function IconLink() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}
function IconDuplicate() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}
