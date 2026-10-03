import type { gitea } from '@adhar-console/api-clients';

/**
 * How a repository list is qualified and sectioned.
 *
 * JSX-free on purpose: the repo's Deno test runner has no React in its import
 * map, so anything reachable from a `.tsx` cannot be unit-tested. Same reason
 * `nav-ownership.ts` sits beside `nav-item.tsx`.
 */

/**
 * The owner a repository belongs to — the `adhar` in `adhar/packages`.
 *
 * Gitea gives both `owner.login` and `full_name`; the latter is always present
 * and always qualified, so it is the fallback when a listing omits the owner
 * object, which the search endpoints do.
 */
export function repoOwner(r: gitea.Repo): string {
  return r.owner?.login || r.full_name?.split('/')[0] || '';
}

/**
 * Split a sorted list into one section per owner.
 *
 * Returns a single unnamed section while every repository has the same owner,
 * which is the common case on a one-org install — a heading over the whole
 * list is furniture. The sections appear exactly when they start carrying
 * information: as soon as a second owner exists, whether that is another
 * team's org or a fork pulled in from elsewhere.
 *
 * Order follows the list's own sort rather than the alphabet, so whatever the
 * operator sorted by still decides which section comes first.
 */
export function groupByOwner(
  list: gitea.Repo[],
): Array<{ owner: string; repos: gitea.Repo[] }> {
  const owners = new Set(list.map(repoOwner));
  if (owners.size < 2) return [{ owner: '', repos: list }];
  const out: Array<{ owner: string; repos: gitea.Repo[] }> = [];
  const index = new Map<string, number>();
  for (const r of list) {
    const owner = repoOwner(r);
    const at = index.get(owner);
    if (at === undefined) {
      index.set(owner, out.length);
      out.push({ owner, repos: [r] });
    } else out[at].repos.push(r);
  }
  return out;
}
