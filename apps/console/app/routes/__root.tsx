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

  // Unauthenticated → bounce to /login (preserving the path the user wanted).
  useEffect(() => {
    if (status !== 'anonymous' || isPublic) return
    nav({
      to: '/login',
      search: { returnTo: pathname === '/' ? undefined : pathname },
      replace: true,
    })
  }, [status, isPublic, pathname, nav])

  // Authenticated but no tenant claim → finish onboarding before anything else.
  // Skip the guard on `/onboarding` itself (so the wizard renders) and on
  // `/auth/*` (callback bounces handle their own targets).
  useEffect(() => {
    if (status !== 'authenticated' || !session) return
    if (session.user.tenants.length === 0 && pathname !== ONBOARDING_PATH && !isPublic) {
      nav({ to: ONBOARDING_PATH, replace: true })
    }
  }, [status, session, pathname, isPublic, nav])

  // Loading splash while we're still figuring out who the user is.
  if (status === 'loading' && !isPublic) return <BootSplash />

  // Anonymous + protected route → render nothing (redirect already in flight).
  if (status === 'anonymous' && !isPublic) return null

  return <Outlet />
}

function BootSplash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-slate-50">
      <AdharSymbol size={56} className="animate-pulse" />
      <div className="flex items-center gap-3 rounded-xl border border-edge-default bg-white px-4 py-3 text-sm text-content-muted shadow-sm">
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
