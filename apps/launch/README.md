# apps/launch

The public **Adhar Cloud launch site**: a "coming soon" page with a 3D
model of the platform under construction and early-access registration,
plus a maintenance page. A plain Vite + React SPA on the console's design
foundation — no Module Federation, no auth, no cluster access.

## Run

```bash
pnpm run launch:dev        # from repo root: Vite on :5200 + registration API on :5199
# or, from this directory
deno task dev              # Vite only (proxies /api → :5199)
deno task dev:server       # the registration API, with --watch
```

Production:

```bash
deno task build            # → dist/
PORT=3100 LAUNCH_INTEREST_FILE=/var/lib/adhar/interest.jsonl deno task serve
```

## Routes

| Path           | What                                                                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`            | Launch page — one full-viewport 3D animation of the software supply chain: a paved golden path across a white deck through source → build → scan & sign → promote → deploy → observe, with a feedback path and real shadows, the message and the early-access card over it, and a stage strip that follows the lead packet |
| `/maintenance` | Maintenance page — 3D "in service" scene, countdown, step timeline, notify-me form. `?until=<ISO>` overrides the expected end without a rebuild                                                                                                                                                                            |

Anything else redirects to `/`.

## API (server.ts)

| Method | Path                  | Notes                                                                                                                                                                                    |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/interest`       | `{ email, name?, company?, role?, building?, source }` → `{ position, alreadyRegistered }`. 400 with `{ errors: [{ field, message }] }` on bad input. Honeypot `website` → 200, dropped. |
| GET    | `/api/interest/count` | `{ count }`                                                                                                                                                                              |
| GET    | `/healthz`            | liveness                                                                                                                                                                                 |

Registrations are appended to a JSONL file (`LAUNCH_INTEREST_FILE`, default
`./data/interest.jsonl`), de-duplicated by email, with a 1-based queue
position. Mount a persistent volume there in production.

## Content

Everything the site says lives in `app/data/launch-content.ts`: the six
supply-chain stages (name, tool, one-line detail, position along the track,
colour), the promotion gates, the maintenance window and links. The 3D scene
and the stage strip both read from it, so renaming a tool there changes the
label in the model and the chip under it.

Maintenance window defaults can be overridden at build time with
`VITE_MAINT_STARTED` / `VITE_MAINT_UNTIL` (ISO timestamps).

## Design foundation

- `app/styles.css` imports the console's stylesheet, so brand/surface/
  content/edge tokens, dark mode, elevation and typography are identical.
- shell-ui pieces are imported by subpath (`@adhar/shell-ui/button`,
  `/primitives`, `/brand`, `/toast`, `/theme`, `/mode-toggle`) — the barrel
  would pull the AI assistant and the k8s clients into a marketing page.
- `@adhar-ui/*` is aliased exactly as in the console host config.
- Colour mode follows the shared `adhar-theme` cookie, so a dark console
  visitor lands on a dark launch page.

## 3D

`three` + `@react-three/fiber` + `@react-three/drei`, lazy-loaded in their
own chunk so the first paint never waits on the renderer. No WebGL → a
static SVG fallback; a renderer crash → the same fallback via an error
boundary; `prefers-reduced-motion` → the scene stops idling. Labels are DOM
(`<Html>`) so they use the app's font and tokens.
