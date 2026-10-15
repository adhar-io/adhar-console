---
title: Runtime threat detection
category: Security
summary: Watch what containers actually do — and alert when a pod starts behaving like an attacker.
tools: [Falco, Tetragon, Trivy]
order: 50
---

## Why
Scanning images finds known vulnerabilities before deploy. It cannot see a zero-day exploited at runtime: a shell spawned in a web container, a write to `/etc`, an unexpected outbound connection. Runtime detection is the alarm for what got past the door.

## How Adhar does it
**Falco** watches system calls and fires on rules (shell in container, sensitive file read, privilege escalation). **Tetragon** (Cilium's eBPF security observability) traces process execution and network activity per pod and can enforce — kill the process — inline. Findings appear under [Deliver → Runtime](/deliver?section=runtime).

## Use it
- Start with the default rule sets; route critical alerts to on-call, others to a review queue.
- Add app-specific rules for things your service should never do ("api never spawns a shell").

## Watch out
- Tune noisy rules early, or people learn to ignore the channel.
- Enforcement (killing processes) belongs to well-understood rules only.
- Detection without a response playbook is just a log.
