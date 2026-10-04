/**
 * Naming an Argo CD Application's source so a card can show it.
 *
 * A card had the raw `repoURL`, which on this platform is an in-cluster
 * service address: `http://gitea-http.adhar-system.svc.cluster.local:3000/
 * adhar/manifests`. In a card-width box that truncates to
 * `gitea-http.adhar-system.svc.cluster.local:3000/a…` — forty characters of
 * identical boilerplate on every card, and the one part that differs cut off.
 *
 * The repository is what the reader is identifying, so that is what the card
 * shows; the full URL stays on hover.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */
export function shortRepo(url: string): string {
  const raw = (url ?? '').trim()
  if (!raw) return '—'

  let s = raw.replace(/\/+$/, '').replace(/\.git$/i, '')
  // `git@host:org/repo` — scp-style, where the colon is a separator and not a
  // port, so it cannot be parsed as a URL.
  const scp = /^[^/@\s]+@([^/:]+):(.+)$/.exec(s)
  if (scp) s = `${scp[1]}/${scp[2]}`
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')

  const parts = s.split('?')[0].split('#')[0].split('/').filter(Boolean)
  if (parts.length === 0) return '—'
  // A host on its own is all there is to say; otherwise the last two segments
  // are the owner and the repository.
  return parts.slice(-2).join('/')
}

/**
 * What the Application takes out of that repository: a chart, or a path, at a
 * revision. `HEAD` is Argo CD's own default when `targetRevision` is unset.
 */
export function sourceRef(
  source: { chart?: string; path?: string; targetRevision?: string },
): string {
  const what = source.chart ? `chart ${source.chart}` : source.path || '/'
  return `${what} @ ${source.targetRevision || 'HEAD'}`
}
