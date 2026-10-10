/**
 * Everything the launch site *says*, in one place.
 *
 * The 3D supply-chain scene, the stage strip under it and the maintenance
 * page all read from here, so the picture and the prose can never drift
 * apart. Change copy or a tool name here, not in a component.
 */

/* ─────────────────────────── Supply chain ─────────────────────────────── */

export type StageKind = 'source' | 'build' | 'attest' | 'promote' | 'deploy' | 'observe'

export interface SupplyStage {
  id: StageKind
  name: string
  tool: string
  detail: string
  /** Position along the chain, 0..1 — the 3D path places the station by it. */
  u: number
  /** Hex used by the scene for this station and for packets that have passed it. */
  color: string
}

export const SUPPLY_CHAIN: SupplyStage[] = [
  {
    id: 'source',
    name: 'Source',
    tool: 'Gitea',
    detail: 'Commits land in Git, with policy checks on every merge.',
    u: 0.06,
    color: '#94a3b8',
  },
  {
    id: 'build',
    name: 'Build',
    tool: 'Tekton',
    detail: 'Built once from golden templates. Reproducible by default.',
    u: 0.24,
    color: '#6366f1',
  },
  {
    id: 'attest',
    name: 'Scan & sign',
    tool: 'Harbor',
    detail: 'SBOM, vulnerability scan and a signature on every image.',
    u: 0.42,
    color: '#3b82f6',
  },
  {
    id: 'promote',
    name: 'Promote',
    tool: 'Kargo',
    detail: 'The same artifact moves dev → stage → prod. Nothing is rebuilt.',
    u: 0.6,
    color: '#8b5cf6',
  },
  {
    id: 'deploy',
    name: 'Deploy',
    tool: 'Argo CD',
    detail: 'GitOps rollouts, progressive and reversible.',
    u: 0.8,
    color: '#a78bfa',
  },
  {
    id: 'observe',
    name: 'Observe',
    tool: 'Grafana',
    detail: 'Logs, metrics and traces tied to the release that caused them.',
    u: 0.95,
    color: '#10b981',
  },
]

/** The three promotion gates, as fractions of the chain. */
export const PROMOTION_GATES = [
  { name: 'dev', u: 0.55 },
  { name: 'stage', u: 0.6 },
  { name: 'prod', u: 0.65 },
] as const

/* ───────────────────────── Maintenance window ─────────────────────────── */

export interface MaintenanceStep {
  name: string
  detail: string
  state: 'done' | 'active' | 'next'
}

export interface MaintenanceWindow {
  title: string
  reason: string
  /** ISO timestamps. `until` may be overridden with `?until=` on the page. */
  startedAt: string
  until: string
  affected: string[]
  unaffected: string[]
  steps: MaintenanceStep[]
}

// Vite exposes build-time env on `import.meta.env`; Deno's ImportMeta type
// does not declare it, hence the cast rather than a global type augmentation.
const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

/** Default window; a deploy sets VITE_MAINT_UNTIL / VITE_MAINT_STARTED to override. */
export const MAINTENANCE: MaintenanceWindow = {
  title: 'Scheduled maintenance',
  reason: 'We are upgrading the control plane and rotating platform certificates.',
  startedAt: ENV.VITE_MAINT_STARTED ?? '2026-10-10T20:00:00Z',
  until: ENV.VITE_MAINT_UNTIL ?? '2026-10-10T23:00:00Z',
  affected: ['Adhar Console', 'Adhar Assist', 'Sign-in'],
  unaffected: ['Running workloads', 'Git hosting', 'Deployed applications'],
  steps: [
    {
      name: 'Drain traffic',
      detail: 'New sessions paused, in-flight work finished cleanly.',
      state: 'done',
    },
    {
      name: 'Upgrade control plane',
      detail: 'Rolling the API servers and operators forward.',
      state: 'active',
    },
    {
      name: 'Rotate certificates',
      detail: 'Platform-wide TLS renewal with zero-trust re-pinning.',
      state: 'next',
    },
    {
      name: 'Verify & restore',
      detail: 'Smoke tests across every lifecycle phase before traffic returns.',
      state: 'next',
    },
  ],
}

/* ───────────────────────────── Site links ─────────────────────────────── */

export const LINKS = {
  github: 'https://github.com/adhar-io',
  docs: 'https://adhar.io',
  console: 'https://console.platform.adhar.io',
}
