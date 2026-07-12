# apps/console

The TanStack Start host — SSR + BFF + Module Federation host all in one
Deno process.

## Run

```bash
deno task dev      # from this directory
# or
pnpm run console:dev    # from repo root
# or
turbo run dev      # host + every module
```

Host port: **5100**.

## What lives where

```
apps/console/
├── deno.json            # deno tasks + npm: imports for React, TanStack, MF, Tailwind
├── package.json         # pnpm metadata (scripts mirror deno tasks)
├── vite.config.ts       # MF host config + Tailwind + TanStack Start plugin
├── app.config.ts        # shim for TanStack Start versions that still read this
├── tsconfig.json        # extends packages/tsconfig/react-app.json
└── app/
    ├── client.tsx       # hydrateRoot entry
    ├── ssr.tsx          # SSR handler
    ├── router.tsx       # TanStack Router + QueryClient
    ├── routeTree.gen.ts # placeholder (router-plugin rewrites at build time)
    ├── styles.css       # Tailwind v4 @import + adhar-ui tokens
    ├── routes/
    │   ├── __root.tsx       # root layout (html/head/body)
    │   ├── index.tsx        # /
    │   ├── login.tsx        # /login (stub)
    │   ├── $phase.tsx       # /$phase layout (phase-aware chrome)
    │   ├── $phase/index.tsx # /$phase landing — loads the MF remote
    │   ├── onboarding.tsx   # /onboarding wizard
    │   ├── settings.tsx     # /settings — loads workspace remote
    │   ├── profile.tsx      # /profile — PATs, sessions, notifications
    │   ├── status.tsx       # /status — platform transparency page
    │   ├── changelog.tsx    # /changelog
    │   └── help.tsx         # /help
    └── server/
        ├── session.ts       # getLayoutData server fn (user + tenants)
        └── bff.ts           # all BFF endpoints (createServerFn)
```

## Key rules

- **No imports from `modules/*`.** The host discovers remotes at runtime
  via Module Federation; compile-time coupling defeats the point.
- **Every data call is a server function.** No browser-side `fetch` to
  backing tools.
- **Tenant from session.** Server functions must resolve tenant from the
  session cookie; never from request input.
- **Stub by default.** `app/server/bff.ts` initializes every client with
  `.stub()`; swap individually to `.create({ baseUrl, token })` as real
  services come online.

## Environment variables

See `../../.env.example`. The important ones:

- `ADHAR_UI_PATH` — path to the sibling `adhar-ui` checkout (dev only).
- `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`.
- Each backing tool's URL + token.
- `K8S_IN_CLUSTER=true` for production pods.

See [../../docs/architecture/bff.md](../../docs/architecture/bff.md) for the
BFF pattern and [../../docs/architecture/module-federation.md](../../docs/architecture/module-federation.md)
for the host MF config.
