import type { Adr, ApiSpec, Persona, Journey, StickyNote, Wireframe } from './types.ts'

/* ───── ADRs ───── */

export const SEED_ADRS: Adr[] = [
  {
    id: 'adr-001',
    number: 1,
    title: 'Adopt TanStack Start for the console shell',
    status: 'accepted',
    authors: ['tapas'],
    updated_at: '2026-04-05T10:00:00Z',
    repo: 'acme/docs',
    context:
      'The console needs streaming-friendly SSR, file-based routing, and excellent DX. Next.js was considered but locks us into Vercel-flavoured edge runtimes.',
    decision:
      'Adopt TanStack Start. Vite-based, framework-agnostic, file-based routing, full type-safety end-to-end. Ships with a usable router and SSR story today.',
    consequences:
      'Smaller community than Next; fewer plug-and-play recipes. Mitigated by TanStack Router maturity and our SDK glue.',
    tags: ['shell', 'framework'],
  },
  {
    id: 'adr-002',
    number: 2,
    title: 'Use Module Federation for the eight phase modules',
    status: 'accepted',
    authors: ['tapas', 'maya'],
    updated_at: '2026-04-12T10:00:00Z',
    repo: 'acme/docs',
    context:
      'Eight phase modules ship on different cadences. A single monorepo bundle would couple their release timelines.',
    decision:
      'Use @module-federation/vite. Each phase ships independently as a remote, host pulls them at runtime. Local dev runs each on its own port.',
    consequences:
      'Cross-module type sharing relies on workspace packages. Federation runtime adds a small boot cost — acceptable for a console.',
    tags: ['architecture', 'federation'],
  },
  {
    id: 'adr-003',
    number: 3,
    title: 'Deno runtime for the BFF',
    status: 'accepted',
    authors: ['tapas'],
    updated_at: '2026-04-14T10:00:00Z',
    repo: 'acme/docs',
    context:
      'The BFF talks to Plane, ArgoCD, Kargo, and Harbor. We want first-class TypeScript without a build step.',
    decision: 'Deno 2 with Hono. Native ESM, native TS, npm: specifiers for compatibility.',
    consequences:
      'Some npm packages with native add-ons need vetting. Bun was considered; Deno wins on stability and security-by-default.',
    tags: ['runtime', 'bff'],
  },
  {
    id: 'adr-004',
    number: 4,
    title: 'Drop REST for Plane.so in favour of GraphQL',
    status: 'proposed',
    authors: ['maya'],
    updated_at: '2026-04-22T10:00:00Z',
    repo: 'acme/docs',
    context:
      'The Plane REST surface forces us to fan out N+1 calls when rendering project dashboards.',
    decision:
      'If Plane ships a stable GraphQL endpoint by Q3, migrate aggregation queries. Otherwise build a thin BFF aggregator.',
    consequences: 'Decision pending — depends on upstream Plane roadmap.',
    tags: ['api', 'plane'],
  },
  {
    id: 'adr-005',
    number: 5,
    title: 'Tailwind v4 + design tokens in CSS variables',
    status: 'accepted',
    authors: ['tapas'],
    updated_at: '2026-04-08T10:00:00Z',
    repo: 'acme/docs',
    context:
      'Need a token system that any module can opt into without a JS theming runtime.',
    decision:
      'CSS custom properties for every token; Tailwind v4 picks them up via @theme directive. Modules consume via utility classes, never JS lookups.',
    consequences: 'Zero runtime theming cost. Theme switching is a className flip on <html>.',
    tags: ['styling', 'tokens'],
  },
]

/* ───── Personas ───── */

export const SEED_PERSONAS: Persona[] = [
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
  },
  {
    id: 'persona-rahul',
    name: 'Rahul — Engineering Manager',
    avatar: '🧑🏽‍💼',
    role: 'Engineering manager',
    bio: 'Manages two squads building product features. Reports up to a director, defends timelines downward.',
    goals: [
      'Forecast delivery for next two cycles',
      'Spot blocked work before standup catches it',
      'Keep WIP balanced across squads',
    ],
    frustrations: [
      'Status updates that lag reality by a week',
      'Manual rollups across three project tools',
      'No way to compare planned vs actual without CSV exports',
    ],
    behaviors: [
      'Lives in Slack and project tool',
      'Skims dashboards in 30-second bursts between meetings',
    ],
    needs: ['At-a-glance delivery confidence', 'Drill-down only when something looks off'],
    tech: ['Plane', 'Slack', 'Linear (legacy)', 'Notion'],
  },
  {
    id: 'persona-anika',
    name: 'Anika — Product Designer',
    avatar: '🎨',
    role: 'Product designer',
    bio: 'Designs experiences end-to-end — research, journey maps, hi-fi flows, hand-off specs.',
    goals: [
      'Keep design system tokens in sync with shipping product',
      'Run discovery without losing artifacts in Slack threads',
      'Make hand-off self-explanatory so devs do not Slack questions',
    ],
    frustrations: [
      'Engineers who skip the design system and reinvent components',
      'Personas trapped in a Figma file no one opens',
      'No place to keep journey maps that the whole team can update',
    ],
    behaviors: ['Heavy Figma user', 'Documents in Notion', 'Co-designs in workshops weekly'],
    needs: ['Living design artifacts that engineering can browse', 'Token catalog tied to code'],
    tech: ['Figma', 'FigJam', 'Notion', 'Loom'],
  },
]

/* ───── Journey maps ───── */

export const SEED_JOURNEYS: Journey[] = [
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
        thoughts: ['Looks promising — does it actually replace ArgoCD UI?'],
        pains: ['Lots of marketing copy, hard to find a demo'],
        opportunities: ['Auto-spin demo workspace seeded with realistic data'],
      },
      {
        id: 's2',
        name: 'Sign up',
        emotion: 'cautious',
        actions: ['Enters work email', 'Verifies via magic link', 'Picks workspace name'],
        thoughts: ['Will this require SSO setup before I can poke around?'],
        pains: ['Required tenant slug feels jargon-heavy'],
        opportunities: ['Suggest tenant slug from email domain'],
      },
      {
        id: 's3',
        name: 'Connect cluster',
        emotion: 'focused',
        actions: ['Pastes kubeconfig', 'Names the cluster', 'Approves agent install'],
        thoughts: ['This is the moment of truth — does it pick up my real workloads?'],
        pains: ['kubeconfig copy/paste is fiddly'],
        opportunities: ['One-click GKE/EKS/AKS OAuth flow'],
      },
      {
        id: 's4',
        name: 'First workload',
        emotion: 'excited',
        actions: ['Picks Hello World template', 'Clicks Deploy', 'Watches rollout'],
        thoughts: ['I want to see logs streaming in.'],
        pains: ['Empty state if rollout takes more than 30s'],
        opportunities: ['Streaming progress hub with deep-link to ArgoCD'],
      },
      {
        id: 's5',
        name: 'Invite teammate',
        emotion: 'satisfied',
        actions: ['Copies invite link', 'Pastes in Slack'],
        thoughts: ['Want to share this with the team — does it support Google SSO?'],
        pains: ['No SSO setup yet'],
        opportunities: ['Trigger SSO setup wizard right after first workload'],
      },
    ],
  },
  {
    id: 'journey-incident',
    name: 'Triage a Sev-2 incident',
    persona: 'persona-priya',
    summary:
      'On-call engineer gets paged, lands in Adhar, and ships a fix within an hour with full audit trail.',
    stages: [
      {
        id: 's1',
        name: 'Page',
        emotion: 'stressed',
        actions: ['Phone goes off', 'Opens PagerDuty link'],
        thoughts: ['What service? What changed in the last hour?'],
        pains: ['No quick "what changed" view'],
        opportunities: ['Adhar deep link from PagerDuty with last-hour change list'],
      },
      {
        id: 's2',
        name: 'Diagnose',
        emotion: 'focused',
        actions: ['Looks at Grafana panel', 'Checks ArgoCD diff'],
        thoughts: ['Was this the deploy 40 minutes ago?'],
        pains: ['Switching tabs constantly'],
        opportunities: ['Inline metrics + diff in Adhar incident view'],
      },
      {
        id: 's3',
        name: 'Mitigate',
        emotion: 'urgent',
        actions: ['Triggers rollback in ArgoCD', 'Annotates incident'],
        thoughts: ['I need this rollback approved fast.'],
        pains: ['Approval workflow is in a different tool'],
        opportunities: ['Inline approval w/ audit log in Adhar'],
      },
      {
        id: 's4',
        name: 'Postmortem',
        emotion: 'reflective',
        actions: ['Drafts incident report', 'Creates ADR draft for fix'],
        thoughts: ['Need to capture lessons before I forget.'],
        pains: ['Templates live in a wiki, not where the data is'],
        opportunities: ['Auto-draft postmortem from incident timeline'],
      },
    ],
  },
]

/* ───── Whiteboard sticky notes ───── */

export const SEED_NOTES: StickyNote[] = [
  {
    id: 'note-1',
    text: 'What if the dashboard auto-clusters incidents by service?',
    color: 'amber',
    x: 80,
    y: 80,
    author: 'maya',
  },
  {
    id: 'note-2',
    text: 'Persona: SRE-on-call needs different defaults than platform-builder.',
    color: 'rose',
    x: 320,
    y: 120,
    author: 'tapas',
  },
  {
    id: 'note-3',
    text: 'Journey: cold-start latency on first workspace open should be < 1.5s.',
    color: 'sky',
    x: 560,
    y: 80,
    author: 'tapas',
  },
  {
    id: 'note-4',
    text: 'Tokens spike — motion durations need a single source of truth.',
    color: 'violet',
    x: 120,
    y: 280,
    author: 'anika',
  },
  {
    id: 'note-5',
    text: 'Wireframe: empty-state for first cluster connect.',
    color: 'emerald',
    x: 400,
    y: 320,
    author: 'anika',
  },
]

/* ───── Wireframes ───── */

export const SEED_WIREFRAMES: Wireframe[] = [
  {
    id: 'wf-onboarding-1',
    flow: 'onboarding',
    name: 'Sign up',
    order: 1,
    notes: 'Domain-derived workspace slug suggestion. SSO collapsed by default.',
    blocks: [
      { type: 'logo', x: 24, y: 24, w: 80, h: 32 },
      { type: 'h1', x: 24, y: 80, w: 320, h: 32 },
      { type: 'text', x: 24, y: 120, w: 320, h: 16 },
      { type: 'input', x: 24, y: 160, w: 320, h: 36, label: 'Work email' },
      { type: 'input', x: 24, y: 220, w: 320, h: 36, label: 'Workspace slug' },
      { type: 'button', x: 24, y: 280, w: 120, h: 36, label: 'Continue' },
    ],
  },
  {
    id: 'wf-onboarding-2',
    flow: 'onboarding',
    name: 'Connect cluster',
    order: 2,
    notes: 'Three options: paste kubeconfig, OAuth-driven cloud, run agent install command.',
    blocks: [
      { type: 'h1', x: 24, y: 24, w: 320, h: 32 },
      { type: 'card', x: 24, y: 76, w: 200, h: 120, label: 'GKE / EKS / AKS' },
      { type: 'card', x: 240, y: 76, w: 200, h: 120, label: 'Paste kubeconfig' },
      { type: 'card', x: 456, y: 76, w: 200, h: 120, label: 'Self-hosted' },
      { type: 'button', x: 24, y: 220, w: 120, h: 36, label: 'Skip for now' },
    ],
  },
  {
    id: 'wf-onboarding-3',
    flow: 'onboarding',
    name: 'First workload',
    order: 3,
    notes: 'Live rollout strip with progress + deep link to ArgoCD.',
    blocks: [
      { type: 'h1', x: 24, y: 24, w: 320, h: 32 },
      { type: 'card', x: 24, y: 76, w: 660, h: 80, label: 'Hello World template' },
      { type: 'card', x: 24, y: 168, w: 660, h: 120, label: 'Rollout progress' },
      { type: 'button', x: 24, y: 304, w: 140, h: 36, label: 'Open in ArgoCD' },
    ],
  },
  {
    id: 'wf-incident-1',
    flow: 'incident',
    name: 'Incident landing',
    order: 1,
    notes: 'Lands directly to incident from PagerDuty deep link.',
    blocks: [
      { type: 'h1', x: 24, y: 24, w: 420, h: 32 },
      { type: 'card', x: 24, y: 76, w: 320, h: 100, label: 'What changed (last hour)' },
      { type: 'card', x: 360, y: 76, w: 320, h: 100, label: 'Recent metrics' },
      { type: 'card', x: 24, y: 196, w: 660, h: 140, label: 'Timeline' },
      { type: 'button', x: 24, y: 352, w: 120, h: 36, label: 'Trigger rollback' },
    ],
  },
]

/* ───── API / schema design ───── */

const WORKSPACES_OPENAPI = `{
  "openapi": "3.0.3",
  "info": {
    "title": "Adhar Workspaces API",
    "version": "1.4.0",
    "description": "Provision and manage self-serve developer workspaces."
  },
  "servers": [{ "url": "https://api.adhar.dev/v1" }],
  "paths": {
    "/workspaces": {
      "get": {
        "tags": ["Workspaces"],
        "summary": "List workspaces for the current tenant"
      },
      "post": {
        "tags": ["Workspaces"],
        "summary": "Create a new workspace"
      }
    },
    "/workspaces/{id}": {
      "get": {
        "tags": ["Workspaces"],
        "summary": "Fetch a single workspace by id"
      },
      "delete": {
        "tags": ["Workspaces"],
        "summary": "Archive a workspace"
      }
    },
    "/workspaces/{id}/clusters": {
      "get": {
        "tags": ["Clusters"],
        "summary": "List clusters attached to a workspace"
      },
      "post": {
        "tags": ["Clusters"],
        "summary": "Attach a cluster via kubeconfig or cloud OAuth"
      }
    },
    "/clusters/{id}/health": {
      "get": {
        "tags": ["Clusters"],
        "summary": "Read live health for an attached cluster"
      }
    }
  },
  "components": {
    "schemas": {
      "Workspace": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "slug": { "type": "string" },
          "name": { "type": "string" },
          "tier": { "type": "string", "enum": ["free", "team", "enterprise"] },
          "createdAt": { "type": "string", "format": "date-time" },
          "clusters": { "type": "array", "items": { "$ref": "#/components/schemas/Cluster" } }
        },
        "required": ["id", "slug", "name"]
      },
      "Cluster": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "provider": { "type": "string", "enum": ["gke", "eks", "aks", "self-hosted"] },
          "region": { "type": "string" },
          "healthy": { "type": "boolean" },
          "nodeCount": { "type": "integer" }
        },
        "required": ["id", "name", "provider"]
      },
      "Error": {
        "type": "object",
        "properties": {
          "code": { "type": "string" },
          "message": { "type": "string" }
        }
      }
    }
  }
}`

const INCIDENTS_OPENAPI = `{
  "openapi": "3.0.3",
  "info": {
    "title": "Adhar Incidents API",
    "version": "0.9.0",
    "description": "Triage, annotate, and resolve incidents with a full audit trail."
  },
  "servers": [{ "url": "https://api.adhar.dev/v1" }],
  "paths": {
    "/incidents": {
      "get": { "tags": ["Incidents"], "summary": "List incidents, newest first" },
      "post": { "tags": ["Incidents"], "summary": "Open a new incident" }
    },
    "/incidents/{id}": {
      "get": { "tags": ["Incidents"], "summary": "Fetch an incident with its timeline" },
      "patch": { "tags": ["Incidents"], "summary": "Update severity or status" }
    },
    "/incidents/{id}/annotations": {
      "post": { "tags": ["Timeline"], "summary": "Append an annotation to the timeline" }
    },
    "/incidents/{id}/rollback": {
      "post": { "tags": ["Actions"], "summary": "Trigger a rollback with inline approval" }
    }
  },
  "components": {
    "schemas": {
      "Incident": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "severity": { "type": "string", "enum": ["sev1", "sev2", "sev3"] },
          "status": { "type": "string", "enum": ["open", "mitigated", "resolved"] },
          "service": { "type": "string" },
          "openedAt": { "type": "string", "format": "date-time" },
          "timeline": { "type": "array", "items": { "$ref": "#/components/schemas/Annotation" } }
        },
        "required": ["id", "title", "severity", "status"]
      },
      "Annotation": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "author": { "type": "string" },
          "note": { "type": "string" },
          "at": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}`

export const SEED_API_SPECS: ApiSpec[] = [
  {
    id: 'api-workspaces',
    name: 'Workspaces API',
    version: '1.4.0',
    description: 'Provision and manage self-serve developer workspaces and their clusters.',
    document: WORKSPACES_OPENAPI,
    created_at: '2026-05-02T10:00:00Z',
    updated_at: '2026-06-18T10:00:00Z',
  },
  {
    id: 'api-incidents',
    name: 'Incidents API',
    version: '0.9.0',
    description: 'Triage, annotate, and resolve incidents with a full audit trail.',
    document: INCIDENTS_OPENAPI,
    created_at: '2026-05-20T10:00:00Z',
    updated_at: '2026-06-30T10:00:00Z',
  },
]
