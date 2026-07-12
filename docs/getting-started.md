# Getting started

A first-time walkthrough — from clone to running a local stack, then swapping
stubs for real backends.

## 1. Prerequisites

| Tool   | Version  | Why                                                      |
| ------ | -------- | -------------------------------------------------------- |
| Deno   | ≥ 2.0    | Runtime for the host, remotes, and every package task    |
| pnpm   | ≥ 10     | Workspace manager; shared node_modules resolution        |
| Node   | ≥ 20     | Some pnpm/Turbo primitives still expect it               |
| Docker | optional | Only needed to build / run the container                 |

You also need a checkout of [`adhar-ui`](https://github.com/adhar-io/adhar-ui)
somewhere on disk — the console consumes `@adhar-ui/*` via Vite aliases, not
via a published npm package.

## 2. Clone

```bash
mkdir -p ~/Work/AdharWS
cd ~/Work/AdharWS
git clone https://github.com/adhar-io/adhar-ui
git clone https://github.com/adhar-io/adhar-console
cd adhar-console
cp .env.example .env   # defaults are fine for local dev
```

If your `adhar-ui` checkout is not a sibling directory, set `ADHAR_UI_PATH`:

```bash
export ADHAR_UI_PATH=/absolute/path/to/adhar-ui
```

## 3. Install & run

```bash
pnpm install
pnpm dev                  # same as: deno task dev
```

You should see the host at **http://localhost:5100** and each remote at
**5101–5108**, with colored prefixed output per process:

| Port | Module          |
| ---- | --------------- |
| 5100 | console (host)  |
| 5101 | define          |
| 5102 | design          |
| 5103 | develop         |
| 5104 | deliver         |
| 5105 | discover        |
| 5106 | decide          |
| 5107 | platform        |
| 5108 | workspace       |

Ctrl+C cleanly SIGTERMs every child.

### Scope to a subset

`scripts/dev.ts` accepts process names:

```bash
deno task dev console develop platform
# → only host + develop + platform remotes
```

Names match the folder basename.

### Host-only

`pnpm run console:dev` starts just the host. Phase pages render the
"loading module…" fallback until their remote comes up — useful when
you're only working on shell-level code.

### Alternative: Turborepo

If you'd rather use Turbo's graph and cache for dev:

```bash
pnpm run dev:turbo
```

Build and test still go through Turbo by default — see `package.json`.

## 4. First screen

With all stubs active:

1. The root `/` lands on the phase grid.
2. Click **Develop** → Repositories list pulls from `gitea.GiteaClient.stub()`.
3. Click **Platform** → Clusters tab renders from `k8s.K8sClient.stub()`.
4. Click the avatar in the topbar → **Organization settings** opens the
   Workspace federated remote.
5. Visit `/onboarding` to see the wizard. `/status` shows real versions of
   every backing OSS tool; `/changelog` is the public changelog.

## 5. Swap a stub for a real backend

Pick a tool to wire up first — Gitea is the smallest. In
`apps/console/app/server/bff.ts`:

```ts
const clients = {
  // before
  gitea: gitea.GiteaClient.stub(),
  // after
  gitea: gitea.GiteaClient.create({
    baseUrl: env('GITEA_URL')!,
    token: env('GITEA_TOKEN'),
  }),
  ...
}
```

Put real values in `.env` (for dev) or `deploy/k8s/configmap.yaml` + Secret
(for prod). The BFF picks them up; the views don't change.

Order I'd recommend:

1. **Gitea** — smallest surface, easy token, makes the Develop phase real.
2. **Keycloak** — replace the stub session (see
   [docs/architecture/auth.md](./architecture/auth.md)).
3. **Kubernetes** — the Platform view gets real data the moment you point at
   an in-cluster SA or a kubeconfig.
4. **ArgoCD / Kargo / Harbor / Kyverno** — one per PR, same pattern.
5. **LGTM** — Grafana dashboard IDs are the main config here.
6. **Plane.so / Argo Workflows / Rollouts** — lowest priority; stubs are fine
   for most demos.

## 6. Build & deploy

```bash
# Build container (expects adhar-ui sibling; see deploy/Dockerfile).
docker build \
  -t harbor.adhar.local/adhar/console:$(git rev-parse --short HEAD) \
  -f deploy/Dockerfile \
  .

kubectl apply -k deploy/k8s
```

See [`docs/architecture/deploy.md`](./architecture/deploy.md) for production
concerns: image pull secrets, SSO trust, multi-cluster config, RBAC tightening.

## 7. Troubleshooting

- **"Cannot resolve `@adhar-ui/react`"** — `ADHAR_UI_PATH` is wrong or the
  sibling clone is missing.
- **"Module 'define/Home' not found"** — the `define` remote isn't running;
  `turbo run dev` should spin it up, or `cd modules/define && deno task dev`.
- **"Hydration mismatch on federated route"** — SSR tried to evaluate a
  remote import; wrap it in a client-only boundary (see
  [module federation doc](./architecture/module-federation.md#ssr-and-hydration)).
- **401 from the BFF** — the stub session cookie expired; hit `/login`.
