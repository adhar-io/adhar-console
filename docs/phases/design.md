# Phase · Design

ADRs, design tokens, architecture diagrams, the visual page builder, component
catalog.

- **Primary backers:** the Adhar Builder (`packages/builder`, `@adhar/builder`),
  Mermaid (diagrams-as-code), Storybook (catalog), Gitea (ADR storage).
- **Module:** `modules/design` → exposes `./Home`.
- **Port in dev:** 5102.

## Views

| Tab               | What it does                                                |
| ----------------- | ----------------------------------------------------------- |
| Visual Builder    | `@adhar/builder` in visual mode (canvas, themes, Adhar AI)  |
| ADRs              | List of Architecture Decision Records (accepted, proposed…) |
| Design Tokens     | Color / spacing / typography browser over `@adhar-ui/tokens`|
| Diagrams          | Curated Mermaid diagrams (topology, flows, pipelines)       |
| Component Catalog | Embeds adhar-ui's Storybook                                  |

## Integration notes

- **Visual Designer** is the first-party `@adhar/builder` package, imported
  directly by Design (also used to edit wireframes). Develop's Code Builder was
  retired in its favour; `/develop?section=codebuilder` redirects here. No remote
  and no external URL: the workbench, Monaco, Mermaid and React Flow are lazy
  chunks of the Design module. Projects persist in the console document store
  (`builder.project/<id>`); wireframes keep their project on the wireframe
  document. A project can be committed to Gitea in one commit and reopened from
  `.adhar/builder.json`. Generation uses Adhar AI when it is configured, else an
  offline template generator.
- **ADRs** are expected at `acme/docs/adrs/*.md` in Gitea. The Gitea client
  will list + render them directly (v0.3.x).
- **Design Tokens** read `@adhar-ui/tokens` CSS variables at runtime; the
  table is populated live from the cascade.
- **Diagrams** are Mermaid source-only in v1; real rendering comes from the
  same Mermaid that powers the builder.

## Who uses it

Engineers drafting design decisions, UX designers browsing component
coverage, platform team reviewing canonical diagrams.
