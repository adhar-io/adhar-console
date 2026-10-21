import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, useToast } from '@adhar/shell-ui'
import type { SourceStatus } from '~/data/catalog-live.ts'

/**
 * The catalog with nothing in it.
 *
 * The catalog used to fall back to a built-in sample catalog here, which
 * looked exactly like real services. It now says what is true: either nothing
 * has been created yet, or the sources the catalog reads (the cluster, Gitea)
 * could not be reached — and offers the next step. The first real application
 * replaces this as soon as a source reports it.
 */
export function CatalogEmpty({ sources, onRegister }: { sources: SourceStatus[]; onRegister(): void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const failing = sources.filter((s) => s.state === 'error')
  const unreachable = failing.length > 0 && failing.length === sources.length

  return (
    <section className="flex flex-col items-center px-4 py-14 text-center sm:py-20" aria-labelledby="catalog-empty-title">
      <EmptyCatalogArt />
      <h2 id="catalog-empty-title" className="mt-6 text-lg font-semibold text-content">
        {unreachable ? 'The catalog could not reach its sources' : 'No services in the catalog yet'}
      </h2>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-content-muted">
        {unreachable
          ? 'Applications appear here from the cluster and from Gitea. Neither answered, so there is nothing to list right now.'
          : 'Every application your teams create on Adhar shows up here automatically — with its environments, deployments, tech stack and docs. Create your first one from a golden path, or register a service that already exists.'}
      </p>

      {failing.length ? (
        <ul className="mt-4 w-full max-w-md space-y-1.5 text-left">
          {failing.map((s) => (
            <li key={s.id} className="flex items-start gap-2 rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-[12px]">
              <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-rose-500" />
              <span className="min-w-0">
                <span className="font-medium text-content">{s.label}</span>
                <span className="text-content-muted"> — {s.error ?? 'not reachable'}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {unreachable ? (
          <Button
            variant="primary"
            size="sm"
            onClick={async () => {
              await qc.invalidateQueries({ queryKey: ['catalog'] })
              toast.success('Checking the catalog sources again')
            }}
          >
            Try again
          </Button>
        ) : (
          <Link
            to="/catalog"
            search={{ section: 'create' } as never}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            Create a new app
          </Link>
        )}
        <Button variant="secondary" size="sm" onClick={onRegister}>
          Register existing service
        </Button>
      </div>
    </section>
  )
}

/** A stack of empty catalog cards with a dashed slot — theme colours only, so it reads in light and dark. */
function EmptyCatalogArt() {
  return (
    <svg viewBox="0 0 240 160" className="h-36 w-auto sm:h-44" role="img" aria-label="An empty catalog">
      <defs>
        <linearGradient id="catalog-empty-glow" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--color-brand-500)" stopOpacity="0.18" />
          <stop offset="1" stopColor="var(--color-brand-500)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="120" cy="140" rx="96" ry="12" fill="var(--color-edge-default)" opacity="0.6" />
      <circle cx="120" cy="74" r="66" fill="url(#catalog-empty-glow)" />
      {/* back cards */}
      <rect x="44" y="40" width="96" height="64" rx="10" fill="var(--color-surface-sunken)" stroke="var(--color-edge-default)" />
      <rect x="100" y="30" width="96" height="64" rx="10" fill="var(--color-surface-sunken)" stroke="var(--color-edge-default)" />
      {/* front card */}
      <rect x="68" y="56" width="104" height="72" rx="12" fill="var(--color-surface-raised)" stroke="var(--color-edge-strong)" />
      <rect x="80" y="68" width="22" height="22" rx="6" fill="var(--color-brand-500)" opacity="0.15" />
      <path d="M86 79h10M91 74v10" stroke="var(--color-brand-500)" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="110" y="70" width="48" height="6" rx="3" fill="var(--color-edge-strong)" />
      <rect x="110" y="82" width="32" height="5" rx="2.5" fill="var(--color-edge-default)" />
      <rect x="80" y="100" width="80" height="16" rx="5" fill="none" stroke="var(--color-edge-strong)" strokeDasharray="4 4" />
      {/* sparkle */}
      <path d="M196 54l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="var(--color-brand-400)" opacity="0.7" />
      <circle cx="40" cy="96" r="3" fill="var(--color-brand-400)" opacity="0.5" />
    </svg>
  )
}
