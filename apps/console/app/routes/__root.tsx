import { useEffect } from 'react'
import {
  createRootRouteWithContext,
  Outlet,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { AdharSymbol, Spinner, subscribeUnauthorized } from '@adhar-console/shell-ui'
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

// `/onboarding` is public so "Create a new account" opens the onboarding stages
// directly (no Keycloak round-trip first); the wizard renders fine without a
// session and establishes identity at the provisioning step.
const PUBLIC_PATH_PREFIXES = ['/login', '/signup', '/onboarding', '/auth/']

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  )
}

function RootComponent() {
  useRouteTitleSync()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { status } = useAuth()
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

  // A 401 from any BFF call means the session expired mid-use — data layers emit
  // `adhar:unauthorized`; send the user to sign in again (unless already on a
  // public page), preserving where they were.
  useEffect(() => {
    return subscribeUnauthorized(() => {
      if (isPublicPath(globalThis.location?.pathname ?? pathname)) return
      nav({
        to: '/login',
        search: {
          returnTo: pathname === '/' ? undefined : pathname,
          error: 'Your session expired. Please sign in again.',
        },
        replace: true,
      })
    })
  }, [pathname, nav])

  // Onboarding is NEVER auto-forced. A normal login lands straight in the app
  // (the server callback sends `login` intent to `/`, `register` intent to
  // `/onboarding`). The console auto-provisions a default organization, so a
  // signed-in user always has a workspace. Onboarding stays reachable at
  // /onboarding — via "Create a new account" or an in-app entry point — but it
  // is not a blocking gate, so a fresh browser logging in goes to the dashboard.

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
