/**
 * GENERATED MIRROR of ./cis-baseline.yaml — the kubectl-apply artifact is the
 * .yaml file; this constant exists because the Vite MF remote (and
 * `deno check`) cannot import raw .yaml modules. Keep both in sync.
 */
export const CIS_BASELINE_YAML = `# ──────────────────────────────────────────────────────────────────────────
# Adhar policy pack: cis-k8s-baseline
# CIS Kubernetes Benchmark v1.9.0 — Section 5 (Policies)
#
# Audit-first: every ClusterPolicy ships with validationFailureAction: Audit
# so adopting the pack never blocks admission. Review the findings in the
# Deliver → Policy dashboard, then promote individual policies to Enforce.
#
# Apply:   kubectl apply -f cis-baseline.yaml
# Remove:  kubectl delete -f cis-baseline.yaml
#
# NOTE: mirrored as a string constant in ./cis-baseline.ts for the console
# UI (Vite MF remote cannot import .yaml). Keep both files in sync.
# ──────────────────────────────────────────────────────────────────────────
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privileged-containers
  annotations:
    policies.kyverno.io/title: Disallow Privileged Containers
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: critical
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.2.1
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: privileged-containers
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Privileged mode is disallowed (CIS 5.2.1). Set
          securityContext.privileged to false or remove the field.
        pattern:
          spec:
            =(ephemeralContainers):
              - =(securityContext):
                  =(privileged): "false"
            =(initContainers):
              - =(securityContext):
                  =(privileged): "false"
            containers:
              - =(securityContext):
                  =(privileged): "false"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-host-namespaces
  annotations:
    policies.kyverno.io/title: Disallow Host Namespaces
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.2.2, CIS-5.2.3
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: host-namespaces
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Sharing the host PID or IPC namespace is disallowed
          (CIS 5.2.2 / 5.2.3). Set hostPID and hostIPC to false or remove
          the fields.
        pattern:
          spec:
            =(hostPID): "false"
            =(hostIPC): "false"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-host-network
  annotations:
    policies.kyverno.io/title: Disallow Host Network
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.2.4
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: host-network
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Sharing the host network namespace is disallowed (CIS 5.2.4). Set
          hostNetwork to false or remove the field.
        pattern:
          spec:
            =(hostNetwork): "false"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privilege-escalation
  annotations:
    policies.kyverno.io/title: Disallow Privilege Escalation
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.2.5
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: privilege-escalation
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Privilege escalation is disallowed (CIS 5.2.5). Every container
          must set securityContext.allowPrivilegeEscalation to false.
        pattern:
          spec:
            =(ephemeralContainers):
              - securityContext:
                  allowPrivilegeEscalation: "false"
            =(initContainers):
              - securityContext:
                  allowPrivilegeEscalation: "false"
            containers:
              - securityContext:
                  allowPrivilegeEscalation: "false"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-run-as-nonroot
  annotations:
    policies.kyverno.io/title: Require runAsNonRoot
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.2.6
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: run-as-non-root
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Running as root is disallowed (CIS 5.2.6). Set runAsNonRoot to
          true at the pod level or on every container.
        anyPattern:
          - spec:
              securityContext:
                runAsNonRoot: true
          - spec:
              containers:
                - securityContext:
                    runAsNonRoot: true
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-drop-net-raw
  annotations:
    policies.kyverno.io/title: Drop NET_RAW Capability
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.2.7
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: require-drop-net-raw
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Containers must drop the NET_RAW capability (CIS 5.2.7). Add
          NET_RAW to securityContext.capabilities.drop.
        foreach:
          - list: request.object.spec.containers
            deny:
              conditions:
                all:
                  - key: NET_RAW
                    operator: AnyNotIn
                    value: "{{ element.securityContext.capabilities.drop[] || \`[]\` }}"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-seccomp-profile
  annotations:
    policies.kyverno.io/title: Require Seccomp Profile
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.7.2
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: seccomp-profile
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          A RuntimeDefault or Localhost seccomp profile is required
          (CIS 5.7.2). Set it at the pod level or on every container.
        anyPattern:
          - spec:
              securityContext:
                seccompProfile:
                  type: "RuntimeDefault | Localhost"
          - spec:
              containers:
                - securityContext:
                    seccompProfile:
                      type: "RuntimeDefault | Localhost"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-ro-rootfs
  annotations:
    policies.kyverno.io/title: Require Read-Only Root Filesystem
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.7.3
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: read-only-root-filesystem
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Containers must apply a SecurityContext with a read-only root
          filesystem (CIS 5.7.3). Set readOnlyRootFilesystem to true and
          mount writable paths as emptyDir volumes.
        pattern:
          spec:
            containers:
              - securityContext:
                  readOnlyRootFilesystem: true
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-default-namespace
  annotations:
    policies.kyverno.io/title: Disallow Default Namespace
    policies.kyverno.io/category: CIS Kubernetes Benchmark
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod, Workload
    adhar.io/pack: cis-k8s-baseline
    adhar.io/control: CIS-5.7.4
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: validate-namespace
      match:
        any:
          - resources:
              kinds:
                - Pod
                - Deployment
                - StatefulSet
                - DaemonSet
                - Job
                - CronJob
      validate:
        message: >-
          The default namespace must not be used (CIS 5.7.4). Create the
          workload in a purpose-specific namespace.
        pattern:
          metadata:
            namespace: "!default"
`
