---
title: Secure software supply chain
category: Delivery
summary: Only signed, scanned images built by your pipeline can run in production.
tools: [Tekton, Harbor, Trivy, Cosign, Kyverno]
order: 40
---

## Why
An attacker who can push an image — or swap a base layer — owns your cluster. The defence is a chain of custody: who built this, from which commit, with which known vulnerabilities, and is it the same bytes now?

## How Adhar does it
- **Build** in Tekton from a Git commit; push to **Harbor**.
- **Scan** with Trivy (Harbor scans on push); results under [Deliver → Scans](/deliver?section=scans).
- **Sign** with Cosign, keyed by the pipeline.
- **Enforce** with a Kyverno `verifyImages` policy: unsigned images, or images from other registries, are rejected at admission.

## Use it
```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata: { name: require-signed-images }
spec:
  validationFailureAction: Enforce
  rules:
    - name: verify
      match: { any: [{ resources: { kinds: [Pod], namespaces: ["*-prod"] } }] }
      verifyImages:
        - imageReferences: ["harbor.example.com/*"]
          attestors: [{ entries: [{ keys: { publicKey: "<cosign.pub>" } }] }]
```

## Watch out
- Pin base images by digest and rebuild on a schedule to pick up patches.
- Start policies in `Audit`, fix the reports, then switch to `Enforce`.
- A critical CVE gate that nobody can bypass will be bypassed by disabling it — define an exception process.
