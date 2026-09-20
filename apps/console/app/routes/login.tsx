import { useState } from 'react'
import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  AdharSymbol,
  AdharWordmark,
  Button,
  ModeToggle,
  useAppConfig,
} from '@adhar-console/shell-ui'
import { getDemoSession, useAuth } from '@adhar-console/auth'
import { z } from 'zod'

/**
 * Sign-in page — a brand-saturated story panel floating beside an SSO-first
 * action card, both sitting on one ambient field.
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
 *
 * ---------------------------------------------------------------------------
 * LAYOUT NOTES (why it is built this way)
 * ---------------------------------------------------------------------------
 * The hero is an INSET rounded panel, not a flush half. Butting a saturated
 * blue panel against the page surface produced a hard vertical seam down the
 * middle of the screen — the single most unfinished-looking thing here. Given
 * a margin and a radius it reads as a surface resting on the page instead.
 *
 * The ambient layer (aurora + hairline mesh) therefore lives on the ROOT, not
 * inside the right-hand column, so both halves share one field and the hero
 * has something to float on. The page background is opaque, so the global
 * `body::before` texture never reaches this route — without this layer the
 * sign-in side is a flat void holding a small card.
 *
 * Below `lg` the hero is hidden entirely. That used to leave a phone with no
 * statement of what the product is and a third of a screen of empty space, so
 * the compact logo line and `COMPACT_PROOF` strip stand in for it.
 */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    returnTo: z.string().optional(),
    error: z.string().optional(),
  }),
  head: () => ({ meta: [{ title: 'Sign in · Adhar Console' }] }),
  component: LoginPage,
})

/*
 * Proof points for the hero. Four, not six, and each makes a claim the others
 * don't: the previous list said "GitOps delivery" twice and repeated the
 * paragraph's "no black boxes, no lock-in" verbatim, which reads as padding.
 */
const HIGHLIGHTS = [
  'GitOps delivery with progressive rollouts and policy guardrails.',
  'Logs, metrics, traces, cost and policy in one lifecycle view.',
  'Single sign-on — your Kubernetes RBAC applies everywhere.',
  'Self-hosted, multi-tenant and 100% open source.',
]

/* The same promise, compressed — shown under the card on small screens, where
 * the hero panel is hidden and the page would otherwise say nothing about the
 * product at all. */
const COMPACT_PROOF = [
  ['Lifecycle', 'Plan → ship → observe'],
  ['Delivery', 'GitOps + rollouts'],
  ['Open', 'Self-hosted, no lock-in'],
] as const

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
  // Whether this platform lets people sign themselves up (a Keycloak realm
  // setting, probed server-side and reported on /api/config).
  const selfRegistration = useAppConfig().data?.selfRegistration ?? false
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

  /**
   * Sign up for real, then set the workspace up.
   *
   * This used to open `/onboarding` directly. Onboarding is a public route, so
   * the wizard rendered — but creating an organization needs an owner, and with
   * no account there is nobody to own it. The visitor filled in every step and
   * the first provisioning action failed on a 401. Registration has to happen
   * first; Keycloak hands the account straight back here with a session, and
   * `returnTo` drops them into onboarding ready to provision.
   */
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
    setSession(getDemoSession())
    // `returnTo` may carry a query string (`/deliver?section=flow`); the router
    // wants path and search separately, so split them instead of dropping it.
    const [path, query = ''] = (returnTo ?? '/').split('?')
    const search = Object.fromEntries(new URLSearchParams(query))
    nav({ to: path || '/', search: search as never, replace: true })
  }

  const redirecting = busy === 'login' || busy === 'register'

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-surface-app">
      {/*
        One ambient field behind the whole page, not a per-column decoration.
        The page background is opaque, so the global body texture never showed
        through here and the sign-in side was a flat void holding a small card.
        A drifting brand/accent wash plus a hairline mesh (masked out under the
        card, so it never fights the form) give the form side a surface of its
        own, and carry the hero's colour across the seam.
      */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="adhar-aurora absolute -top-1/4 left-[58%] h-184 w-184 -translate-x-1/2 rounded-full opacity-60 blur-3xl dark:opacity-40"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklch, var(--color-brand-500) 22%, transparent) 0%, transparent 70%)',
          }}
        />
        <div
          className="adhar-aurora-slow absolute -bottom-1/4 right-[-10%] h-136 w-136 rounded-full opacity-50 blur-3xl dark:opacity-30"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklch, var(--color-accent-500) 20%, transparent) 0%, transparent 70%)',
          }}
        />
        {/*
          Light spilling out of the hero, across the join. The hero is flush
          against the form side, so without this the two halves meet on a hard
          vertical cut down the middle of the screen — the most obviously
          unfinished thing on the page. A brand glow fading over ~14rem makes
          the boundary a falloff rather than an edge, and it is the same colour
          the hero's own right edge is lit with, so the two agree.
        */}
        <div
          className="absolute inset-y-0 left-1/2 hidden w-56 lg:block"
          style={{
            background:
              'linear-gradient(90deg, color-mix(in oklch, var(--color-brand-500) 26%, transparent), transparent 85%)',
          }}
        />
        {/*
          Two grids rather than one: the hole in the mask has to sit under the
          card, and the card is centred below `lg` but sits at ~72% once the
          hero panel takes the left half. A single mask tuned for one of those
          turns the other into graph paper behind the form.
        */}
        <div
          className="absolute inset-0 opacity-40 lg:hidden dark:opacity-35"
          style={{
            backgroundImage:
              'linear-gradient(var(--color-edge-default) 1px, transparent 1px), linear-gradient(90deg, var(--color-edge-default) 1px, transparent 1px)',
            backgroundSize: '52px 52px',
            maskImage: 'radial-gradient(ellipse 70% 45% at 50% 50%, transparent 20%, black 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 70% 45% at 50% 50%, transparent 20%, black 100%)',
          }}
        />
        <div
          className="absolute inset-0 hidden opacity-40 lg:block dark:opacity-35"
          style={{
            backgroundImage:
              'linear-gradient(var(--color-edge-default) 1px, transparent 1px), linear-gradient(90deg, var(--color-edge-default) 1px, transparent 1px)',
            backgroundSize: '52px 52px',
            maskImage: 'radial-gradient(ellipse 60% 55% at 72% 50%, transparent 25%, black 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 60% 55% at 72% 50%, transparent 25%, black 100%)',
          }}
        />
      </div>

      <BrandPanel />

      {/* Sign-in column */}
      <div className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        {/* Color-mode toggle — available before sign-in so the login screen
            itself respects the user's light/dark preference. */}
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ModeToggle variant="icon" />
        </div>

        <div className="relative w-full max-w-104">
          {/* Logo — shown here on small screens (brand panel is hidden). It
              carries the positioning line too, so a phone still learns what
              this is before being asked to sign in. */}
          <div className="mb-7 flex flex-col items-center gap-3 text-center lg:hidden">
            <span className="flex items-center gap-2.5">
              <AdharSymbol size={40} />
              <AdharWordmark fontSize={26} />
            </span>
            <p className="text-[13px] font-medium text-content-muted">
              Your entire platform, one console.
            </p>
          </div>

          <div className="relative overflow-hidden rounded-3xl border border-edge-default bg-surface-raised/85 p-7 shadow-2xl shadow-brand-950/10 ring-1 ring-black/5 backdrop-blur-xl dark:bg-surface-raised/70 dark:shadow-black/50 dark:ring-white/8 sm:p-9">
            {/* Brand accent: a soft top glow plus a hairline, so the card reads
                as the lit surface of the page rather than a plain box. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-24 h-40 opacity-70 blur-2xl"
              style={{
                backgroundImage:
                  'radial-gradient(60% 100% at 50% 100%, color-mix(in oklch, var(--color-brand-500) 28%, transparent), transparent 70%)',
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-brand-500/70 to-transparent"
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

            {/*
              The eyebrow pill here used to read "Your platform, one console" —
              word for word the hero headline two columns to the left, both on
              screen at once. The card leads with the headline instead.
            */}
            <div className="relative space-y-2">
              <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-content">
                {configured ? (
                  <>
                    Welcome back to{' '}
                    <span className="bg-linear-to-r from-brand-600 to-accent-600 bg-clip-text text-transparent dark:from-brand-300 dark:to-accent-500">
                      Adhar
                    </span>
                  </>
                ) : (
                  'Explore the console'
                )}
              </h1>
              <p className="text-[13.5px] leading-relaxed text-content-muted">
                {configured
                  ? 'Sign in with your organisation account to pick up where you left off.'
                  : 'Walk the whole console with a stubbed session — no identity provider required.'}
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
                  {selfRegistration ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="lg"
                      block
                      onClick={handleSignup}
                      loading={busy === 'register'}
                    >
                      {busy === 'register' ? 'Redirecting to sign-up…' : 'Create a new account'}
                    </Button>
                  ) : (
                    /* Sign-up is closed on this platform. Saying so is kinder
                       than a button that ends at an identity-provider error —
                       and an account has to exist before a workspace can be
                       created for it. */
                    <p className="text-center text-[12px] leading-relaxed text-content-muted">
                      Need an account?{' '}
                      <span className="font-medium text-content">
                        Ask your platform administrator to create one
                      </span>{' '}
                      — self sign-up is turned off for this platform.
                    </p>
                  )}
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
                    to="/onboarding"
                    className="inline-flex h-11 w-full items-center justify-center rounded-md border border-edge-default bg-surface-raised px-4 text-sm font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
                  >
                    Create a new account
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

          {/* Below `lg` the hero panel is hidden, so the page said nothing
              about the product and left a third of a phone screen empty under
              the card. Three compressed proof points fill it and carry the
              same promise the hero makes on desktop. */}
          <ul className="mt-6 grid grid-cols-3 gap-2 lg:hidden">
            {COMPACT_PROOF.map(([label, detail]) => (
              <li
                key={label}
                className="rounded-xl border border-edge-subtle bg-surface-raised/60 px-2.5 py-2 text-center backdrop-blur-sm"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">
                  {label}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-content-muted">{detail}</div>
              </li>
            ))}
          </ul>

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
      // Flush, full-bleed half of the screen — no margin, no radius. The seam
      // that treatment leaves is handled with light rather than with a gap:
      // an inner edge highlight here, and a brand glow bleeding rightwards
      // from the join (see the ambient layer), so the two halves read as one
      // lit surface meeting another instead of two panels butted together.
      className="relative hidden w-1/2 shrink-0 overflow-hidden lg:flex lg:flex-col"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 20% -5%, color-mix(in oklch, var(--color-brand-500) 55%, transparent), transparent 55%), linear-gradient(150deg, var(--color-brand-950), var(--color-brand-900) 55%, var(--color-accent-950, var(--color-brand-950)))',
      }}
    >
      {/*
        Drifting light fields. These were `animate-pulse` before — a 2s opacity
        throb on a 24rem orb, which reads as a loading skeleton rather than
        atmosphere. `adhar-aurora` moves them slowly instead, and both stop
        under `prefers-reduced-motion`.
      */}
      <div
        aria-hidden
        className="adhar-aurora absolute -left-24 -top-24 h-96 w-96 rounded-full opacity-50 blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--color-brand-400) 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="adhar-aurora-slow absolute -bottom-32 -right-16 h-112 w-112 rounded-full opacity-40 blur-3xl"
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
          WebkitMaskImage: 'radial-gradient(ellipse 80% 80% at 40% 30%, black, transparent 75%)',
        }}
      />
      {/*
        Depth at the edges. A flat rectangle of gradient reads as a swatch;
        these give it the falloff a lit surface has — darker into the bottom
        corners, and a hairline of light down the right edge where the panel
        meets the page, so the join is where the light is brightest rather
        than where the colour stops.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 85% at 30% 25%, transparent 45%, color-mix(in oklch, var(--color-brand-950) 70%, transparent) 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-linear-to-r from-transparent to-white/6"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-px bg-linear-to-b from-transparent via-white/35 to-transparent"
      />

      <div className="relative z-10 flex h-full flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center gap-2.5">
          <AdharSymbol size={38} />
          <span className="text-lg font-extrabold uppercase tracking-tight text-white">Adhar</span>
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">
            Console
          </span>
        </div>

        {/* The panel is now a full half of the screen, so the measure is
            capped rather than left to fill it — a 900px line of body copy is
            unreadable however much room there is for it. */}
        <div className="max-w-xl">
          <h2 className="text-[2.35rem] font-semibold leading-[1.08] tracking-[-0.02em] text-white xl:text-[3rem]">
            Your entire platform,
            <br />
            one console.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/70">
            Plan, build, ship and observe without stitching together a dozen dashboards — every
            capability powered by a best-in-class open-source project, running on your own
            infrastructure.
          </p>

          {/* Distinct proof points — see HIGHLIGHTS. */}
          <ul className="mt-9 space-y-3.5">
            {HIGHLIGHTS.map((h) => (
              <li
                key={h}
                className="flex items-start gap-3 text-[14.5px] leading-relaxed text-white/80"
              >
                <span className="mt-px flex-none rounded-full bg-white/10 p-1 text-accent-500 ring-1 ring-inset ring-white/15">
                  <IconCheck />
                </span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
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
function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m20 6-11 11-5-5" />
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
