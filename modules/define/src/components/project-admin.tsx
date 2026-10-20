import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, EmptyState, Select, Spinner, StatusBadge, usePlaneWorkspace, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import {
  memberDisplayName,
  planeClient,
  planeError,
  ROLE_OPTIONS,
  rolePill,
  useArchiveProject,
  useLabelMutations,
  useLabels,
  useMembers,
  usePlaneLink,
  useProjectMembers,
  useStateMutations,
  useStates,
  useUpdateProject,
} from '../data/plane.ts'
import { useMembershipActions } from '../data/planning-plane.ts'
import { membershipId, storeError, useMemberships, usePatchWorkflowRules, useWorkflowRules } from '../data/planning-store.ts'
import { EMPTY_RULES, pruneRules, type WorkflowRules } from '../data/planning-workflow.ts'
import { Notice } from './planning-ui.tsx'

/**
 * The project's administration, inside the project drawer: members, the
 * workflow (states with groups, order and default; console-enforced
 * transition rules), labels with hierarchy, Plane features and archiving.
 *
 * Plane's public API can add a project member and answers with the
 * membership's id; it never lists that id again. The console records it when
 * it adds someone, so role changes and removals work for members added here —
 * for anyone added in Plane, the page links to Plane's settings instead.
 */

/* ─────────── members ─────────── */

export function ProjectMembersTab({ projectId }: { projectId: string }) {
  const members = useProjectMembers(projectId)
  const workspace = useMembers()
  const recorded = useMemberships()
  const actions = useMembershipActions(projectId)
  const toast = useToast()
  const settingsUrl = usePlaneLink(`projects/${projectId}/settings/members`)
  const [who, setWho] = useState('')
  const [role, setRole] = useState(15)

  const inProject = new Set((members.data ?? []).map((m) => m.id))
  const candidates = (workspace.data ?? []).filter((m) => !inProject.has(m.member?.id ?? m.id))
  const pkOf = useMemo(() => new Map((recorded.data ?? []).filter((d) => d.data.project === projectId).map((d) => [d.data.member, d.data.pk] as const)), [recorded.data, projectId])

  if (members.isLoading) return <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={12} /> Loading members…</div>
  if (members.isError) return <EmptyState compact title="Couldn't load project members" description={planeError(members.error)} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-edge-default bg-surface-raised p-3">
        <div className="min-w-56 flex-1">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Add from the workspace</div>
          <Select
            aria-label="Person"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            options={[
              { value: '', label: candidates.length ? 'Choose a person…' : 'Everyone is already in this project' },
              ...candidates.map((m) => ({ value: m.member?.id ?? m.id, label: `${memberDisplayName(m)}${m.member?.email ? ` · ${m.member.email}` : ''}` })),
            ]}
            disabled={!candidates.length}
          />
        </div>
        <div className="w-36">
          <Select aria-label="Role" value={String(role)} onChange={(e) => setRole(Number(e.target.value))} options={ROLE_OPTIONS.map((r) => ({ value: String(r.value), label: r.label }))} />
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!who}
          loading={actions.add.isPending}
          onClick={() =>
            actions.add.mutate({ member: who, role }, {
              onSuccess: () => {
                toast.success('Added to the project')
                setWho('')
              },
              onError: (e) => toast.error(planeError(e, "Couldn't add the member.")),
            })}
        >
          Add member
        </Button>
      </div>

      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        {(members.data ?? []).map((m) => {
          const name = m.display_name || [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.id
          const pill = rolePill(m.role)
          const pk = pkOf.get(m.id)
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30">
                {name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-content">{name}{m.is_bot ? <span className="ml-1.5 text-[10px] text-content-subtle">bot</span> : null}</span>
                {m.email ? <span className="block truncate text-[11px] text-content-subtle">{m.email}</span> : null}
              </span>
              {pk
                ? (
                  <span className="flex items-center gap-2">
                    <Select
                      aria-label={`Role of ${name}`}
                      value={String(m.role)}
                      disabled={actions.setRole.isPending}
                      onChange={(e) =>
                        actions.setRole.mutate({ member: m.id, pk, role: Number(e.target.value) }, {
                          onSuccess: () => toast.success(`${name} is now ${rolePill(Number(e.target.value)).label}`),
                          onError: (err) => toast.error(planeError(err, "Couldn't change the role.")),
                        })}
                      options={ROLE_OPTIONS.map((r) => ({ value: String(r.value), label: r.label }))}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={actions.remove.isPending && actions.remove.variables?.member === m.id}
                      onClick={() => {
                        if (!confirm(`Remove ${name} from this project?`)) return
                        actions.remove.mutate({ member: m.id, pk }, {
                          onSuccess: () => toast.success(`Removed ${name}`),
                          onError: (err) => toast.error(planeError(err, "Couldn't remove the member.")),
                        })
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                )
                : <StatusBadge kind={pill.tone}>{pill.label}</StatusBadge>}
            </li>
          )
        })}
      </ul>
      <p className="text-[12px] text-content-muted">
        Role changes and removal work for people added from this console. Plane's API does not reveal the membership of people added in Plane itself, so change those in Plane.{' '}
        {settingsUrl ? <a href={settingsUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Manage in Plane ↗</a> : null}
      </p>
      {recorded.isError ? <Notice tone="warn">{storeError(recorded.error)}</Notice> : null}
    </div>
  )
}

/* ─────────── workflow ─────────── */

export const STATE_GROUPS: Array<{ id: plane.StateGroup; label: string; hint: string; color: string }> = [
  { id: 'backlog', label: 'Backlog', hint: 'Captured, not planned', color: '#a3a3a3' },
  { id: 'unstarted', label: 'Unstarted', hint: 'Planned, not begun', color: '#3a3a3a' },
  { id: 'started', label: 'Started', hint: 'In progress', color: '#f59e0b' },
  { id: 'completed', label: 'Completed', hint: 'Done — counts toward progress', color: '#16a34a' },
  { id: 'cancelled', label: 'Cancelled', hint: 'Closed without doing', color: '#dc2626' },
]

export function WorkflowTab({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-8">
      <StatesEditor projectId={projectId} />
      <TransitionsEditor projectId={projectId} />
    </div>
  )
}

export function LabelsTab({ projectId }: { projectId: string }) {
  return <LabelsEditor projectId={projectId} />
}

function StatesEditor({ projectId }: { projectId: string }) {
  const states = useStates(projectId)
  const m = useStateMutations(projectId)
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [adding, setAdding] = useState<plane.StateGroup | null>(null)
  const [moving, setMoving] = useState(false)
  const byGroup = useMemo(() => {
    const out = new Map<plane.StateGroup, plane.State[]>()
    for (const s of [...(states.data ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
      out.set(s.group, [...(out.get(s.group) ?? []), s])
    }
    return out
  }, [states.data])

  /** Swap a state's position with its neighbour inside its group (Plane `sequence`). */
  const move = async (list: plane.State[], k: number, dir: -1 | 1) => {
    const a = list[k]
    const b = list[k + dir]
    if (!a || !b) return
    setMoving(true)
    try {
      const sa = a.sequence ?? k * 1000
      const sb = b.sequence ?? (k + dir) * 1000
      const patchSeq = (id: string, sequence: number) => planeClient.updateState(slug, projectId, id, { sequence } as unknown as Parameters<typeof planeClient.updateState>[3])
      await patchSeq(a.id, sb === sa ? sa + dir : sb)
      await patchSeq(b.id, sa)
      await qc.invalidateQueries({ queryKey: ['plane', 'states', slug, projectId] })
    } catch (e) {
      toast.error(planeError(e, "Couldn't reorder the states."))
    } finally {
      setMoving(false)
    }
  }

  if (states.isLoading) return <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={12} /> Loading states…</div>
  if (states.isError) return <EmptyState compact title="Couldn't load states" description={planeError(states.error)} />

  return (
    <section>
      <h3 className="text-[14px] font-semibold text-content">States</h3>
      <p className="mb-3 text-[12px] text-content-muted">The columns of the board, in order. Every state belongs to a group; the group decides what counts as done. New items land in the default state.</p>
      <div className="space-y-3">
        {STATE_GROUPS.map((g) => {
          const list = byGroup.get(g.id) ?? []
          return (
            <div key={g.id} className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              <div className="flex items-center gap-2 border-b border-edge-subtle bg-surface-sunken/40 px-4 py-2">
                <span className="text-[12px] font-semibold text-content">{g.label}</span>
                <span className="hidden text-[11px] text-content-subtle sm:inline">{g.hint}</span>
                <button type="button" onClick={() => setAdding(adding === g.id ? null : g.id)} className="ml-auto text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                  {adding === g.id ? 'Cancel' : '+ Add state'}
                </button>
              </div>
              <ul className="divide-y divide-edge-subtle">
                {list.map((s, k) => (
                  <NamedColorRow
                    key={s.id}
                    name={s.name}
                    color={s.color}
                    badge={s.default ? 'default' : undefined}
                    saving={m.update.isPending || m.remove.isPending}
                    onSave={(patch) => m.update.mutate({ id: s.id, patch }, { onError: (e) => toast.error(planeError(e, "Couldn't save the state.")) })}
                    extra={
                      <>
                        <button type="button" disabled={k === 0 || moving} onClick={() => move(list, k, -1)} className="text-[11px] text-content-muted hover:text-content disabled:opacity-30" aria-label={`Move ${s.name} up`}>↑</button>
                        <button type="button" disabled={k === list.length - 1 || moving} onClick={() => move(list, k, 1)} className="text-[11px] text-content-muted hover:text-content disabled:opacity-30" aria-label={`Move ${s.name} down`}>↓</button>
                        {s.default ? null : (
                          <button type="button" onClick={() => m.update.mutate({ id: s.id, patch: { default: true } }, { onSuccess: () => toast.success(`${s.name} is now the default`), onError: (e) => toast.error(planeError(e, "Couldn't set the default.")) })} className="text-[11px] text-content-muted hover:text-content">
                            Make default
                          </button>
                        )}
                      </>
                    }
                    onDelete={s.default ? undefined : () => {
                      if (!confirm(`Delete the state "${s.name}"? Plane refuses if work items are still in it.`)) return
                      m.remove.mutate(s.id, { onSuccess: () => toast.success(`Deleted ${s.name}`), onError: (e) => toast.error(planeError(e, "Couldn't delete the state — move its work items first.")) })
                    }}
                  />
                ))}
                {!list.length && adding !== g.id ? <li className="px-4 py-2 text-[12px] text-content-subtle">No {g.label.toLowerCase()} states.</li> : null}
                {adding === g.id
                  ? (
                    <NewNamedColor
                      defaultColor={g.color}
                      placeholder={`New ${g.label.toLowerCase()} state`}
                      saving={m.create.isPending}
                      onCreate={(name, color) =>
                        m.create.mutate({ name, color, group: g.id }, {
                          onSuccess: () => {
                            toast.success(`Added ${name}`)
                            setAdding(null)
                          },
                          onError: (e) => toast.error(planeError(e, "Couldn't add the state.")),
                        })}
                    />
                  )
                  : null}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Transition rules — which state may follow which — kept in the console's
 * store and enforced by the console's own boards and drawers.
 */
function TransitionsEditor({ projectId }: { projectId: string }) {
  const states = useStates(projectId)
  const rules = useWorkflowRules(projectId)
  const save = usePatchWorkflowRules()
  const toast = useToast()
  const ordered = useMemo(() => {
    const groupRank = new Map(STATE_GROUPS.map((g, k) => [g.id, k]))
    return [...(states.data ?? [])].sort((a, b) => (groupRank.get(a.group)! - groupRank.get(b.group)!) || (a.sequence ?? 0) - (b.sequence ?? 0))
  }, [states.data])
  const current: WorkflowRules = rules.data ?? EMPTY_RULES
  const write = (next: WorkflowRules, msg?: string) =>
    save.mutate({ id: projectId, fn: () => pruneRules(next, ordered.map((s) => s.id)) }, {
      onSuccess: () => msg && toast.success(msg),
      onError: (e) => toast.error(storeError(e)),
    })

  if (!ordered.length) return null
  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-content">Transitions</h3>
        <span className="ml-auto">
          <Checkbox
            label="Enforce in the console"
            checked={current.enforce}
            disabled={rules.isLoading || save.isPending || rules.isError}
            onChange={(e) => write({ ...current, enforce: e.target.checked }, e.target.checked ? 'Workflow rules enforced' : 'Workflow rules off')}
          />
        </span>
      </div>
      <p className="mb-3 text-[12px] text-content-muted">
        Which state may follow which. A row left open allows any move. The console's boards, drawers and bulk edits check these rules; moves made in Plane itself are not checked.
      </p>
      {rules.isError ? <Notice tone="warn">{storeError(rules.error)}</Notice> : (
        <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full min-w-140 text-[12px]">
            <thead>
              <tr className="border-b border-edge-subtle text-left text-[11px] text-content-subtle">
                <th className="px-3 py-2 font-medium">From ↓ / To →</th>
                <th className="px-2 py-2 font-medium">Restrict</th>
                {ordered.map((s) => (
                  <th key={s.id} className="px-1.5 py-2 text-center font-medium" title={s.name}>
                    <span className="inline-flex max-w-22 items-center gap-1 truncate"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />{s.name}</span>
                  </th>
                ))}
                <th className="px-2 py-2 font-medium" title="Needs an assignee to enter">Needs assignee</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((from) => {
                const allowed = current.transitions[from.id]
                const restricted = !!allowed
                return (
                  <tr key={from.id} className="border-b border-edge-subtle last:border-0">
                    <td className="px-3 py-1.5 font-medium text-content">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: from.color }} />{from.name}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Restrict moves out of ${from.name}`}
                        checked={restricted}
                        onChange={(e) => {
                          const t = { ...current.transitions }
                          if (e.target.checked) t[from.id] = ordered.filter((s) => s.id !== from.id).map((s) => s.id)
                          else delete t[from.id]
                          write({ ...current, transitions: t })
                        }}
                      />
                    </td>
                    {ordered.map((to) => (
                      <td key={to.id} className="px-1.5 py-1.5 text-center">
                        {to.id === from.id ? <span className="text-content-subtle">·</span> : (
                          <input
                            type="checkbox"
                            aria-label={`${from.name} to ${to.name}`}
                            disabled={!restricted}
                            checked={!restricted || allowed.includes(to.id)}
                            onChange={(e) => {
                              const list = new Set(allowed ?? [])
                              if (e.target.checked) list.add(to.id)
                              else list.delete(to.id)
                              write({ ...current, transitions: { ...current.transitions, [from.id]: [...list] } })
                            }}
                          />
                        )}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${from.name} needs an assignee`}
                        checked={(current.requireAssignee ?? []).includes(from.id)}
                        onChange={(e) => {
                          const set = new Set(current.requireAssignee ?? [])
                          if (e.target.checked) set.add(from.id)
                          else set.delete(from.id)
                          write({ ...current, requireAssignee: [...set] })
                        }}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function LabelsEditor({ projectId }: { projectId: string }) {
  const labels = useLabels(projectId)
  const m = useLabelMutations(projectId)
  const toast = useToast()
  const [adding, setAdding] = useState<string | null>(null)
  const list = [...(labels.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const roots = list.filter((l) => !l.parent || !list.some((p) => p.id === l.parent))
  const children = (id: string) => list.filter((l) => l.parent === id)
  const row = (l: plane.Label, depth: number) => (
    <NamedColorRow
      key={l.id}
      name={l.name}
      color={l.color}
      depth={depth}
      saving={m.update.isPending}
      onSave={(patch) => m.update.mutate({ id: l.id, patch }, { onError: (e) => toast.error(planeError(e, "Couldn't save the label.")) })}
      extra={
        <>
          {depth === 0 ? <button type="button" onClick={() => setAdding(l.id)} className="text-[11px] text-content-muted hover:text-content">+ Sub-label</button> : null}
          <select
            aria-label={`Parent of ${l.name}`}
            value={l.parent ?? ''}
            onChange={(e) => m.update.mutate({ id: l.id, patch: { parent: e.target.value || null } }, { onError: (err) => toast.error(planeError(err, "Couldn't move the label.")) })}
            className="h-6 rounded border border-edge-default bg-surface-app px-1 text-[11px] text-content-muted"
          >
            <option value="">No parent</option>
            {roots.filter((r) => r.id !== l.id && !children(l.id).length).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </>
      }
      onDelete={() => {
        if (!confirm(`Delete the label "${l.name}"? It is removed from every work item.`)) return
        m.remove.mutate(l.id, { onSuccess: () => toast.success(`Deleted ${l.name}`), onError: (e) => toast.error(planeError(e, "Couldn't delete the label.")) })
      }}
    />
  )
  return (
    <section>
      <div className="flex items-center">
        <h3 className="text-[14px] font-semibold text-content">Labels</h3>
        <button type="button" onClick={() => setAdding(adding === '' ? null : '')} className="ml-auto text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">{adding === '' ? 'Cancel' : '+ New label'}</button>
      </div>
      <p className="mb-3 text-[12px] text-content-muted">Cross-cutting tags — area, type, customer — with one level of nesting (Plane label parents). Filters, saved views and release notes use them; labels named bug or defect count as bugs.</p>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        {adding !== null
          ? (
            <NewNamedColor
              defaultColor="#6366f1"
              placeholder={adding ? `Sub-label of ${list.find((l) => l.id === adding)?.name ?? ''}` : 'Label name'}
              saving={m.create.isPending}
              onCreate={(name, color) =>
                m.create.mutate({ name, color, parent: adding || null }, {
                  onSuccess: () => {
                    toast.success(`Added ${name}`)
                    setAdding(null)
                  },
                  onError: (e) => toast.error(planeError(e, "Couldn't add the label.")),
                })}
            />
          )
          : null}
        {labels.isLoading ? <li className="px-4 py-3 text-[12px] text-content-muted"><Spinner size={12} /></li> : labels.isError ? <li className="px-4 py-3 text-[12px] text-content-muted">{planeError(labels.error)}</li> : list.length === 0 && adding === null
          ? <li className="px-4 py-3 text-[12px] text-content-subtle">No labels yet.</li>
          : roots.flatMap((r) => [row(r, 0), ...children(r.id).map((c) => row(c, 1))])}
      </ul>
    </section>
  )
}

function NamedColorRow({ name, color, badge, extra, saving, onSave, onDelete, depth = 0 }: {
  name: string
  color: string
  badge?: string
  extra?: React.ReactNode
  saving: boolean
  onSave(patch: { name?: string; color?: string }): void
  onDelete?(): void
  depth?: number
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  return (
    <li className="group flex flex-wrap items-center gap-3 px-4 py-2" style={{ paddingLeft: 16 + depth * 20 }}>
      <label className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-edge-default" style={{ backgroundColor: color }} title="Change colour">
        <input type="color" value={toHex(color)} onChange={(e) => onSave({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label={`Colour of ${name}`} />
      </label>
      {editing
        ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (draft.trim() && draft.trim() !== name) onSave({ name: draft.trim() })
              setEditing(false)
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditing(false)
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-app px-2 text-[13px] text-content focus:border-brand-400 focus:outline-none"
            />
            <Button size="xs" variant="primary" type="submit" loading={saving}>Save</Button>
          </form>
        )
        : (
          <button
            type="button"
            onClick={() => {
              setDraft(name)
              setEditing(true)
            }}
            className="min-w-0 flex-1 truncate text-left text-[13px] text-content hover:text-brand-700 dark:hover:text-brand-300"
            title="Rename"
          >
            {name}
          </button>
        )}
      {badge ? <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">{badge}</span> : null}
      <span className={cn('flex items-center gap-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100', editing && 'hidden')}>
        {extra}
        {onDelete ? <button type="button" onClick={onDelete} className="text-[11px] text-rose-700 hover:underline dark:text-rose-300">Delete</button> : null}
      </span>
    </li>
  )
}

function NewNamedColor({ defaultColor, placeholder, saving, onCreate }: { defaultColor: string; placeholder: string; saving: boolean; onCreate(name: string, color: string): void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(defaultColor)
  return (
    <li className="px-4 py-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onCreate(name.trim(), color)
        }}
      >
        <input type="color" value={toHex(color)} onChange={(e) => setColor(e.target.value)} className="h-7 w-7 cursor-pointer rounded border border-edge-default bg-transparent p-0.5" aria-label="Colour" />
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} className="h-7 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-app px-2 text-[13px] text-content focus:border-brand-400 focus:outline-none" />
        <Button size="xs" variant="primary" type="submit" disabled={!name.trim()} loading={saving}>Add</Button>
      </form>
    </li>
  )
}

/** `<input type=color>` needs `#rrggbb`; Plane stores whatever it was given. */
function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('')
  return '#888888'
}

/* ─────────── features + archive ─────────── */

const FEATURES: Array<{ key: keyof plane.Project; label: string; hint: string }> = [
  { key: 'cycle_view', label: 'Sprints (cycles)', hint: 'Time-boxed iterations with burndown.' },
  { key: 'module_view', label: 'Epics (modules)', hint: 'Group work items into deliverables.' },
  { key: 'intake_view', label: 'Intake', hint: 'A triage queue in front of the backlog.' },
  { key: 'page_view', label: 'Pages', hint: 'Project documents, edited in Plane.' },
  { key: 'issue_views_view', label: 'Views', hint: 'Shared filtered lists in Plane.' },
]

export function ProjectFeatures({ project }: { project: plane.Project }) {
  const update = useUpdateProject()
  const qc = useQueryClient()
  const slug = usePlaneWorkspace()
  const toast = useToast()
  const on = (k: keyof plane.Project) => Boolean(k === 'intake_view' ? project.intake_view ?? project.inbox_view : project[k])
  return (
    <section>
      <h3 className="text-[14px] font-semibold text-content">Features</h3>
      <p className="mb-3 text-[12px] text-content-muted">Turn Plane features on or off for this project. Off hides them here and in Plane; nothing is deleted.</p>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        {FEATURES.map((f) => (
          <li key={f.key} className="px-4 py-3">
            <Checkbox
              label={f.label}
              description={f.hint}
              checked={on(f.key)}
              disabled={update.isPending}
              onChange={(e) =>
                update.mutate({ id: project.id, patch: { [f.key]: e.target.checked } as Partial<plane.Project> }, {
                  onSuccess: () => {
                    qc.invalidateQueries({ queryKey: ['plane', 'project', slug, project.id] })
                    toast.success(`${f.label} ${e.target.checked ? 'on' : 'off'}`)
                  },
                  onError: (err) => toast.error(planeError(err, `Couldn't change ${f.label}.`)),
                })}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ProjectArchive({ project, onArchived }: { project: plane.Project; onArchived(): void }) {
  const archive = useArchiveProject()
  const toast = useToast()
  const archived = Boolean(project.archived_at)
  return (
    <section className="rounded-xl border border-rose-200 bg-rose-50/40 p-4 dark:border-rose-500/30 dark:bg-rose-500/5">
      <h3 className="text-[14px] font-semibold text-content">{archived ? 'Archived project' : 'Archive project'}</h3>
      <p className="mt-1 text-[12px] text-content-muted">
        {archived
          ? 'This project is read-only and hidden from project lists. Restoring brings it back as it was.'
          : 'Archiving hides the project from lists and makes it read-only. Work items, sprints and history are kept, and it can be restored.'}
      </p>
      <Button
        className="mt-3"
        size="sm"
        variant={archived ? 'primary' : 'danger'}
        loading={archive.isPending}
        onClick={() => {
          if (!archived && !confirm(`Archive ${project.name}?`)) return
          archive.mutate({ id: project.id, archive: !archived }, {
            onSuccess: () => {
              toast.success(archived ? `Restored ${project.name}` : `Archived ${project.name}`)
              if (!archived) onArchived()
            },
            onError: (e) => toast.error(planeError(e, archived ? "Couldn't restore the project." : "Couldn't archive the project.")),
          })
        }}
      >
        {archived ? 'Restore project' : 'Archive project'}
      </Button>
    </section>
  )
}

/** Kept for callers of the previous drawer layout. */
export function ProjectSettingsTab({ project, onArchived }: { project: plane.Project; onArchived(): void }) {
  return (
    <div className="space-y-6">
      <ProjectFeatures project={project} />
      <ProjectArchive project={project} onArchived={onArchived} />
    </div>
  )
}

export { membershipId }
