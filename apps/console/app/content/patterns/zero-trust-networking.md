---
title: Zero-trust networking
category: Security
summary: Nothing talks to anything unless a policy says so — identity, not IP address, decides.
tools: [Cilium, Hubble, Cilium Gateway API, cert-manager]
order: 10
---

## Why
A flat cluster network means one compromised pod can reach every database. Zero trust assumes the network is hostile: deny by default, allow the few flows a service needs, and encrypt what crosses it.

## How Adhar does it
- **Cilium** (eBPF) enforces network policy by workload **identity** (labels), at L3/L4 and L7 (HTTP paths, Kafka topics, DNS names).
- [Environments](/platform?section=environments) create namespaces with a baseline network policy; make it **default-deny** plus the minimum allows (DNS, same-namespace, ingress gateway).
- **Hubble** shows every flow and every drop — the fastest way to write a correct policy.
- **cert-manager** issues TLS for every ingress; the Gateway API terminates it at the edge.

## Use it
```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata: { name: orders-db-ingress, namespace: shop-prod }
spec:
  endpointSelector: { matchLabels: { app: orders-db } }
  ingress:
    - fromEndpoints: [{ matchLabels: { app: orders } }]
      toPorts: [{ ports: [{ port: "5432", protocol: TCP }] }]
```

## Watch out
- Default-deny breaks DNS first — allow kube-dns egress explicitly.
- Write policies from **observed** Hubble flows, not from memory.
- Egress to the internet should go through an allow-list (`toFQDNs`), not `0.0.0.0/0`.
