# Security

## Reporting a vulnerability

Email `security@adhar.io`. Do **not** file a public issue for unfixed
vulnerabilities.

- Expected first response: 24 hours (business days).
- Expected triage + fix timeline: 14 days for high/critical, 60 days for low/medium.
- We will coordinate disclosure; by default CVEs are published on the fix
  release.

We do not yet run a paid bug bounty. Credit in the changelog is offered for
all valid reports.

## Supported versions

- Current minor and previous minor receive security patches.
- `0.x` is pre-1.0 — no guarantees prior to the stable cut. After 1.0, the
  supported matrix lives on [`/status`](./docs/phases/platform.md).

## Threat model (summary)

- **Primary threat:** cross-tenant data leakage. Every server function
  resolves tenant from the session and scopes downstream calls; never from
  request input.
- **Secondary threat:** privilege escalation via API tokens. Tokens are
  scoped, prefixed, displayed only on creation, and carry explicit scopes
  enforced at the BFF layer.
- **Deferred (not in v1):** strong per-user impersonation of the Kubernetes
  API. Today the console SA holds broad read access and the Platform view
  surfaces data from that SA. Per-request user tokens are on the `0.3.x`
  roadmap.

## Practices in this repo

- Dockerfile runs distroless + non-root + read-only rootfs.
- `SecurityContext` drops all capabilities and blocks privilege escalation.
- Dependencies pinned via `pnpm-lock.yaml` + `deno.lock`.
- `zod` validates every BFF input and every backing-tool response before it
  reaches client code.
- No `eval`, no user-supplied code execution paths.
- Secrets never committed; `deploy/k8s/secret.example.yaml` is a template.
  Production is expected to use External Secrets or SOPS.
- CORS on remotes is permissive **only** during local dev (`cors: true` in
  each remote's `vite.config.ts`); in production, all remotes are served
  from the host origin at `/mf/<remote>/`.

## Checklist for security-touching PRs

- [ ] Did you change anything in `packages/auth` or `packages/tenancy`?
- [ ] Did you add a BFF endpoint that takes `tenant`/`org` as input? (If yes —
      don't; resolve from session instead.)
- [ ] Did you add a dependency? New deps need justification + license check.
- [ ] Did you add a new scope to the API token enum?
- [ ] Does the change get logged to the audit log?
