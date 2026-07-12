import type { Diagram, DiagramType } from './types.ts'

export const TYPE_LABEL: Record<DiagramType, string> = {
  flowchart: 'Flowchart',
  sequence: 'Sequence',
  classDiagram: 'Class',
  stateDiagram: 'State',
  erDiagram: 'ER',
  gantt: 'Gantt',
  mindmap: 'Mind map',
  C4Context: 'C4 context',
  journey: 'User journey',
}

export const TYPE_DESCRIPTION: Record<DiagramType, string> = {
  flowchart: 'Boxes & arrows for system topology, decision trees, pipelines.',
  sequence: 'Time-ordered messages between actors / services.',
  classDiagram: 'Object model — classes, fields, relationships.',
  stateDiagram: 'State machines and transitions.',
  erDiagram: 'Entity-relationship — schema modelling.',
  gantt: 'Task / phase timelines with dependencies.',
  mindmap: 'Branching idea trees for brainstorming.',
  C4Context: 'C4 context-level system landscape.',
  journey: 'User journey w/ mood scores per stage.',
}

export const TYPE_COLOR: Record<DiagramType, string> = {
  flowchart: 'brand',
  sequence: 'violet',
  classDiagram: 'amber',
  stateDiagram: 'emerald',
  erDiagram: 'rose',
  gantt: 'sky',
  mindmap: 'violet',
  C4Context: 'brand',
  journey: 'emerald',
}

export const TEMPLATES: Record<DiagramType, { label: string; source: string }[]> = {
  flowchart: [
    {
      label: 'System topology',
      source: `flowchart LR
  User-->|HTTPS| Ingress
  Ingress-->ConsoleHost
  ConsoleHost-->BFF
  BFF-->Gitea
  BFF-->ArgoCD
  BFF-->Kargo
  BFF-->Harbor
  BFF-->K8s[(Kube-API)]
  BFF-->LGTM[(Grafana stack)]`,
    },
    {
      label: 'Decision tree',
      source: `flowchart TD
  Start([Issue reported]) --> Triage{Severity?}
  Triage -->|Sev-1| Page[Page on-call]
  Triage -->|Sev-2| Open[Open ticket]
  Triage -->|Sev-3| Backlog[Backlog]
  Page --> Diagnose[Diagnose]
  Diagnose --> Fix[Fix + post-mortem]
  Fix --> Done([Resolved])`,
    },
    {
      label: 'Empty (LR)',
      source: `flowchart LR
  A[Start] --> B{Decision}
  B -->|yes| C[Action]
  B -->|no| D[Skip]`,
    },
  ],
  sequence: [
    {
      label: 'Auth handshake',
      source: `sequenceDiagram
  participant U as User
  participant C as Console
  participant K as Keycloak
  participant B as BFF
  U->>C: GET /platform
  C->>K: OIDC redirect
  K-->>C: Auth code
  C->>K: Exchange code
  K-->>C: Tokens
  C->>B: API call w/ access token
  B-->>C: Data
  C-->>U: HTML + hydrate`,
    },
    {
      label: 'Webhook delivery',
      source: `sequenceDiagram
  participant G as Gitea
  participant B as BFF
  participant Q as Queue
  participant W as Worker
  G->>B: POST /webhook
  B->>Q: enqueue
  B-->>G: 202 Accepted
  Q->>W: deliver
  W->>W: process`,
    },
    {
      label: 'Empty',
      source: `sequenceDiagram
  participant A
  participant B
  A->>B: Hello
  B-->>A: World`,
    },
  ],
  classDiagram: [
    {
      label: 'Domain model',
      source: `classDiagram
  class Project {
    +String id
    +String name
    +String identifier
    +listIssues() Issue[]
  }
  class Issue {
    +String id
    +String name
    +Priority priority
    +State state
  }
  class State {
    +String id
    +String name
    +String color
  }
  Project "1" --> "*" Issue
  Issue "*" --> "1" State`,
    },
    {
      label: 'Empty',
      source: `classDiagram
  class A {
    +String id
    +doSomething()
  }
  class B
  A --> B`,
    },
  ],
  stateDiagram: [
    {
      label: 'Issue lifecycle',
      source: `stateDiagram-v2
  [*] --> Backlog
  Backlog --> Started
  Started --> InReview
  InReview --> Started: changes requested
  InReview --> Done
  Done --> [*]
  Started --> Cancelled
  Cancelled --> [*]`,
    },
    {
      label: 'Empty',
      source: `stateDiagram-v2
  [*] --> Idle
  Idle --> Active
  Active --> [*]`,
    },
  ],
  erDiagram: [
    {
      label: 'Plane schema',
      source: `erDiagram
  WORKSPACE ||--o{ PROJECT : has
  PROJECT ||--o{ ISSUE : contains
  PROJECT ||--o{ CYCLE : contains
  PROJECT ||--o{ MODULE : contains
  ISSUE }o--o{ LABEL : tagged
  ISSUE }o--|| STATE : has
  CYCLE ||--o{ ISSUE : tracks`,
    },
    {
      label: 'Empty',
      source: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains`,
    },
  ],
  gantt: [
    {
      label: 'Quarter plan',
      source: `gantt
  title Q3 delivery plan
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Platform
  ArgoCD wiring     :done,    p1, 2026-04-01, 2026-04-12
  Kargo promotion   :active,  p2, 2026-04-12, 12d
  Harbor scanning   :         p3, after p2, 8d
  section Console
  Define module     :done,    c1, 2026-04-01, 14d
  Design module     :active,  c2, after c1, 10d
  Develop module    :         c3, after c2, 14d`,
    },
  ],
  mindmap: [
    {
      label: 'Project goals',
      source: `mindmap
  root((Adhar))
    Architecture
      ADRs
      Diagrams
      Whiteboard
    UX
      Personas
      Journeys
      Wireframes
    Design system
      Tokens
      Catalog
      Builder`,
    },
  ],
  C4Context: [
    {
      label: 'Console landscape',
      source: `C4Context
  title Adhar Console — context
  Person(operator, "Operator", "Platform & app teams")
  System(adhar, "Adhar Console", "Single pane of glass over the SDLC")
  System_Ext(plane, "Plane.so", "Project management")
  System_Ext(argo, "ArgoCD + Kargo", "GitOps")
  System_Ext(harbor, "Harbor", "Container registry")
  System_Ext(keycloak, "Keycloak", "Identity")
  Rel(operator, adhar, "Uses", "HTTPS")
  Rel(adhar, plane, "Reads/writes", "REST")
  Rel(adhar, argo, "Reads/writes", "REST")
  Rel(adhar, harbor, "Reads", "REST")
  Rel(adhar, keycloak, "OIDC", "HTTPS")`,
    },
  ],
  journey: [
    {
      label: 'First-run onboarding',
      source: `journey
  title Operator first run
  section Discover
    Land on adhar.dev: 4: User
    Read value prop: 3: User
    Click Get started: 5: User
  section Sign up
    Enter email: 3: User
    Verify magic link: 4: User
    Pick workspace slug: 2: User
  section Connect
    Paste kubeconfig: 3: User
    Approve agent: 4: User
  section Win
    Deploy hello world: 5: User
    Invite teammate: 5: User`,
    },
  ],
}

const ts = '2026-04-22T10:00:00Z'

export const SEED_DIAGRAMS: Diagram[] = [
  {
    id: 'diag-topology',
    title: 'Platform topology',
    type: 'flowchart',
    source: TEMPLATES.flowchart[0].source,
    tags: ['platform', 'system'],
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'diag-auth-flow',
    title: 'Authenticated request flow',
    type: 'sequence',
    source: TEMPLATES.sequence[0].source,
    tags: ['security', 'auth'],
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'diag-delivery',
    title: 'Delivery pipeline',
    type: 'flowchart',
    source: `flowchart LR
  PR[Gitea PR merged]--> AW[Argo Workflow]
  AW --> HB[Harbor image]
  HB --> KR[Kargo warehouse]
  KR --> KS[stage: dev]
  KS -->|promote| KST[stage: staging]
  KST -->|promote| KSP[stage: prod]
  KSP --> AR[Argo Rollout: canary]
  AR --> OK[Healthy]`,
    tags: ['delivery', 'gitops'],
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'diag-issue-state',
    title: 'Issue lifecycle',
    type: 'stateDiagram',
    source: TEMPLATES.stateDiagram[0].source,
    tags: ['domain', 'plane'],
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'diag-domain',
    title: 'Plane domain model',
    type: 'erDiagram',
    source: TEMPLATES.erDiagram[0].source,
    tags: ['domain', 'data'],
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'diag-context',
    title: 'C4 context — Adhar Console',
    type: 'C4Context',
    source: TEMPLATES.C4Context[0].source,
    tags: ['architecture', 'c4'],
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'diag-q3',
    title: 'Q3 delivery plan',
    type: 'gantt',
    source: TEMPLATES.gantt[0].source,
    tags: ['plan', 'timeline'],
    created_at: ts,
    updated_at: ts,
  },
]
