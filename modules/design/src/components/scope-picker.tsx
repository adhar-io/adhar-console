import { useEffect, useRef } from 'react'
import { Select } from '@adhar/shell-ui'
import { lastProject, useDesignScope } from '../data/design-scope.ts'

/**
 * Project scope for the Design pages (header action). Lists the projects in
 * the active team's lens; "All projects" clears it. The choice lives in the
 * URL (`?project=`) and is remembered for the next visit.
 */
export function ScopePicker() {
  const scope = useDesignScope()
  const restored = useRef(false)

  // Restore the last project once the list is known and the URL has none.
  useEffect(() => {
    if (restored.current || !scope.ready) return
    restored.current = true
    const last = lastProject()
    if (!scope.project && last && scope.projects.some((p) => p.slug === last)) scope.setProject(last)
  }, [scope])

  if (scope.ready && scope.projects.length === 0) return null
  return (
    <Select
      aria-label="Project scope"
      title={scope.filtering ? `Projects owned by team ${scope.team}` : 'Narrow the Design pages to one project'}
      value={scope.project}
      onChange={(e) => scope.setProject(e.target.value || undefined)}
      className="h-8 py-1 text-xs"
      wrapperClassName="w-full sm:w-52"
      options={[
        { value: '', label: scope.filtering ? `All ${scope.team} projects` : 'All projects' },
        ...scope.projects.map((p) => ({ value: p.slug, label: p.name || p.slug })),
      ]}
    />
  )
}

/** "Workspace" chip for artifacts shared across every project. */
export function SharedChip() {
  return (
    <span
      title="Workspace-wide — not tied to one project"
      className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-content-subtle ring-1 ring-inset ring-edge-default"
    >
      Workspace
    </span>
  )
}

/** Project chip for an artifact's tag. */
export function ProjectChip({ project }: { project?: string }) {
  if (!project) return <SharedChip />
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
      {project}
    </span>
  )
}
