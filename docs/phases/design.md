# Phase · Design

ADRs, design tokens, architecture diagrams, the visual page builder, component
catalog.

- **Primary backers:** adhar-ui builder (`adhar-ui/apps/builder`), Mermaid
  (diagrams-as-code), Storybook (catalog), Gitea (ADR storage).
- **Module:** `modules/design` → exposes `./Home`.
- **Port in dev:** 5102.

## Views

| Tab               | What it does                                                |
| ----------------- | ----------------------------------------------------------- |
| Visual Builder    | Embeds adhar-ui's builder app (Monaco + Yjs collab)         |
| ADRs              | List of Architecture Decision Records (accepted, proposed…) |
| Design Tokens     | Color / spacing / typography browser over `@adhar-ui/tokens`|
| Diagrams          | Curated Mermaid diagrams (topology, flows, pipelines)       |
| Component Catalog | Embeds adhar-ui's Storybook                                  |

## Integration notes

- **Visual Builder** is an iframe in v1. Graduates to a federated remote
  once the builder app exposes a `remoteEntry` — that change also lets it
  share the host's session and avoid a second sign-in.
- **ADRs** are expected at `acme/docs/adrs/*.md` in Gitea. The Gitea client
  will list + render them directly (v0.3.x).
- **Design Tokens** read `@adhar-ui/tokens` CSS variables at runtime; the
  table is populated live from the cascade.
- **Diagrams** are Mermaid source-only in v1; real rendering comes from the
  same Mermaid that powers the builder.

## Who uses it

Engineers drafting design decisions, UX designers browsing component
coverage, platform team reviewing canonical diagrams.
