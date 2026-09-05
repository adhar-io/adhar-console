import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { gitea } from '@adhar-console/api-clients';
import { useGiteaOrg } from '@adhar-console/shell-ui';

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

/* ─────────── queries ─────────── */

export function useRepos() {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    staleTime: REFRESH_MS,
  });
}

export function useRepo(repo?: string) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'repo', org, repo],
    queryFn: () => giteaClient.getRepo(org, repo!),
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
  return useQuery({
    queryKey: ['gitea', 'prs', org, repo, state],
    queryFn: () => giteaClient.listPullRequests(org, repo!, state),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  });
}

/** PRs across every repo in the org — flattened. Used by the dashboard. */
export function useAllOpenPullRequests() {
  const org = useGiteaOrg();
  const repos = useRepos();
  return useQuery({
    queryKey: ['gitea', 'prs-flat', org, repos.data?.map((r) => r.name).join(',')],
    queryFn: async () => {
      if (!repos.data) return [];
      const out: Array<gitea.PullRequest & { repo: string }> = [];
      for (const r of repos.data) {
        const list = await giteaClient.listPullRequests(org, r.name, 'open');
        out.push(...list.map((p) => ({ ...p, repo: r.name })));
      }
      return out;
    },
    enabled: !!repos.data?.length,
    staleTime: REFRESH_MS,
  });
}

export function useIssues(repo?: string, state: 'open' | 'closed' | 'all' = 'open') {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['gitea', 'issues', org, repo, state],
    queryFn: () => giteaClient.listIssues(org, repo!, state),
    enabled: !!repo,
    staleTime: REFRESH_MS,
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
