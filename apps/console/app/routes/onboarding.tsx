import { useMemo, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  Button,
  DEFAULT_APP_LINKS,
  StatusBadge,
  type AppLink,
} from '@adhar-console/shell-ui'
import { useAuth, type Session } from '@adhar-console/auth'
import { BACKING_TOOLS } from '@adhar-console/platform-info'
import { cn } from '@adhar-console/utils'

export const Route = createFileRoute('/onboarding')({
  head: () => ({ meta: [{ title: 'Get started · Adhar Console' }] }),
  component: OnboardingWizard,
})

type Step = 0 | 1 | 2 | 3 | 4

interface State {
  orgSlug: string
  orgName: string
  region: 'us-east-1' | 'eu-west-1' | 'ap-south-1'
  plan: 'free' | 'team' | 'business'
  invites: { email: string; role: 'admin' | 'member' | 'viewer' }[]
  connectedTools: Set<string>
  starter: 'blank' | 'monorepo' | 'microservices' | 'ml-platform'
}

const DEFAULT: State = {
  orgSlug: '',
  orgName: '',
  region: 'us-east-1',
  plan: 'team',
  invites: [],
  connectedTools: new Set(['gitea', 'argocd', 'kargo', 'harbor', 'keycloak', 'grafana']),
  starter: 'monorepo',
}

interface StepDef {
  id: Step
  title: string
  eyebrow: string
  description: string
}

const STEPS: StepDef[] = [
  {
    id: 0,
    eyebrow: 'Welcome',
    title: 'Adhar Platform for the whole SDLC',
    description: "2-minute setup — we'll walk through the essentials.",
  },
  {
    id: 1,
    eyebrow: 'Workspace',
    title: 'Create your organization',
    description: 'Name, slug, region, and plan.',
  },
  {
    id: 2,
    eyebrow: 'People',
    title: 'Invite your team',
    description: 'Optional — you can always invite folks later from Settings.',
  },
  {
    id: 3,
    eyebrow: 'Integrations',
    title: 'Connect your platform tools',
    description: 'Every integration is a real open-source project — no black boxes.',
  },
  {
    id: 4,
    eyebrow: 'Starter',
    title: 'Pick a starter project',
    description: 'A first workload to land on so the dashboards have something to show.',
  },
]

function OnboardingWizard() {
  const nav = useNavigate()
  const { session, setSession } = useAuth()
  const [step, setStep] = useState<Step>(0)
  const [state, setState] = useState<State>(DEFAULT)

  const canContinue = useMemo(() => {
    if (step === 1) return state.orgName.trim().length > 0 && state.orgSlug.trim().length > 0
    return true
  }, [step, state.orgName, state.orgSlug])

  function finishOnboarding() {
    /*
     * Optimistically update the in-memory session so the orgSlug becomes the
     * user's first tenant claim — this satisfies the root route's onboarding
     * gate for the current tab.
     *
     * NOTE: this is client-only. Real tenant provisioning (Crossplane claim +
     * Keycloak group/attribute so the `tenants` claim survives a reload) is a
     * platform concern handled by a future `/api/tenants` BFF call; until then
     * the new tenant is not persisted into the server-side session cookie.
     */
    if (session) {
      const slug = state.orgSlug.trim()
      const updated: Session = {
        ...session,
        user: {
          ...session.user,
          tenants: session.user.tenants.includes(slug)
            ? session.user.tenants
            : [slug, ...session.user.tenants],
        },
        activeTenant: slug || session.activeTenant,
      }
      setSession(updated)
    }
    try {
      localStorage.setItem('adhar.onboarding.completed', new Date().toISOString())
    } catch {
      /* storage quota / private mode — non-fatal */
    }
    nav({ to: '/' })
  }

  function next() {
    if (!canContinue) return
    if (step === 4) {
      finishOnboarding()
      return
    }
    setStep((step + 1) as Step)
  }
  function back() {
    if (step === 0) return
    setStep((step - 1) as Step)
  }

  const current = STEPS[step]
  const progressPct = ((step + 1) / STEPS.length) * 100

  return (
    <div
      className="relative min-h-screen overflow-hidden bg-surface-app"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 20% -10%, color-mix(in oklch, var(--color-brand-500) 22%, transparent) 0, transparent 45%), radial-gradient(ellipse at 110% 110%, color-mix(in oklch, var(--color-accent-500) 18%, transparent) 0, transparent 45%)',
      }}
    >
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-10 sm:px-6 lg:px-8">
        {/* Top chrome */}
        <header className="mb-8 flex items-center justify-between gap-3">
          <Link
            to="/"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-edge-default bg-white/80 px-3 text-sm text-content-muted shadow-sm backdrop-blur transition-colors hover:border-edge-strong hover:text-content"
          >
            <IconArrowLeft />
            Skip for now
          </Link>
          {session ? (
            <div className="inline-flex h-10 items-center gap-2.5 rounded-full border border-edge-default bg-white/80 py-1 pl-1.5 pr-3.5 shadow-sm backdrop-blur">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-linear-to-br from-brand-500 to-accent-500 text-[11px] font-semibold text-white">
                {initials(session.user.name)}
              </span>
              <span className="hidden flex-col leading-tight sm:flex">
                <span className="text-xs font-semibold text-content">{session.user.name}</span>
                <span className="text-[10px] text-content-subtle">{session.user.email}</span>
              </span>
              <span className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
                <IconShieldMini /> SSO
              </span>
            </div>
          ) : (
            <span className="inline-flex h-8 items-center gap-2 rounded-full border border-edge-default bg-white/80 px-3 text-xs shadow-sm backdrop-blur">
              <AdharMark />
              <span className="font-semibold text-content">Adhar</span>
              <span className="text-content-subtle">Console</span>
            </span>
          )}
        </header>

        {/* Stepper */}
        <nav aria-label="Onboarding progress" className="mb-8">
          <ol className="hidden grid-cols-5 gap-2 md:grid">
            {STEPS.map((s) => {
              const done = s.id < step
              const active = s.id === step
              return (
                <li key={s.id} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all',
                      done && 'bg-brand-600 text-white shadow-sm',
                      active && 'bg-brand-600 text-white shadow-sm ring-4 ring-brand-500/20',
                      !done && !active && 'bg-surface-sunken text-content-subtle ring-1 ring-edge-default',
                    )}
                  >
                    {done ? (
                      <IconCheck />
                    ) : (
                      s.id + 1
                    )}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={cn(
                        'truncate text-[10px] font-semibold uppercase tracking-widest',
                        active ? 'text-brand-700' : 'text-content-subtle',
                      )}
                    >
                      {s.eyebrow}
                    </div>
                    <div
                      className={cn(
                        'truncate text-xs',
                        active ? 'font-medium text-content' : 'text-content-muted',
                      )}
                    >
                      {s.title.split(' ').slice(0, 3).join(' ')}…
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="h-1 overflow-hidden rounded-full bg-surface-sunken md:mt-3">
            <div
              className="h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-smooth"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-content-subtle md:hidden">
            <span>
              Step {step + 1} of {STEPS.length}
            </span>
            <span className="font-medium text-brand-700">{current.eyebrow}</span>
          </div>
        </nav>

        {/* Main card */}
        <main className="flex-1">
          <div className="overflow-hidden rounded-2xl border border-edge-default bg-white shadow-lg">
            <div className="border-b border-edge-subtle bg-linear-to-br from-brand-50 to-white px-6 py-6 sm:px-10 sm:py-8">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-brand-700">
                Step {step + 1} · {current.eyebrow}
              </div>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-content sm:text-3xl">
                {current.title}
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-content-muted">
                {current.description}
              </p>
            </div>

            <div className="px-6 py-6 sm:px-10 sm:py-8">
              {step === 0 && <StepWelcome session={session} />}
              {step === 1 && <StepOrg state={state} setState={setState} />}
              {step === 2 && <StepInvites state={state} setState={setState} />}
              {step === 3 && <StepConnect state={state} setState={setState} />}
              {step === 4 && <StepStarter state={state} setState={setState} />}
            </div>

            <div className="flex flex-col-reverse items-stretch gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-10">
              <div>
                {step > 0 ? (
                  <Button variant="ghost" size="md" onClick={back} leading={<IconArrowLeft />}>
                    Back
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                <Link
                  to="/"
                  className="text-center text-xs font-medium text-content-muted hover:text-content"
                >
                  I'll finish later
                </Link>
                <Button
                  variant="primary"
                  size="md"
                  onClick={next}
                  disabled={!canContinue}
                  trailing={<IconArrowRight />}
                >
                  {step === 4 ? 'Finish & open console' : 'Continue'}
                </Button>
              </div>
            </div>
          </div>
        </main>

        <footer className="mt-10 text-center text-[11px] text-content-subtle">
          Everything you set here can be changed later in Settings.
        </footer>
      </div>
    </div>
  )
}

/* ───── step panels ───── */

function StepWelcome({ session }: { session: Session | null }) {
  const highlights = [
    {
      title: 'Unified operator UI',
      body:
        'One canvas for requirements, design, delivery, observability, and cost. No more 12 browser tabs.',
    },
    {
      title: 'Open source all the way down',
      body:
        'Every feature is aggregated from a real OSS project — Gitea, Argo, Kargo, Harbor, Kyverno, LGTM, Plane, Keycloak.',
    },
    {
      title: 'Kubernetes-native',
      body:
        'Reads straight from the kube-apiserver in dev, or an authenticated BFF in production — no vendor data stores.',
    },
    {
      title: 'Composable abstractions',
      body:
        'Crossplane composites for Application, Database, Pipeline, and Route claims — so your teams ship, not config.',
    },
  ]
  return (
    <div className="space-y-6">
      {session ? (
        <div className="flex items-center gap-4 rounded-2xl border border-edge-subtle bg-linear-to-br from-brand-50 via-white to-accent-50/40 p-4 sm:p-5">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br from-brand-500 to-accent-500 text-lg font-semibold text-white shadow-sm">
            {initials(session.user.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-700">
              <IconShieldMini /> Signed in via single sign-on
            </div>
            <div className="mt-0.5 truncate text-lg font-semibold text-content">
              Welcome, {firstName(session.user.name)} 👋
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="truncate rounded-full bg-white px-2 py-0.5 text-[11px] text-content-muted ring-1 ring-inset ring-edge-default">
                {session.user.email}
              </span>
              {session.user.roles.map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-inset ring-brand-200"
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 self-start rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold text-content-muted shadow-sm ring-1 ring-inset ring-edge-default sm:inline-flex">
            <AdharMark /> Keycloak
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {highlights.map((h, i) => (
        <div
          key={h.title}
          className="rounded-xl border border-edge-subtle bg-surface-sunken/60 p-4"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
              {i + 1}
            </span>
            <div className="text-sm font-semibold text-content">{h.title}</div>
          </div>
            <p className="mt-2 text-sm leading-relaxed text-content-muted">{h.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function StepOrg({
  state,
  setState,
}: {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
}) {
  const slugOk = /^[a-z0-9][a-z0-9-]{1,30}$/.test(state.orgSlug)
  const plans: { id: State['plan']; title: string; price: string; perks: string[] }[] = [
    { id: 'free', title: 'Free', price: '$0', perks: ['Up to 3 projects', '1 environment', 'Community support'] },
    {
      id: 'team',
      title: 'Team',
      price: '$29 /user · mo',
      perks: ['Unlimited projects', 'SSO + audit log', 'Priority support'],
    },
    {
      id: 'business',
      title: 'Business',
      price: '$79 /user · mo',
      perks: ['SAML SCIM', 'Dedicated env', '99.95% SLA'],
    },
  ]
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Organization name
          </span>
          <input
            value={state.orgName}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                orgName: e.target.value,
                orgSlug:
                  s.orgSlug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
              }))
            }
            placeholder="Acme Corp"
            className="mt-1.5 w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm shadow-sm"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Slug
          </span>
          <div className="mt-1.5 flex overflow-hidden rounded-lg border border-edge-default bg-white shadow-sm focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400/20">
            <span className="border-r border-edge-subtle bg-surface-sunken px-3 py-2 font-mono text-xs text-content-subtle">
              adhar.io/
            </span>
            <input
              value={state.orgSlug}
              onChange={(e) => setState((s) => ({ ...s, orgSlug: e.target.value.toLowerCase() }))}
              placeholder="acme"
              className="flex-1 bg-transparent px-3 py-2 font-mono text-sm focus:outline-none"
            />
          </div>
          <span
            className={cn(
              'mt-1 block text-[11px]',
              state.orgSlug && !slugOk ? 'text-rose-600' : 'text-content-subtle',
            )}
          >
            {state.orgSlug && !slugOk
              ? 'Use lowercase letters, numbers, and hyphens only (2–31 chars).'
              : 'Used in URLs + namespace prefixes. Lowercase letters, numbers, hyphens.'}
          </span>
        </label>
        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Primary region
          </span>
          <select
            value={state.region}
            onChange={(e) => setState((s) => ({ ...s, region: e.target.value as State['region'] }))}
            className="mt-1.5 w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm shadow-sm"
          >
            <option value="us-east-1">us-east-1 · N. Virginia</option>
            <option value="eu-west-1">eu-west-1 · Ireland</option>
            <option value="ap-south-1">ap-south-1 · Mumbai</option>
          </select>
          <span className="mt-1 block text-[11px] text-content-subtle">
            Where metrics, logs, and audit data are stored.
          </span>
        </label>
      </div>

      <div>
        <div className="mb-3 text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
          Plan
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {plans.map((p) => {
            const on = state.plan === p.id
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => setState((s) => ({ ...s, plan: p.id }))}
                className={cn(
                  'relative rounded-xl border p-4 text-left transition-all duration-150 ease-smooth',
                  on
                    ? 'border-brand-500 bg-brand-50/40 ring-2 ring-brand-500/20'
                    : 'border-edge-default bg-white hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
                )}
              >
                {p.id === 'team' ? (
                  <span className="absolute -top-2 right-3 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                    Popular
                  </span>
                ) : null}
                <div className="text-sm font-semibold text-content">{p.title}</div>
                <div className="mt-0.5 text-[11px] text-content-muted">{p.price}</div>
                <ul className="mt-2.5 space-y-1 text-[11px] text-content-muted">
                  {p.perks.map((pk) => (
                    <li key={pk} className="flex items-start gap-1.5">
                      <IconCheckDot />
                      {pk}
                    </li>
                  ))}
                </ul>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function StepInvites({
  state,
  setState,
}: {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<State['invites'][number]['role']>('member')
  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!email) return
          setState((s) => ({ ...s, invites: [...s.invites, { email, role }] }))
          setEmail('')
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <div className="relative flex-1">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="w-full rounded-lg border border-edge-default bg-white px-3 py-2 pr-10 text-sm shadow-sm"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-content-subtle">
            <IconMail />
          </span>
        </div>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
          className="rounded-lg border border-edge-default bg-white px-3 py-2 text-sm shadow-sm sm:w-32"
        >
          <option value="admin">admin</option>
          <option value="member">member</option>
          <option value="viewer">viewer</option>
        </select>
        <Button type="submit" variant="primary">
          Add invite
        </Button>
      </form>

      {state.invites.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge-default bg-surface-sunken/60 p-8 text-center">
          <div className="text-sm font-medium text-content">No invites queued</div>
          <p className="mt-1 text-xs text-content-muted">
            Skip this step and invite your team later from Settings → Members.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {state.invites.map((i, idx) => (
            <li
              key={idx}
              className="flex items-center justify-between rounded-lg border border-edge-subtle bg-surface-sunken/60 px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2 text-content">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                  {i.email.slice(0, 2).toUpperCase()}
                </span>
                {i.email}
              </span>
              <div className="flex items-center gap-2">
                <select
                  value={i.role}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      invites: s.invites.map((x, j) =>
                        j === idx ? { ...x, role: e.target.value as typeof i.role } : x,
                      ),
                    }))
                  }
                  className="rounded-md border border-edge-default bg-white px-2 py-1 text-xs"
                >
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                  <option value="viewer">viewer</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      invites: s.invites.filter((_, j) => j !== idx),
                    }))
                  }
                  aria-label="Remove invite"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-white hover:text-rose-600"
                >
                  <IconTrash />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StepConnect({
  state,
  setState,
}: {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
}) {
  function toggle(id: string) {
    setState((s) => {
      const next = new Set(s.connectedTools)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...s, connectedTools: next }
    })
  }

  // Pair BACKING_TOOLS (rich metadata) with DEFAULT_APP_LINKS (brand icons)
  const iconsById = useMemo(() => {
    const m = new Map<string, AppLink>()
    for (const a of DEFAULT_APP_LINKS) m.set(a.id, a)
    return m
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-content-muted">
        <span>
          <span className="font-semibold text-content">{state.connectedTools.size}</span> of{' '}
          {BACKING_TOOLS.length} connected
        </span>
        <button
          type="button"
          onClick={() =>
            setState((s) => ({
              ...s,
              connectedTools: new Set(BACKING_TOOLS.map((t) => t.id)),
            }))
          }
          className="font-medium text-brand-700 hover:text-brand-800"
        >
          Select all
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {BACKING_TOOLS.map((t) => {
          const on = state.connectedTools.has(t.id)
          const app = iconsById.get(t.id)
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => toggle(t.id)}
              aria-pressed={on}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 text-left transition-all duration-150 ease-smooth',
                on
                  ? 'border-brand-500 bg-brand-50/40 ring-2 ring-brand-500/20'
                  : 'border-edge-default bg-white hover:border-edge-strong hover:shadow-md',
              )}
            >
              {app?.icon ? (
                <div className="shrink-0">{app.icon}</div>
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-sunken text-xs font-bold text-content">
                  {t.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-content">{t.name}</div>
                  <StatusBadge kind={on ? 'healthy' : 'unknown'}>
                    {on ? 'connected' : 'skip'}
                  </StatusBadge>
                </div>
                <div className="truncate text-[11px] text-content-muted">{t.purpose}</div>
                <div className="mt-1 font-mono text-[10px] text-content-subtle">
                  v{t.version} · {t.license}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StepStarter({
  state,
  setState,
}: {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
}) {
  const options: {
    id: State['starter']
    title: string
    description: string
    accent: string
    tags: string[]
  }[] = [
    {
      id: 'blank',
      title: 'Blank org',
      description: 'No starter — I\'ll set things up from scratch.',
      accent: 'linear-gradient(135deg, #64748b, #334155)',
      tags: ['clean slate'],
    },
    {
      id: 'monorepo',
      title: 'Full-stack monorepo',
      description:
        'pnpm workspace with web + API + shared libs, wired to Argo Workflows + Kargo promotion.',
      accent: 'linear-gradient(135deg, var(--color-brand-500), var(--color-brand-800))',
      tags: ['web', 'api', 'gitops'],
    },
    {
      id: 'microservices',
      title: 'Microservices',
      description:
        'Three services behind Traefik, with Argo Rollouts canary steps preconfigured.',
      accent: 'linear-gradient(135deg, #8b5cf6, #3730a3)',
      tags: ['canary', 'traefik', 'rollouts'],
    },
    {
      id: 'ml-platform',
      title: 'ML platform',
      description:
        'KServe + Argo Workflows for training pipelines + Grafana ML dashboards.',
      accent: 'linear-gradient(135deg, var(--color-accent-500), #0f766e)',
      tags: ['kserve', 'workflows', 'grafana'],
    },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {options.map((o) => {
        const on = state.starter === o.id
        return (
          <button
            type="button"
            key={o.id}
            onClick={() => setState((s) => ({ ...s, starter: o.id }))}
            aria-pressed={on}
            className={cn(
              'group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-150 ease-smooth',
              on
                ? 'border-brand-500 ring-2 ring-brand-500/20'
                : 'border-edge-default bg-white hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
            )}
          >
            <div
              className="mb-3 h-20 w-full rounded-lg"
              style={{ backgroundImage: o.accent }}
            />
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">{o.title}</div>
                <div className="mt-1 text-xs leading-relaxed text-content-muted">
                  {o.description}
                </div>
              </div>
              {on ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white">
                  <IconCheck />
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {o.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ───── helpers ───── */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

/* ───── tiny icon set ───── */

function IconShieldMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function AdharMark() {
  return (
    <span
      className="relative flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-bold text-white"
      style={{
        backgroundImage:
          'linear-gradient(135deg, var(--color-brand-500), var(--color-brand-800))',
      }}
    >
      A
    </span>
  )
}

function IconArrowLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  )
}

function IconArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function IconCheckDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="var(--color-brand-500)" opacity="0.15" />
      <path d="m8 12 2.5 2.5L16 9" stroke="var(--color-brand-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconMail() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}
