import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Kyverno policy engine client.
 *
 * Surfaces the full library: ClusterPolicies + Policies, PolicyReports +
 * ClusterPolicyReports, PolicyExceptions, and per-policy rule breakdowns.
 * The dashboard at `modules/deliver/src/views/policy.tsx` reads this.
 */

export const PolicyResultSchema = z.enum(['pass', 'fail', 'warn', 'error', 'skip'])
export type PolicyResult = z.infer<typeof PolicyResultSchema>

export const PolicySeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
export type PolicySeverity = z.infer<typeof PolicySeveritySchema>

export const PolicyActionSchema = z.enum(['validate', 'mutate', 'generate', 'verifyImages'])
export type PolicyAction = z.infer<typeof PolicyActionSchema>

export const PolicyRuleSchema = z.object({
  name: z.string(),
  action: PolicyActionSchema,
  severity: PolicySeveritySchema.optional(),
  match: z
    .object({
      kinds: z.array(z.string()).optional(),
      namespaces: z.array(z.string()).optional(),
    })
    .optional(),
  description: z.string().optional(),
})
export type PolicyRule = z.infer<typeof PolicyRuleSchema>

export const PolicySchema = z.object({
  name: z.string(),
  /** Cluster-scoped if undefined. */
  namespace: z.string().optional(),
  kind: z.enum(['Policy', 'ClusterPolicy']),
  validationFailureAction: z.enum(['Audit', 'Enforce']),
  background: z.boolean().optional(),
  category: z.string().optional(),
  severity: PolicySeveritySchema.optional(),
  description: z.string().optional(),
  ready: z.boolean().optional(),
  /** Aggregate result counts from PolicyReport. */
  pass: z.number().optional(),
  fail: z.number().optional(),
  warn: z.number().optional(),
  rules: z.array(PolicyRuleSchema),
  created_at: z.string().optional(),
})
export type Policy = z.infer<typeof PolicySchema>

export const PolicyReportSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
    creationTimestamp: z.string().optional(),
  }),
  summary: z.object({
    pass: z.number(),
    fail: z.number(),
    warn: z.number(),
    error: z.number(),
    skip: z.number(),
  }),
  results: z
    .array(
      z.object({
        policy: z.string(),
        rule: z.string(),
        result: PolicyResultSchema,
        severity: PolicySeveritySchema.optional(),
        category: z.string().optional(),
        message: z.string().optional(),
        timestamp: z.string().optional(),
        resources: z
          .array(z.object({ kind: z.string(), name: z.string(), namespace: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
})
export type PolicyReport = z.infer<typeof PolicyReportSchema>

export const PolicyExceptionSchema = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  policyRef: z.string(),
  rules: z.array(z.string()),
  match: z.object({
    kinds: z.array(z.string()).optional(),
    namespaces: z.array(z.string()).optional(),
    names: z.array(z.string()).optional(),
  }),
  reason: z.string().optional(),
  expires_at: z.string().optional(),
  created_at: z.string().optional(),
})
export type PolicyException = z.infer<typeof PolicyExceptionSchema>

export interface KyvernoClient {
  listPolicies(): Promise<Policy[]>
  getPolicy(name: string, namespace?: string): Promise<Policy>
  listPolicyReports(namespace?: string): Promise<PolicyReport[]>
  listExceptions(): Promise<PolicyException[]>
  /** Toggle a Policy's enforcement mode (Audit ↔ Enforce). */
  setEnforcementMode(name: string, mode: 'Audit' | 'Enforce', namespace?: string): Promise<void>
}

function build(http: HttpClient): KyvernoClient {
  return {
    listPolicies: async () => {
      const cluster = await http.get<{ items: Policy[] }>(`/apis/kyverno.io/v1/clusterpolicies`)
      const ns = await http.get<{ items: Policy[] }>(`/apis/kyverno.io/v1/policies`)
      return [...cluster.items, ...ns.items]
    },
    getPolicy: (name, namespace) =>
      http.get<Policy>(
        namespace
          ? `/apis/kyverno.io/v1/namespaces/${namespace}/policies/${name}`
          : `/apis/kyverno.io/v1/clusterpolicies/${name}`,
      ),
    listPolicyReports: async (ns) => {
      const path = ns
        ? `/apis/wgpolicyk8s.io/v1alpha2/namespaces/${ns}/policyreports`
        : `/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports`
      const res = await http.get<{ items: PolicyReport[] }>(path)
      return res.items
    },
    listExceptions: async () => {
      const res = await http.get<{ items: PolicyException[] }>(`/apis/kyverno.io/v2/policyexceptions`)
      return res.items
    },
    setEnforcementMode: async (name, mode, namespace) => {
      await http.patch<void>(
        namespace
          ? `/apis/kyverno.io/v1/namespaces/${namespace}/policies/${name}`
          : `/apis/kyverno.io/v1/clusterpolicies/${name}`,
        { spec: { validationFailureAction: mode } },
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
      )
    },
  }
}

/* ─────────── stub data ─────────── */

const ts = '2026-04-23T18:14:00Z'

const STUB_POLICIES: Policy[] = [
  {
    name: 'require-pod-resources',
    kind: 'ClusterPolicy',
    validationFailureAction: 'Enforce',
    background: true,
    category: 'Best Practices',
    severity: 'medium',
    description: 'Every Pod must declare CPU and memory requests + limits.',
    ready: true,
    pass: 184,
    fail: 4,
    warn: 0,
    rules: [
      {
        name: 'validate-resources',
        action: 'validate',
        severity: 'medium',
        match: { kinds: ['Pod'] },
        description: 'spec.containers[*].resources.{requests,limits}.{cpu,memory} must be set',
      },
    ],
    created_at: '2026-03-04T10:00:00Z',
  },
  {
    name: 'disallow-host-network',
    kind: 'ClusterPolicy',
    validationFailureAction: 'Enforce',
    background: true,
    category: 'Pod Security',
    severity: 'high',
    description: 'Pods must not use the host network namespace.',
    ready: true,
    pass: 142,
    fail: 0,
    warn: 0,
    rules: [
      {
        name: 'host-network',
        action: 'validate',
        severity: 'high',
        match: { kinds: ['Pod'] },
      },
    ],
    created_at: '2026-03-04T10:00:00Z',
  },
  {
    name: 'require-tenant-label',
    kind: 'ClusterPolicy',
    validationFailureAction: 'Audit',
    category: 'Multi-tenancy',
    severity: 'high',
    description: 'Every workload must carry an adhar.io/tenant label.',
    ready: true,
    pass: 88,
    fail: 6,
    warn: 2,
    rules: [
      {
        name: 'check-for-labels',
        action: 'validate',
        severity: 'high',
        match: { kinds: ['Deployment', 'StatefulSet', 'DaemonSet'] },
      },
    ],
    created_at: '2026-03-21T12:00:00Z',
  },
  {
    name: 'verify-image-signatures',
    kind: 'ClusterPolicy',
    validationFailureAction: 'Enforce',
    category: 'Supply Chain',
    severity: 'critical',
    description: 'Container images must be signed by Adhar Sigstore root.',
    ready: true,
    pass: 220,
    fail: 1,
    warn: 0,
    rules: [
      {
        name: 'verify-images',
        action: 'verifyImages',
        severity: 'critical',
        match: { kinds: ['Pod'] },
      },
    ],
    created_at: '2026-03-30T08:00:00Z',
  },
  {
    name: 'mutate-add-default-labels',
    kind: 'ClusterPolicy',
    validationFailureAction: 'Audit',
    background: false,
    category: 'Best Practices',
    severity: 'low',
    description: 'Add default app.kubernetes.io/* labels on Deployment creation.',
    ready: true,
    pass: 0,
    fail: 0,
    warn: 0,
    rules: [
      {
        name: 'add-labels',
        action: 'mutate',
        severity: 'low',
        match: { kinds: ['Deployment'] },
      },
    ],
    created_at: '2026-04-02T09:00:00Z',
  },
  {
    name: 'generate-default-network-policy',
    kind: 'ClusterPolicy',
    validationFailureAction: 'Audit',
    category: 'Networking',
    severity: 'medium',
    description: 'Generate a deny-all NetworkPolicy on every new namespace.',
    ready: true,
    rules: [
      {
        name: 'add-deny-all',
        action: 'generate',
        severity: 'medium',
        match: { kinds: ['Namespace'] },
      },
    ],
    created_at: '2026-04-09T14:00:00Z',
  },
  {
    name: 'disallow-latest-tag',
    kind: 'Policy',
    namespace: 'acme-portal',
    validationFailureAction: 'Audit',
    category: 'Best Practices',
    severity: 'medium',
    description: 'Deployments cannot use image tag :latest.',
    ready: true,
    pass: 14,
    fail: 1,
    warn: 0,
    rules: [{ name: 'no-latest', action: 'validate', match: { kinds: ['Deployment'] } }],
    created_at: '2026-04-12T07:00:00Z',
  },
]

const STUB_REPORTS: PolicyReport[] = [
  {
    metadata: { name: 'cluster-wide', creationTimestamp: ts },
    summary: { pass: 654, fail: 12, warn: 2, error: 0, skip: 38 },
    results: [
      {
        policy: 'require-tenant-label',
        rule: 'check-for-labels',
        result: 'fail',
        severity: 'high',
        category: 'Multi-tenancy',
        message: 'Deployment missing adhar.io/tenant label',
        timestamp: ts,
        resources: [{ kind: 'Deployment', name: 'orphan-app', namespace: 'default' }],
      },
      {
        policy: 'require-pod-resources',
        rule: 'validate-resources',
        result: 'fail',
        severity: 'medium',
        category: 'Best Practices',
        message: 'spec.containers[0].resources.limits.cpu missing',
        timestamp: ts,
        resources: [
          { kind: 'Pod', name: 'billing-service-xyz', namespace: 'acme-billing' },
          { kind: 'Pod', name: 'platform-bff-9d', namespace: 'acme-platform' },
        ],
      },
      {
        policy: 'verify-image-signatures',
        rule: 'verify-images',
        result: 'fail',
        severity: 'critical',
        category: 'Supply Chain',
        message: 'image harbor.adhar.local/acme/legacy-tool:v0.1 not signed by trusted root',
        timestamp: ts,
        resources: [{ kind: 'Pod', name: 'legacy-tool-7c', namespace: 'kube-system' }],
      },
      {
        policy: 'require-tenant-label',
        rule: 'check-for-labels',
        result: 'warn',
        severity: 'high',
        category: 'Multi-tenancy',
        message: 'StatefulSet uses deprecated label adhar/tenant — switch to adhar.io/tenant',
        timestamp: ts,
        resources: [{ kind: 'StatefulSet', name: 'redis-cache', namespace: 'data' }],
      },
      {
        policy: 'disallow-latest-tag',
        rule: 'no-latest',
        result: 'fail',
        severity: 'medium',
        category: 'Best Practices',
        message: 'Container "web" uses image tag :latest',
        timestamp: ts,
        resources: [{ kind: 'Deployment', name: 'customer-portal', namespace: 'acme-portal' }],
      },
    ],
  },
  {
    metadata: { name: 'acme-billing', namespace: 'acme-billing', creationTimestamp: ts },
    summary: { pass: 84, fail: 2, warn: 0, error: 0, skip: 4 },
  },
  {
    metadata: { name: 'acme-portal', namespace: 'acme-portal', creationTimestamp: ts },
    summary: { pass: 38, fail: 1, warn: 1, error: 0, skip: 2 },
  },
  {
    metadata: { name: 'acme-platform', namespace: 'acme-platform', creationTimestamp: ts },
    summary: { pass: 96, fail: 1, warn: 0, error: 0, skip: 6 },
  },
]

const STUB_EXCEPTIONS: PolicyException[] = [
  {
    name: 'redis-cache-resources-exception',
    namespace: 'data',
    policyRef: 'require-pod-resources',
    rules: ['validate-resources'],
    match: { kinds: ['Pod'], names: ['redis-cache-*'], namespaces: ['data'] },
    reason: 'Memory limit pinned by operator; CPU bounded by HPA.',
    expires_at: '2026-06-01T00:00:00Z',
    created_at: '2026-04-12T08:00:00Z',
  },
  {
    name: 'kube-system-tenant-label-exception',
    policyRef: 'require-tenant-label',
    rules: ['check-for-labels'],
    match: { namespaces: ['kube-system', 'kube-public'] },
    reason: 'System namespaces are platform-owned, not tenant-mapped.',
    created_at: '2026-03-25T14:00:00Z',
  },
]

export const KyvernoClient = defineClient<KyvernoClient>(build, () => {
  const policies = STUB_POLICIES.slice()
  return {
    listPolicies: async () => policies,
    getPolicy: async (name, namespace) => {
      const p = policies.find((x) => x.name === name && x.namespace === namespace)
      if (!p) throw new Error(`Stub: policy ${namespace ?? 'cluster'}/${name} not found`)
      return p
    },
    listPolicyReports: async (ns) =>
      ns
        ? STUB_REPORTS.filter((r) => r.metadata.namespace === ns)
        : STUB_REPORTS,
    listExceptions: async () => STUB_EXCEPTIONS,
    setEnforcementMode: async (name, mode, namespace) => {
      const p = policies.find((x) => x.name === name && x.namespace === namespace)
      if (p) p.validationFailureAction = mode
    },
  }
})
