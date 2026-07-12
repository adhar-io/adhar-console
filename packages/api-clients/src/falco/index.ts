import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Falco runtime security feed.
 *
 * Falco fires events when its rule engine detects suspicious syscall
 * behaviour (shell-in-container, sensitive mount, ptrace, write below
 * etc/, …). Falcosidekick forwards the events; this client reads the
 * persisted feed exposed by the BFF.
 */

export const FalcoPrioritySchema = z.enum([
  'Emergency',
  'Alert',
  'Critical',
  'Error',
  'Warning',
  'Notice',
  'Informational',
  'Debug',
])
export type FalcoPriority = z.infer<typeof FalcoPrioritySchema>

export const FalcoEventSchema = z.object({
  id: z.string(),
  rule: z.string(),
  priority: FalcoPrioritySchema,
  output: z.string(),
  timestamp: z.string(),
  source: z.string(),
  hostname: z.string().optional(),
  tags: z.array(z.string()).optional(),
  output_fields: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type FalcoEvent = z.infer<typeof FalcoEventSchema>

export const FalcoRuleSchema = z.object({
  name: z.string(),
  priority: FalcoPrioritySchema,
  description: z.string().optional(),
  enabled: z.boolean(),
  tags: z.array(z.string()),
  hits_24h: z.number().optional(),
})
export type FalcoRule = z.infer<typeof FalcoRuleSchema>

export interface FalcoClient {
  listEvents(filter?: { priority?: FalcoPriority; namespace?: string; sinceMs?: number }): Promise<FalcoEvent[]>
  listRules(): Promise<FalcoRule[]>
  toggleRule(name: string, enabled: boolean): Promise<void>
}

function build(http: HttpClient): FalcoClient {
  return {
    listEvents: async (filter) => {
      const qs = new URLSearchParams()
      if (filter?.priority) qs.set('priority', filter.priority)
      if (filter?.namespace) qs.set('namespace', filter.namespace)
      if (filter?.sinceMs) qs.set('since_ms', String(filter.sinceMs))
      const res = await http.get<{ items: FalcoEvent[] }>(`/api/v1/falco/events?${qs}`)
      return res.items
    },
    listRules: async () => {
      const res = await http.get<{ items: FalcoRule[] }>(`/api/v1/falco/rules`)
      return res.items
    },
    toggleRule: async (name, enabled) => {
      await http.post<void>(`/api/v1/falco/rules/${encodeURIComponent(name)}/toggle`, { enabled })
    },
  }
}

const now = Date.now()
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()

const SEED_EVENTS: FalcoEvent[] = [
  {
    id: 'evt-001',
    rule: 'Terminal shell in container',
    priority: 'Warning',
    output:
      'A shell was spawned in a container with an attached terminal (user=root container_id=abc12 image=harbor.adhar.local/acme/billing-service:v1.2.0 shell=bash)',
    timestamp: minutesAgo(8),
    source: 'syscall',
    hostname: 'node-prod-3',
    tags: ['container', 'shell', 'mitre_execution'],
    output_fields: { 'k8s.ns.name': 'acme-billing', 'k8s.pod.name': 'billing-service-7f4c-xkn5p' },
  },
  {
    id: 'evt-002',
    rule: 'Write below etc',
    priority: 'Error',
    output:
      'File below /etc opened for writing (user=root command=sed -i path=/etc/passwd container_id=def34)',
    timestamp: minutesAgo(22),
    source: 'syscall',
    hostname: 'node-prod-1',
    tags: ['filesystem', 'mitre_persistence'],
    output_fields: { 'k8s.ns.name': 'acme-platform', 'k8s.pod.name': 'platform-bff-78a-c12kk' },
  },
  {
    id: 'evt-003',
    rule: 'Outbound connection to C2 IP',
    priority: 'Critical',
    output:
      'Outbound connection to known threat-intel IP (proc=curl dest=185.220.101.7:443 container_id=feed01)',
    timestamp: minutesAgo(41),
    source: 'syscall',
    hostname: 'node-prod-5',
    tags: ['network', 'mitre_command_and_control'],
    output_fields: { 'k8s.ns.name': 'acme-portal', 'k8s.pod.name': 'customer-portal-d4-p9lkm' },
  },
  {
    id: 'evt-004',
    rule: 'Sensitive mount by container',
    priority: 'Notice',
    output:
      'Container mounted host /var/run/docker.sock (user=root command=docker ps container_id=2233aa)',
    timestamp: minutesAgo(120),
    source: 'syscall',
    hostname: 'node-prod-2',
    tags: ['container', 'mitre_privilege_escalation'],
    output_fields: { 'k8s.ns.name': 'kube-system', 'k8s.pod.name': 'fluentd-x4d2b' },
  },
  {
    id: 'evt-005',
    rule: 'Read sensitive file untrusted',
    priority: 'Warning',
    output:
      'Sensitive file opened for reading by non-trusted program (path=/root/.ssh/id_rsa container_id=cafe45)',
    timestamp: minutesAgo(180),
    source: 'syscall',
    hostname: 'node-prod-4',
    tags: ['filesystem', 'mitre_credential_access'],
    output_fields: { 'k8s.ns.name': 'acme-billing', 'k8s.pod.name': 'billing-service-7f4c-zwqvb' },
  },
  {
    id: 'evt-006',
    rule: 'Disallowed K8s API call',
    priority: 'Warning',
    output:
      'Disallowed Kubernetes API call (verb=delete resource=secrets reason=non-allowlisted-sa)',
    timestamp: minutesAgo(245),
    source: 'k8s_audit',
    hostname: 'apiserver-2',
    tags: ['k8s', 'mitre_credential_access'],
    output_fields: { 'k8s.ns.name': 'acme-platform' },
  },
]

const SEED_RULES: FalcoRule[] = [
  {
    name: 'Terminal shell in container',
    priority: 'Warning',
    description: 'A shell was spawned in a container with an attached terminal.',
    enabled: true,
    tags: ['container', 'shell', 'mitre_execution'],
    hits_24h: 4,
  },
  {
    name: 'Write below etc',
    priority: 'Error',
    description: 'File below /etc opened for writing.',
    enabled: true,
    tags: ['filesystem', 'mitre_persistence'],
    hits_24h: 1,
  },
  {
    name: 'Outbound connection to C2 IP',
    priority: 'Critical',
    description: 'Outbound network connection to a known threat-intel IP.',
    enabled: true,
    tags: ['network', 'mitre_command_and_control'],
    hits_24h: 1,
  },
  {
    name: 'Sensitive mount by container',
    priority: 'Notice',
    description: 'Container mounted a sensitive host path (e.g. docker.sock).',
    enabled: true,
    tags: ['container', 'mitre_privilege_escalation'],
    hits_24h: 2,
  },
  {
    name: 'Disallowed K8s API call',
    priority: 'Warning',
    description: 'A Kubernetes API call was made that is not in the allowlist.',
    enabled: true,
    tags: ['k8s', 'audit'],
    hits_24h: 6,
  },
  {
    name: 'Read sensitive file untrusted',
    priority: 'Warning',
    description: 'A sensitive file (SSH keys, kubeconfigs…) was read by a non-trusted program.',
    enabled: true,
    tags: ['filesystem', 'mitre_credential_access'],
    hits_24h: 0,
  },
  {
    name: 'Modify shell config files',
    priority: 'Warning',
    description: 'A shell config (.bashrc, .profile) was modified.',
    enabled: false,
    tags: ['filesystem', 'mitre_persistence'],
    hits_24h: 0,
  },
]

export const FalcoClient = defineClient<FalcoClient>(build, () => {
  const rules = SEED_RULES.slice()
  return {
    listEvents: async (filter) => {
      let list = SEED_EVENTS.slice()
      if (filter?.priority) list = list.filter((e) => e.priority === filter.priority)
      if (filter?.namespace) {
        list = list.filter((e) => e.output_fields?.['k8s.ns.name'] === filter.namespace)
      }
      if (filter?.sinceMs) {
        const cutoff = now - filter.sinceMs
        list = list.filter((e) => new Date(e.timestamp).getTime() >= cutoff)
      }
      return list.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
    },
    listRules: async () => rules,
    toggleRule: async (name, enabled) => {
      const r = rules.find((x) => x.name === name)
      if (r) r.enabled = enabled
    },
  }
})
