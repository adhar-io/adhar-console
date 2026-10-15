import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * Deep links inside the Develop module.
 *
 * The host route owns `?section=`; each view keeps its own selection next to
 * it (`?section=prs&pr=billing-service/17`), so a dashboard row, a toast or a
 * pasted URL lands on the exact repo, PR, issue or commit. Everything goes
 * through the router — never a hand-built href — because TanStack Router
 * JSON-encodes search values and a short sha like `12e4567` would otherwise
 * come back as a number.
 */

export type DevelopSection =
  | 'dashboard'
  | 'repos'
  | 'branches'
  | 'commits'
  | 'prs'
  | 'issues'
  | 'environments'
  | 'pipelines'
  | 'performance'
  | 'content'
  | 'codebuilder';

export interface DevelopParams {
  /** Repository name (bare, within the configured org). */
  repo?: string;
  /** Repo drawer tab. */
  tab?: string;
  /** `repo/index` of an open pull request drawer. */
  pr?: string;
  /** `repo/index` of an open issue drawer. */
  issue?: string;
  /** Commit sha of an open commit drawer. */
  sha?: string;
  /** Branch for the commit history. */
  branch?: string;
  /** List state filter (`open` / `closed` / `merged` / `all`). */
  state?: string;
  /** Pipelines: the open connection drawer. */
  conn?: string;
  /** Page-level tab of a section (Pipelines, Performance). */
  view?: string;
  /** Performance: the open suite / run. */
  suite?: string;
  run?: string;
}

const KEYS = ['repo', 'tab', 'pr', 'issue', 'sha', 'branch', 'state', 'conn', 'view', 'suite', 'run'] as const;

function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

/** The Develop deep-link params on the current URL. */
export function useDevelopParams(): DevelopParams {
  const s = useSearch({ strict: false }) as Record<string, unknown>;
  const out: DevelopParams = {};
  for (const k of KEYS) if (s[k] != null && s[k] !== '') out[k] = String(s[k]);
  return out;
}

/** Patch the params of the current page in place (no new history entry). */
export function useSetDevelopParams() {
  const navigate = useNavigate();
  return useCallback(
    (patch: DevelopParams) =>
      navigate({
        to: '/develop',
        search: ((prev: Record<string, unknown>) => clean({ ...prev, ...patch })) as never,
        replace: true,
      }),
    [navigate],
  );
}

/** Go to another Develop section, optionally straight to one item. */
export function useGoDevelop() {
  const navigate = useNavigate();
  return useCallback(
    (section: DevelopSection, params: DevelopParams = {}) =>
      navigate({ to: '/develop', search: clean({ section, ...params }) as never }),
    [navigate],
  );
}

/** `repo/42` ⇄ `{ repo, index }`. */
export function itemRef(repo: string, index: number): string {
  return `${repo}/${index}`;
}
export function parseItemRef(ref?: string): { repo: string; index: number } | null {
  if (!ref) return null;
  const i = ref.lastIndexOf('/');
  if (i <= 0) return null;
  const index = Number(ref.slice(i + 1));
  return Number.isFinite(index) ? { repo: ref.slice(0, i), index } : null;
}
