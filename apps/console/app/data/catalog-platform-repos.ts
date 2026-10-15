/**
 * Gitea repositories that are platform infrastructure, not the org's software.
 *
 * Every repo in the org otherwise becomes a catalog Component, and the platform
 * keeps its own repos in that same org — so creating ONE service made six appear:
 * `packages` and `environments` are the GitOps repos bootstrap seeds,
 * `adhar-templates` is the golden-path collection the Create New page reads,
 * `adhar-ui` / `adhar-kit` are the shared libraries mirrored from GitHub, and
 * `adhar` is the platform's OWN source, mirrored for the AI knowledge base
 * (docs/ and cmd/ live nowhere else in-cluster). None of them is a service
 * anybody created — and on 2026-10-15 "adhar" sat in the catalog as a Component
 * because this list did not name it.
 *
 * Names are not the whole rule: any Gitea PULL MIRROR is upstream code the
 * platform fetched, never something a team scaffolded here, so `repo.mirror`
 * excludes a repo regardless of its name. The name list stays for the two seeded
 * (non-mirror) GitOps repos and for callers that only have a name.
 *
 * This is deliberately the same set the supply-chain pipeline excludes from
 * app-ci (see `packages/application/adhar-supply-chain/manifests/70-app-ci.yaml`,
 * whose CEL interceptor skips exactly these names) and for the same reason: a
 * push to one of them is platform traffic, not an application. The k8s side of
 * this hook has always filtered its equivalent (`SYSTEM_NAMESPACES`); the Gitea
 * side simply never had the counterpart.
 */
export const PLATFORM_REPOS = new Set([
  'packages',
  'environments',
  'templates',
  'adhar-templates',
  'adhar-ui',
  'adhar-kit',
  'adhar',
])

/** True for a platform repo that should not surface as a catalog service. */
export function isPlatformRepo(name: string | undefined, repo?: { mirror?: boolean }): boolean {
  if (repo?.mirror) return true
  return PLATFORM_REPOS.has((name ?? '').toLowerCase())
}
