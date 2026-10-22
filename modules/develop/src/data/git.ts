import { useCallback, useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gitea } from '@adhar/api-clients';
import { toPublicUrl, useGiteaOrg, usePublicBaseDomain, useToolPublicUrl } from '@adhar/shell-ui';

/**
 * Gitea hooks for the Develop module.
 *
 * The Gitea org is a per-install identifier served by the BFF at `/api/config`
 * and read through `useGiteaOrg()` (real default `adhar`) — never hardcoded.
 * Each hook resolves the org locally and threads it through both its
 * `queryKey` and `queryFn`, so every Develop view queries the real org.
 */

export const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' });

const REFRESH_MS = 30_000;

/* ─────────── selection ─────────── */

const REPO_KEY = 'adhar.develop.activeRepo';
const BRANCH_KEY = 'adhar.develop.activeBranch';

// Storage access throws (SecurityError) when site data is blocked, and these
// run during render — a remembered selection is a nicety, never a crash.
function readStore(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeStore(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch { /* storage unavailable — the choice just does not persist */ }
}

export function getStoredRepo(): string | undefined {
  return readStore(REPO_KEY);
}
export function setStoredRepo(name: string) {
  writeStore(REPO_KEY, name);
}
export function getStoredBranch(repo: string): string | undefined {
  return readStore(`${BRANCH_KEY}:${repo}`);
}
export function setStoredBranch(repo: string, branch: string) {
  writeStore(`${BRANCH_KEY}:${repo}`, branch);
}

/* ─────────── public URLs ─────────── */

/**
 * Gitea builds `html_url` / `clone_url` from the request host. The BFF talks
 * to it over the in-cluster service DNS, so every self-reported link points
 * at `gitea-http.<ns>.svc.cluster.local` — unusable in a browser. Swap the
 * origin for the tool's public URL (`/api/config.tools.gitea`) or
 * `gitea.<publicBaseDomain>`; already-public URLs pass through untouched.
 */
export function usePublicGiteaUrl(): (raw: string | undefined) => string | undefined {
  const toolUrl = useToolPublicUrl('gitea');
  const baseDomain = usePublicBaseDomain();
  return useCallback(
    (raw) => (raw ? toPublicUrl(raw, { toolUrl, tool: 'gitea', baseDomain }) : raw),
    [toolUrl, baseDomain],
  );
}

function usePublicRepo() {
  const pub = usePublicGiteaUrl();
  return useCallback(
    (r: gitea.Repo): gitea.Repo => ({ ...r, html_url: pub(r.html_url)!, clone_url: pub(r.clone_url) }),
    [pub],
  );
}

/* ─────────── queries ─────────── */

export function useRepos() {
  const org = useGiteaOrg();
  const publicise = usePublicRepo();
  return useQuery({
    queryKey: ['gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    select: useCallback((list: gitea.Repo[]) => list.map(publicise), [publicise]),
    staleTime: REFRESH_MS,
  });
}

export function useRepo(repo?: string) {
  const org = useGiteaOrg();
  const publicise = usePublicRepo();
  return useQuery({
    queryKey: ['gitea', 'repo', org, repo],
    queryFn: () => giteaClient.getRepo(org, repo!),
    select: publicise,
    enabled: !!repo,
    staleTime: REFRESH_MS,
  });
}

/**
 * Branches of `repo`. Pass `enabled: false` to read whatever is cached without
 * asking Gitea (tab badges that should not cost a request of their own).
 * Switching repos keeps the previous list as placeholder until the new one
 * lands, so views can dim it instead of blanking.
 */
export function useBranches(repo?: string, opts: { enabled?: boolean } = {}) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'branches', org, repo],
    queryFn: () => giteaClient.listBranches(org, repo!),
    enabled: !!repo && (opts.enabled ?? true),
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useCommits(repo?: string, ref?: string, limit = 50) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'commits', org, repo, ref, limit],
    queryFn: () => giteaClient.listCommits(org, repo!, ref, limit),
    enabled: !!repo,
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function usePullRequests(repo?: string, state: 'open' | 'closed' | 'all' = 'open') {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  return useQuery({
    queryKey: ['gitea', 'prs', org, repo, state],
    queryFn: () => giteaClient.listPullRequests(org, repo!, state),
    select: useCallback((list: gitea.PullRequest[]) => list.map((p) => ({ ...p, html_url: pub(p.html_url)! })), [pub]),
    enabled: !!repo,
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export type RepoPull = gitea.PullRequest & { repo: string };
export type RepoIssue = gitea.Issue & { repo: string };
export type ListState = 'open' | 'closed' | 'all';

/**
 * Run `fn` over `items` with at most `limit` calls in flight.
 *
 * Firing one request per repository all at once (150 repos → 150 requests)
 * saturated the browser's per-origin connection pool and Gitea itself (the BFF
 * authenticates every call with basic auth, which Gitea re-hashes per request),
 * so every request a click made — the drawer's README, a tab's list — queued
 * behind the storm for seconds. A small pool keeps the org views moving and
 * leaves room for interactive requests.
 */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const out: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const FAN_OUT = 4;

/**
 * Run `fn` for every repo (bounded) and flatten, tagging each row with its
 * repo. A repo whose tracker is disabled answers 404 — it contributes nothing
 * rather than failing the whole org view.
 */
async function acrossRepos<T>(names: string[], fn: (repo: string) => Promise<T[]>): Promise<Array<T & { repo: string }>> {
  const settled = await pool(names, FAN_OUT, async (repo) => (await fn(repo)).map((x) => ({ ...x, repo })));
  const ok = settled.filter((r): r is PromiseFulfilledResult<Array<T & { repo: string }>> => r.status === 'fulfilled');
  if (names.length && !ok.length) {
    const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw first?.reason ?? new Error('Gitea unreachable');
  }
  return ok.flatMap((r) => r.value);
}

/**
 * Every issue (or PR issue) in the org matching `state`, through Gitea's
 * cross-repo search: one request per 50 hits instead of one per repository.
 * Pages after the first are fetched together once `X-Total-Count` says how
 * many there are. Only hits in `names` (the org's active repos) are kept —
 * an older Gitea that ignores `owner=` would otherwise leak other orgs in.
 */
async function searchOrg(org: string, type: 'issues' | 'pulls', state: ListState, names: Set<string>, maxPages: number) {
  const first = await giteaClient.searchIssues({ owner: org, type, state, page: 1 });
  const pages = first.total !== undefined ? Math.min(maxPages, Math.ceil(first.total / 50)) : first.items.length < 50 ? 1 : maxPages;
  const rest = pages > 1
    ? await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), FAN_OUT, (page) => giteaClient.searchIssues({ owner: org, type, state, page }))
    : [];
  const items = [first.items, ...rest.flatMap((r) => (r.status === 'fulfilled' ? [r.value.items] : []))].flat();
  return items.filter((i) => {
    const repo = i.repository;
    if (!repo || !names.has(repo.name)) return false;
    const owner = repo.owner ?? repo.full_name?.split('/')[0];
    return !owner || owner === org;
  });
}

/**
 * Whether pull requests can be opened on this repository. A pull mirror
 * (its content is overwritten from upstream), an archived or empty repository,
 * or one with the Pull Requests unit switched off answers every PR call with
 * 404 — e.g. `POST /repos/adhar/adhar/pulls` on the platform's mirrored repo.
 */
export function pullRequestsBlocked(r?: Pick<gitea.Repo, 'mirror' | 'archived' | 'empty' | 'has_pull_requests'>): string | null {
  if (!r) return null;
  if (r.mirror) return 'This repository is a pull mirror — its content is overwritten from upstream, so pull requests belong in the upstream repository.';
  if (r.archived) return 'This repository is archived and read-only.';
  if (r.empty) return 'This repository has no commits yet.';
  if (r.has_pull_requests === false) return 'Pull requests are turned off for this repository (Settings → Pull requests).';
  return null;
}

/** Gitea ≥ 1.13 reports `open_pr_counter` on every repository in the org list. */
function hasPrCounter(list: gitea.Repo[]): boolean {
  return list.some((r) => typeof r.open_pr_counter === 'number');
}

function useRepoNames(only?: string, prs = false) {
  const repos = useRepos();
  const list = useMemo(
    () => (repos.data ?? []).filter((r) => !r.archived && (!prs || !pullRequestsBlocked(r))),
    [repos.data, prs],
  );
  const names = useMemo(() => (only ? [only] : list.map((r) => r.name)), [only, list]);
  // Repos that have open PRs right now — read off the repo list itself, so the
  // org-wide open-PR view asks only the repositories that have any.
  const withOpenPrs = useMemo(
    () => (only || !hasPrCounter(list) ? null : list.filter((r) => (r.open_pr_counter ?? 0) > 0).map((r) => r.name)),
    [only, list],
  );
  return { names, withOpenPrs, ready: !!only || !!repos.data, error: repos.error };
}

/** Pull requests across the org (or one repo when `repo` is set), tagged with their repo. */
export function useOrgPullRequests(state: ListState = 'open', repo?: string, opts: { enabled?: boolean } = {}) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  const { names, withOpenPrs, ready } = useRepoNames(repo, true);
  return useQuery({
    queryKey: ['gitea', 'prs-flat', org, state, repo ?? '*', names.length, withOpenPrs?.join(',') ?? ''],
    queryFn: async () => {
      if (repo) return acrossRepos(names, (r) => giteaClient.listPullRequests(org, r, state));
      // Which repositories to ask. Open: the ones whose counter says they
      // have open PRs. Closed history: the ones the org-wide search shows
      // recent closed PRs in. Either falls back to every repo when Gitea
      // cannot answer (an old version, search disabled).
      let targets = names;
      if (state === 'open' && withOpenPrs) targets = withOpenPrs;
      else if (state !== 'open') {
        try {
          const hits = await searchOrg(org, 'pulls', 'closed', new Set(names), 4);
          const recent = new Set(hits.map((h) => h.repository!.name));
          if (state === 'all' && withOpenPrs) for (const n of withOpenPrs) recent.add(n);
          targets = names.filter((n) => recent.has(n));
          if (state === 'all' && !withOpenPrs) targets = names;
        } catch {
          targets = names;
        }
      }
      return acrossRepos(targets, (r) => giteaClient.listPullRequests(org, r, state));
    },
    select: useCallback((list: RepoPull[]) => list.map((p) => ({ ...p, html_url: pub(p.html_url)! })), [pub]),
    enabled: ready && (opts.enabled ?? true),
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

/**
 * A fast first look at the org's pull requests: Gitea's cross-repo search
 * answers in one or two requests, where the full list needs one request per
 * repository. Search hits are issues, so branch names, mergeability and diff
 * size are missing — views render these rows at once and swap in the full
 * {@link useOrgPullRequests} rows when they land.
 */
export function useOrgPullSearch(state: 'open' | 'closed', enabled = true) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  const { names, ready } = useRepoNames(undefined, true);
  return useQuery({
    queryKey: ['gitea', 'prs-search', org, state, names.length],
    queryFn: async (): Promise<RepoPull[]> => {
      const hits = await searchOrg(org, 'pulls', state, new Set(names), state === 'open' ? 20 : 4);
      return hits.map((h) => ({
        id: h.id,
        number: h.number,
        title: h.title,
        body: h.body,
        state: h.state,
        user: { login: h.user.login, avatar_url: h.user.avatar_url ?? '' },
        labels: h.labels ?? [],
        assignees: h.assignees,
        created_at: h.created_at,
        updated_at: h.updated_at,
        closed_at: h.closed_at,
        comments: h.comments,
        html_url: h.html_url ?? '',
        merged: !!h.pull_request?.merged,
        merged_at: h.pull_request?.merged_at ?? null,
        draft: h.pull_request?.draft,
        repo: h.repository!.name,
      }));
    },
    select: useCallback((list: RepoPull[]) => list.map((p) => ({ ...p, html_url: pub(p.html_url)! })), [pub]),
    enabled: ready && enabled,
    staleTime: REFRESH_MS,
    retry: false,
  });
}

/** Open PRs across every repo in the org — flattened. Used by the dashboard. */
export function useAllOpenPullRequests() {
  return useOrgPullRequests('open');
}

/**
 * Open PR count per repository. Read straight off the repo list when Gitea
 * reports `open_pr_counter` (no extra requests at all); otherwise counted from
 * the org-wide open PR list.
 */
export function useOpenPrCounts(): { counts: Map<string, number>; isLoading: boolean } {
  const repos = useRepos();
  const counter = !!repos.data && hasPrCounter(repos.data);
  const fallback = useOrgPullRequests('open', undefined, { enabled: !!repos.data && !counter });
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    if (counter) for (const r of repos.data ?? []) m.set(r.name, r.open_pr_counter ?? 0);
    else for (const p of fallback.data ?? []) m.set(p.repo, (m.get(p.repo) ?? 0) + 1);
    return m;
  }, [counter, repos.data, fallback.data]);
  return { counts, isLoading: repos.isLoading || (!counter && fallback.isLoading) };
}

/** Issues across the org (or one repo), tagged with their repo. */
export function useOrgIssues(state: ListState = 'open', repo?: string) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  const { names, ready } = useRepoNames(repo);
  return useQuery({
    queryKey: ['gitea', 'issues-flat', org, state, repo ?? '*', names.length],
    queryFn: async (): Promise<RepoIssue[]> => {
      if (!repo) {
        // One search instead of one request per repository; per-repo only if
        // this Gitea cannot search.
        try {
          const hits = await searchOrg(org, 'issues', state, new Set(names), state === 'open' ? 20 : 4);
          return hits.filter((h) => !h.pull_request).map(({ repository, pull_request: _pr, ...i }) => ({ ...i, labels: i.labels ?? [], repo: repository!.name }));
        } catch { /* fall through to per-repo */ }
      }
      return acrossRepos(names, (r) => giteaClient.listIssues(org, r, state));
    },
    select: useCallback((list: RepoIssue[]) => list.map((i) => ({ ...i, html_url: pub(i.html_url) })), [pub]),
    enabled: ready,
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useIssues(repo?: string, state: ListState = 'open') {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'issues', org, repo, state],
    queryFn: () => giteaClient.listIssues(org, repo!, state),
    enabled: !!repo,
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

/** One PR — for deep links to a PR that is not in the loaded list. */
export function usePullRequest(repo?: string, index?: number) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  return useQuery({
    queryKey: ['gitea', 'pull', org, repo, index],
    queryFn: async (): Promise<RepoPull> => ({ ...(await giteaClient.getPullRequest(org, repo!, index!)), repo: repo! }),
    select: useCallback((p: RepoPull) => ({ ...p, html_url: pub(p.html_url)! }), [pub]),
    enabled: !!repo && index != null,
    staleTime: REFRESH_MS,
  });
}

export function useIssue(repo?: string, index?: number) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  return useQuery({
    queryKey: ['gitea', 'issue', org, repo, index],
    queryFn: async (): Promise<RepoIssue> => ({ ...(await giteaClient.getIssue(org, repo!, index!)), repo: repo! }),
    select: useCallback((i: RepoIssue) => ({ ...i, html_url: pub(i.html_url) }), [pub]),
    enabled: !!repo && index != null,
    staleTime: REFRESH_MS,
  });
}

export function useComments(repo?: string, index?: number) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'comments', org, repo, index],
    queryFn: () => giteaClient.listComments(org, repo!, index!),
    enabled: !!repo && index != null,
    staleTime: REFRESH_MS,
  });
}

export function usePullReviews(repo?: string, index?: number) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'reviews', org, repo, index],
    queryFn: () => giteaClient.listPullReviews(org, repo!, index!),
    enabled: !!repo && index != null,
    staleTime: REFRESH_MS,
  });
}

export function usePullCommits(repo?: string, index?: number) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'pull-commits', org, repo, index],
    queryFn: () => giteaClient.listPullCommits(org, repo!, index!),
    enabled: !!repo && index != null,
    staleTime: REFRESH_MS,
  });
}

const COMMIT_PAGE = 40;

/** Commit history on `ref`, paged — `fetchNextPage` walks further back. */
export function useCommitHistory(repo?: string, ref?: string, path?: string) {
  const org = useGiteaOrg();
  return useInfiniteQuery({
    queryKey: ['gitea', 'commits', org, repo, 'history', ref, path ?? ''],
    queryFn: ({ pageParam }) => giteaClient.listCommits(org, repo!, ref, COMMIT_PAGE, { page: pageParam, path }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.length < COMMIT_PAGE ? undefined : pages.length + 1),
    enabled: !!repo && !!ref,
    staleTime: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useCommit(repo?: string, sha?: string) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  return useQuery({
    queryKey: ['gitea', 'commit', org, repo, sha],
    queryFn: () => giteaClient.getCommit(org, repo!, sha!),
    select: useCallback((c: gitea.CommitDetail) => ({ ...c, html_url: pub(c.html_url) }), [pub]),
    enabled: !!repo && !!sha,
    staleTime: 5 * 60_000,
  });
}

export function useCommitDiff(repo?: string, sha?: string) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'commit-diff', org, repo, sha],
    queryFn: async () => parseUnifiedDiff((await giteaClient.getCommitDiff(org, repo!, sha!)) ?? ''),
    enabled: !!repo && !!sha,
    staleTime: 5 * 60_000,
  });
}

/**
 * Ahead/behind of `head` against `base`. Two compares; `null` when the
 * Gitea is too old for the compare API, so the UI can simply leave it out.
 */
export function useAheadBehind(repo?: string, base?: string, head?: string, enabled = true) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'ahead-behind', org, repo, base, head],
    queryFn: async () => {
      try {
        const [ahead, behind] = await Promise.all([
          giteaClient.compare(org, repo!, base!, head!),
          giteaClient.compare(org, repo!, head!, base!),
        ]);
        return { ahead: ahead.total_commits, behind: behind.total_commits };
      } catch {
        return null;
      }
    },
    enabled: enabled && !!repo && !!base && !!head && base !== head,
    staleTime: 2 * 60_000,
    retry: false,
  });
}

export function useTree(repo?: string, ref?: string, path = '') {
  const org = useGiteaOrg();
  return useQuery({
    ...treeQuery(org, repo!, ref!, path),
    enabled: !!repo && !!ref,
  });
}

export function useFile(repo?: string, ref?: string, path?: string) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'file', org, repo, ref, path],
    queryFn: () => giteaClient.getFile(org, repo!, ref!, path!),
    enabled: !!repo && !!ref && !!path,
    staleTime: REFRESH_MS,
  });
}

/* ─────────── pull-request diff ─────────── */

export type DiffLineKind = 'add' | 'del' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  /** Text of the line (without the leading +/-/space marker). */
  text: string;
  /** 1-based line number on the old side, when applicable. */
  oldNo?: number;
  /** 1-based line number on the new side, when applicable. */
  newNo?: number;
}

export interface DiffHunk {
  /** The raw @@ header, e.g. "@@ -1,6 +1,8 @@ function foo()". */
  header: string;
  lines: DiffLine[];
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/**
 * Minimal unified-diff parser — turns raw `git diff` text into structured
 * files/hunks/lines so the PR drawer can render a tinted, line-numbered diff
 * without pulling in a diff library.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = () => {
    if (file) files.push(file);
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      push();
      const m = line.match(/ b\/(.+)$/);
      file = {
        path: m ? m[1] : 'unknown',
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null' && p.startsWith('a/')) file.oldPath = p.slice(2);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null' && p.startsWith('b/')) file.path = p.slice(2);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newNo });
      newNo++;
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo });
      oldNo++;
      file.deletions++;
    } else if (line.startsWith(' ') || line === '') {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
    // ignore "\ No newline at end of file" and other metadata
  }
  push();
  return files;
}

/**
 * Real PR diff — fetches the raw unified `.diff` text from Gitea (through the
 * BFF proxy) and runs it through {@link parseUnifiedDiff}. `repo` may be a bare
 * name (owner defaults to the configured Gitea org) or a fully-qualified
 * `owner/name`.
 */
export function usePullDiff(repo?: string, number?: number) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'pull-diff', org, repo, number],
    queryFn: async (): Promise<DiffFile[]> => {
      const [owner, name] = repo!.includes('/') ? repo!.split('/') : [org, repo!];
      const raw = await giteaClient.getPullDiff(owner, name, number!);
      return parseUnifiedDiff(raw ?? '');
    },
    enabled: !!repo && number != null,
    staleTime: REFRESH_MS,
  });
}

/* ─────────── repository management ─────────── */

function useRepoQuery<T>(part: string, repo: string | undefined, fn: (org: string, repo: string) => Promise<T>, enabled = true) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', part, org, repo],
    queryFn: () => fn(org, repo!),
    enabled: !!repo && enabled,
    staleTime: REFRESH_MS,
  });
}

export function useRepoLanguages(repo?: string) {
  return useRepoQuery('languages', repo, (o, r) => giteaClient.listLanguages(o, r));
}
export function useRepoTopics(repo?: string) {
  return useRepoQuery('topics', repo, (o, r) => giteaClient.listTopics(o, r));
}
export function useBranchProtections(repo?: string) {
  return useRepoQuery('protections', repo, (o, r) => giteaClient.listBranchProtections(o, r));
}
export function useCollaborators(repo?: string, enabled = true) {
  return useRepoQuery('collaborators', repo, (o, r) => giteaClient.listCollaborators(o, r), enabled);
}
export function useReleases(repo?: string) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  return useQuery({
    queryKey: ['gitea', 'releases', org, repo],
    queryFn: () => giteaClient.listReleases(org, repo!),
    select: useCallback((list: gitea.Release[]) => list.map((x) => ({ ...x, html_url: pub(x.html_url) })), [pub]),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  });
}
export function useTags(repo?: string) {
  return useRepoQuery('tags', repo, (o, r) => giteaClient.listTags(o, r));
}
export function useWebhooks(repo?: string, enabled = true) {
  return useRepoQuery('hooks', repo, (o, r) => giteaClient.listWebhooks(o, r), enabled);
}
export function useRepoLabels(repo?: string) {
  return useRepoQuery('labels', repo, (o, r) => giteaClient.listLabels(o, r));
}

const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i;

function treeQuery(org: string, repo: string, ref: string, path = '') {
  return {
    queryKey: ['gitea', 'tree', org, repo, ref, path],
    queryFn: () => giteaClient.listTree(org, repo, ref, path),
    staleTime: REFRESH_MS,
  } as const;
}

async function readReadme(qc: ReturnType<typeof useQueryClient>, org: string, repo: string, ref: string) {
  // The root listing and the likeliest README are asked for together — two
  // round trips in sequence (list, then read) were most of the drawer's wait.
  // The listing goes through the query cache, so the Files tab reuses it.
  const guess = giteaClient.getFile(org, repo, ref, 'README.md').catch(() => null);
  const root = await qc.fetchQuery(treeQuery(org, repo, ref));
  const entry = root.find((e) => e.type === 'blob' && README_RE.test(e.path.split('/').pop() ?? ''));
  if (!entry) return null;
  const f = entry.path === 'README.md' ? (await guess) ?? await giteaClient.getFile(org, repo, ref, entry.path) : await giteaClient.getFile(org, repo, ref, entry.path);
  const text = f.encoding === 'base64' ? decodeBase64(f.content) : f.content;
  return { path: entry.path, text };
}

/** README at the repo root (any casing / extension), decoded to text. */
export function useReadme(repo?: string, ref?: string) {
  const org = useGiteaOrg();
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['gitea', 'readme', org, repo, ref],
    queryFn: () => readReadme(qc, org, repo!, ref!),
    enabled: !!repo && !!ref,
    staleTime: REFRESH_MS,
  });
}

/**
 * Warm the cache for what opening a repository shows first — its README and
 * the counts on the drawer's tabs — so a hover (or focus) before the click
 * turns the click into a cache hit. Hover intent is the caller's job: this
 * fires immediately and is cheap to call repeatedly (fresh data is skipped).
 */
export function usePrefetchRepo() {
  const org = useGiteaOrg();
  const qc = useQueryClient();
  return useCallback((r: Pick<gitea.Repo, 'name' | 'default_branch' | 'empty'>) => {
    if (r.empty) return;
    void qc.prefetchQuery({
      queryKey: ['gitea', 'readme', org, r.name, r.default_branch],
      queryFn: () => readReadme(qc, org, r.name, r.default_branch),
      staleTime: REFRESH_MS,
    });
    void qc.prefetchQuery({
      queryKey: ['gitea', 'branches', org, r.name],
      queryFn: () => giteaClient.listBranches(org, r.name),
      staleTime: REFRESH_MS,
    });
  }, [org, qc]);
}

function decodeBase64(s: string): string {
  try {
    const bin = atob(s.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return s;
  }
}

export function useUserSearch(q: string) {
  return useQuery({
    queryKey: ['gitea', 'user-search', q],
    queryFn: () => giteaClient.searchUsers(q, 8),
    enabled: q.trim().length >= 2,
    staleTime: REFRESH_MS,
  });
}

/**
 * Generic Gitea mutation — runs `fn` with the org threaded in, then
 * invalidates the listed `['gitea', part, org, repo]` keys (`repo` optional
 * for org-wide keys like `repos`).
 */
function useGiteaMutation<V, R = void>(
  fn: (org: string, vars: V) => Promise<R>,
  invalidate: (vars: V) => Array<[part: string, repo?: string]>,
) {
  const org = useGiteaOrg();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => fn(org, vars),
    onSuccess: (_d, vars) => {
      for (const [part, repo] of invalidate(vars)) {
        qc.invalidateQueries({ queryKey: repo ? ['gitea', part, org, repo] : ['gitea', part, org] });
      }
    },
  });
}

export function useCreateRepo() {
  return useGiteaMutation((org, body: gitea.CreateRepoBody) => giteaClient.createRepo(org, body), () => [['repos']]);
}
export function useUpdateRepo() {
  return useGiteaMutation(
    (org, v: { repo: string; body: gitea.UpdateRepoBody }) => giteaClient.updateRepo(org, v.repo, v.body),
    (v) => [['repos'], ['repo', v.repo]],
  );
}
export function useDeleteRepo() {
  return useGiteaMutation((org, repo: string) => giteaClient.deleteRepo(org, repo), () => [['repos']]);
}
export function useForkRepo() {
  return useGiteaMutation(
    (org, v: { repo: string; name?: string }) => giteaClient.forkRepo(org, v.repo, org, v.name),
    () => [['repos']],
  );
}
export function useSetTopics() {
  return useGiteaMutation(
    (org, v: { repo: string; topics: string[] }) => giteaClient.setTopics(org, v.repo, v.topics),
    (v) => [['topics', v.repo], ['repos']],
  );
}
export function useCreateBranch() {
  return useGiteaMutation(
    (org, v: { repo: string; name: string; from: string }) => giteaClient.createBranch(org, v.repo, v.name, v.from),
    (v) => [['branches', v.repo]],
  );
}
export function useDeleteBranch() {
  return useGiteaMutation(
    (org, v: { repo: string; name: string }) => giteaClient.deleteBranch(org, v.repo, v.name),
    (v) => [['branches', v.repo]],
  );
}
export function useProtectBranch() {
  return useGiteaMutation(
    (org, v: { repo: string; body: gitea.CreateBranchProtectionBody }) => giteaClient.createBranchProtection(org, v.repo, v.body),
    (v) => [['protections', v.repo], ['branches', v.repo]],
  );
}
export function useUnprotectBranch() {
  return useGiteaMutation(
    (org, v: { repo: string; ruleName: string }) => giteaClient.deleteBranchProtection(org, v.repo, v.ruleName),
    (v) => [['protections', v.repo], ['branches', v.repo]],
  );
}
export function useAddCollaborator() {
  return useGiteaMutation(
    (org, v: { repo: string; user: string; permission: gitea.CollaboratorPermission }) =>
      giteaClient.addCollaborator(org, v.repo, v.user, v.permission),
    (v) => [['collaborators', v.repo]],
  );
}
export function useRemoveCollaborator() {
  return useGiteaMutation(
    (org, v: { repo: string; user: string }) => giteaClient.removeCollaborator(org, v.repo, v.user),
    (v) => [['collaborators', v.repo]],
  );
}
export function useCreateRelease() {
  return useGiteaMutation(
    (org, v: { repo: string; body: Parameters<gitea.GiteaClient['createRelease']>[2] }) => giteaClient.createRelease(org, v.repo, v.body),
    (v) => [['releases', v.repo], ['tags', v.repo], ['repos']],
  );
}
export function useDeleteRelease() {
  return useGiteaMutation(
    (org, v: { repo: string; id: number }) => giteaClient.deleteRelease(org, v.repo, v.id),
    (v) => [['releases', v.repo], ['repos']],
  );
}
export function useCreateTag() {
  return useGiteaMutation(
    (org, v: { repo: string; body: { tag_name: string; target?: string; message?: string } }) => giteaClient.createTag(org, v.repo, v.body),
    (v) => [['tags', v.repo]],
  );
}
export function useDeleteTag() {
  return useGiteaMutation(
    (org, v: { repo: string; tag: string }) => giteaClient.deleteTag(org, v.repo, v.tag),
    (v) => [['tags', v.repo], ['releases', v.repo]],
  );
}
export function useCreateWebhook() {
  return useGiteaMutation(
    (org, v: { repo: string; body: gitea.CreateWebhookBody }) => giteaClient.createWebhook(org, v.repo, v.body),
    (v) => [['hooks', v.repo]],
  );
}
export function useUpdateWebhook() {
  return useGiteaMutation(
    (org, v: { repo: string; id: number; body: Partial<gitea.CreateWebhookBody> }) => giteaClient.updateWebhook(org, v.repo, v.id, v.body),
    (v) => [['hooks', v.repo]],
  );
}
export function useDeleteWebhook() {
  return useGiteaMutation(
    (org, v: { repo: string; id: number }) => giteaClient.deleteWebhook(org, v.repo, v.id),
    (v) => [['hooks', v.repo]],
  );
}
export function useTestWebhook() {
  return useGiteaMutation((org, v: { repo: string; id: number }) => giteaClient.testWebhook(org, v.repo, v.id), () => []);
}

/* ─────────── pull requests + issues ─────────── */

const PULL_KEYS = (repo: string): Array<[string, string?]> => [['prs', repo], ['prs-flat'], ['prs-search'], ['pull', repo], ['repos'], ['repo', repo]];
const ISSUE_KEYS = (repo: string): Array<[string, string?]> => [['issues', repo], ['issues-flat'], ['issue', repo], ['repos'], ['repo', repo]];

export function useCreatePull() {
  return useGiteaMutation(
    (org, v: { repo: string; body: gitea.CreatePullBody }) => giteaClient.createPullRequest(org, v.repo, v.body),
    (v) => PULL_KEYS(v.repo),
  );
}
export function useUpdatePull() {
  return useGiteaMutation(
    (org, v: { repo: string; index: number; body: gitea.UpdatePullBody }) => giteaClient.updatePullRequest(org, v.repo, v.index, v.body),
    (v) => PULL_KEYS(v.repo),
  );
}
export function useMergePull() {
  return useGiteaMutation(
    (org, v: { repo: string; index: number; style: gitea.MergeStyle; title?: string; message?: string; deleteBranch?: boolean }) =>
      giteaClient.mergePullRequest(org, v.repo, v.index, v),
    (v) => [...PULL_KEYS(v.repo), ['branches', v.repo], ['commits', v.repo]],
  );
}
export function useCreateReview() {
  return useGiteaMutation(
    (org, v: { repo: string; index: number; event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string }) =>
      giteaClient.createPullReview(org, v.repo, v.index, v),
    (v) => [['reviews', v.repo]],
  );
}
export function useCreateIssue() {
  return useGiteaMutation(
    (org, v: { repo: string; body: gitea.CreateIssueBody }) => giteaClient.createIssue(org, v.repo, v.body),
    (v) => ISSUE_KEYS(v.repo),
  );
}
export function useUpdateIssue() {
  return useGiteaMutation(
    (org, v: { repo: string; index: number; body: gitea.UpdateIssueBody }) => giteaClient.updateIssue(org, v.repo, v.index, v.body),
    (v) => ISSUE_KEYS(v.repo),
  );
}
/** Labels on an issue or a PR — both trackers are refreshed. */
export function useSetLabels() {
  return useGiteaMutation(
    (org, v: { repo: string; index: number; labels: number[] }) => giteaClient.setIssueLabels(org, v.repo, v.index, v.labels),
    (v) => [...ISSUE_KEYS(v.repo), ...PULL_KEYS(v.repo)],
  );
}
export function useCreateComment() {
  return useGiteaMutation(
    (org, v: { repo: string; index: number; body: string }) => giteaClient.createComment(org, v.repo, v.index, v.body),
    (v) => [['comments', v.repo], ['issues-flat'], ['prs-flat'], ['prs-search']],
  );
}
export function useDeleteComment() {
  return useGiteaMutation(
    (org, v: { repo: string; id: number }) => giteaClient.deleteComment(org, v.repo, v.id),
    (v) => [['comments', v.repo]],
  );
}

export function useSaveFile() {
  const org = useGiteaOrg();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      repo,
      ref,
      path,
      content,
      message,
      sha,
    }: {
      repo: string;
      ref: string;
      path: string;
      content: string;
      message: string;
      sha?: string;
    }) => giteaClient.saveFile(org, repo, ref, path, { content, message, sha }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['gitea', 'file', org, vars.repo, vars.ref, vars.path] });
      qc.invalidateQueries({ queryKey: ['gitea', 'commits', org, vars.repo] });
    },
  });
}
