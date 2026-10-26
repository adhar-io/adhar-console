import { useEffect, useState } from 'react'
import { Button, Modal } from '@adhar/shell-ui'
import type { DesignScope } from '../data/platform.ts'
import { ownerTeam, type Scoped } from '../data/scope.ts'

/**
 * Tenancy UI for design artifacts: a project / team picker and an owner chip.
 */

const SELECT =
  'h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-[12.5px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

export function ScopeFields({ value, onChange, scope, compact }: { value: Scoped; onChange(v: Scoped): void; scope: DesignScope; compact?: boolean }) {
  const project = scope.projects.find((p) => p.slug === value.project)
  const teamOptions = project?.teams?.length ? scope.teams.filter((t) => project.teams!.includes(t.slug)) : scope.teams
  return (
    <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`}>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Project</span>
        <select
          value={value.project ?? ''}
          onChange={(e) => {
            const slug = e.target.value || undefined
            const p = scope.projects.find((x) => x.slug === slug)
            const team = value.team && p?.teams?.length && !p.teams.includes(value.team) ? p.teams[0] : value.team ?? p?.teams?.[0]
            onChange({ project: slug, team })
          }}
          className={SELECT}
          aria-label="Project"
        >
          <option value="">Workspace-wide</option>
          {scope.projects.map((p) => <option key={p.slug} value={p.slug}>{p.name ?? p.slug}</option>)}
          {value.project && !project ? <option value={value.project}>{value.project} (not found)</option> : null}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Owner team</span>
        <select value={value.team ?? ''} onChange={(e) => onChange({ ...value, team: e.target.value || undefined })} className={SELECT} aria-label="Owner team">
          <option value="">No owner</option>
          {teamOptions.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
          {value.team && !scope.teams.some((t) => t.slug === value.team) ? <option value={value.team}>{value.team}</option> : null}
        </select>
      </label>
    </div>
  )
}

/** "Payments · shop" — the owner team and project, or nothing for workspace-wide items. */
export function ScopeChip({ item, scope, className }: { item: Scoped; scope: DesignScope; className?: string }) {
  const team = ownerTeam(item, scope.projects)
  if (!team && !item.project) return null
  return (
    <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-full bg-surface-sunken px-2 py-0.5 text-[10.5px] text-content-muted ${className ?? ''}`} title="Owner team · project">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><circle cx="9" cy="8" r="3.2" /><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5M16 11.5a3 3 0 1 0 0-6M21 19c0-2.4-1.5-4.2-4-4.8" /></svg>
      <span className="truncate">{[scope.teamName(team), item.project ? scope.projectName(item.project) : undefined].filter(Boolean).join(' · ')}</span>
    </span>
  )
}

/** Edit an artifact's project and owner team. */
export function ScopeModal({ open, onClose, value, scope, onSave }: { open: boolean; onClose(): void; value: Scoped; scope: DesignScope; onSave(v: Scoped): void }) {
  const [v, setV] = useState<Scoped>(value)
  useEffect(() => {
    if (open) setV(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Project and owner"
      description="Which workspace project this belongs to and which team owns it. The team selector in the top bar filters by this."
      width="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => onSave(v)}>Save</Button>
        </>
      }
    >
      <ScopeFields value={v} onChange={setV} scope={scope} />
    </Modal>
  )
}
