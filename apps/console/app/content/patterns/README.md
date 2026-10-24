# Writing an architecture pattern

Every `.md` file in this folder (except this README) becomes a card under
**Help → Architecture patterns**. No code changes: add or edit a file, and the
next build publishes it. `deno test` fails with a clear message if a file is
malformed.

## 1. Name the file

The file name is the URL: `zero-downtime-deploys.md` opens at
`/help?pattern=zero-downtime-deploys`. Use kebab-case and keep it stable —
people will share links to it.

## 2. Front matter

```markdown
---
title: Zero-downtime deploys
category: Resilience
summary: Ship every change without dropping a request.
tools: [Argo Rollouts, Kubernetes, Cilium]
order: 10
---
```

| Key | Required | What it is |
| --- | --- | --- |
| `title` | yes | Card and reader heading. Short, noun-first. |
| `category` | yes | One of `Platform engineering`, `Scale`, `Resilience`, `Delivery`, `Data`, `Security`, `Tenancy`, `Operations`, `AI & MCP`. |
| `summary` | yes | One sentence on the card. Say the outcome, not the mechanism. |
| `tools` | no | Platform components it uses — shown as chips, searchable. |
| `order` | no | Position inside its category (lower first; default 100). |

## 3. Body — four short sections

Keep the whole doc to one screen (roughly 150–300 words). Use these headings
so every pattern reads the same way:

```markdown
## Why
The problem in two or three sentences. What breaks without it?

## How Adhar does it
The platform's actual mechanism — name the component, the claim kind or the
console page. Concrete beats generic.

## Use it
A minimal snippet (YAML, command) or the exact steps in the console.

## Watch out
Two to four bullets: the trade-offs and the mistakes people make.
```

Supported Markdown: headings, paragraphs, **bold**, *italic*, `code`,
fenced code blocks, bullet and numbered lists, tables, quotes and links.

## Style

- Write for an engineer with five minutes. Lead with the point.
- Only describe what Adhar actually ships. If something is optional or needs
  enabling, say so.
- Prefer "do X" over "you might consider X".
- Link console pages with relative paths, e.g. `[Rollouts](/deliver?section=rollouts)`.
