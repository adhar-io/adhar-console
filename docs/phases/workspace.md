# Phase · Workspace (SaaS admin)

Not a 6D phase — a cross-cutting settings surface. Everything about running
the org lives here.

- **Primary backer:** Adhar's internal control-plane API (not an OSS tool).
- **Module:** `modules/workspace` → exposes `./Home`, `./Organization`,
  `./Members`, `./Projects`, `./Tokens`, `./Audit`, `./Plan`.
- **Port in dev:** 5108.
- **Entry in the host:** `/settings` route → loads `workspace/Home`.

## Sections (left nav)

| Group            | Section         | Purpose                                           |
| ---------------- | --------------- | ------------------------------------------------- |
| Organization     | General         | Name, slug, region, SSO, domain                   |
| Organization     | Members         | Keycloak groups: add, make admin, remove          |
| Organization     | Teams           | `ws-team-<org>.<team>` groups; project access     |
| Workloads        | Projects        | Repo + envs + team ownership                      |
| Workloads        | Environments    | Dev → staging → prod + promotion rules            |
| Connectivity     | Integrations    | Backing tool health + configure                   |
| Connectivity     | API Tokens      | Org tokens for CI / automation                    |
| Connectivity     | Webhooks        | Outbound events (Slack, PagerDuty, custom)        |
| Security & Trust | Audit log       | Every privileged action + actor + outcome         |
| Billing          | Plan            | Tier, seats, renewal, pricing tiers shown public  |
| Billing          | Usage & quotas  | Real-time counters and limits                     |
| Danger zone      | Delete org      | Irreversible; requires typed confirmation         |

## Data layer

All views call the console's BFF, `/api/workspace/*`, through
`modules/workspace/src/data/client.ts`. Tenant = the active org, re-validated
on every request against the caller's Keycloak groups — never from the request
body.

People are Keycloak's, and only Keycloak's: an organization's members are the
group `org-<slug>`, its admins `org-<slug>-admin` (every admin is in both), and
a team is the group `ws-team-<org>.<team>`. The console stores no members,
roles or invitations — Members reads and writes those groups, and adding
someone new creates their Keycloak account (Keycloak emails a set-password
link). See `docs/rbac.md`.

## Onboarding (`/onboarding`)

A 5-step wizard that writes once to the workspace client:

1. Welcome / intro.
2. Create organization (name, slug, region, plan) — you become its admin.
3. Add people afterwards in Settings → Members (there are no invitations).
4. Connect backing tools (multi-select of every BACKING_TOOLS entry).
5. Pick a starter project (blank / monorepo / microservices / ML platform).

Users can re-run it from the Help menu at any time — it's idempotent.

## Transparency conventions

- **Pricing on `/settings → Plan`** lists every tier with features, not just
  the user's current one.
- **Usage & quotas** shows the current consumption and the quota side-by-side.
  Every metric is derived from Prometheus — the queries are public.
- **Audit log** is visible to every org admin (not just platform admins) and
  retained for 365 days on Business plans.
- **Integrations** page shows real versions + source URLs via
  `@adhar/platform-info`.

## Extension

Adding a new admin surface:

1. New view file under `modules/workspace/src/views/<section>.tsx`.
2. Add to the `GROUPS` array in `modules/workspace/src/home.tsx`.
3. Add the data hook to `modules/workspace/src/data/client.ts`.
4. Add a BFF endpoint in `apps/console/app/server/workspace/handlers.ts` if
   the data lives server-side, gated by a `CONSOLE_PERMISSIONS` entry.
