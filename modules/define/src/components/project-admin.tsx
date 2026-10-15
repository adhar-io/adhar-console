import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, EmptyState, Select, Spinner, StatusBadge, usePlaneWorkspace, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import {
  memberDisplayName,
  planeError,
  ROLE_OPTIONS,
  rolePill,
  useAddProjectMember,
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

/**
 * The project's administration, inside the project drawer: who is in it,
 * its workflow (states and labels), which Plane features are on, and
 * archiving. Everything is Plane's public API; the two things that API
 * cannot do — change a member's project role, remove a member — link to
 * Plane's own settings page instead of pretending.
 */

/* ─────────── members ─────────── */

export function ProjectMembersTab({ projectId }: { projectId: string }) {
  const members = useProjectMembers(projectId)
  const workspace = useMembers()
  const add = useAddProjectMember(projectId)
  const toast = useToast()
  const settingsUrl = usePlaneLink(`projects/${projectId}/settings/members`)
  const [who, setWho] = useState('')
  const [role, setRole] = useState(15)

  const inProject = new Set((members.data ?? []).map((m) => m.id))
  const candidates = (workspace.data ?? []).filter((m) => !inProject.has(m.member?.id ?? m.id))

  if (members.isLoading) return <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={12} /> Loading members…</div>
  if (members.isError) return <EmptyState compact title="Couldn't load project members" description={planeError(members.error)} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-edge-default bg-surface-raised p-3">
        <div className="min-w-[14rem] flex-1">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Add from the workspace</div>
          <Select
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
          <Select value={String(role)} onChange={(e) => setRole(Number(e.target.value))} options={ROLE_OPTIONS.map((r) => ({ value: String(r.value), label: r.label }))} />
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!who}
          loading={add.isPending}
          onClick={() =>
            add.mutate({ member: who, role }, {
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
          return (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/30">
                {name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-content">{name}{m.is_bot ? <span className="ml-1.5 text-[10px] text-content-subtle">bot</span> : null}</span>
                {m.email ? <span className="block truncate text-[11px] text-content-subtle">{m.email}</span> : null}
              </span>
              <StatusBadge kind={pill.tone}>{pill.label}</StatusBadge>
            </li>
          )
        })}
      </ul>
      <p className="text-[12px] text-content-muted">
        Changing someone's project role or removing them is not available through Plane's API.{' '}
        {settingsUrl ? <a href={settingsUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Manage in Plane ↗</a> : null}
      </p>
    </div>
  )
}

/* ─────────── workflow ─────────── */

const GROUPS: Array<{ id: plane.StateGroup; label: string; hint: string; color: string }> = [
  { id: 'backlog', label: 'Backlog', hint: 'Captured, not planned', color: '#a3a3a3' },
  { id: 'unstarted', label: 'Unstarted', hint: 'Planned, not begun', color: '#3a3a3a' },
  { id: 'started', label: 'Started', hint: 'In progress', color: '#f59e0b' },
  { id: 'completed', label: 'Completed', hint: 'Done — counts toward progress', color: '#16a34a' },
  { id: 'cancelled', label: 'Cancelled', hint: 'Closed without doing', color: '#dc2626' },
]

export function WorkflowTab({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6">
      <StatesEditor projectId={projectId} />
      <LabelsEditor projectId={projectId} />
    </div>
  )
}

function StatesEditor({ projectId }: { projectId: string }) {
  const states = useStates(projectId)
  const m = useStateMutations(projectId)
  const toast = useToast()
  const [adding, setAdding] = useState<plane.StateGroup | null>(null)
  const byGroup = useMemo(() => {
    const out = new Map<plane.StateGroup, plane.State[]>()
    for (const s of [...(states.data ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
      out.set(s.group, [...(out.get(s.group) ?? []), s])
    }
    return out
  }, [states.data])

  if (states.isLoading) return <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={12} /> Loading states…</div>

  return (
    <section>
      <h3 className="text-[14px] font-semibold text-content">States</h3>
      <p className="mb-3 text-[12px] text-content-muted">The columns of the board. Every state belongs to a group; the group decides what counts as done.</p>
      <div className="space-y-3">
        {GROUPS.map((g) => (
          <div key={g.id} className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
            <div className="flex items-center gap-2 border-b border-edge-subtle bg-surface-sunken/40 px-4 py-2">
              <span className="text-[12px] font-semibold text-content">{g.label}</span>
              <span className="text-[11px] text-content-subtle">{g.hint}</span>
              <button type="button" onClick={() => setAdding(adding === g.id ? null : g.id)} className="ml-auto text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                {adding === g.id ? 'Cancel' : '+ Add state'}
              </button>
            </div>
            <ul className="divide-y divide-edge-subtle">
              {(byGroup.get(g.id) ?? []).map((s) => (
                <NamedColorRow
                  key={s.id}
                  name={s.name}
                  color={s.color}
                  badge={s.default ? 'default' : undefined}
                  saving={m.update.isPending || m.remove.isPending}
                  onSave={(patch) => m.update.mutate({ id: s.id, patch }, { onError: (e) => toast.error(planeError(e, "Couldn't save the state.")) })}
                  extra={s.default ? null : (
                    <button type="button" onClick={() => m.update.mutate({ id: s.id, patch: { default: true } }, { onSuccess: () => toast.success(`${s.name} is now the default`), onError: (e) => toast.error(planeError(e, "Couldn't set the default.")) })} className="text-[11px] text-content-muted hover:text-content">
                      Make default
                    </button>
                  )}
                  onDelete={s.default ? undefined : () => {
                    if (!confirm(`Delete the state "${s.name}"? Plane refuses if issues are still in it.`)) return
                    m.remove.mutate(s.id, { onSuccess: () => toast.success(`Deleted ${s.name}`), onError: (e) => toast.error(planeError(e, "Couldn't delete the state — move its issues first.")) })
                  }}
                />
              ))}
              {adding === g.id ? (
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
              ) : null}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

function LabelsEditor({ projectId }: { projectId: string }) {
  const labels = useLabels(projectId)
  const m = useLabelMutations(projectId)
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const list = [...(labels.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <section>
      <div className="flex items-center">
        <h3 className="text-[14px] font-semibold text-content">Labels</h3>
        <button type="button" onClick={() => setAdding((a) => !a)} className="ml-auto text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">{adding ? 'Cancel' : '+ New label'}</button>
      </div>
      <p className="mb-3 text-[12px] text-content-muted">Cross-cutting tags — area, type, customer. Filters and saved views use them.</p>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        {adding ? (
          <NewNamedColor
            defaultColor="#6366f1"
            placeholder="Label name"
            saving={m.create.isPending}
            onCreate={(name, color) =>
              m.create.mutate({ name, color }, {
                onSuccess: () => {
                  toast.success(`Added ${name}`)
                  setAdding(false)
                },
                onError: (e) => toast.error(planeError(e, "Couldn't add the label.")),
              })}
          />
        ) : null}
        {labels.isLoading ? <li className="px-4 py-3 text-[12px] text-content-muted"><Spinner size={12} /></li> : list.length === 0 && !adding ? (
          <li className="px-4 py-3 text-[12px] text-content-subtle">No labels yet.</li>
        ) : list.map((l) => (
          <NamedColorRow
            key={l.id}
            name={l.name}
            color={l.color}
            saving={m.update.isPending}
            onSave={(patch) => m.update.mutate({ id: l.id, patch }, { onError: (e) => toast.error(planeError(e, "Couldn't save the label.")) })}
            onDelete={() => {
              if (!confirm(`Delete the label "${l.name}"? It is removed from every issue.`)) return
              m.remove.mutate(l.id, { onSuccess: () => toast.success(`Deleted ${l.name}`), onError: (e) => toast.error(planeError(e, "Couldn't delete the label.")) })
            }}
          />
        ))}
      </ul>
    </section>
  )
}

function NamedColorRow({ name, color, badge, extra, saving, onSave, onDelete }: {
  name: string
  color: string
  badge?: string
  extra?: React.ReactNode
  saving: boolean
  onSave(patch: { name?: string; color?: string }): void
  onDelete?(): void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  return (
    <li className="group flex items-center gap-3 px-4 py-2">
      <label className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-edge-default" style={{ backgroundColor: color }} title="Change colour">
        <input type="color" value={toHex(color)} onChange={(e) => onSave({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label={`Colour of ${name}`} />
      </label>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim() && draft.trim() !== name) onSave({ name: draft.trim() })
            setEditing(false)
          }}
        >
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } }} className="h-7 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-app px-2 text-[13px] text-content focus:border-brand-400 focus:outline-none" />
          <Button size="xs" variant="primary" type="submit" loading={saving}>Save</Button>
        </form>
      ) : (
        <button type="button" onClick={() => { setDraft(name); setEditing(true) }} className="min-w-0 flex-1 truncate text-left text-[13px] text-content hover:text-brand-700 dark:hover:text-brand-300" title="Rename">
          {name}
        </button>
      )}
      {badge ? <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">{badge}</span> : null}
      <span className={cn('flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100', editing && 'hidden')}>
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
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name.trim(), color) }}>
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

/* ─────────── settings ─────────── */

const FEATURES: Array<{ key: keyof plane.Project; label: string; hint: string }> = [
  { key: 'cycle_view', label: 'Cycles', hint: 'Time-boxed iterations with burndown.' },
  { key: 'module_view', label: 'Modules', hint: 'Group issues into deliverable units.' },
  { key: 'intake_view', label: 'Intake', hint: 'A triage queue in front of the backlog.' },
  { key: 'page_view', label: 'Pages', hint: 'Project documents, edited in Plane.' },
  { key: 'issue_views_view', label: 'Views', hint: 'Shared filtered lists in Plane.' },
]

export function ProjectSettingsTab({ project, onArchived }: { project: plane.Project; onArchived(): void }) {
  const update = useUpdateProject()
  const archive = useArchiveProject()
  const qc = useQueryClient()
  const slug = usePlaneWorkspace()
  const toast = useToast()
  const archived = Boolean(project.archived_at)
  const on = (k: keyof plane.Project) => Boolean(k === 'intake_view' ? project.intake_view ?? project.inbox_view : project[k])

  return (
    <div className="space-y-6">
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

      <section className="rounded-xl border border-rose-200 bg-rose-50/40 p-4 dark:border-rose-500/30 dark:bg-rose-500/5">
        <h3 className="text-[14px] font-semibold text-content">{archived ? 'Archived project' : 'Archive project'}</h3>
        <p className="mt-1 text-[12px] text-content-muted">
          {archived
            ? 'This project is read-only and hidden from project lists. Restoring brings it back as it was.'
            : 'Archiving hides the project from lists and makes it read-only. Issues, cycles and history are kept, and it can be restored.'}
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
    </div>
  )
}
