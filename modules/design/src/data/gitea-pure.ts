/** Pure Gitea helpers (tested in `gitea_test.ts`). */

/**
 * Git's blob id for a text file (`sha1("blob <len>\0" + bytes)`) — the same
 * value Gitea reports as a file's `sha`, so a sync can tell whether the copy
 * in the repo is still the one the console wrote.
 */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content)
  const head = new TextEncoder().encode(`blob ${body.length}\0`)
  const all = new Uint8Array(head.length + body.length)
  all.set(head)
  all.set(body, head.length)
  const digest = await crypto.subtle.digest('SHA-1', all)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A branch name for a console-opened pull request: `design/<slug>-<stamp>`. */
export function prBranchName(slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change'
  return `design/${s}-${Date.now().toString(36)}`
}
