import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { kyverno } from '@adhar-console/api-clients'
import { CIS_BASELINE_YAML, SOC2_BASELINE_YAML } from './bundles/index.ts'

/**
 * Compliance policy packs.
 *
 * A pack is an opt-in bundle of Kyverno ClusterPolicies (see
 * `./bundles/*.yaml`) whose controls cite a compliance framework — CIS
 * Kubernetes Benchmark section 5 IDs, SOC 2 Trust Services Criteria, etc.
 * Coverage is never fabricated: `packCoverage` derives per-control
 * pass / fail / exempt status purely from the live Kyverno PolicyReport
 * findings and PolicyExceptions the dashboard already loads. Controls whose
 * mapped policy has produced no report results yet show as `unknown`
 * ("no data") and are excluded from the compliance percentage.
 *
 * Enabling a pack is console-local bookkeeping (localStorage, same pattern
 * as the marketplace Helm releases) — it does not mutate the cluster.
 * Adoption is the downloaded bundle + `kubectl apply`, audit-first.
 */

export type PackFramework = 'CIS' | 'SOC2' | 'PSS' | 'NSA-CISA'

export interface PackControl {
  /** Framework citation, e.g. 'CIS-5.2.5' or 'SOC2-CC6.1'. */
  id: string
  title: string
  description: string
  /** Name of the bundled Kyverno ClusterPolicy that implements the control. */
  kyvernoPolicy: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  category: string
}

export interface PolicyPack {
  id: string
  name: string
  framework: PackFramework
  version: string
  description: string
  controls: PackControl[]
  /** Distinct Kyverno policy names shipped in the bundle. */
  kyvernoPolicies: string[]
  /** Default opt-in state — packs always start disabled. */
  enabled: boolean
  /** Raw multi-document ClusterPolicy YAML (the kubectl-apply artifact). */
  bundleYaml: string
  /** Suggested filename when downloading the bundle. */
  bundleFile: string
}

export const POLICY_PACKS: PolicyPack[] = [
  {
    id: 'cis-k8s-baseline',
    name: 'CIS Kubernetes Benchmark',
    framework: 'CIS',
    version: 'v1.9.0',
    description:
      'Section 5 (Policies) of the CIS Kubernetes Benchmark as audit-mode Kyverno ClusterPolicies — pod security primitives, seccomp, read-only root filesystems and namespace hygiene.',
    enabled: false,
    bundleFile: 'cis-baseline.yaml',
    bundleYaml: CIS_BASELINE_YAML,
    kyvernoPolicies: [
      'disallow-privileged-containers',
      'disallow-host-namespaces',
      'disallow-host-network',
      'disallow-privilege-escalation',
      'require-run-as-nonroot',
      'require-drop-net-raw',
      'require-seccomp-profile',
      'require-ro-rootfs',
      'disallow-default-namespace',
    ],
    controls: [
      {
        id: 'CIS-5.2.1',
        title: 'Minimize the admission of privileged containers',
        description:
          'Privileged containers have full access to the host kernel and devices. No container may set securityContext.privileged: true.',
        kyvernoPolicy: 'disallow-privileged-containers',
        severity: 'critical',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.2.2',
        title: 'Minimize the admission of containers wishing to share the host process ID namespace',
        description:
          'hostPID lets a container inspect and signal every process on the node. Pods must not set spec.hostPID: true.',
        kyvernoPolicy: 'disallow-host-namespaces',
        severity: 'high',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.2.3',
        title: 'Minimize the admission of containers wishing to share the host IPC namespace',
        description:
          'hostIPC exposes host shared-memory segments to the container. Pods must not set spec.hostIPC: true.',
        kyvernoPolicy: 'disallow-host-namespaces',
        severity: 'high',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.2.4',
        title: 'Minimize the admission of containers wishing to share the host network namespace',
        description:
          'hostNetwork grants access to node loopback and sniffing of node traffic. Pods must not set spec.hostNetwork: true.',
        kyvernoPolicy: 'disallow-host-network',
        severity: 'high',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.2.5',
        title: 'Minimize the admission of containers with allowPrivilegeEscalation',
        description:
          'Every container must explicitly set securityContext.allowPrivilegeEscalation: false so setuid binaries cannot gain privileges.',
        kyvernoPolicy: 'disallow-privilege-escalation',
        severity: 'high',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.2.6',
        title: 'Minimize the admission of root containers',
        description:
          'Containers must run as a non-root user: runAsNonRoot: true at the pod level or on every container.',
        kyvernoPolicy: 'require-run-as-nonroot',
        severity: 'high',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.2.7',
        title: 'Minimize the admission of containers with the NET_RAW capability',
        description:
          'NET_RAW enables crafting raw packets (ARP/DNS spoofing). Every container must drop the NET_RAW capability.',
        kyvernoPolicy: 'require-drop-net-raw',
        severity: 'medium',
        category: 'Pod Security',
      },
      {
        id: 'CIS-5.7.2',
        title: 'Ensure that the seccomp profile is set in your Pod definitions',
        description:
          'A RuntimeDefault or Localhost seccomp profile must be set at the pod level or on every container to filter syscalls.',
        kyvernoPolicy: 'require-seccomp-profile',
        severity: 'medium',
        category: 'Workload Hardening',
      },
      {
        id: 'CIS-5.7.3',
        title: 'Apply SecurityContext to your Pods and Containers',
        description:
          'Containers must apply a hardening SecurityContext; this pack enforces readOnlyRootFilesystem: true with writable emptyDir mounts.',
        kyvernoPolicy: 'require-ro-rootfs',
        severity: 'medium',
        category: 'Workload Hardening',
      },
      {
        id: 'CIS-5.7.4',
        title: 'The default namespace should not be used',
        description:
          'Workloads must live in purpose-specific namespaces so RBAC, quotas and network policy boundaries apply.',
        kyvernoPolicy: 'disallow-default-namespace',
        severity: 'medium',
        category: 'Namespaces',
      },
    ],
  },
  {
    id: 'soc2-baseline',
    name: 'SOC 2 Platform Baseline',
    framework: 'SOC2',
    version: '2017 TSC (rev. 2022)',
    description:
      'Kyverno guardrails mapped to SOC 2 Trust Services Criteria — logical access (CC6.x), monitoring (CC7.x), change management (CC8.1) and availability (A1.1) — so policy findings double as audit evidence.',
    enabled: false,
    bundleFile: 'soc2-baseline.yaml',
    bundleYaml: SOC2_BASELINE_YAML,
    kyvernoPolicies: [
      'require-run-as-nonroot',
      'require-tenant-label',
      'restrict-nodeport',
      'restrict-image-registries',
      'verify-image-signatures',
      'require-pod-probes',
      'disallow-latest-tag',
      'require-pod-resources',
    ],
    controls: [
      {
        id: 'SOC2-CC6.1',
        title: 'Logical access — workloads execute with least privilege',
        description:
          'CC6.1 requires logical access security over protected resources. Containers must not run as root (runAsNonRoot: true).',
        kyvernoPolicy: 'require-run-as-nonroot',
        severity: 'high',
        category: 'Access Control',
      },
      {
        id: 'SOC2-CC6.3',
        title: 'Access responsibility — every workload declares an owning tenant',
        description:
          'CC6.3 requires that roles and responsibilities are assigned and reviewable. Workloads must carry the adhar.io/tenant ownership label.',
        kyvernoPolicy: 'require-tenant-label',
        severity: 'medium',
        category: 'Ownership & Accountability',
      },
      {
        id: 'SOC2-CC6.6',
        title: 'Boundary protection — no unmanaged NodePort entry points',
        description:
          'CC6.6 requires protection against access from outside system boundaries. Services must enter through the managed ingress, not NodePorts.',
        kyvernoPolicy: 'restrict-nodeport',
        severity: 'medium',
        category: 'Network Boundary',
      },
      {
        id: 'SOC2-CC6.7',
        title: 'Software movement — images only from trusted registries',
        description:
          'CC6.7 restricts the movement of software into the system. Images must be pulled from harbor.adhar.local or registry.k8s.io.',
        kyvernoPolicy: 'restrict-image-registries',
        severity: 'high',
        category: 'Supply Chain',
      },
      {
        id: 'SOC2-CC6.8',
        title: 'Unauthorized software — image signatures are verified',
        description:
          'CC6.8 requires prevention and detection of unauthorized software. Images must carry a cosign signature from the platform signing root.',
        kyvernoPolicy: 'verify-image-signatures',
        severity: 'critical',
        category: 'Supply Chain',
      },
      {
        id: 'SOC2-CC7.1',
        title: 'Monitoring — workloads expose liveness and readiness probes',
        description:
          'CC7.1 requires monitoring to detect anomalies and failures. Every container must define liveness and readiness probes.',
        kyvernoPolicy: 'require-pod-probes',
        severity: 'medium',
        category: 'Monitoring',
      },
      {
        id: 'SOC2-CC8.1',
        title: 'Change management — immutable, versioned image tags',
        description:
          'CC8.1 requires that changes are authorized and traceable. Images must use an explicit, non-"latest" tag so deployments map to reviewed versions.',
        kyvernoPolicy: 'disallow-latest-tag',
        severity: 'medium',
        category: 'Change Management',
      },
      {
        id: 'SOC2-A1.1',
        title: 'Availability — capacity requests and limits are declared',
        description:
          'A1.1 requires managing capacity to meet availability commitments. Every container must declare CPU and memory requests and limits.',
        kyvernoPolicy: 'require-pod-resources',
        severity: 'medium',
        category: 'Availability',
      },
    ],
  },
]

export function packById(id: string): PolicyPack | undefined {
  return POLICY_PACKS.find((p) => p.id === id)
}

/* ─────────── coverage rollup (derived from live findings) ─────────── */

export type ControlStatus = 'pass' | 'fail' | 'exempt' | 'unknown'

export interface ControlCoverage {
  control: PackControl
  status: ControlStatus
  /** Report result counts for the control's mapped policy. */
  pass: number
  fail: number
  warn: number
  /** Resources named in failing findings, deduplicated. */
  failingResources: { kind: string; name: string; namespace?: string }[]
  /** PolicyExceptions that waive the mapped policy. */
  exceptionNames: string[]
}

export interface PackCoverage {
  controls: ControlCoverage[]
  passed: number
  failed: number
  exempt: number
  unknown: number
  /**
   * Percentage of evaluated controls (pass + fail) that pass, 0–100.
   * `null` when no control has produced report data yet — e.g. the bundle
   * has not been applied — so the UI never shows an invented number.
   */
  compliancePct: number | null
}

/**
 * Roll up a pack's controls against the live Kyverno findings.
 *
 * Per control (matched on the finding's `policy` name):
 *   fail    — at least one `fail`/`error` result
 *   pass    — results exist and none failed (warn-only still passes,
 *             the warn count is surfaced alongside)
 *   exempt  — no results, but a PolicyException waives the policy
 *   unknown — the policy has produced no report results (not applied yet)
 */
export function packCoverage(
  pack: PolicyPack,
  findings: kyverno.PolicyReport[],
  exceptions: kyverno.PolicyException[] = [],
): PackCoverage {
  type Tally = {
    pass: number
    fail: number
    warn: number
    resources: Map<string, { kind: string; name: string; namespace?: string }>
  }
  const byPolicy = new Map<string, Tally>()
  for (const report of findings) {
    for (const result of report.results ?? []) {
      let tally = byPolicy.get(result.policy)
      if (!tally) {
        tally = { pass: 0, fail: 0, warn: 0, resources: new Map() }
        byPolicy.set(result.policy, tally)
      }
      if (result.result === 'pass') tally.pass += 1
      else if (result.result === 'fail' || result.result === 'error') {
        tally.fail += 1
        for (const r of result.resources ?? []) {
          tally.resources.set(`${r.kind}/${r.namespace ?? ''}/${r.name}`, r)
        }
      } else if (result.result === 'warn') tally.warn += 1
    }
  }

  const controls: ControlCoverage[] = pack.controls.map((control) => {
    const tally = byPolicy.get(control.kyvernoPolicy)
    const exceptionNames = exceptions
      .filter((e) => e.policyRef === control.kyvernoPolicy)
      .map((e) => e.name)
    const hasResults = !!tally && tally.pass + tally.fail + tally.warn > 0
    const status: ControlStatus =
      tally && tally.fail > 0
        ? 'fail'
        : hasResults
          ? 'pass'
          : exceptionNames.length > 0
            ? 'exempt'
            : 'unknown'
    return {
      control,
      status,
      pass: tally?.pass ?? 0,
      fail: tally?.fail ?? 0,
      warn: tally?.warn ?? 0,
      failingResources: tally ? [...tally.resources.values()] : [],
      exceptionNames,
    }
  })

  const passed = controls.filter((c) => c.status === 'pass').length
  const failed = controls.filter((c) => c.status === 'fail').length
  const exempt = controls.filter((c) => c.status === 'exempt').length
  const unknown = controls.filter((c) => c.status === 'unknown').length
  const evaluated = passed + failed
  const compliancePct = evaluated > 0 ? Math.round((passed / evaluated) * 100) : null

  return { controls, passed, failed, exempt, unknown, compliancePct }
}

/* ─────────── enablement (localStorage, marketplace-installs pattern) ─────────── */

const STORAGE_KEY = 'adhar.deliver.policy-packs.enabled'

function loadEnabledPackIds(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[]
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function saveEnabledPackIds(ids: string[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* ignore quota errors */
  }
}

export function useEnabledPacks() {
  return useQuery<string[]>({
    queryKey: ['kyverno', 'packs', 'enabled'],
    queryFn: () => Promise.resolve(loadEnabledPackIds()),
    staleTime: 1_000,
  })
}

export function useTogglePack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ packId, enabled }: { packId: string; enabled: boolean }) => {
      const current = loadEnabledPackIds()
      const next = enabled
        ? current.includes(packId)
          ? current
          : [...current, packId]
        : current.filter((id) => id !== packId)
      saveEnabledPackIds(next)
      return next
    },
    onSuccess: (next) => qc.setQueryData(['kyverno', 'packs', 'enabled'], next),
  })
}
