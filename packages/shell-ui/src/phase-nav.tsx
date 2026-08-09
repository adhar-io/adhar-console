import { Link, useRouterState } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'

export type Phase =
  | 'define'
  | 'design'
  | 'develop'
  | 'deliver'
  | 'discover'
  | 'decide'
  | 'platform'

export const PHASES: { id: Phase; label: string; description: string; accent: string }[] = [
  { id: 'define', label: 'Define', description: 'Requirements & OKRs', accent: 'bg-blue-500' },
  { id: 'design', label: 'Design', description: 'Architecture & UI', accent: 'bg-indigo-500' },
  { id: 'develop', label: 'Develop', description: 'Code & CI', accent: 'bg-emerald-500' },
  { id: 'deliver', label: 'Deliver', description: 'GitOps & releases', accent: 'bg-amber-500' },
  { id: 'discover', label: 'Discover', description: 'Observability', accent: 'bg-rose-500' },
  { id: 'decide', label: 'Decide', description: 'Analytics & KPIs', accent: 'bg-violet-500' },
  { id: 'platform', label: 'Platform', description: 'Kubernetes ops', accent: 'bg-slate-500' },
]

export function PhaseNav() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <nav aria-label="Software lifecycle phases" className="flex flex-col gap-0.5">
      {PHASES.map((p) => {
        const active = path.startsWith(`/${p.id}`)
        return (
          <Link
            key={p.id}
            to={`/${p.id}`}
            className={cn(
              'group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-surface-sunken text-content font-medium'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', p.accent)} aria-hidden />
            <span className="flex-1">{p.label}</span>
            <span className="text-xs text-content-subtle group-hover:text-content-muted">
              {p.description}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
