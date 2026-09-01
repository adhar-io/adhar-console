import { useState, type ReactNode } from 'react'
import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  AdharSymbol,
  AdharWordmark,
  ArgoCDIcon,
  ArgoRolloutsIcon,
  ArgoWorkflowsIcon,
  Button,
  CrossplaneIcon,
  GiteaIcon,
  GrafanaIcon,
  HarborIcon,
  KargoIcon,
  KeycloakIcon,
  KubernetesIcon,
  KyvernoIcon,
  LokiIcon,
  ModeToggle,
  PlaneIcon,
  PrometheusIcon,
  TempoIcon,
} from '@adhar-console/shell-ui'
import { getStubSession, useAuth } from '@adhar-console/auth'
import { z } from 'zod'

/**
 * Sign-in page — a split hero: an immersive, brand-saturated story panel on the
 * left and an SSO-first action card on the right.
 *
 * When Keycloak is configured the primary CTA triggers the OIDC redirect
 * (Keycloak owns the credentials form — the console never sees a password).
 * In local dev (no Keycloak) a stub "demo user" keeps the UI walkable.
 * `?returnTo=/path` is preserved through the redirect; sign-up carries the user
 * into the onboarding wizard.
 *
 * Theme-aware throughout: the action side runs on design tokens (light/dark),
 * and the hero uses the brand-token gradient (brand-900→brand-950) that stays
 * legible with light type in either color mode — no bare white/black surfaces.
 */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    returnTo: z.string().optional(),
    error: z.string().optional(),
  }),
  head: () => ({ meta: [{ title: 'Sign in · Adhar Console' }] }),
  component: LoginPage,
})

/* ─────────────── capability showcase (real platform tools) ─────────────── */

interface Capability {
  icon: ReactNode
  name: string
  blurb: string
}
interface CapabilityGroup {
  key: string
  label: string
  items: Capability[]
}

/**
 * The platform's real backing tools, grouped by what they do. Each carries a
 * one-line value prop (not just a name) and its actual brand icon. This is the
 * "no black boxes" promise made visible on the sign-in screen.
 */
const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    key: 'source',
    label: 'Plan & Source',
    items: [
      { icon: <PlaneIcon size={28} />, name: 'Plane', blurb: 'Issues, cycles & OKRs' },
      { icon: <GiteaIcon size={28} />, name: 'Gitea', blurb: 'Git hosting, PRs & packages' },
    ],
  },
  {
    key: 'delivery',
    label: 'Delivery',
    items: [
      { icon: <ArgoCDIcon size={28} />, name: 'Argo CD', blurb: 'GitOps continuous delivery' },
      { icon: <KargoIcon size={28} />, name: 'Kargo', blurb: 'Multi-stage promotion' },
      { icon: <ArgoRolloutsIcon size={28} />, name: 'Rollouts', blurb: 'Canary & blue/green' },
      { icon: <ArgoWorkflowsIcon size={28} />, name: 'Workflows', blurb: 'Container-native CI' },
    ],
  },
  {
    key: 'security',
    label: 'Security & Supply chain',
    items: [
      { icon: <KyvernoIcon size={28} />, name: 'Kyverno', blurb: 'Policy-as-code admission' },
      { icon: <HarborIcon size={28} />, name: 'Harbor', blurb: 'OCI registry + CVE scans' },
      { icon: <KeycloakIcon size={28} />, name: 'Keycloak', blurb: 'SSO & identity' },
    ],
  },
  {
    key: 'observability',
    label: 'Observability',
    items: [
      { icon: <GrafanaIcon size={28} />, name: 'Grafana', blurb: 'Dashboards & alerts' },
      { icon: <PrometheusIcon size={28} />, name: 'Prometheus', blurb: 'Metrics & alerting' },
      { icon: <LokiIcon size={28} />, name: 'Loki', blurb: 'Log aggregation' },
      { icon: <TempoIcon size={28} />, name: 'Tempo', blurb: 'Distributed traces' },
    ],
  },
  {
    key: 'platform',
    label: 'Platform',
    items: [
      { icon: <CrossplaneIcon size={28} />, name: 'Crossplane', blurb: 'Infra via K8s APIs' },
      { icon: <KubernetesIcon size={28} />, name: 'Kubernetes', blurb: 'The runtime substrate' },
    ],
  },
]

/**
 * Map the raw `?error=` string the OIDC handlers redirect back with to a
 * calmer title + guidance. Unknown errors pass through verbatim so we never
 * hide a real message. `retryable` decides whether we offer a one-click retry
 * (transient / recoverable failures) versus just an explanation.
 */
function friendlyError(raw: string): { title: string; hint?: string; retryable: boolean } {
  const r = raw.toLowerCase()
  if (r.includes('temporarily unavailable') || r.includes('discovery')) {
    return {
      title: 'Sign-in is temporarily unavailable.',
      hint: 'The identity provider (Keycloak) could not be reached. This is usually transient — try again in a moment.',
      retryable: true,
    }
  }
  if (r.includes('state mismatch') || r.includes('invalid sign-in state') || r.includes('session state')) {
    return {
      title: 'Your sign-in link expired.',
      hint: 'This can happen if the tab sat idle or cookies were cleared mid-flow. Start a fresh sign-in.',
      retryable: true,
    }
  }
  if (r.includes('could not be completed')) {
    return {
      title: 'Sign-in could not be completed.',
      hint: 'The token exchange with Keycloak failed. Try again; if it persists, contact your platform admin.',
      retryable: true,
    }
  }
  if (r.includes('access_denied') || r.includes('consent')) {
    return { title: 'Sign-in was cancelled.', hint: 'You can try again when ready.', retryable: true }
  }
  return { title: raw, retryable: true }
}

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
        {/* Color-mode toggle — available before sign-in so the login screen
            itself respects the user's light/dark preference. */}
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ModeToggle variant="icon" />
        </div>

        {/* Ambient tint (mobile / narrow — hero panel is hidden below lg) */}
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

          <div className="relative overflow-hidden rounded-2xl border border-edge-default bg-surface-raised/95 p-7 shadow-xl shadow-black/6 ring-1 ring-black/3 backdrop-blur dark:shadow-black/40 dark:ring-white/6 sm:p-8">
            {/* Top brand accent hairline */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-brand-500/60 to-transparent"
            />

            {/* Seamless redirect overlay — covers the card while we hand off to
                Keycloak, so the transition reads as one smooth step. */}
            {redirecting ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-2xl bg-surface-raised/85 backdrop-blur-sm">
                <span className="text-brand-600 dark:text-brand-400">
                  <BigSpinner />
                </span>
                <p className="text-sm font-medium text-content">Taking you to secure sign-in…</p>
                <p className="text-[11px] text-content-subtle">Redirecting to Keycloak</p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/25">
                Internal Developer Platform
              </span>
              <h1 className="pt-1 text-2xl font-semibold tracking-tight text-content">
                {configured ? 'Welcome back' : 'Explore the console'}
              </h1>
              <p className="text-sm text-content-muted">
                Sign in to ship, operate, and observe — the whole software lifecycle in one
                Kubernetes-native console.
              </p>
            </div>

            {localError ? (
              (() => {
                const fe = friendlyError(localError)
                return (
                  <div
                    role="alert"
                    className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300"
                  >
                    <div className="flex items-start gap-2 text-xs font-semibold">
                      <IconAlert />
                      <span>{fe.title}</span>
                    </div>
                    {fe.hint ? (
                      <p className="mt-1 pl-6 text-[11px] font-normal leading-snug text-rose-600/90 dark:text-rose-300/80">
                        {fe.hint}
                      </p>
                    ) : null}
                    {fe.retryable && configured ? (
                      <button
                        type="button"
                        onClick={handleSignin}
                        disabled={redirecting}
                        className="mt-2 ml-6 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-rose-700 underline-offset-2 hover:underline disabled:opacity-60 dark:text-rose-200"
                      >
                        {busy === 'login' ? <Spinner /> : null}
                        Try again
                      </button>
                    ) : null}
                  </div>
                )
              })()
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
                      className="absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-surface-raised/20 to-transparent transition-transform duration-700 group-hover:translate-x-full"
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
    <aside
      className="relative hidden w-[48%] max-w-3xl shrink-0 overflow-hidden lg:flex lg:flex-col"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 20% -5%, color-mix(in oklch, var(--color-brand-500) 55%, transparent), transparent 55%), linear-gradient(150deg, var(--color-brand-950), var(--color-brand-900) 55%, var(--color-accent-950, var(--color-brand-950)))',
      }}
    >
      {/* Animated gradient orbs */}
      <div
        aria-hidden
        className="absolute -left-24 -top-24 h-96 w-96 animate-pulse rounded-full opacity-50 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--color-brand-400) 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--color-accent-500) 0%, transparent 70%)' }}
      />
      {/* Faint grid mesh */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse 80% 80% at 40% 30%, black, transparent 75%)',
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

        <div className="max-w-xl">
          <h2 className="text-[2.1rem] font-semibold leading-[1.12] tracking-tight text-white xl:text-[2.6rem]">
            Your entire platform,
            <br />
            one console.
          </h2>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/70">
            Plan, build, ship, and observe without stitching together a dozen dashboards. Every
            capability is powered by a best-in-class open-source project — self-hosted, tenant-aware,
            and yours. No black boxes, no lock-in.
          </p>

          {/* Grouped capability showcase */}
          <div className="mt-8 space-y-5">
            {CAPABILITY_GROUPS.map((group) => (
              <div key={group.key}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
                    {group.label}
                  </span>
                  <span className="h-px flex-1 bg-white/10" />
                </div>
                <div className="grid grid-cols-2 gap-2 xl:grid-cols-2">
                  {group.items.map((cap) => (
                    <div
                      key={cap.name}
                      className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 backdrop-blur-sm transition-colors hover:border-white/20 hover:bg-white/10"
                    >
                      <span className="flex-none">{cap.icon}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-white">
                          {cap.name}
                        </span>
                        <span className="block truncate text-[11px] text-white/55">{cap.blurb}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-white/55">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-medium text-white/80 ring-1 ring-inset ring-white/10">
            <IconShield /> SSO by Keycloak
          </span>
          <span className="hidden xl:inline">Kubernetes-native · Multi-tenant · 100% open source</span>
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
function BigSpinner() {
  return (
    <svg className="animate-spin" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
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
