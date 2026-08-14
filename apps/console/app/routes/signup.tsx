import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { AdharLogo, Button } from '@adhar-console/shell-ui'
import { getStubSession, useAuth } from '@adhar-console/auth'

/**
 * Sign-up landing page.
 *
 * Real account creation lives in Keycloak — clicking "Create account" jumps
 * to the Keycloak-hosted registration form via `kc_action=register`. After
 * the user finishes there, Keycloak redirects back to `/auth/callback`,
 * which routes a fresh user (no tenants yet) to `/onboarding` to set up
 * their workspace.
 *
 * Without Keycloak configured (local dev), this page just minted the stub
 * session and drops the user straight into the onboarding wizard.
 */
export const Route = createFileRoute('/signup')({
  head: () => ({ meta: [{ title: 'Create account · Adhar Console' }] }),
  component: SignupPage,
})

function SignupPage() {
  const { configured, signup, setSession } = useAuth()
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSignup() {
    setBusy(true)
    setError(null)
    try {
      if (configured) {
        await signup({ returnTo: '/onboarding' })
        // browser navigates away — nothing else to do
      } else {
        setSession(getStubSession())
        nav({ to: '/onboarding', replace: true })
      }
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : 'Could not start account creation.')
    }
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center bg-surface-app px-4 py-12"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 85% 0%, color-mix(in oklch, var(--color-accent-500) 22%, transparent) 0, transparent 45%), radial-gradient(ellipse at -10% 110%, color-mix(in oklch, var(--color-brand-500) 18%, transparent) 0, transparent 45%)',
      }}
    >
      <div className="grid w-full max-w-4xl gap-8 lg:grid-cols-[1.1fr_1fr]">
        {/* Left — pitch */}
        <div className="hidden lg:flex lg:flex-col lg:justify-center lg:gap-5">
          <div className="flex items-center">
            <AdharLogo symbolSize={40} subtitle="Console" />
          </div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-content">
            Adhar Platform for the whole SDLC.
          </h1>
          <p className="text-sm leading-relaxed text-content-muted">
            Define, design, develop, deliver, discover, decide — in a single console backed by
            best-in-class open source. We provision the toolchain, you ship.
          </p>
          <ul className="space-y-2 text-sm text-content-muted">
            <FeatureRow>Plane for issues · Gitea for code · ArgoCD for deploys</FeatureRow>
            <FeatureRow>Crossplane + Kyverno + Harbor for platform compliance</FeatureRow>
            <FeatureRow>Grafana + Loki + Tempo + Mimir wired to every service</FeatureRow>
            <FeatureRow>Keycloak SSO, multi-tenant, no black boxes</FeatureRow>
          </ul>
        </div>

        {/* Right — signup card */}
        <div className="rounded-2xl border border-edge-default bg-surface-raised p-7 shadow-sm">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-content">
              Create your workspace
            </h2>
            <p className="text-sm text-content-muted">
              {configured
                ? 'Sign up via Keycloak — you’ll then walk through a 2-minute onboarding.'
                : 'Demo mode — we’ll mint a stub session and drop you into onboarding.'}
            </p>
          </div>

          {error ? (
            <div className="mt-4 rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-700 dark:text-rose-300">
              {error}
            </div>
          ) : null}

          <ol className="mt-6 space-y-3 text-sm">
            <Step n={1} title="Create your account">
              {configured
                ? 'Email + password (or social login) hosted by Keycloak.'
                : 'Stubbed in demo mode — no real credentials needed.'}
            </Step>
            <Step n={2} title="Set up your organization">
              Name, slug, region, plan — takes about 30 seconds.
            </Step>
            <Step n={3} title="Connect your tools">
              Pre-wired to the Adhar platform stack — flip toggles to opt in or out.
            </Step>
            <Step n={4} title="Pick a starter project">
              Lands a first workload so dashboards have data on day one.
            </Step>
          </ol>

          <div className="mt-6 space-y-2.5">
            <Button
              type="button"
              variant="primary"
              size="lg"
              block
              loading={busy}
              onClick={handleSignup}
            >
              {configured ? 'Create account with Keycloak' : 'Start demo onboarding'}
            </Button>
            <Link
              to="/login"
              className="inline-flex h-10 w-full items-center justify-center rounded-md border border-edge-default bg-surface-raised px-4 text-sm font-medium text-content shadow-sm hover:border-edge-strong hover:bg-surface-sunken"
            >
              I already have an account
            </Link>
          </div>

          <p className="mt-5 text-center text-[11px] text-content-subtle">
            By creating an account you agree to the{' '}
            <a href="#terms" className="underline-offset-2 hover:underline">
              Terms
            </a>{' '}
            and{' '}
            <a href="#privacy" className="underline-offset-2 hover:underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

function FeatureRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-1 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-200">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12l5 5 9-11" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-surface-raised">
        {n}
      </span>
      <div className="flex-1">
        <div className="text-sm font-medium text-content">{title}</div>
        <div className="text-xs text-content-muted">{children}</div>
      </div>
    </li>
  )
}
