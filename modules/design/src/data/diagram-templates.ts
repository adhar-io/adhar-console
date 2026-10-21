import type { DiagramType } from './types.ts'

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

/* ───────────── Template gallery ─────────────
 * Ready-made Adhar architecture diagrams for the "New diagram" gallery. Each
 * is valid Mermaid (v11) and maps onto a stored `DiagramType`; `category`
 * groups them in the picker.
 */

export type GalleryCategory = 'Architecture' | 'Delivery' | 'Security' | 'Data' | 'Process' | 'Planning'

export interface GalleryTemplate {
  id: string
  title: string
  description: string
  category: GalleryCategory
  type: DiagramType
  tags: string[]
  source: string
}

export const GALLERY: GalleryTemplate[] = [
  {
    id: 'g-c4-container',
    title: 'Console — C4 container view',
    description: 'Host, BFF, doc store and the platform tools it fronts.',
    category: 'Architecture',
    type: 'C4Context',
    tags: ['c4', 'architecture'],
    source: `C4Container
  title Container view — Adhar Console
  Person(dev, "Developer", "Builds and ships apps")
  System_Boundary(console, "Adhar Console") {
    Container(host, "Console host", "React, TanStack Start", "Shell, routing, module federation")
    Container(bff, "BFF", "Deno", "Auth, tool proxy, document store")
    ContainerDb(pg, "Postgres", "PostgreSQL", "Tenant documents")
  }
  System_Ext(kc, "Keycloak", "OIDC identity provider")
  System_Ext(gitea, "Gitea", "Git hosting")
  System_Ext(argo, "Argo CD", "GitOps delivery")
  Rel(dev, host, "Uses", "HTTPS")
  Rel(host, bff, "Calls", "JSON")
  Rel(bff, pg, "Reads and writes")
  Rel(bff, kc, "Validates tokens", "OIDC")
  Rel(bff, gitea, "Proxies", "REST")
  Rel(bff, argo, "Proxies", "REST")`,
  },
  {
    id: 'g-c4-context',
    title: 'Platform — C4 system context',
    description: 'Who uses Adhar and which systems it depends on.',
    category: 'Architecture',
    type: 'C4Context',
    tags: ['c4', 'context'],
    source: `C4Context
  title System context — Adhar platform
  Person(dev, "Developer")
  Person(ops, "Platform engineer")
  System(adhar, "Adhar platform", "Internal developer platform on Kubernetes")
  System_Ext(idp, "Corporate IdP", "SAML / OIDC upstream")
  System_Ext(cloud, "Cloud provider", "Compute, storage, DNS")
  Rel(dev, adhar, "Builds, deploys, observes")
  Rel(ops, adhar, "Operates, governs")
  Rel(adhar, idp, "Federates login")
  Rel(adhar, cloud, "Provisions via Crossplane")`,
  },
  {
    id: 'g-gitops',
    title: 'GitOps delivery pipeline',
    description: 'Gitea → Tekton → Harbor → Kargo → Argo CD → cluster.',
    category: 'Delivery',
    type: 'flowchart',
    tags: ['gitops', 'ci', 'cd'],
    source: `flowchart LR
  subgraph CI["CI — Tekton"]
    PR[Pull request merged] --> PL[PipelineRun]
    PL --> T[Test + scan]
    T --> IMG[Build image]
  end
  subgraph REG["Registry"]
    H[(Harbor)]
  end
  subgraph CD["CD — Argo CD + Kargo"]
    W[Kargo warehouse] --> D[stage: dev]
    D -->|promote| S[stage: staging]
    S -->|promote| P[stage: prod]
  end
  IMG --> H --> W
  P --> R[Argo Rollout canary] --> OK([Healthy])`,
  },
  {
    id: 'g-oidc',
    title: 'OIDC login via Keycloak',
    description: 'Browser, console BFF and Keycloak authorization-code flow.',
    category: 'Security',
    type: 'sequence',
    tags: ['auth', 'keycloak'],
    source: `sequenceDiagram
  autonumber
  actor U as User
  participant C as Console
  participant B as BFF
  participant K as Keycloak
  U->>C: Open console
  C->>B: GET /api/session
  B-->>C: 401 — no session
  C->>K: Redirect /auth (PKCE)
  U->>K: Sign in
  K-->>C: Redirect with code
  C->>B: /callback?code=…
  B->>K: Exchange code for tokens
  K-->>B: id_token + access_token
  B-->>C: Set session cookie
  C->>B: API calls with cookie`,
  },
  {
    id: 'g-tenancy',
    title: 'Tenancy hierarchy',
    description: 'Org → Teams → Projects → Apps with environments.',
    category: 'Data',
    type: 'erDiagram',
    tags: ['tenancy', 'domain'],
    source: `erDiagram
  ORGANIZATION ||--o{ TEAM : has
  TEAM ||--o{ PROJECT : owns
  PROJECT ||--o{ APPLICATION : contains
  APPLICATION ||--o{ ENVIRONMENT : "deploys to"
  TEAM }o--o{ USER : members
  ORGANIZATION {
    string id PK
    string name
  }
  TEAM {
    string id PK
    string orgId FK
    string name
  }
  PROJECT {
    string id PK
    string teamId FK
    string namespace
  }
  APPLICATION {
    string id PK
    string projectId FK
    string repo
  }`,
  },
  {
    id: 'g-observability',
    title: 'Observability pipeline (LGTM)',
    description: 'OpenTelemetry into Mimir, Loki and Tempo, read by Grafana.',
    category: 'Architecture',
    type: 'flowchart',
    tags: ['observability', 'lgtm'],
    source: `flowchart LR
  APP[Workloads] -->|OTLP| COL[OTel collector]
  COL -->|metrics| M[(Mimir)]
  COL -->|logs| L[(Loki)]
  COL -->|traces| T[(Tempo)]
  M --> G[Grafana]
  L --> G
  T --> G
  G --> A[Alerting / OnCall]`,
  },
  {
    id: 'g-crossplane',
    title: 'Crossplane composition',
    description: 'Claim → composite resource → managed cloud resources.',
    category: 'Architecture',
    type: 'flowchart',
    tags: ['crossplane', 'infra'],
    source: `flowchart TD
  C[PostgresClaim<br/>team namespace] --> XR[XPostgres<br/>composite]
  XR --> COMP{{Composition}}
  COMP --> DB[RDS instance]
  COMP --> SG[Security group]
  COMP --> SEC[Connection secret]
  SEC -.->|mounted by| APP[Application]`,
  },
  {
    id: 'g-workflow',
    title: 'Argo Workflows DAG',
    description: 'Fan-out / fan-in data processing workflow.',
    category: 'Process',
    type: 'flowchart',
    tags: ['workflows', 'argo'],
    source: `flowchart TD
  S([Start]) --> E[extract]
  E --> T1[transform: users]
  E --> T2[transform: orders]
  E --> T3[transform: events]
  T1 --> L[load warehouse]
  T2 --> L
  T3 --> L
  L --> V{validate}
  V -->|ok| N([Notify])
  V -->|fail| R[retry / alert]`,
  },
  {
    id: 'g-incident',
    title: 'Incident lifecycle',
    description: 'States of an incident from detection to post-mortem.',
    category: 'Process',
    type: 'stateDiagram',
    tags: ['sre', 'incident'],
    source: `stateDiagram-v2
  [*] --> Detected
  Detected --> Triaged: on-call acks
  Triaged --> Mitigating
  Mitigating --> Monitoring: fix deployed
  Monitoring --> Mitigating: regression
  Monitoring --> Resolved
  Resolved --> PostMortem
  PostMortem --> [*]`,
  },
  {
    id: 'g-branching',
    title: 'Trunk-based branching',
    description: 'Short-lived feature branches and a release tag.',
    category: 'Delivery',
    type: 'flowchart',
    tags: ['git'],
    source: `gitGraph
  commit id: "init"
  branch feature/login
  commit id: "oidc"
  commit id: "tests"
  checkout main
  merge feature/login
  commit id: "v0.2.0" tag: "v0.2.0"
  branch fix/session
  commit id: "fix"
  checkout main
  merge fix/session`,
  },
  {
    id: 'g-roadmap',
    title: 'Platform roadmap',
    description: 'Quarter-by-quarter capability timeline.',
    category: 'Planning',
    type: 'gantt',
    tags: ['roadmap'],
    source: `timeline
  title Adhar platform roadmap
  Q1 : Console shell : Keycloak SSO
  Q2 : GitOps delivery : Harbor + Trivy
  Q3 : Design phase tools : Observability
  Q4 : AI assist : Cost insights`,
  },
  {
    id: 'g-capabilities',
    title: 'Platform capability map',
    description: 'Mind map of the platform phases and their tools.',
    category: 'Planning',
    type: 'mindmap',
    tags: ['capabilities'],
    source: `mindmap
  root((Adhar))
    Define
      Plane
      Personas
    Design
      ADRs
      Diagrams
      API specs
    Develop
      Gitea
      Workspaces
    Deliver
      Tekton
      Argo CD
      Kargo
    Discover
      Grafana
      Loki`,
  },
]
