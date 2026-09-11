import type { ToolDef } from '../provider.ts'
import { TOOL_DEFS } from '../tools.ts'

/**
 * The agent roster behind Adhar AI.
 *
 * Each agent is the same runtime (AG-UI run loop + the console's read-only
 * cluster tools) with a different brief, a different slice of the toolbox and
 * its own starter prompts. Keeping them declarative means the UI can render the
 * roster, the capability badges and the starters straight from this file, and
 * adding an agent is one entry rather than a new endpoint.
 *
 * Every agent inherits the platform's safety posture: reads run with the
 * SIGNED-IN USER's RBAC, and nothing mutates the cluster — a change is
 * *proposed* and a human applies it.
 */

export type AgentId = 'sre' | 'delivery' | 'security' | 'finops' | 'platform'

export interface AgentDef {
  id: AgentId
  name: string
  /** One line, shown under the name in the agent switcher. */
  description: string
  /** Tailwind accent the UI themes this agent with. */
  accent: 'brand' | 'emerald' | 'amber' | 'violet' | 'sky'
  /** Glyph id resolved by the client's icon map. */
  icon: string
  /** Server-side tools this agent may call, by name. */
  tools: string[]
  starters: Array<{ label: string; prompt: string }>
  systemPrompt: string
}

/** Shared preamble — platform facts + the safety contract, identical for all agents. */
const PLATFORM_BRIEF = [
  `You are an agent inside Adhar Console, an enterprise platform console for a Kubernetes-based internal developer platform organised around a 6D lifecycle (Define → Design → Develop → Deliver → Discover → Decide).`,
  `Platform facts:`,
  `- Sign-in is Keycloak SSO. Every cluster read you make runs with the SIGNED-IN USER's own RBAC — you can never see more than they can.`,
  `- Delivery is GitOps through Argo CD (Application CRs). A live edit to a GitOps-managed object gets reverted by Argo CD; the durable fix belongs in its Gitea repo or the Application spec.`,
  `- Admission policy is Kyverno; denials appear as admission-webhook errors on Events and failed rollouts.`,
  `- Source and manifests live in Gitea; images in Harbor; promotion through Kargo; dashboards in Grafana.`,
  `Safety contract — non-negotiable:`,
  `- You are READ-ONLY. You cannot apply, patch, scale or delete anything.`,
  `- To change something, call propose_change with a complete minimal manifest. That only RECORDS a proposal for a human to review and apply. NEVER claim a change was applied.`,
  `Working style:`,
  `- Gather evidence with tools BEFORE concluding. Never invent resource names, statuses or log lines — cite what you actually observed.`,
  `- Prefer the focused diagnostics (k8s_pod_diagnostics, k8s_workload_health, k8s_events_scan) over raw lists when triaging.`,
  `- Call update_plan at the start of any multi-step investigation and mark steps done as you go; the operator watches it live.`,
  `- Call render_ui when a table, metric row, timeline, comparison or callout communicates better than prose. The console renders it as a real component next to your answer. Use it for anything the operator will scan rather than read.`,
  `- Record every material conclusion with record_finding so it lands in the run's findings panel.`,
  `- Be concise. Short markdown, no preamble, no restating the question.`,
].join('\n')

const DIAGNOSTIC_TOOLS = [
  'k8s_discovery',
  'k8s_list',
  'k8s_get',
  'k8s_describe',
  'k8s_logs',
  'k8s_events',
  'k8s_events_scan',
  'k8s_pod_diagnostics',
  'k8s_workload_health',
]

/** Tools every agent gets: the agentic/UI primitives defined in this module. */
const AGENTIC_TOOLS = ['update_plan', 'record_finding', 'render_ui']

export const AGENTS: AgentDef[] = [
  {
    id: 'sre',
    name: 'Reliability',
    description: 'Triage failing workloads, read logs and events, find the root cause',
    accent: 'brand',
    icon: 'pulse',
    tools: [...DIAGNOSTIC_TOOLS, 'argocd_app_status', 'propose_change', ...AGENTIC_TOOLS],
    starters: [
      { label: 'What is unhealthy right now?', prompt: 'Scan the cluster for Warning events and unhealthy workloads, then summarise what needs attention, worst first.' },
      { label: 'Triage a crashlooping pod', prompt: 'Find pods that are crashlooping or in ImagePullBackOff, diagnose the most serious one and explain the root cause.' },
      { label: 'Why did this rollout stall?', prompt: 'Find deployments whose ready replicas are below desired and explain what is blocking each rollout.' },
    ],
    systemPrompt: [
      PLATFORM_BRIEF,
      ``,
      `Your brief: you are a senior SRE. Triage, diagnose, explain root cause, propose the fix.`,
      `Method: 1) scan for evidence (events, workload health) 2) drill into the worst offender (pod diagnostics, logs — use previous=true after a crash) 3) check whether it is Argo CD-managed 4) state the root cause concretely 5) propose_change if there is a fix, noting that a GitOps-managed object needs the change in Git.`,
    ].join('\n'),
  },
  {
    id: 'delivery',
    name: 'Delivery',
    description: 'Argo CD sync state, rollouts, drift and release readiness',
    accent: 'emerald',
    icon: 'rocket',
    tools: [...DIAGNOSTIC_TOOLS, 'argocd_app_status', 'propose_change', ...AGENTIC_TOOLS],
    starters: [
      { label: 'Which apps are out of sync?', prompt: 'List the Argo CD Applications that are OutOfSync or Degraded and explain what drifted for each.' },
      { label: 'Is this release healthy?', prompt: 'Check the health and sync status of the Argo CD Applications and report which ones are safe and which need attention.' },
      { label: 'Explain a failed sync', prompt: 'Find Argo CD Applications whose last operation failed and explain why each failed.' },
    ],
    systemPrompt: [
      PLATFORM_BRIEF,
      ``,
      `Your brief: you own GitOps delivery. Report sync state, drift, failed operations and rollout readiness.`,
      `Always distinguish DRIFT (live differs from Git) from FAILURE (sync ran and errored) from UNHEALTHY (synced but the workload is sick) — operators act differently on each. Name the Application, its project and its source repo/path.`,
    ].join('\n'),
  },
  {
    id: 'security',
    name: 'Security',
    description: 'Policy denials, RBAC exposure, image and workload hardening',
    accent: 'amber',
    icon: 'shield',
    tools: [...DIAGNOSTIC_TOOLS, 'propose_change', ...AGENTIC_TOOLS],
    starters: [
      { label: 'Any policy denials?', prompt: 'Scan for admission-webhook and Kyverno policy denials in recent events and explain what each one blocked and why.' },
      { label: 'Audit workload hardening', prompt: 'Check running workloads for containers with no resource limits, privileged security contexts or :latest image tags, and rank the risk.' },
      { label: 'Who can do what?', prompt: 'Summarise the ClusterRoleBindings that grant cluster-admin and explain the exposure.' },
    ],
    systemPrompt: [
      PLATFORM_BRIEF,
      ``,
      `Your brief: platform security. Find policy denials, over-broad RBAC, and workloads that violate hardening baselines (no limits, privileged, hostPath/hostNetwork, mutable :latest tags, missing probes).`,
      `Rank findings by real exploitability in THIS cluster, not by generic CVE-style severity. Say plainly when something is a theoretical risk rather than an active one.`,
    ].join('\n'),
  },
  {
    id: 'finops',
    name: 'FinOps',
    description: 'Requests vs usage, waste, right-sizing and capacity headroom',
    accent: 'violet',
    icon: 'coins',
    tools: [...DIAGNOSTIC_TOOLS, 'propose_change', ...AGENTIC_TOOLS],
    starters: [
      { label: 'Where is the waste?', prompt: 'Find workloads whose CPU/memory requests look oversized relative to their replica count and usage, and rank the biggest savings.' },
      { label: 'Do we have headroom?', prompt: 'Summarise node capacity versus total pod requests and tell me how much headroom the cluster has.' },
      { label: 'Right-size a workload', prompt: 'Pick the workload with the most obviously wrong resource requests and propose corrected requests and limits.' },
    ],
    systemPrompt: [
      PLATFORM_BRIEF,
      ``,
      `Your brief: cost and capacity. Compare requests/limits against node allocatable and replica counts, find waste and right-size it.`,
      `Be explicit that requests (not usage) drive scheduling and therefore cost. When you propose a change, give concrete numbers and say what headroom you left. If you do not have usage metrics, say so rather than guessing at utilisation.`,
    ].join('\n'),
  },
  {
    id: 'platform',
    name: 'Platform guide',
    description: 'How the platform works, where things live, how to get things done',
    accent: 'sky',
    icon: 'compass',
    tools: [...DIAGNOSTIC_TOOLS, 'argocd_app_status', ...AGENTIC_TOOLS],
    starters: [
      { label: 'What runs on this cluster?', prompt: 'Give me an inventory of the platform: namespaces, the main workloads in each and what they are for.' },
      { label: 'How do I ship a service?', prompt: 'Walk me through shipping a new service on this platform, from scaffolding to production, naming the actual tools this cluster runs.' },
      { label: 'Explain this namespace', prompt: 'Explain what lives in the adhar-system namespace and how the pieces fit together.' },
    ],
    systemPrompt: [
      PLATFORM_BRIEF,
      ``,
      `Your brief: you are the platform's guide. Explain how this specific installation is put together and how to get things done on it.`,
      `Ground every explanation in what you can actually see in the cluster — inspect before you explain. When you describe a workflow, name the real tools and the real console pages. Prefer render_ui tables and timelines for anything with more than three items.`,
    ].join('\n'),
  },
]

export const DEFAULT_AGENT: AgentId = 'sre'

export function getAgent(id: string | undefined): AgentDef {
  return AGENTS.find((a) => a.id === id) ?? AGENTS.find((a) => a.id === DEFAULT_AGENT)!
}

/* ─────────────────────── agentic tool definitions ─────────────────────── */

/**
 * Tools that drive the UI rather than the cluster. They are executed on the
 * server (no browser round-trip) and their whole effect is the AG-UI event
 * they emit: a state delta, or a generative-UI payload.
 */
export const AGENTIC_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Publish or update your investigation plan. The operator sees it live as a checklist. Call it once up front with all the steps, then again to flip a step to active/done/failed. Keep steps short and concrete.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'The full plan, in order. Always send every step — this replaces the previous plan.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short imperative step, e.g. "Scan warning events"' },
                status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
              },
              required: ['label', 'status'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_finding',
      description:
        'Record a material conclusion so it appears in the run\'s findings panel and can be acted on. Use it for each distinct problem or confirmation you reach — not for narration.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info', 'ok'] },
          title: { type: 'string', description: 'One line, e.g. "payments-api is OOMKilled every ~4 minutes"' },
          detail: { type: 'string', description: 'The evidence, concretely: names, counts, reasons, log lines.' },
          resource: {
            type: 'object',
            description: 'The object this is about, when there is one.',
            properties: {
              kind: { type: 'string' },
              name: { type: 'string' },
              namespace: { type: 'string' },
            },
          },
        },
        required: ['severity', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_ui',
      description:
        'Render a real UI component in the conversation instead of describing data in prose. Use it whenever the operator would scan rather than read: comparisons, rankings, counts, sequences. The component appears inline under your message.',
      parameters: {
        type: 'object',
        properties: {
          component: {
            type: 'string',
            enum: ['table', 'metrics', 'timeline', 'checklist', 'comparison', 'callout', 'bar-chart', 'resource-list'],
            description:
              'table: rows/columns. metrics: a row of big numbers. timeline: ordered events with timestamps. checklist: pass/fail items. comparison: before/after or expected/actual. callout: one highlighted statement. bar-chart: labelled magnitudes. resource-list: clickable Kubernetes objects.',
          },
          title: { type: 'string' },
          props: {
            type: 'object',
            description:
              'Shape depends on component. table:{columns:[{key,label,align?}],rows:[{...}]} · metrics:{items:[{label,value,hint?,tone?}]} · timeline:{items:[{at,label,detail?,tone?}]} · checklist:{items:[{label,status:pass|fail|warn,detail?}]} · comparison:{left:{title,items:[{label,value}]},right:{title,items:[{label,value}]}} · callout:{tone:info|success|warning|danger,text} · bar-chart:{items:[{label,value,hint?}],unit?} · resource-list:{items:[{kind,name,namespace?,status?,tone?}]}',
            additionalProperties: true,
          },
        },
        required: ['component', 'props'],
      },
    },
  },
]

/** Tool definitions an agent may use, in the order the model sees them. */
export function toolsForAgent(agent: AgentDef): ToolDef[] {
  const all = [...TOOL_DEFS, ...AGENTIC_TOOL_DEFS]
  return agent.tools
    .map((name) => all.find((t) => t.function.name === name))
    .filter((t): t is ToolDef => !!t)
}

/** True when the name is something the SERVER executes (vs a browser tool). */
export function isServerTool(name: string): boolean {
  return [...TOOL_DEFS, ...AGENTIC_TOOL_DEFS].some((t) => t.function.name === name)
}

/* ───────────────────── tool result → generative UI ───────────────────── */

export interface UiPayload {
  component: string
  title?: string
  props: Record<string, unknown>
}

type Json = Record<string, unknown>

/**
 * Map a completed server tool call to the component the console should render
 * beside the answer. This is what makes the transcript *show* a diagnosis
 * instead of describing it: the model picks the tool, the tool picks the view.
 *
 * Returning null means "this tool has no visual form" — the model's prose
 * carries it.
 */
export function uiForToolResult(name: string, args: Json, result: unknown): UiPayload | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Json
  if (typeof r.error === 'string') {
    return { component: 'callout', title: name, props: { tone: 'danger', text: r.error } }
  }

  switch (name) {
    case 'k8s_pod_diagnostics':
      return {
        component: 'pod-diagnostics',
        title: `Pod ${String(r.pod ?? args.pod ?? '')}`,
        props: r,
      }
    case 'k8s_workload_health':
      return {
        component: 'workload-health',
        title: String(r.workload ?? ''),
        props: r,
      }
    case 'k8s_events_scan':
      return {
        component: 'events-scan',
        title: `Warning events · ${String(r.scope ?? '')}`,
        props: r,
      }
    case 'k8s_events':
      return { component: 'events-scan', title: 'Events', props: { scope: String(args.namespace ?? 'cluster'), groups: r.items ?? r.groups ?? [], warningGroups: (r.items as unknown[] | undefined)?.length ?? 0 } }
    case 'argocd_app_status':
      return { component: 'argocd-app', title: `Argo CD · ${String(r.application ?? '')}`, props: r }
    case 'k8s_logs':
      return {
        component: 'log-viewer',
        title: `Logs · ${String(args.pod ?? '')}${args.container ? `/${String(args.container)}` : ''}`,
        props: { lines: typeof r.logs === 'string' ? r.logs : typeof result === 'string' ? result : JSON.stringify(r), pod: args.pod, container: args.container, namespace: args.namespace },
      }
    case 'k8s_list': {
      const items = Array.isArray(r.items) ? (r.items as Json[]) : []
      if (!items.length) return null
      return {
        component: 'resource-list',
        title: `${String(args.resource ?? 'resources')}${args.namespace ? ` · ${String(args.namespace)}` : ''} · ${items.length}`,
        props: {
          items: items.slice(0, 50).map((o) => ({
            kind: String(args.resource ?? ''),
            name: String(o.name ?? ''),
            namespace: o.namespace as string | undefined,
            status: statusText(o),
            tone: toneFor(statusText(o)),
          })),
        },
      }
    }
    case 'k8s_get':
    case 'k8s_describe':
      return {
        component: 'resource-summary',
        title: `${String(args.resource ?? '')}/${String(args.name ?? '')}`,
        props: { object: r, kind: args.resource, name: args.name, namespace: args.namespace },
      }
    default:
      return null
  }
}

function statusText(o: Json): string {
  const s = o.status
  if (typeof s === 'string') return s
  if (s && typeof s === 'object') {
    const st = s as Json
    return String(st.phase ?? st.status ?? '')
  }
  return String(o.phase ?? o.ready ?? '')
}

function toneFor(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  const s = status.toLowerCase()
  if (/running|ready|healthy|succeeded|active|bound|synced|true/.test(s)) return 'ok'
  if (/pending|progressing|updating|creating|waiting/.test(s)) return 'warn'
  if (/fail|error|crash|backoff|unhealthy|degraded|evicted|oom|lost|unknown/.test(s)) return 'bad'
  return 'muted'
}
