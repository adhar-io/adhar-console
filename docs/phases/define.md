# Phase · Define

Requirements, epics, agile issues, roadmap, OKRs.

- **Primary backer:** [Plane.so](https://plane.so) (self-hosted, AGPL-3.0).
- **Module:** `modules/define` → exposes `./Home`.
- **Port in dev:** 5101.

## Views

| Tab        | What it shows                                                      |
| ---------- | ------------------------------------------------------------------ |
| Projects   | All Plane projects in the active workspace                         |
| Issues     | Open issues with state + priority badges                           |
| Roadmap    | Per-quarter swimlanes; items tagged planned / active / shipped     |
| OKRs       | Objectives + key results with progress bars                        |

## Data sources

- `@adhar-console/api-clients/plane` — list projects, list issues.
- Roadmap and OKRs are currently rendered from in-module fixtures; they
  graduate to Plane cycles + custom fields in v0.3.x.

## Deep linking

When an issue references a Git repo, the issue card links into **Develop →
PRs** filtered by the Plane reference label. Similarly, OKR progress can
pull deploy counts from the Discover BFF; not wired in v1.

## Extending

- Add a "planned releases" tab by reading Plane cycles.
- Add team dashboards by cross-referencing Plane assignees with Workspace
  teams.
