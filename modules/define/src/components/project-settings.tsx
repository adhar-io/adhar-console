import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, Field, Input, Select, Textarea, usePlaneWorkspace, useToast } from '@adhar/shell-ui'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, planeError, useMembers, useProjectMembers, useUpdateProject } from '../data/plane.ts'
import { useEstimatePoints, usePlanIssues } from '../data/planning-plane.ts'
import {
  ESTIMATE_PRESETS,
  type EstimateScale,
  type NotificationPrefs,
  storeError,
  usePatchProjectMeta,
  useProjectMeta,
} from '../data/planning-store.ts'
import { type Health, toMs } from '../data/planning-model.ts'
import { HealthBadge, Notice } from './planning-ui.tsx'

/**
 * Project settings that live partly in Plane (details, lead) and partly in
 * the console (tenancy link, health override, estimate scale, notification
 * preferences). Each section names where its data is kept.
 */

/* ─────────── details ─────────── */

export function ProjectDetailsForm({ project }: { project: plane.Project }) {
  const update = useUpdateProject()
  const members = useProjectMembers(project.id)
  const workspace = useMembers()
  const qc = useQueryClient()
  const slug = usePlaneWorkspace()
  const toast = useToast()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [lead, setLead] = useState(project.project_lead ?? '')
  const [assignee, setAssignee] = useState(project.default_assignee ?? '')
  useEffect(() => {
    setName(project.name)
    setDescription(project.description ?? '')
    setLead(project.project_lead ?? '')
    setAssignee(project.default_assignee ?? '')
  }, [project.id, project.name, project.description, project.project_lead, project.default_assignee])

  const people = (members.data ?? []).map((m) => ({ value: m.id, label: m.display_name || m.email || m.id }))
  if (!people.length) {
    for (const m of workspace.data ?? []) people.push({ value: m.member?.id ?? m.id, label: memberDisplayName(m) })
  }
  const dirty = name !== project.name || description !== (project.description ?? '') || lead !== (project.project_lead ?? '') || assignee !== (project.default_assignee ?? '')

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[14px] font-semibold text-content">Details</h3>
        <p className="text-[12px] text-content-muted">Stored in Plane.</p>
      </div>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          update.mutate({ id: project.id, patch: { name: name.trim(), description, project_lead: lead || null, default_assignee: assignee || null } }, {
            onSuccess: () => {
              qc.invalidateQueries({ queryKey: ['plane', 'project', slug, project.id] })
              toast.success('Project details saved')
            },
            onError: (err) => toast.error(planeError(err, "Couldn't save the project.")),
          })
        }}
      >
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Identifier" hint="Prefix of work item keys; change it in Plane.">
          <Input value={project.identifier} readOnly disabled />
        </Field>
        <Field label="Lead">
          <Select value={lead} onChange={(e) => setLead(e.target.value)} options={[{ value: '', label: 'No lead' }, ...people]} />
        </Field>
        <Field label="Default assignee" hint="New work items are assigned to this person.">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} options={[{ value: '', label: 'Nobody' }, ...people]} />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" variant="primary" size="sm" disabled={!dirty || !name.trim()} loading={update.isPending}>Save details</Button>
        </div>
      </form>
    </section>
  )
}

/* ─────────── tenancy ─────────── */

interface WsProject {
  slug: string
  name: string
  teams?: string[]
}

/**
 * Link a Plane project to an Adhar project (Organization → Team → Project).
 * The link lives in the console's store; the Projects page uses it to narrow
 * the list to the active team.
 */
export function TenancyLink({ project }: { project: plane.Project }) {
  const meta = useProjectMeta(project.id)
  const save = usePatchProjectMeta()
  const toast = useToast()
  // Read the team list directly: shell-ui's useTeams also manages the active
  // team selection, which a settings form must not touch.
  const teamsQ = useQuery({
    queryKey: ['workspace', 'teams'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/teams', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`Teams unavailable (${res.status})`)
      return ((await res.json()) as { items?: Array<{ slug: string; name: string }> }).items ?? []
    },
    staleTime: 60_000,
    retry: false,
  })
  const teams = { teams: teamsQ.data ?? [], loading: teamsQ.isLoading }
  const ws = useQuery({
    queryKey: ['workspace', 'projects', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/projects', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`Workspace projects unavailable (${res.status})`)
      return ((await res.json()) as { items?: WsProject[] }).items ?? []
    },
    staleTime: 60_000,
    retry: false,
  })
  const linked = meta.data?.adharProject ?? ''
  const suggestion = useMemo(() => {
    if (linked) return undefined
    const id = project.identifier.toLowerCase()
    const nm = project.name.toLowerCase()
    return (ws.data ?? []).find((p) => p.slug.toLowerCase() === id || p.name.toLowerCase() === nm || p.slug.toLowerCase() === nm.replace(/\s+/g, '-'))
  }, [ws.data, linked, project.identifier, project.name])
  const linkedProject = (ws.data ?? []).find((p) => p.slug === linked)
  const set = (patch: { adharProject?: string | null; teams?: string[] }, msg: string) =>
    save.mutate({ id: project.id, fn: (cur) => ({ ...(cur ?? {}), ...patch }) }, { onSuccess: () => toast.success(msg), onError: (e) => toast.error(storeError(e)) })
  const direct = meta.data?.teams ?? []

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[14px] font-semibold text-content">Organization, team and project</h3>
        <p className="text-[12px] text-content-muted">Which Adhar project — and so which teams — this Plane project belongs to. Kept in the console; it narrows Define to the active team.</p>
      </div>
      {meta.isError ? <Notice tone="warn">{storeError(meta.error)}</Notice> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Adhar project" hint={ws.isError ? 'The workspace project list is unavailable.' : linkedProject?.teams?.length ? `Teams: ${linkedProject.teams.join(', ')}` : undefined}>
          <Select
            value={linked}
            disabled={meta.isLoading || save.isPending || ws.isError}
            onChange={(e) => set({ adharProject: e.target.value || null }, e.target.value ? 'Linked to the Adhar project' : 'Unlinked')}
            options={[{ value: '', label: ws.isLoading ? 'Loading…' : 'Not linked' }, ...(ws.data ?? []).map((p) => ({ value: p.slug, label: p.name }))]}
          />
        </Field>
        <Field label="Teams" hint="Optional, without an Adhar project.">
          <div className="flex flex-wrap gap-2 pt-1">
            {teams.teams.length
              ? teams.teams.map((t) => (
                <Checkbox
                  key={t.slug}
                  label={t.name}
                  checked={direct.includes(t.slug)}
                  disabled={save.isPending || meta.isError}
                  onChange={(e) => set({ teams: e.target.checked ? [...direct, t.slug] : direct.filter((x) => x !== t.slug) }, 'Teams updated')}
                />
              ))
              : <span className="text-[12px] text-content-subtle">{teams.loading ? 'Loading teams…' : 'No teams in this organization.'}</span>}
          </div>
        </Field>
      </div>
      {suggestion
        ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
            Looks like <b className="text-content">{suggestion.name}</b>.
            <Button size="xs" onClick={() => set({ adharProject: suggestion.slug }, `Linked to ${suggestion.name}`)}>Link it</Button>
          </div>
        )
        : null}
    </section>
  )
}

/* ─────────── health override ─────────── */

export function HealthOverrideForm({ projectId, derived }: { projectId: string; derived?: { health: Health; reasons: string[] } }) {
  const meta = useProjectMeta(projectId)
  const save = usePatchProjectMeta()
  const toast = useToast()
  const cur = meta.data?.healthOverride
  const [health, setHealth] = useState<Health | ''>(cur?.health ?? '')
  const [note, setNote] = useState(cur?.note ?? '')
  const [until, setUntil] = useState(cur?.until ?? '')
  useEffect(() => {
    setHealth(cur?.health ?? '')
    setNote(cur?.note ?? '')
    setUntil(cur?.until ?? '')
  }, [cur?.health, cur?.note, cur?.until])
  const expired = cur?.until && (toMs(cur.until) ?? 0) + 86_400_000 <= Date.now()
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[14px] font-semibold text-content">Health</h3>
        <p className="text-[12px] text-content-muted">
          Derived from overdue work and the active sprint's pace{derived ? <> — now <HealthBadge health={derived.health} /> ({derived.reasons.join('; ')})</> : null}. Set it by hand when you know more than the numbers; kept in the console.
        </p>
      </div>
      {meta.isError ? <Notice tone="warn">{storeError(meta.error)}</Notice> : null}
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr_10rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({
            id: projectId,
            fn: (c) => ({ ...(c ?? {}), healthOverride: health ? { health, note: note.trim() || undefined, until: until || null, at: new Date().toISOString() } : null }),
          }, { onSuccess: () => toast.success(health ? 'Health set' : 'Health back to derived'), onError: (err) => toast.error(storeError(err)) })
        }}
      >
        <Field label="Status">
          <Select
            value={health}
            onChange={(e) => setHealth(e.target.value as Health | '')}
            options={[{ value: '', label: 'Derived' }, { value: 'on-track', label: 'On track' }, { value: 'at-risk', label: 'At risk' }, { value: 'off-track', label: 'Off track' }]}
          />
        </Field>
        <Field label="Why">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vendor dependency slipped two weeks" disabled={!health} />
        </Field>
        <Field label="Until" hint={expired ? 'Expired — derived health shows.' : undefined}>
          <Input type="date" value={until ?? ''} onChange={(e) => setUntil(e.target.value)} disabled={!health} />
        </Field>
        <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={meta.isError}>Save</Button>
      </form>
    </section>
  )
}

/* ─────────── estimates ─────────── */

export function EstimatesTab({ projectId }: { projectId: string }) {
  const meta = useProjectMeta(projectId)
  const save = usePatchProjectMeta()
  const planeEst = useEstimatePoints(projectId)
  const issues = usePlanIssues(projectId)
  const toast = useToast()
  const scale: EstimateScale = meta.data?.estimate ?? ESTIMATE_PRESETS.fibonacci
  const [custom, setCustom] = useState(scale.kind === 'custom' ? scale.values.join(', ') : '')
  const [days, setDays] = useState(String(meta.data?.sprintDays ?? 14))
  useEffect(() => setDays(String(meta.data?.sprintDays ?? 14)), [meta.data?.sprintDays])
  const withPlaneEstimate = (issues.data ?? []).filter((i) => i.estimate_point !== null && i.estimate_point !== undefined).length
  const write = (estimate: EstimateScale) =>
    save.mutate({ id: projectId, fn: (c) => ({ ...(c ?? {}), estimate }) }, { onSuccess: () => toast.success('Estimate scale saved'), onError: (e) => toast.error(storeError(e)) })

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-[14px] font-semibold text-content">Story points</h3>
        <p className="text-[12px] text-content-muted">
          {planeEst.data === null
            ? 'This Plane does not expose estimates through its API (the estimates routes are not registered), so the console keeps story points itself, per work item, on the scale below. Sprint capacity, burndown and velocity in points use them.'
            : planeEst.data && planeEst.data.length
            ? `Plane has an estimate with points ${planeEst.data.map((p) => p.value).join(', ')}; numeric Plane estimates are used where set, console points elsewhere.`
            : 'The console keeps story points per work item on the scale below. Sprint capacity, burndown and velocity in points use them.'}
          {withPlaneEstimate && planeEst.data === null ? ` ${withPlaneEstimate} work items carry a Plane estimate the API cannot resolve to a value.` : ''}
        </p>
        {meta.isError ? <Notice tone="warn">{storeError(meta.error)}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(ESTIMATE_PRESETS) as Array<keyof typeof ESTIMATE_PRESETS>).map((k) => {
            const p = ESTIMATE_PRESETS[k]
            const on = scale.kind === k
            return (
              <button
                key={k}
                type="button"
                onClick={() => write(p)}
                disabled={save.isPending || meta.isError}
                className={`rounded-lg border px-3 py-2 text-left text-[12px] ${on ? 'border-brand-400 bg-brand-50 text-content dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised text-content-muted hover:text-content'}`}
              >
                <div className="font-semibold capitalize text-content">{k === 'tshirt' ? 'T-shirt' : k}</div>
                <div className="tabular-nums">{p.labels ? p.labels.map((l, i) => `${l}=${p.values[i]}`).join(' ') : p.values.join(' · ')}</div>
              </button>
            )
          })}
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const values = [...new Set(custom.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b)
            if (!values.length) return toast.error('Enter numbers separated by commas.')
            write({ kind: 'custom', values })
          }}
        >
          <Field label="Custom scale" hint={scale.kind === 'custom' ? `In use: ${scale.values.join(', ')}` : undefined}>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0.5, 1, 2, 3, 5" />
          </Field>
          <Button type="submit" size="sm" disabled={!custom.trim() || meta.isError}>Use custom</Button>
        </form>
      </section>
      <section className="space-y-2">
        <h3 className="text-[14px] font-semibold text-content">Sprint length</h3>
        <p className="text-[12px] text-content-muted">Default length when starting a sprint without an end date.</p>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Math.max(1, Math.min(60, Number(days) || 14))
            save.mutate({ id: projectId, fn: (c) => ({ ...(c ?? {}), sprintDays: n }) }, { onSuccess: () => toast.success(`Sprints default to ${n} days`), onError: (er) => toast.error(storeError(er)) })
          }}
        >
          <Field label="Days">
            <Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" />
          </Field>
          <Button type="submit" size="sm" disabled={meta.isError}>Save</Button>
        </form>
      </section>
    </div>
  )
}

/* ─────────── notifications ─────────── */

const PREFS: Array<{ key: keyof Omit<NotificationPrefs, 'broadcast'>; label: string; hint: string }> = [
  { key: 'sprintStarted', label: 'Sprint started', hint: 'When someone starts a sprint from the console.' },
  { key: 'sprintCompleted', label: 'Sprint completed', hint: 'With the completed / carried-over count.' },
  { key: 'intakeBreached', label: 'Intake SLA breached', hint: 'When the Intake page finds a request past its triage window.' },
  { key: 'releaseShipped', label: 'Release shipped', hint: 'When a release is marked released.' },
  { key: 'releaseDue', label: 'Release due', hint: 'When an unreleased release is due within a week with open work.' },
]

export function NotificationsTab({ projectId }: { projectId: string }) {
  const meta = useProjectMeta(projectId)
  const save = usePatchProjectMeta()
  const toast = useToast()
  const prefs = meta.data?.notifications ?? {}
  const set = (patch: NotificationPrefs) =>
    save.mutate({ id: projectId, fn: (c) => ({ ...(c ?? {}), notifications: { ...(c?.notifications ?? {}), ...patch } }) }, { onError: (e) => toast.error(storeError(e)) })
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[14px] font-semibold text-content">Notifications</h3>
        <p className="text-[12px] text-content-muted">Console notifications for this project's planning events. They are raised when the event happens in the console (the console has no background worker); Plane's own email notifications are configured in Plane.</p>
      </div>
      {meta.isError ? <Notice tone="warn">{storeError(meta.error)}</Notice> : null}
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        {PREFS.map((p) => (
          <li key={p.key} className="px-4 py-3">
            <Checkbox label={p.label} description={p.hint} checked={!!prefs[p.key]} disabled={meta.isLoading || meta.isError} onChange={(e) => set({ [p.key]: e.target.checked })} />
          </li>
        ))}
        <li className="px-4 py-3">
          <Checkbox label="Send to everyone in the organization" description="Off: only the person who acted sees them." checked={!!prefs.broadcast} disabled={meta.isLoading || meta.isError} onChange={(e) => set({ broadcast: e.target.checked })} />
        </li>
      </ul>
    </section>
  )
}
