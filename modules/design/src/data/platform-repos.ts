/**
 * Gitea repositories that are the platform's own, not the organisation's
 * software (pure, tested) — the host's list (`catalog-platform-repos.ts`),
 * which is in turn the set the supply chain's app-ci trigger skips by name
 * (`adhar-supply-chain` 70-app-ci.yaml). `packages` / `environments` are the
 * GitOps repos bootstrap seeds, `adhar-templates` the golden paths, `adhar-ui`
 * / `adhar-kit` the shared libraries copied from GitHub, `adhar` the platform's
 * own source. Only a name says what they are — the library copies are
 * force-pushed, not Gitea mirrors, and carry no topic or description — but any
 * Gitea PULL mirror is upstream code too, whatever it is called.
 *
 * Its own module so a page that only needs this check (the Visual Designer's
 * library) does not pull in the whole platform model.
 */
export const PLATFORM_REPOS = new Set(['packages', 'environments', 'templates', 'adhar-templates', 'adhar-ui', 'adhar-kit', 'adhar'])

export function isPlatformRepo(r: { name?: string; mirror?: boolean }): boolean {
  return !!r.mirror || PLATFORM_REPOS.has((r.name ?? '').toLowerCase())
}
