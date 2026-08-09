import { useState } from 'react'
import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import { AdharSymbol, AdharWordmark, Button } from '@adhar-console/shell-ui'
import { getStubSession, useAuth } from '@adhar-console/auth'
import { z } from 'zod'

/**
 * Sign-in page — split-screen: an immersive brand panel + an SSO-first card.
 *
 * When Keycloak is configured the primary CTA triggers the OIDC redirect
 * (Keycloak owns the credentials form — the console never sees a password).
 * In local dev (no Keycloak) a stub "demo user" keeps the UI walkable.
 * `?returnTo=/path` is preserved through the redirect.
 */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    returnTo: z.string().optional(),
    error: z.string().optional(),
  }),
  head: () => ({ meta: [{ title: 'Sign in · Adhar Console' }] }),
  component: LoginPage,
})

const PHASES = [
  { k: 'Define', d: 'Requirements, epics, OKRs' },
  { k: 'Design', d: 'ADRs, tokens, diagrams' },
  { k: 'Develop', d: 'Repos, PRs, pipelines' },
  { k: 'Deliver', d: 'GitOps, rollouts, policy' },
  { k: 'Discover', d: 'Logs, metrics, traces' },
  { k: 'Decide', d: 'DORA, health, spend' },
]

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

  const redirecting = busy === 'login' || busy === 'register'

  return (
    <div className="flex min-h-screen bg-surface-app">
      <BrandPanel />

      {/* Sign-in column */}
      <div className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        {/* Ambient tint (mobile / narrow) */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 lg:hidden"
          style={{
            backgroundImage:
              'radial-gradient(ellipse at 50% -10%, color-mix(in oklch, var(--color-brand-500) 16%, transparent) 0, transparent 55%)',
          }}
        />

        <div className="relative w-full max-w-sm">
          {/* Logo — shown here on small screens (brand panel is hidden) */}
          <div className="mb-8 flex items-center justify-center lg:hidden">
            <span className="flex items-center gap-2.5">
              <AdharSymbol size={40} />
              <AdharWordmark fontSize={26} />
            </span>
          </div>

          <div className="rounded-2xl border border-edge-default bg-white/95 p-7 shadow-xl shadow-black/[0.04] backdrop-blur sm:p-8">
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight text-content">Welcome back</h1>
              <p className="text-sm text-content-muted">
                Sign in to your Adhar platform — one console for the whole software lifecycle.
              </p>
            </div>

            {localError ? (
              <div
                role="alert"
                className="mt-5 flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 px-3 py-2.5 text-xs font-medium text-rose-700 dark:text-rose-300"
              >
                <IconAlert />
                <span>{localError}</span>
              </div>
            ) : null}

            <div className="mt-6 space-y-3">
              {configured ? (
                <>
                  <button
                    type="button"
                    onClick={handleSignin}
                    disabled={redirecting}
                    className="group relative flex h-12 w-full items-center justify-center gap-2.5 overflow-hidden rounded-xl bg-linear-to-r from-brand-600 to-accent-600 px-4 font-semibold text-white shadow-lg shadow-brand-600/25 transition-all hover:shadow-brand-600/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-80"
                  >
                    <span
                      aria-hidden
                      className="absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover:translate-x-full"
                    />
                    {busy === 'login' ? <Spinner /> : <IconShield />}
                    {busy === 'login' ? 'Redirecting to Keycloak…' : 'Continue with Single Sign-On'}
                  </button>
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
                    className="inline-flex h-11 w-full items-center justify-center rounded-md border border-edge-default bg-surface-raised px-4 text-sm font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
                  >
                    Walk through onboarding
                  </Link>
                </>
              )}
            </div>

            {/* Trust line */}
            <div className="mt-6 flex items-center gap-2 rounded-lg bg-surface-sunken/70 px-3 py-2.5 text-[11px] leading-snug text-content-muted">
              <span className="text-emerald-600">
                <IconLock />
              </span>
              {configured ? (
                <span>
                  Secured by <span className="font-semibold text-content">Keycloak</span> single sign-on. Your
                  password never touches the console.
                </span>
              ) : (
                <span>
                  Demo mode — Keycloak isn’t configured. Set <code className="rounded bg-surface-raised px-1 font-mono">KEYCLOAK_URL</code> to enable SSO.
                </span>
              )}
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-content-subtle">
            By continuing you agree to the{' '}
            <a href="#terms" className="font-medium text-content-muted underline-offset-2 hover:text-content hover:underline">
              Terms
            </a>{' '}
            and{' '}
            <a href="#privacy" className="font-medium text-content-muted underline-offset-2 hover:text-content hover:underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

/* ─────────────── brand / marketing panel ─────────────── */

function BrandPanel() {
  return (
    <aside className="relative hidden w-[46%] max-w-2xl shrink-0 overflow-hidden lg:flex lg:flex-col">
      {/* Base + animated gradient orbs */}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(150deg, #0b1220 0%, #131a2e 55%, #0d1b2a 100%)' }} />
      <div
        aria-hidden
        className="absolute -left-24 -top-24 h-96 w-96 rounded-full opacity-60 blur-3xl"
        style={{ background: 'radial-gradient(circle, #3B82F6 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full opacity-50 blur-3xl"
        style={{ background: 'radial-gradient(circle, #8B5CF6 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />

      <div className="relative z-10 flex h-full flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <AdharSymbol size={38} />
          <span className="text-lg font-extrabold uppercase tracking-tight text-white">Adhar</span>
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">
            Console
          </span>
        </div>

        <div className="max-w-lg">
          <h2 className="text-[2.1rem] font-semibold leading-[1.15] tracking-tight text-white xl:text-[2.5rem]">
            One control plane for your whole platform.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70">
            Requirements to production to observability — aggregated from the best open-source tools,
            unified under one tenant-aware, Kubernetes-native console.
          </p>

          <ul className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4">
            {PHASES.map((p) => (
              <li key={p.k} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-inset ring-white/15">
                  <IconDot />
                </span>
                <div>
                  <div className="text-sm font-semibold text-white">{p.k}</div>
                  <div className="text-xs text-white/55">{p.d}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-3 text-xs text-white/55">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-medium text-white/80 ring-1 ring-inset ring-white/10">
            <IconShield /> SSO by Keycloak
          </span>
          <span className="hidden xl:inline">Gitea · Argo CD · Kargo · Harbor · Kyverno · Grafana · Crossplane</span>
        </div>
      </div>
    </aside>
  )
}

/* ─────────────── icons ─────────────── */

function Spinner() {
  return (
    <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
function IconShield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}
function IconLock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
function IconAlert() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  )
}
function IconDot() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden>
      <circle cx="4" cy="4" r="3" />
    </svg>
  )
}
