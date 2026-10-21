import type { Adr, Journey, Persona } from '../types.ts'

/** Test-only fixtures for ux-lib_test.ts — never imported by the app. */

export const TEST_ADRS: Adr[] = [
  {
    id: 'adr-001',
    number: 1,
    title: 'Adopt TanStack Start for the console shell',
    status: 'accepted',
    authors: ['tapas'],
    updated_at: '2026-04-05T10:00:00Z',
    repo: 'adhar/docs',
    context:
      'The console needs streaming-friendly SSR, file-based routing, and excellent DX. Next.js was considered but locks us into Vercel-flavoured edge runtimes.',
    decision:
      'Adopt TanStack Start. Vite-based, framework-agnostic, file-based routing, full type-safety end-to-end. Ships with a usable router and SSR story today.',
    consequences:
      'Smaller community than Next; fewer plug-and-play recipes. Mitigated by TanStack Router maturity and our SDK glue.',
    tags: ['shell', 'framework'],
  },
]

export const TEST_PERSONAS: Persona[] = [
  {
    id: 'persona-priya',
    name: 'Priya — Platform Engineer',
    avatar: '👩🏽‍💻',
    role: 'Platform engineer',
    bio: 'Owns the developer platform for a 200-person fintech. Maintains the inner loop: kubectl, ArgoCD, Crossplane.',
    goals: [
      'Ship a self-serve dev environment in under five minutes',
      'Reduce escalations from app teams asking how to wire things up',
      'Keep audit trail on every config change',
    ],
    frustrations: [
      'Too many UIs — ArgoCD, Plane, Grafana, Harbor — context-switching tax is brutal',
      'Hand-rolled scripts that nobody else can debug',
      'Stale dashboards that lie about prod state',
    ],
    behaviors: [
      'Lives in terminal + IDE; uses UIs reluctantly',
      'Reads release notes religiously',
      'Documents fixes as runbooks for future-self',
    ],
    needs: ['Single pane of glass with deep links back to source tools', 'Strong audit / event log'],
    tech: ['Kubernetes', 'Terraform', 'Go', 'Python', 'GitHub Actions'],
    quote: 'If it is not in Git, it did not happen.',
    jobs: [
      'When an app team asks for a new environment, I want to hand them a template, so I can stay out of the loop',
      'When something drifts, I want to see what changed and who changed it, so I can fix it fast',
    ],
    color: 'brand',
    tags: ['Internal', 'Power user'],
    location: 'Bengaluru · hybrid',
  },
]

export const TEST_JOURNEYS: Journey[] = [
  {
    id: 'journey-onboarding',
    name: 'Operator first-run onboarding',
    persona: 'persona-priya',
    summary:
      'A new platform engineer signs up, connects their first cluster, and ships a sample workload — within 15 minutes.',
    stages: [
      {
        id: 's1',
        name: 'Discover',
        emotion: 'curious',
        actions: ['Lands on adhar.dev', 'Reads value prop', 'Clicks Get started'],
        touchpoints: ['Marketing site', 'Docs'],
        thoughts: ['Looks promising — does it actually replace ArgoCD UI?'],
        pains: ['Lots of marketing copy, hard to find a demo'],
        opportunities: ['Auto-spin demo workspace seeded with realistic data'],
      },
      {
        id: 's2',
        name: 'Sign up',
        emotion: 'cautious',
        actions: ['Enters work email', 'Verifies via magic link', 'Picks workspace name'],
        touchpoints: ['Sign-up form', 'Email'],
        thoughts: ['Will this require SSO setup before I can poke around?'],
        pains: ['Required tenant slug feels jargon-heavy'],
        opportunities: ['Suggest tenant slug from email domain'],
      },
      {
        id: 's3',
        name: 'Connect cluster',
        emotion: 'focused',
        actions: ['Pastes kubeconfig', 'Names the cluster', 'Approves agent install'],
        touchpoints: ['Console', 'Terminal'],
        thoughts: ['This is the moment of truth — does it pick up my real workloads?'],
        pains: ['kubeconfig copy/paste is fiddly'],
        opportunities: ['One-click GKE/EKS/AKS OAuth flow'],
      },
      {
        id: 's4',
        name: 'First workload',
        emotion: 'excited',
        actions: ['Picks Hello World template', 'Clicks Deploy', 'Watches rollout'],
        touchpoints: ['Templates', 'Argo CD'],
        thoughts: ['I want to see logs streaming in.'],
        pains: ['Empty state if rollout takes more than 30s'],
        opportunities: ['Streaming progress hub with deep-link to ArgoCD'],
      },
      {
        id: 's5',
        name: 'Invite teammate',
        emotion: 'satisfied',
        actions: ['Copies invite link', 'Pastes in Slack'],
        touchpoints: ['Console', 'Slack'],
        thoughts: ['Want to share this with the team — does it support Google SSO?'],
        pains: ['No SSO setup yet'],
        opportunities: ['Trigger SSO setup wizard right after first workload'],
      },
    ],
  },
]
