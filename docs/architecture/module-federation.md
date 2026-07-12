# Module Federation

Each phase is a federated **remote**; the host app is the **host**. Built with
`@module-federation/vite`.

## Why MF?

- **Independent deploys** — a team owning `deliver` can ship a new remote
  without rebuilding the host.
- **Code-split at the phase boundary** — the host bundle stays tiny.
- **Shared React singleton** — no two Reacts, no duplicated Query client.

We evaluated: monorepo workspaces with lazy routes, iframes, Webpack 5
federation on Rspack. Vite + official plugin won on DX and SSR compatibility.

## Where the config lives

Both the host and every remote use small factories from
[`packages/build-config/`](../../packages/build-config) so dev/prod URLs,
bases, adhar-ui resolution, and shared-deps config stay in exactly one
place.

`apps/console/vite.config.ts` is literally:

```ts
import { defineHostConfig } from '@adhar-console/build-config/host'
export default defineHostConfig({ appDir: import.meta.dirname! })
```

And each module's `vite.config.ts`:

```ts
import { defineRemoteConfig } from '@adhar-console/build-config/remote'

export default defineRemoteConfig({
  name: 'platform',
  port: 5107,
  moduleDir: import.meta.dirname!,
  exposes: {
    './Home': './src/home.tsx',
    // …
  },
})
```

The full remote list lives in `packages/build-config/src/registry.ts` and
is shared by the host factory, the dev runner (`scripts/dev.ts`), and the
build runner (`scripts/build.ts`).

## What the host factory does

Roughly:

```ts
federation({
  name: 'adhar_console_host',
  remotes: Object.fromEntries(REMOTES.map((r) => [
    r.name,
    { type: 'module', name: r.name, entry: isBuild
        ? `/mf/${r.name}/remoteEntry.js`
        : `http://localhost:${r.port}/mf/remoteEntry.js` },
  ])),
  shared: {
    react: { singleton: true, requiredVersion: '^19.2.0' },
    'react-dom': { singleton: true, requiredVersion: '^19.2.0' },
    '@tanstack/react-router': { singleton: true },
    '@tanstack/react-query': { singleton: true },
  },
})
```

- `singleton: true` is critical — two copies of React break hooks in the
  remote.
- `requiredVersion` is enforced at load time; a remote built against the
  wrong React major refuses to load and surfaces in the error boundary.

## Remote config

Each remote's `vite.config.ts` (e.g. `modules/deliver/`):

```ts
federation({
  name: 'deliver',
  filename: 'remoteEntry.js',
  exposes: {
    './Home': './src/home.tsx',
    './ArgoApps': './src/views/argo-apps.tsx',
    './KargoStages': './src/views/kargo-stages.tsx',
    // ...
  },
  shared: { react: { singleton: true }, ... },
})
```

- `base: '/mf/'` in the Vite config so the remote's assets end up at that
  prefix — the host serves `/mf/deliver/...` statically.
- Every exposed entry has a `./<Something>` path; consumed from the host with
  `import('deliver/Something')`.

## How the host loads a remote

`modules/mf-utils` gives you a `RemoteModule` component that wraps the
dynamic import with `React.lazy`, `Suspense`, and an error boundary:

```tsx
<RemoteModule loader={() => import('deliver/Home')} />
```

Static `import(...)` calls are transformed by the plugin into federation-aware
loaders. Dynamic variable-driven imports defeat the transform, so the host's
phase route uses an explicit `switch` to pick the loader by phase id.

## SSR and hydration

**v1 design: client-side only.** Remotes are never evaluated on the server.
The host SSRs the shell + a skeleton; on hydration, the browser resolves the
remote entry, fetches the chunk, and renders the real component.

Why:

- The MF plugin's server runtime is still maturing.
- SSR'ing a remote requires the server to trust, fetch, and execute code from
  the remote's origin — a security concern for multi-vendor setups.
- Shell SSR is enough for good LCP; the remote loads within the shell's
  `<Suspense>` fallback.

## Dev vs prod URLs

| Mode | Host URL                      | Remote URL                                                |
| ---- | ----------------------------- | --------------------------------------------------------- |
| Dev  | `http://localhost:5100`       | `http://localhost:510X/mf/remoteEntry.js`                 |
| Prod | `https://console.adhar.local` | `https://console.adhar.local/mf/<remote>/remoteEntry.js`  |

Two things have to line up for this to work, and both are handled by the
factories in `packages/build-config/`:

1. **Each remote's Vite `base`** switches between dev and build:
   - `serve` → `base: '/mf/'` so the dev server at port 510X exposes
     `/mf/remoteEntry.js` and its chunks under `/mf/assets/*`.
   - `build` → `base: '/mf/<name>/'` so asset URLs emitted inside
     `remoteEntry.js` resolve correctly when served from the host's origin
     at `/mf/<name>/*`. Getting this wrong is a silent footgun — the
     `remoteEntry.js` loads fine but its chunks 404 with "Unexpected token
     '<'" errors.
2. **The host's `federation({ remotes })`** uses a full dev URL (pointing at
   each remote's dev server) in `serve` and a relative path
   (`/mf/<name>/remoteEntry.js`) in `build`. Same branch.

In production, `scripts/build.ts` copies each remote's `dist/` into
`apps/console/.output/public/mf/<name>/` so a single container serves host
+ every remote from one origin — no CORS, no cross-origin trust, no
separate CDN.

## Gotchas

- **Auto-install peer deps** (`.npmrc`) because pnpm's strict peer behavior
  conflicts with MF shared declarations.
- **Tailwind `@source`** — the host's CSS must declare every place that
  generates classes, including each remote source dir, so the purged CSS
  includes everything the UI needs.
- **Network isolation during dev** — if a remote is down, the host shows
  the fallback + error boundary; it does not crash. Check the remote's port.

## Swapping in a different MF backend

`@module-federation/vite` is actively maintained. If you ever need to move
to `originjs/vite-plugin-federation` or a Rspack-based setup, the code that
needs to change is confined to:

1. The host's `vite.config.ts` `federation(...)` block.
2. Each remote's `vite.config.ts` `federation(...)` block.
3. The `ambient.d.ts` `declare module 'deliver/Home'` equivalents (added
   lazily; v1 casts at the call site).

Module consumption code (`import('deliver/Home')`) is identical across all
MF implementations.
