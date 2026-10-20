/** Pure matching for the Development panel (tested in work-dev_test.ts). */

/** True when `text` mentions `key` as a whole token (CON-4 ≠ CON-42, case-insensitive). */
export function mentionsKey(text: string | null | undefined, key: string): boolean {
  if (!text || !key) return false
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${k}(?![0-9])`, 'i').test(text)
}

/** `https://gitea.x/org/repo(.git)` or `git@gitea.x:org/repo.git` → `{owner, repo}`. */
export function repoFromUrl(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) return undefined
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() } : undefined
}
