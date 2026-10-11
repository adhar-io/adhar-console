import { EmptyState } from '@adhar/shell-ui'
import { useProject, usePlaneLink } from '../data/plane.ts'

/**
 * Pages — the project's wiki, which lives in Plane.
 *
 * Plane's pages are documents in its real-time collaborative editor (the
 * `plane-live` service), and its public API — the one the console reaches
 * with the platform's API key — has no pages endpoints at all. Rendering a
 * list here would mean inventing data or calling routes that answer 404, so
 * this tab opens the project's pages in Plane, signed in through the same
 * Keycloak session as the console.
 */
export function Pages({ projectId }: { projectId?: string }) {
  const project = useProject(projectId)
  const pagesUrl = usePlaneLink(projectId ? `projects/${projectId}/pages` : '')

  if (!projectId) return <EmptyState title="Pick a project" />

  const name = project.data?.name ?? 'this project'
  return (
    <EmptyState
      title={`Pages for ${name} are edited in Plane`}
      description="Plane pages are live, multi-person documents in Plane's own editor, and its API does not expose them. Open them in Plane — you are signed in with the same account."
      icon={<IconDoc />}
      action={pagesUrl
        ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <a
              href={pagesUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              Open pages in Plane ↗
            </a>
          </div>
        )
        : undefined}
    />
  )
}

function IconDoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  )
}
