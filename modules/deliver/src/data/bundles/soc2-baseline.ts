/**
 * GENERATED MIRROR of ./soc2-baseline.yaml — the kubectl-apply artifact is the
 * .yaml file; this constant exists because the Vite MF remote (and
 * `deno check`) cannot import raw .yaml modules. Keep both in sync.
 */
export const SOC2_BASELINE_YAML = `# ──────────────────────────────────────────────────────────────────────────
# Adhar policy pack: soc2-baseline
# SOC 2 Trust Services Criteria (2017, rev. 2022) — platform baseline
#
# Maps common Kyverno guardrails onto the Common Criteria (CC-series) and
# Availability criteria so PolicyReport findings can be rolled up as
# audit evidence per criterion.
#
# Audit-first: every ClusterPolicy ships with validationFailureAction: Audit
# so adopting the pack never blocks admission. Review the findings in the
# Deliver → Policy dashboard, then promote individual policies to Enforce.
#
# Apply:   kubectl apply -f soc2-baseline.yaml
# Remove:  kubectl delete -f soc2-baseline.yaml
#
# NOTE: mirrored as a string constant in ./soc2-baseline.ts for the console
# UI (Vite MF remote cannot import .yaml). Keep both files in sync.
# ──────────────────────────────────────────────────────────────────────────
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-run-as-nonroot
  annotations:
    policies.kyverno.io/title: Require runAsNonRoot
    policies.kyverno.io/category: SOC 2 — Logical Access
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC6.1
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
          Workloads must not execute as root (SOC 2 CC6.1 — least-privilege
          logical access). Set runAsNonRoot to true at the pod level or on
          every container.
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
  name: require-tenant-label
  annotations:
    policies.kyverno.io/title: Require Tenant Ownership Label
    policies.kyverno.io/category: SOC 2 — Ownership & Accountability
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Workload
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC6.3
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: check-for-labels
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
                - DaemonSet
      validate:
        message: >-
          Every workload must declare its owning tenant via the
          adhar.io/tenant label (SOC 2 CC6.3 — roles and responsibilities
          for access are assigned and reviewable).
        pattern:
          metadata:
            labels:
              adhar.io/tenant: "?*"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-nodeport
  annotations:
    policies.kyverno.io/title: Restrict NodePort Services
    policies.kyverno.io/category: SOC 2 — Network Boundary
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Service
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC6.6
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: validate-nodeport
      match:
        any:
          - resources:
              kinds:
                - Service
      validate:
        message: >-
          NodePort services bypass the managed ingress boundary
          (SOC 2 CC6.6 — protection against external access outside system
          boundaries). Use a ClusterIP service behind the ingress instead.
        pattern:
          spec:
            =(type): "!NodePort"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
  annotations:
    policies.kyverno.io/title: Restrict Image Registries
    policies.kyverno.io/category: SOC 2 — Supply Chain
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC6.7
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: validate-registries
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Images may only be pulled from the trusted registries
          harbor.adhar.local or registry.k8s.io (SOC 2 CC6.7 — restrict
          the movement of software into the system).
        pattern:
          spec:
            =(ephemeralContainers):
              - image: "harbor.adhar.local/* | registry.k8s.io/*"
            =(initContainers):
              - image: "harbor.adhar.local/* | registry.k8s.io/*"
            containers:
              - image: "harbor.adhar.local/* | registry.k8s.io/*"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
  annotations:
    policies.kyverno.io/title: Verify Image Signatures
    policies.kyverno.io/category: SOC 2 — Supply Chain
    policies.kyverno.io/severity: critical
    policies.kyverno.io/subject: Pod
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC6.8
spec:
  validationFailureAction: Audit
  background: false
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-signatures
      match:
        any:
          - resources:
              kinds:
                - Pod
      verifyImages:
        - imageReferences:
            - "harbor.adhar.local/*"
          attestors:
            - count: 1
              entries:
                # Cosign public key distributed as a Secret; replace with
                # your organisation's signing root before applying.
                - keys:
                    secret:
                      name: adhar-cosign-public-key
                      namespace: kyverno
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-pod-probes
  annotations:
    policies.kyverno.io/title: Require Liveness and Readiness Probes
    policies.kyverno.io/category: SOC 2 — Monitoring
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC7.1
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: validate-probes
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Liveness and readiness probes are required (SOC 2 CC7.1 —
          monitoring to detect anomalies and component failures).
        pattern:
          spec:
            containers:
              - livenessProbe:
                  periodSeconds: ">0"
                readinessProbe:
                  periodSeconds: ">0"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
  annotations:
    policies.kyverno.io/title: Disallow Latest Tag
    policies.kyverno.io/category: SOC 2 — Change Management
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-CC8.1
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: require-image-tag
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          An explicit image tag is required (SOC 2 CC8.1 — changes are
          authorized and traceable to a specific version).
        pattern:
          spec:
            containers:
              - image: "*:*"
    - name: validate-image-tag
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          The mutable tag "latest" is not allowed (SOC 2 CC8.1 — changes
          are authorized and traceable to a specific version).
        pattern:
          spec:
            containers:
              - image: "!*:latest"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-pod-resources
  annotations:
    policies.kyverno.io/title: Require Pod Requests and Limits
    policies.kyverno.io/category: SOC 2 — Availability
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod
    adhar.io/pack: soc2-baseline
    adhar.io/control: SOC2-A1.1
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: validate-resources
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          CPU and memory requests and limits are required (SOC 2 A1.1 —
          capacity is managed to meet availability commitments).
        pattern:
          spec:
            containers:
              - resources:
                  requests:
                    memory: "?*"
                    cpu: "?*"
                  limits:
                    memory: "?*"
                    cpu: "?*"
`
