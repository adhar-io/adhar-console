import { useState } from 'react'
import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Button } from '@adhar-console/shell-ui'
import { getStubSession, useAuth } from '@adhar-console/auth'
import { z } from 'zod'

/**
 * Sign-in page.
 *
 * When Keycloak is configured (`VITE_KEYCLOAK_URL` set), the primary CTA
 * triggers an OIDC redirect — Keycloak owns the credentials form, we never
 * see passwords. When *not* configured (local dev), we fall back to a
 * stub-session button so the UI is still walkable.
 *
 * Optional `?returnTo=/some/path` is preserved through the redirect so users
 * land back where they came from after auth.
 */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    returnTo: z.string().optional(),
    error: z.string().optional(),
  }),
  head: () => ({ meta: [{ title: 'Sign in · Adhar Console' }] }),
  component: LoginPage,
})

function LoginPage() {
  const { configured, signin, signup, setSession } = useAuth()
  const { returnTo, error } = useSearch({ from: '/login' })
  const nav = useNavigate()
  const [busy, setBusy] = useState<'login' | 'register' | 'demo' | null>(null)
  const [localError, setLocalError] = useState<string | null>(error ?? null)

  async function handleSignin() {
    setBusy('login')
    setLocalError(null)
    try {
      await signin({ returnTo })
    } catch (e) {
      setBusy(null)
      setLocalError(e instanceof Error ? e.message : 'Could not start sign-in.')
    }
  }

  async function handleSignup() {
    setBusy('register')
    setLocalError(null)
    try {
      await signup({ returnTo: '/onboarding' })
    } catch (e) {
      setBusy(null)
      setLocalError(e instanceof Error ? e.message : 'Could not start sign-up.')
    }
  }

  function continueAsDemo() {
    setBusy('demo')
    setSession(getStubSession())
    nav({ to: returnTo ?? '/', replace: true })
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center bg-surface-app px-4 py-12"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 15% 0%, color-mix(in oklch, var(--color-brand-500) 22%, transparent) 0, transparent 45%), radial-gradient(ellipse at 110% 110%, color-mix(in oklch, var(--color-accent-500) 18%, transparent) 0, transparent 45%)',
      }}
    >
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-sm font-bold text-white shadow-sm">
            A
          </div>
          <span className="text-lg font-semibold tracking-tight text-content">Adhar Console</span>
        </div>

        <div className="rounded-2xl border border-edge-default bg-white p-7 shadow-sm">
          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-content">Welcome back</h1>
            <p className="text-sm text-content-muted">
              Sign in to manage your platform — or create a new workspace.
            </p>
          </div>

          {localError ? (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              {localError}
            </div>
          ) : null}

          <div className="mt-6 space-y-2.5">
            {configured ? (
              <>
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  block
                  loading={busy === 'login'}
                  onClick={handleSignin}
                >
                  Continue with Keycloak
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  block
                  loading={busy === 'register'}
                  onClick={handleSignup}
                >
                  Create a new account
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  block
                  loading={busy === 'demo'}
                  onClick={continueAsDemo}
                >
                  Continue as demo user
                </Button>
                <Link
                  to="/signup"
                  className="inline-flex h-10 w-full items-center justify-center rounded-md border border-edge-default bg-white px-4 text-sm font-medium text-content shadow-sm hover:border-edge-strong hover:bg-surface-sunken"
                >
                  Walk through onboarding
                </Link>
              </>
            )}
          </div>

          <div className="mt-6 flex items-center gap-3 text-[11px] text-content-subtle">
            <div className="h-px flex-1 bg-edge-subtle" />
            {configured ? 'Single sign-on via Keycloak' : 'Demo mode — Keycloak not configured'}
            <div className="h-px flex-1 bg-edge-subtle" />
          </div>
        </div>

        <p className="text-center text-xs text-content-subtle">
          By signing in you agree to the{' '}
          <a href="#terms" className="underline-offset-2 hover:underline">
            Terms of Service
          </a>{' '}
          and{' '}
          <a href="#privacy" className="underline-offset-2 hover:underline">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  )
}
