import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Role, Session, User } from './types.ts'

/**
 * Browser auth state for the running tab — cookie/session model.
 *
 * The console is a confidential OIDC client: all token handling happens
 * server-side and the browser never sees an access/refresh token. The client
 * only:
 *   1. bootstraps by GETting `/api/auth/session` (cookie-authenticated), and
 *   2. drives sign-in/out via full-page navigation to the server auth routes.
 *
 *   loading       → bootstrapping; we don't yet know if the user is signed in
 *   anonymous     → finished; no valid session
 *   authenticated → finished; we have a session
 *
 * In pure SPA dev (no server — see build-config/host.ts), there is no
 * `/api/auth/*`. The provider detects that (`configured = false`) and the
 * login page offers a stub "Continue as demo user" path via `setSession`.
 */
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated'

export interface AuthContextValue {
  status: AuthStatus
  session: Session | null
  /** True when the server reports Keycloak is configured. */
  configured: boolean
  signin(opts?: { returnTo?: string }): Promise<void>
  signup(opts?: { returnTo?: string }): Promise<void>
  signout(): Promise<void>
  /** Replace the session with a client-minted one (dev demo fallback only). */
  setSession(session: Session): void
}

const AuthContext = createContext<AuthContextValue | null>(null)
export const SessionContext = createContext<Session | null>(null)

export interface AuthProviderProps {
  children: ReactNode
  initialSession?: Session | null
}

/** Vite replaces `import.meta.env.PROD` at build time; guard for safety. */
function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

interface SessionResponse {
  authenticated: boolean
  configured: boolean
  session?: Session
}

async function fetchSession(): Promise<SessionResponse | null> {
  try {
    const res = await fetch('/api/auth/session', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('application/json')) return null
    return (await res.json()) as SessionResponse
  } catch {
    return null
  }
}

export function AuthProvider({ children, initialSession }: AuthProviderProps) {
  const prod = isProdBuild()
  const [session, setSessionState] = useState<Session | null>(initialSession ?? null)
  const [configured, setConfigured] = useState<boolean>(prod)
  const [status, setStatus] = useState<AuthStatus>(
    initialSession ? 'authenticated' : prod ? 'loading' : 'anonymous',
  )
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current || initialSession) return
    bootstrapped.current = true
    // No server in dev → stay anonymous; login page shows the demo path.
    if (!prod) {
      setStatus('anonymous')
      return
    }
    let cancelled = false
    void (async () => {
      const data = await fetchSession()
      if (cancelled) return
      if (!data) {
        // Server unreachable / not a JSON response → assume not configured.
        setConfigured(false)
        setStatus('anonymous')
        return
      }
      setConfigured(data.configured)
      if (data.authenticated && data.session) {
        setSessionState(data.session)
        setStatus('authenticated')
      } else {
        setStatus('anonymous')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [prod, initialSession])

  const signin = useCallback(async (opts?: { returnTo?: string }) => {
    const u = new URL('/api/auth/login', globalThis.location.origin)
    if (opts?.returnTo) u.searchParams.set('returnTo', opts.returnTo)
    globalThis.location.assign(u.toString())
    // Full-page navigation — never resolves.
    await new Promise<void>(() => {})
  }, [])

  const signup = useCallback(async (opts?: { returnTo?: string }) => {
    const u = new URL('/api/auth/login', globalThis.location.origin)
    u.searchParams.set('intent', 'register')
    if (opts?.returnTo) u.searchParams.set('returnTo', opts.returnTo)
    globalThis.location.assign(u.toString())
    await new Promise<void>(() => {})
  }, [])

  const signout = useCallback(async () => {
    if (configured) {
      globalThis.location.assign('/api/auth/logout')
      await new Promise<void>(() => {})
      return
    }
    setSessionState(null)
    setStatus('anonymous')
  }, [configured])

  const setSession = useCallback((s: Session) => {
    setSessionState(s)
    setStatus('authenticated')
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, configured, signin, signup, signout, setSession }),
    [status, session, configured, signin, signup, signout, setSession],
  )

  return createElement(
    AuthContext.Provider,
    { value },
    createElement(SessionContext.Provider, { value: session }, children),
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function useSession(): Session {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession requires an authenticated session')
  return ctx
}

/** Like `useSession`, but returns null instead of throwing when anonymous. */
export function useOptionalSession(): Session | null {
  return useContext(SessionContext)
}

export function useUser(): User {
  return useSession().user
}

export function useHasRole(...roles: Role[]): boolean {
  const user = useUser()
  return roles.some((r) => user.roles.includes(r))
}
