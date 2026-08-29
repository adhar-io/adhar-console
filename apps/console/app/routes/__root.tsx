import { useEffect } from 'react'
import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { AdharSymbol, Spinner } from '@adhar-console/shell-ui'
import { useAuth, type Session } from '@adhar-console/auth'
import type { Tenant } from '@adhar-console/tenancy'

export interface RouterContext {
  queryClient: QueryClient
  session: Session | null
  tenant: Tenant | null
}

/**
 * Root route — renders just the `<Outlet />`.
 *
 * The surrounding `<html>` / `<head>` / `<body>` scaffolding is provided by:
 *   - `apps/console/index.html` in dev (SPA mode)
 *   - TanStack Start's SSR handler in production build
 *
 * Don't reintroduce `<html>`/`<body>` here — it'll double-wrap in dev and
 * break hydration in prod.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
})

/* ─────────── auth gate ─────────── */

const PUBLIC_PATH_PREFIXES = ['/login', '/signup', '/auth/']
const ONBOARDING_PATH = '/onboarding'

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  )
}

function RootComponent() {
  useRouteTitleSync()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { status, session } = useAuth()
  const nav = useNavigate()
  const isPublic = isPublicPath(pathname)

  // Already authenticated but sitting on /login (e.g. a bookmark, or a stale tab
  // after the OIDC round-trip) → send them into the app, honouring ?returnTo.
  const search = useRouterState({ select: (s) => s.location.search as { returnTo?: string } })
  useEffect(() => {
    if (status !== 'authenticated' || pathname !== '/login') return
    const raw = search?.returnTo && search.returnTo.startsWith('/') ? search.returnTo : '/'
    // Never send an authenticated user back to /login — that would re-trigger
    // this effect and loop (the page appears to just reload).
    const to = raw === '/login' || raw.startsWith('/login?') ? '/' : raw
    nav({ to, replace: true })
  }, [status, pathname, search, nav])

  // Unauthenticated → bounce to /login (preserving the path the user wanted).
  useEffect(() => {
    if (status !== 'anonymous' || isPublic) return
    nav({
      to: '/login',
      search: { returnTo: pathname === '/' ? undefined : pathname },
      replace: true,
    })
  }, [status, isPublic, pathname, nav])

  // Onboarding is NO LONGER forced on every login. The Keycloak token has no
  // `tenants` claim (it carries `groups`), so the old `tenants.length === 0`
  // guard bounced EVERY sign-in to /onboarding. The console now auto-provisions
  // a default organization, so a signed-in user always has a workspace and lands
  // straight in the app. Onboarding stays reachable at /onboarding as a
  // first-run helper (surfaced in-app), just not as a blocking gate.
  //
  // Show it once for a genuinely new browser (no completed/skipped flag), then
  // never again — a returning user goes directly to the app.
  useEffect(() => {
    if (status !== 'authenticated' || !session || isPublic) return
    if (pathname !== '/' ) return
    try {
      const seen = globalThis.localStorage?.getItem('adhar.onboarding.completed')
      if (!seen) nav({ to: ONBOARDING_PATH, replace: true })
    } catch {
      /* private mode — just land in the app */
    }
  }, [status, session, pathname, isPublic, nav])

  // Loading splash while we're still figuring out who the user is.
  if (status === 'loading' && !isPublic) return <BootSplash />

  // Anonymous + protected route → render nothing (redirect already in flight).
  if (status === 'anonymous' && !isPublic) return null

  return (
    <>
      <NavProgressBar />
      <Outlet />
    </>
  )
}

/**
 * Thin indeterminate progress bar pinned to the top of the viewport while the
 * router is resolving a navigation — instant feedback on every menu click,
 * before the destination's skeleton or content paints.
 */
function NavProgressBar() {
  const active = useRouterState({ select: (s) => s.status === 'pending' })
  if (!active) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-200 h-0.5 overflow-hidden"
    >
      <div className="nav-progress-sweep h-full w-full bg-linear-to-r from-brand-500 via-accent-500 to-brand-500" />
    </div>
  )
}

function BootSplash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-surface-sunken">
      <AdharSymbol size={56} className="animate-pulse" />
      <div className="flex items-center gap-3 rounded-xl border border-edge-default bg-surface-raised px-4 py-3 text-sm text-content-muted shadow-sm">
        <Spinner size={14} />
        <span>Loading workspace…</span>
      </div>
    </div>
  )
}

/**
 * In SPA mode there's no `<HeadContent />` rendering `<title>` tags — so we
 * set document.title manually from the deepest matched route's `head()` meta.
 */
function useRouteTitleSync() {
  const title = useRouterState({
    select: (s) => {
      const matches = s.matches ?? []
      for (let i = matches.length - 1; i >= 0; i--) {
        const meta = (matches[i] as { meta?: Array<{ title?: string }> }).meta
        if (!meta) continue
        for (let j = meta.length - 1; j >= 0; j--) {
          if (meta[j]?.title) return meta[j].title
        }
      }
      return 'Adhar Console'
    },
  })
  useEffect(() => {
    if (typeof document !== 'undefined' && title) document.title = title
  }, [title])
}
