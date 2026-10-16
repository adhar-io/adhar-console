import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export function getStoredRepo(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage.getItem(REPO_KEY) ?? undefined;
}
export function setStoredRepo(name: string) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(REPO_KEY, name);
}
export function getStoredBranch(repo: string): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage.getItem(`${BRANCH_KEY}:${repo}`) ?? undefined;
}
export function setStoredBranch(repo: string, branch: string) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(`${BRANCH_KEY}:${repo}`, branch);
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

export function useBranches(repo?: string) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'branches', org, repo],
    queryFn: () => giteaClient.listBranches(org, repo!),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  });
}

export function useCommits(repo?: string, ref?: string, limit = 50) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'commits', org, repo, ref, limit],
    queryFn: () => giteaClient.listCommits(org, repo!, ref, limit),
    enabled: !!repo,
    staleTime: REFRESH_MS,
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
  });
}

export type RepoPull = gitea.PullRequest & { repo: string };
export type RepoIssue = gitea.Issue & { repo: string };
export type ListState = 'open' | 'closed' | 'all';

/**
 * Run `fn` for every repo in parallel and flatten, tagging each row with its
 * repo. A repo whose tracker is disabled answers 404 — it contributes nothing
 * rather than failing the whole org view.
 */
async function acrossRepos<T>(names: string[], fn: (repo: string) => Promise<T[]>): Promise<Array<T & { repo: string }>> {
  const settled = await Promise.allSettled(names.map(async (repo) => (await fn(repo)).map((x) => ({ ...x, repo }))));
  const ok = settled.filter((r): r is PromiseFulfilledResult<Array<T & { repo: string }>> => r.status === 'fulfilled');
  if (names.length && !ok.length) {
    const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw first?.reason ?? new Error('Gitea unreachable');
  }
  return ok.flatMap((r) => r.value);
}

/**
 * Whether Gitea will accept pull requests on this repository. A pull mirror
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

function useRepoNames(only?: string, prs = false) {
  const repos = useRepos();
  const names = only
    ? [only]
    : (repos.data ?? []).filter((r) => !r.archived && (!prs || !pullRequestsBlocked(r))).map((r) => r.name);
  return { names, ready: !!only || !!repos.data, error: repos.error };
}

/** Pull requests across the org (or one repo when `repo` is set), tagged with their repo. */
export function useOrgPullRequests(state: ListState = 'open', repo?: string) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  const { names, ready } = useRepoNames(repo, true);
  return useQuery({
    queryKey: ['gitea', 'prs-flat', org, state, names.join(',')],
    queryFn: () => acrossRepos(names, (r) => giteaClient.listPullRequests(org, r, state)),
    select: useCallback((list: RepoPull[]) => list.map((p) => ({ ...p, html_url: pub(p.html_url)! })), [pub]),
    enabled: ready,
    staleTime: REFRESH_MS,
  });
}

/** Open PRs across every repo in the org — flattened. Used by the dashboard. */
export function useAllOpenPullRequests() {
  return useOrgPullRequests('open');
}

/** Issues across the org (or one repo), tagged with their repo. */
export function useOrgIssues(state: ListState = 'open', repo?: string) {
  const org = useGiteaOrg();
  const pub = usePublicGiteaUrl();
  const { names, ready } = useRepoNames(repo);
  return useQuery({
    queryKey: ['gitea', 'issues-flat', org, state, names.join(',')],
    queryFn: () => acrossRepos(names, (r) => giteaClient.listIssues(org, r, state)),
    select: useCallback((list: RepoIssue[]) => list.map((i) => ({ ...i, html_url: pub(i.html_url) })), [pub]),
    enabled: ready,
    staleTime: REFRESH_MS,
  });
}

export function useIssues(repo?: string, state: ListState = 'open') {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'issues', org, repo, state],
    queryFn: () => giteaClient.listIssues(org, repo!, state),
    enabled: !!repo,
    staleTime: REFRESH_MS,
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
    queryKey: ['gitea', 'tree', org, repo, ref, path],
    queryFn: () => giteaClient.listTree(org, repo!, ref!, path),
    enabled: !!repo && !!ref,
    staleTime: REFRESH_MS,
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
export function useCollaborators(repo?: string) {
  return useRepoQuery('collaborators', repo, (o, r) => giteaClient.listCollaborators(o, r));
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
export function useWebhooks(repo?: string) {
  return useRepoQuery('hooks', repo, (o, r) => giteaClient.listWebhooks(o, r));
}
export function useRepoLabels(repo?: string) {
  return useRepoQuery('labels', repo, (o, r) => giteaClient.listLabels(o, r));
}

/** README at the repo root (any casing / extension), decoded to text. */
export function useReadme(repo?: string, ref?: string) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'readme', org, repo, ref],
    queryFn: async () => {
      const root = await giteaClient.listTree(org, repo!, ref!, '');
      const entry = root.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.path.split('/').pop() ?? ''));
      if (!entry) return null;
      const f = await giteaClient.getFile(org, repo!, ref!, entry.path);
      const text = f.encoding === 'base64' ? decodeBase64(f.content) : f.content;
      return { path: entry.path, text };
    },
    enabled: !!repo && !!ref,
    staleTime: REFRESH_MS,
  });
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

const PULL_KEYS = (repo: string): Array<[string, string?]> => [['prs', repo], ['prs-flat'], ['pull', repo], ['repos'], ['repo', repo]];
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
    (v) => [['comments', v.repo], ['issues-flat'], ['prs-flat']],
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
