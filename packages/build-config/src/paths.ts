import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Find the adhar-ui checkout. Priority:
 *   1. `ADHAR_UI_PATH` env var (absolute or relative to CWD).
 *   2. Walk up from `start` looking for `pnpm-workspace.yaml` (the console
 *      workspace root), then try `<root>/../adhar-ui` first and
 *      `<root>/../../Adhar/AdharWS/adhar-ui` second.
 *
 * Throws a clear error if none of the candidates exist — better than letting
 * Vite fail later with a confusing "cannot resolve '@adhar-ui/react'".
 */
export function resolveAdharUiPath(start: string): string {
  if (process.env.ADHAR_UI_PATH) {
    const p = resolve(process.env.ADHAR_UI_PATH)
    if (!existsSync(p)) {
      throw new Error(
        `ADHAR_UI_PATH=${process.env.ADHAR_UI_PATH} but ${p} does not exist`,
      )
    }
    return p
  }

  const consoleRoot = findWorkspaceRoot(start)
  const candidates = [
    resolve(consoleRoot, '..', 'adhar-ui'),
    resolve(consoleRoot, '..', '..', '..', 'Adhar', 'AdharWS', 'adhar-ui'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'packages', 'react', 'src', 'index.ts'))) return c
  }

  throw new Error(
    'Could not locate the adhar-ui checkout. Set ADHAR_UI_PATH to its absolute path.\n' +
      `Tried:\n  ${candidates.join('\n  ')}`,
  )
}

export function findWorkspaceRoot(start: string): string {
  let dir = start
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = dirname(dir)
  }
  throw new Error(`Could not find pnpm-workspace.yaml walking up from ${start}`)
}

/**
 * Build a Vite `resolve.alias` map for every `@adhar-console/*` workspace
 * package. Deno's `nodeModulesDir: auto` does not create symlinks under
 * `node_modules/@adhar-console/*`, so Vite can't find them via Node module
 * resolution — we have to point the resolver at the source files directly.
 *
 * Specific subpaths (`/workspace`, `/gitea`, …) must be listed **before** the
 * root alias so Vite matches them first.
 */
export function consoleAliases(workspaceRoot: string): Record<string, string> {
  const p = (sub: string) => resolve(workspaceRoot, sub)
  return {
    // Subpaths first — prefix-match order matters.
    '@adhar-console/api-clients/workspace': p('packages/api-clients/src/workspace/index.ts'),
    '@adhar-console/api-clients/gitea': p('packages/api-clients/src/gitea/index.ts'),
    '@adhar-console/api-clients/plane': p('packages/api-clients/src/plane/index.ts'),
    '@adhar-console/api-clients/argocd': p('packages/api-clients/src/argocd/index.ts'),
    '@adhar-console/api-clients/kargo': p('packages/api-clients/src/kargo/index.ts'),
    '@adhar-console/api-clients/harbor': p('packages/api-clients/src/harbor/index.ts'),
    '@adhar-console/api-clients/k8s': p('packages/api-clients/src/k8s/index.ts'),
    '@adhar-console/api-clients/kyverno': p('packages/api-clients/src/kyverno/index.ts'),
    '@adhar-console/api-clients/crossplane': p('packages/api-clients/src/crossplane/index.ts'),
    '@adhar-console/api-clients/argo-workflows': p('packages/api-clients/src/argo-workflows/index.ts'),
    '@adhar-console/api-clients/argo-rollouts': p('packages/api-clients/src/argo-rollouts/index.ts'),
    '@adhar-console/api-clients/lgtm': p('packages/api-clients/src/lgtm/index.ts'),
    '@adhar-console/api-clients/base': p('packages/api-clients/src/base/index.ts'),
    // Roots last.
    '@adhar-console/api-clients': p('packages/api-clients/src/index.ts'),
    '@adhar-console/utils': p('packages/utils/src/index.ts'),
    // Auth subpath before the root.
    '@adhar-console/auth/server': p('packages/auth/src/server-index.ts'),
    '@adhar-console/auth': p('packages/auth/src/index.ts'),
    '@adhar-console/db': p('packages/db/src/index.ts'),
    '@adhar-console/tenancy': p('packages/tenancy/src/index.ts'),
    '@adhar-console/shell-ui': p('packages/shell-ui/src/index.ts'),
    '@adhar-console/mf-utils': p('packages/mf-utils/src/index.ts'),
    '@adhar-console/platform-info': p('packages/platform-info/src/index.ts'),
  }
}
