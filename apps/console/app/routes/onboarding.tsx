import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
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
  KyvernoIcon,
  LokiIcon,
  OTelIcon,
  PlaneIcon,
  PrometheusIcon,
  StatusBadge,
  TempoIcon,
} from '@adhar-console/shell-ui'
import { useAuth, type Session } from '@adhar-console/auth'
import { BACKING_TOOLS } from '@adhar-console/platform-info'
import { cn } from '@adhar-console/utils'
import {
  createOrganization,
  toggleTool,
  type CreatedOrg,
  type ToggleOutcome,
} from '~/data/provisioning.ts'

export const Route = createFileRoute('/onboarding')({
  head: () => ({ meta: [{ title: 'Get started · Adhar Console' }] }),
  component: OnboardingWizard,
})

type Step = 0 | 1 | 2 | 3 | 4

interface State {
  orgName: string
  orgDescription: string
  /** Tool ids selected to enable for the org (BACKING_TOOLS ids). */
  selectedTools: Set<string>
}

/** Sensible pre-checked defaults — the platform's core spine. */
const DEFAULT_SELECTED = new Set(['gitea', 'plane', 'argocd', 'kargo', 'harbor', 'kyverno', 'grafana', 'crossplane'])

const DEFAULT: State = {
  orgName: '',
  orgDescription: '',
  selectedTools: new Set(DEFAULT_SELECTED),
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
    title: 'Set up your Adhar workspace',
    description: "A couple of minutes to name your org, pick your capabilities, and provision.",
  },
  {
    id: 1,
    eyebrow: 'Organization',
    title: 'Name your organization',
    description: 'This becomes your tenant — it scopes your projects, data, and namespaces.',
  },
  {
    id: 2,
    eyebrow: 'Capabilities',
    title: 'Choose your capabilities',
    description: 'Each one is a real open-source project we enable via GitOps. Toggle any on or off.',
  },
  {
    id: 3,
    eyebrow: 'Review',
    title: 'Review & provision',
    description: 'Confirm what we\'re about to create. Nothing is provisioned until you hit the button.',
  },
  {
    id: 4,
    eyebrow: 'Provision',
    title: 'Provisioning your workspace',
    description: 'Watch each step run against the platform in real time.',
  },
]

/* ─────────── tool icon map (brand icons by BACKING_TOOLS id) ─────────── */

const TOOL_ICON: Record<string, ReactNode> = {
  gitea: <GiteaIcon size={36} />,
  argocd: <ArgoCDIcon size={36} />,
  kargo: <KargoIcon size={36} />,
  'argo-rollouts': <ArgoRolloutsIcon size={36} />,
  'argo-workflows': <ArgoWorkflowsIcon size={36} />,
  crossplane: <CrossplaneIcon size={36} />,
  keycloak: <KeycloakIcon size={36} />,
  harbor: <HarborIcon size={36} />,
  kyverno: <KyvernoIcon size={36} />,
  plane: <PlaneIcon size={36} />,
  grafana: <GrafanaIcon size={36} />,
  loki: <LokiIcon size={36} />,
  tempo: <TempoIcon size={36} />,
  prometheus: <PrometheusIcon size={36} />,
  opentelemetry: <OTelIcon size={36} />,
}

function toolIcon(id: string, name: string): ReactNode {
  return (
    TOOL_ICON[id] ?? (
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-sunken text-xs font-bold text-content ring-1 ring-inset ring-edge-default">
        {name.slice(0, 2).toUpperCase()}
      </span>
    )
  )
}

/** Preview the slug the server will derive from the org name (mirrors the BFF's slugify). */
function slugPreview(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org'
}

function OnboardingWizard() {
  const nav = useNavigate()
  const { session, setSession } = useAuth()
  const [step, setStep] = useState<Step>(0)
  const [state, setState] = useState<State>(DEFAULT)

  const canContinue = useMemo(() => {
    if (step === 1) return state.orgName.trim().length > 0 && state.orgName.trim().length <= 60
    return true
  }, [step, state.orgName])

  function next() {
    if (!canContinue) return
    // Step 3 → 4 is the provisioning hand-off; the provisioning screen owns the
    // rest of the flow (and the final navigation into the app), so we don't
    // auto-finish here.
    if (step === 3) {
      setStep(4)
      return
    }
    if (step === 4) return
    setStep((step + 1) as Step)
  }
  function back() {
    if (step === 0 || step === 4) return
    setStep((step - 1) as Step)
  }

  function skipOnboarding() {
    // Skipping counts as "seen" so the app never forces onboarding again.
    try {
      localStorage.setItem('adhar.onboarding.completed', new Date().toISOString())
    } catch {
      /* private mode — non-fatal */
    }
    nav({ to: '/' })
  }

  const current = STEPS[step]
  const progressPct = ((step + 1) / STEPS.length) * 100
  const provisioning = step === 4

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
          {provisioning ? (
            <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-edge-default bg-surface-raised/80 px-3 text-sm text-content-muted shadow-sm backdrop-blur">
              <AdharMark />
              <span className="font-semibold text-content">Adhar</span>
              <span className="text-content-subtle">Console</span>
            </span>
          ) : (
            <button
              type="button"
              onClick={skipOnboarding}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-edge-default bg-surface-raised/80 px-3 text-sm text-content-muted shadow-sm backdrop-blur transition-colors hover:border-edge-strong hover:text-content"
            >
              <IconArrowLeft />
              Skip for now
            </button>
          )}
          {session ? (
            <div className="inline-flex h-10 items-center gap-2.5 rounded-full border border-edge-default bg-surface-raised/80 py-1 pl-1.5 pr-3.5 shadow-sm backdrop-blur">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-linear-to-br from-brand-500 to-accent-500 text-[11px] font-semibold text-white">
                {initials(session.user.name)}
              </span>
              <span className="hidden flex-col leading-tight sm:flex">
                <span className="text-xs font-semibold text-content">{session.user.name}</span>
                <span className="text-[10px] text-content-subtle">{session.user.email}</span>
              </span>
              <span className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-200">
                <IconShieldMini /> SSO
              </span>
            </div>
          ) : (
            <span className="inline-flex h-8 items-center gap-2 rounded-full border border-edge-default bg-surface-raised/80 px-3 text-xs shadow-sm backdrop-blur">
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
                    {done ? <IconCheck /> : s.id + 1}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={cn(
                        'truncate text-[10px] font-semibold uppercase tracking-widest',
                        active ? 'text-brand-700 dark:text-brand-300' : 'text-content-subtle',
                      )}
                    >
                      {s.eyebrow}
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
            <span className="font-medium text-brand-700 dark:text-brand-300">{current.eyebrow}</span>
          </div>
        </nav>

        {/* Main card */}
        <main className="flex-1">
          <div className="overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-lg">
            <div className="border-b border-edge-subtle bg-linear-to-br from-brand-50 dark:from-brand-500/10 to-surface-raised px-6 py-6 sm:px-10 sm:py-8">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-brand-700 dark:text-brand-300">
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
              {step === 2 && <StepConnect state={state} setState={setState} />}
              {step === 3 && <StepReview state={state} onEdit={setStep} />}
              {step === 4 && (
                <StepProvision
                  state={state}
                  session={session}
                  setSession={setSession}
                  navHome={() => nav({ to: '/' })}
                />
              )}
            </div>

            {/* Footer nav — hidden on the provisioning screen (it owns its own actions). */}
            {!provisioning ? (
              <div className="flex flex-col-reverse items-stretch gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-10">
                <div>
                  {step > 0 ? (
                    <Button variant="ghost" size="md" onClick={back} leading={<IconArrowLeft />}>
                      Back
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    onClick={skipOnboarding}
                    className="text-center text-xs font-medium text-content-muted hover:text-content"
                  >
                    I'll finish later
                  </button>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={next}
                    disabled={!canContinue}
                    trailing={<IconArrowRight />}
                  >
                    {step === 3 ? 'Provision workspace' : 'Continue'}
                  </Button>
                </div>
              </div>
            ) : null}
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
      title: 'Provisioned via GitOps',
      body:
        'The capabilities you pick are committed to your ApplicationSet — ArgoCD reconciles them into the cluster.',
    },
  ]
  return (
    <div className="space-y-6">
      {session ? (
        <div className="flex items-center gap-4 rounded-2xl border border-edge-subtle bg-linear-to-br from-brand-50 dark:from-brand-500/10 via-surface-raised to-accent-50/40 dark:to-accent-500/5 p-4 sm:p-5">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br from-brand-500 to-accent-500 text-lg font-semibold text-white shadow-sm">
            {initials(session.user.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              <IconShieldMini /> Signed in via single sign-on
            </div>
            <div className="mt-0.5 truncate text-lg font-semibold text-content">
              Welcome, {firstName(session.user.name)} 👋
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="truncate rounded-full bg-surface-raised px-2 py-0.5 text-[11px] text-content-muted ring-1 ring-inset ring-edge-default">
                {session.user.email}
              </span>
              {session.user.roles.map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-brand-50 dark:bg-brand-500/10 px-2 py-0.5 text-[10px] font-medium text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200"
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 self-start rounded-full bg-surface-raised px-2.5 py-1 text-[10px] font-semibold text-content-muted shadow-sm ring-1 ring-inset ring-edge-default sm:inline-flex">
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
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-500/10 text-xs font-semibold text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200">
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
  const trimmed = state.orgName.trim()
  const tooLong = trimmed.length > 60
  const slug = slugPreview(trimmed)
  return (
    <div className="max-w-2xl space-y-6">
      <label className="block">
        <span className="block text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
          Organization name
        </span>
        <input
          autoFocus
          value={state.orgName}
          onChange={(e) => setState((s) => ({ ...s, orgName: e.target.value }))}
          placeholder="Acme Corp"
          maxLength={80}
          className={cn(
            'mt-1.5 w-full rounded-lg border bg-surface-raised px-3 py-2.5 text-sm text-content shadow-sm focus:outline-none focus-visible:ring-2',
            tooLong
              ? 'border-rose-300 focus-visible:ring-rose-500/20'
              : 'border-edge-default focus-visible:border-brand-400 focus-visible:ring-brand-400/20',
          )}
        />
        <span className={cn('mt-1 block text-[11px]', tooLong ? 'text-rose-600' : 'text-content-subtle')}>
          {tooLong
            ? 'Keep it under 60 characters.'
            : 'The display name for your tenant. You can rename it later in Settings.'}
        </span>
      </label>

      <div className="rounded-xl border border-edge-subtle bg-surface-sunken/60 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
          Workspace URL preview
        </div>
        <div className="mt-2 flex items-center overflow-hidden rounded-lg border border-edge-default bg-surface-raised font-mono text-sm shadow-sm">
          <span className="border-r border-edge-subtle bg-surface-sunken px-3 py-2 text-xs text-content-subtle">
            adhar.io/
          </span>
          <span className="truncate px-3 py-2 text-content">{slug}</span>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-content-subtle">
          The slug and a unique id are generated server-side when you provision — this is a preview.
          It scopes your URLs and Kubernetes namespace prefixes.
        </p>
      </div>

      <label className="block">
        <span className="block text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
          Description <span className="font-normal normal-case text-content-subtle">· optional</span>
        </span>
        <textarea
          value={state.orgDescription}
          onChange={(e) => setState((s) => ({ ...s, orgDescription: e.target.value }))}
          placeholder="What does this workspace do? (helps your teammates)"
          rows={2}
          className="mt-1.5 w-full resize-none rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content shadow-sm focus:outline-none focus-visible:border-brand-400 focus-visible:ring-2 focus-visible:ring-brand-400/20"
        />
      </label>
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
      const next = new Set(s.selectedTools)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...s, selectedTools: next }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-content-muted">
        <span>
          <span className="font-semibold text-content">{state.selectedTools.size}</span> of{' '}
          {BACKING_TOOLS.length} capabilities selected
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setState((s) => ({ ...s, selectedTools: new Set(BACKING_TOOLS.map((t) => t.id)) }))}
            className="font-medium text-brand-700 dark:text-brand-300 hover:text-brand-800 dark:hover:text-brand-300"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setState((s) => ({ ...s, selectedTools: new Set(DEFAULT_SELECTED) }))}
            className="font-medium text-content-muted hover:text-content"
          >
            Reset
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {BACKING_TOOLS.map((t) => {
          const on = state.selectedTools.has(t.id)
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => toggle(t.id)}
              aria-pressed={on}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 text-left transition-all duration-150 ease-smooth',
                on
                  ? 'border-brand-500 bg-brand-50/40 dark:bg-brand-500/10 ring-2 ring-brand-500/20'
                  : 'border-edge-default bg-surface-raised hover:border-edge-strong hover:shadow-md',
              )}
            >
              <div className="shrink-0">{toolIcon(t.id, t.name)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-content">{t.name}</div>
                  <StatusBadge kind={on ? 'healthy' : 'unknown'}>{on ? 'enable' : 'skip'}</StatusBadge>
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

function StepReview({ state, onEdit }: { state: State; onEdit: (s: Step) => void }) {
  const slug = slugPreview(state.orgName.trim())
  const selected = BACKING_TOOLS.filter((t) => state.selectedTools.has(t.id))
  return (
    <div className="max-w-3xl space-y-5">
      <ReviewRow label="Organization" onEdit={() => onEdit(1)}>
        <div className="text-sm font-semibold text-content">{state.orgName.trim() || '—'}</div>
        <div className="mt-0.5 font-mono text-[11px] text-content-subtle">adhar.io/{slug}</div>
        {state.orgDescription.trim() ? (
          <div className="mt-1 text-[12px] text-content-muted">{state.orgDescription.trim()}</div>
        ) : null}
      </ReviewRow>

      <ReviewRow label={`Capabilities (${selected.length})`} onEdit={() => onEdit(2)}>
        {selected.length === 0 ? (
          <div className="text-sm text-content-muted">
            None selected — we'll create the org only. You can enable tools later from the Marketplace.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {selected.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge-subtle bg-surface-sunken/60 px-2 py-1 text-[12px] text-content"
              >
                <span className="flex-none">{toolIcon(t.id, t.name)}</span>
                {t.name}
              </span>
            ))}
          </div>
        )}
      </ReviewRow>

      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-snug text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
        <IconInfo />
        <span>
          Provisioning creates your organization (real, persisted) and commits each selected
          capability to your platform ApplicationSet via GitOps. Where the GitOps backend isn't wired
          in this environment, that step is reported as <span className="font-semibold">requested</span> rather
          than completed — never faked.
        </span>
      </div>
    </div>
  )
}

function ReviewRow({
  label,
  onEdit,
  children,
}: {
  label: string
  onEdit: () => void
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border border-edge-subtle bg-surface-raised p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
          {label}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="text-[11px] font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
        >
          Edit
        </button>
      </div>
      {children}
    </div>
  )
}

/* ───── provisioning (the real work) ───── */

type RunState = 'pending' | 'running' | 'done' | 'failed' | 'unavailable' | 'skipped'

interface ProvStep {
  key: string
  /** 'org' or a tool id. */
  kind: 'org' | 'tool'
  label: string
  sublabel?: string
  icon?: ReactNode
  status: RunState
  detail?: string
}

function outcomeToRunState(o: ToggleOutcome): RunState {
  if (o === 'enabled' || o === 'already') return 'done'
  if (o === 'unavailable') return 'unavailable'
  return 'failed'
}

function StepProvision({
  state,
  session,
  setSession,
  navHome,
}: {
  state: State
  session: Session | null
  setSession: (s: Session) => void
  navHome: () => void
}) {
  const selectedIds = useMemo(
    () => BACKING_TOOLS.filter((t) => state.selectedTools.has(t.id)),
    [state.selectedTools],
  )

  const buildInitialSteps = (): ProvStep[] => [
    {
      key: 'org',
      kind: 'org',
      label: `Create organization "${state.orgName.trim()}"`,
      sublabel: 'POST /api/organizations',
      status: 'pending',
    },
    ...selectedIds.map<ProvStep>((t) => ({
      key: `tool:${t.id}`,
      kind: 'tool',
      label: `Enable ${t.name}`,
      sublabel: t.purpose,
      icon: toolIcon(t.id, t.name),
      status: 'pending',
    })),
  ]

  const [steps, setSteps] = useState<ProvStep[]>(buildInitialSteps)
  const [phase, setPhase] = useState<'running' | 'done'>('running')
  const createdOrg = useRef<CreatedOrg | null>(null)
  const orgReachable = useRef(false)
  const started = useRef(false)

  function patch(key: string, next: Partial<ProvStep>) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...next } : s)))
  }

  /** Run the org-creation step. Returns true when the org exists (created now or already). */
  async function runOrg(): Promise<boolean> {
    patch('org', { status: 'running', detail: undefined })
    const res = await createOrganization(state.orgName)
    if (res.ok && res.org) {
      createdOrg.current = res.org
      orgReachable.current = true
      patch('org', {
        status: 'done',
        detail: `Created and activated · id ${res.org.id}`,
      })
      return true
    }
    orgReachable.current = res.status !== 0 && res.status !== 401 && res.status !== 503
    patch('org', {
      status: 'failed',
      detail: res.detail ?? res.error ?? 'Organization creation failed.',
    })
    return false
  }

  async function runTool(step: ProvStep): Promise<void> {
    const id = step.key.replace(/^tool:/, '')
    patch(step.key, { status: 'running', detail: undefined })
    const res = await toggleTool(id, true)
    patch(step.key, {
      status: outcomeToRunState(res.outcome),
      detail: res.detail ?? res.error,
    })
  }

  /** Full sequential run: org first (gates tools), then each tool. */
  async function runAll() {
    setPhase('running')
    const orgOk = await runOrg()
    if (!orgOk) {
      // Can't enable tools without an org — leave them pending, surface the org error.
      setPhase('done')
      return
    }
    // Re-read the current tool steps (state may have the initial list).
    for (const s of steps.filter((x) => x.kind === 'tool')) {
      await runTool(s)
    }
    setPhase('done')
  }

  // Auto-start once when the provisioning screen mounts.
  useEffect(() => {
    if (started.current) return
    started.current = true
    void runAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function retryOrg() {
    setPhase('running')
    const ok = await runOrg()
    if (ok) {
      for (const s of steps.filter((x) => x.kind === 'tool' && x.status !== 'done')) {
        await runTool(s)
      }
    }
    setPhase('done')
  }

  async function retryStep(step: ProvStep) {
    if (step.kind === 'org') {
      await retryOrg()
      return
    }
    if (!orgReachable.current || !createdOrg.current) {
      await retryOrg()
      return
    }
    setPhase('running')
    await runTool(step)
    setPhase('done')
  }

  const orgStep = steps.find((s) => s.kind === 'org')!
  const toolSteps = steps.filter((s) => s.kind === 'tool')
  const orgDone = orgStep.status === 'done'
  const allSettled =
    phase === 'done' && steps.every((s) => s.status !== 'running' && s.status !== 'pending')
  const anyFailed = steps.some((s) => s.status === 'failed')
  const anyUnavailable = steps.some((s) => s.status === 'unavailable')
  const completedCount = steps.filter((s) => s.status === 'done').length
  const runningPct = Math.round((completedCount / steps.length) * 100)

  /** Success landing — org exists. Cookie was re-signed server-side, so a full
   *  reload picks up the new activeTenant (matches useOrganizations' behaviour). */
  function openConsole() {
    try {
      localStorage.setItem('adhar.onboarding.completed', new Date().toISOString())
    } catch {
      /* private mode — non-fatal */
    }
    globalThis.location.assign('/')
  }

  /** Demo / no-DB fallback — org creation couldn't persist server-side. We update
   *  the in-memory session so the current tab has a workspace, and navigate. This
   *  is explicitly labelled as a client-only fallback, not a provisioning success. */
  function continueDemo() {
    if (session && createdOrgSlugFallback()) {
      const slug = createdOrgSlugFallback()
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
      /* non-fatal */
    }
    navHome()
  }
  function createdOrgSlugFallback(): string {
    return slugPreview(state.orgName.trim())
  }

  return (
    <div className="space-y-6">
      {/* Progress header */}
      <div>
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-content">
            {phase === 'running'
              ? 'Provisioning…'
              : orgDone
                ? 'Provisioning complete'
                : 'Provisioning stopped'}
          </span>
          <span className="text-content-subtle">
            {completedCount}/{steps.length} steps
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500 ease-smooth',
              anyFailed && allSettled ? 'bg-amber-500' : 'bg-brand-500',
            )}
            style={{ width: `${Math.max(runningPct, phase === 'running' ? 6 : runningPct)}%` }}
          />
        </div>
      </div>

      {/* Step rows */}
      <ol className="space-y-2">
        {steps.map((s) => (
          <li
            key={s.key}
            className={cn(
              'flex items-start gap-3 rounded-xl border p-3 transition-colors',
              s.status === 'failed'
                ? 'border-rose-200 bg-rose-50/60 dark:border-rose-500/25 dark:bg-rose-500/5'
                : s.status === 'unavailable'
                  ? 'border-amber-200 bg-amber-50/50 dark:border-amber-500/25 dark:bg-amber-500/5'
                  : 'border-edge-subtle bg-surface-raised',
            )}
          >
            <StatusGlyph status={s.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {s.icon ? <span className="flex-none">{s.icon}</span> : null}
                <span className="text-sm font-semibold text-content">{s.label}</span>
                <RunBadge status={s.status} />
              </div>
              {s.sublabel && s.status === 'pending' ? (
                <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle">
                  {s.sublabel}
                </div>
              ) : null}
              {s.detail ? (
                <div
                  className={cn(
                    'mt-1 break-words text-[11px] leading-snug',
                    s.status === 'failed'
                      ? 'text-rose-700 dark:text-rose-300'
                      : s.status === 'unavailable'
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-content-muted',
                  )}
                >
                  {s.detail}
                </div>
              ) : null}
            </div>
            {(s.status === 'failed' || s.status === 'unavailable') && phase === 'done' ? (
              <button
                type="button"
                onClick={() => void retryStep(s)}
                className="shrink-0 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
              >
                Retry
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      {/* Outcome + actions */}
      {allSettled ? (
        <div className="space-y-3 border-t border-edge-subtle pt-5">
          {orgDone ? (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12px] leading-snug text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">
                <IconCheckCircle />
                <span>
                  <span className="font-semibold">{state.orgName.trim()}</span> is live.
                  {anyUnavailable
                    ? ' Some capabilities were requested but couldn\'t be provisioned via GitOps in this environment — enable them later from the Marketplace once the platform is wired.'
                    : anyFailed
                      ? ' Some capability toggles failed — retry them above, or continue and enable them later.'
                      : ' Every selected capability was committed to your ApplicationSet.'}
                </span>
              </div>
              <Button variant="primary" size="lg" block onClick={openConsole} trailing={<IconArrowRight />}>
                Open console
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] leading-snug text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">
                <IconAlert />
                <span>
                  Your organization couldn't be provisioned. See the error above and retry. If this
                  environment has no session store wired (demo mode), you can continue into the
                  console with a client-only workspace — nothing is persisted server-side.
                </span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="primary" size="md" onClick={() => void retryOrg()}>
                  Retry provisioning
                </Button>
                <Button variant="secondary" size="md" onClick={continueDemo}>
                  Continue to console (client-only)
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function StatusGlyph({ status }: { status: RunState }) {
  if (status === 'running') {
    return (
      <span className="mt-0.5 text-brand-600 dark:text-brand-400">
        <MiniSpinner />
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white">
        <IconCheck />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white">
        <IconX />
      </span>
    )
  }
  if (status === 'unavailable') {
    return (
      <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-white">
        <IconClock />
      </span>
    )
  }
  // pending / skipped
  return <span className="mt-0.5 h-5 w-5 rounded-full border-2 border-dashed border-edge-strong" />
}

function RunBadge({ status }: { status: RunState }) {
  const map: Record<RunState, { kind: 'healthy' | 'progressing' | 'failed' | 'paused' | 'unknown'; label: string }> = {
    pending: { kind: 'unknown', label: 'queued' },
    running: { kind: 'progressing', label: 'running' },
    done: { kind: 'healthy', label: 'done' },
    failed: { kind: 'failed', label: 'failed' },
    unavailable: { kind: 'paused', label: 'requested' },
    skipped: { kind: 'unknown', label: 'skipped' },
  }
  const { kind, label } = map[status]
  return (
    <span className="ml-auto">
      <StatusBadge kind={kind}>{label}</StatusBadge>
    </span>
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
        backgroundImage: 'linear-gradient(135deg, var(--color-brand-500), var(--color-brand-800))',
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

function IconX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function IconInfo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
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

function IconCheckCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  )
}

function MiniSpinner() {
  return (
    <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
