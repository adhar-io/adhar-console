import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';

/**
 * Deep links inside the Develop module.
 *
 * The host route owns `?section=`; each view keeps its own selection next to
 * it (`?section=prs&pr=billing-service/17`), so a dashboard row, a toast or a
 * pasted URL lands on the exact repo, PR, issue or commit.
 *
 * This module is a federated remote. When the host's router is shared it is
 * used directly; when it is not (an older host, a standalone remote in dev),
 * the hooks fall back to `location` + the History API and announce changes
 * with `popstate`, which the host router listens to — so a missing router
 * context degrades to plain URLs instead of crashing the page with
 * "Cannot read properties of null (reading 'stores')".
 *
 * Values are encoded the way TanStack Router does: a string that would parse
 * as JSON (a short sha like `12e4567`, a number) is written quoted, and read
 * back as the string it was.
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
  | 'functions';

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
  /** Performance Readiness: the application whose report is open. */
  app?: string;
}

const KEYS = ['repo', 'tab', 'pr', 'issue', 'sha', 'branch', 'state', 'conn', 'view', 'suite', 'run', 'app'] as const;

function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

/** Decode one search value as TanStack Router wrote it. */
function decode(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw);
      if (typeof v === 'string') return v;
    } catch { /* not JSON — keep raw */ }
  }
  return raw;
}

/** Encode one value as TanStack Router would, so either side can read it. */
function encode(v: string): string {
  try {
    JSON.parse(v);
    return JSON.stringify(v); // would otherwise read back as a number/bool/null
  } catch {
    return v;
  }
}

function readSearch(search?: string): Record<string, string> {
  if (search === undefined && typeof location === 'undefined') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search ?? location.search)) out[k] = decode(v);
  return out;
}

/**
 * The search string of the location the app is on *now*. TanStack's browser
 * history notifies subscribers as soon as a navigation is committed but
 * writes `window.history` in a later flush — reading `location.search` from
 * the subscriber sees the previous URL, so a param change would never reach
 * the views. The router's own history location is current.
 */
function currentSearch(router: { history?: { location?: { search?: string } } } | null | undefined): string | undefined {
  const s = router?.history?.location?.search;
  return typeof s === 'string' ? s : undefined;
}

function pick(s: Record<string, unknown>): DevelopParams {
  const out: DevelopParams = {};
  for (const k of KEYS) if (s[k] != null && s[k] !== '') out[k] = String(s[k]);
  return out;
}

/** Write `search` to the URL without a router, and let listeners know. */
function writeUrl(path: string, search: Record<string, string>, replace: boolean) {
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)])).toString();
  const url = `${path}${qs ? `?${qs}` : ''}`;
  if (replace) history.replaceState(history.state, '', url);
  else history.pushState(history.state, '', url);
  // The host router listens for popstate; so do the hooks below.
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}

/** The Develop deep-link params on the current URL. */
export function useDevelopParams(): DevelopParams {
  const router = useRouter({ warn: false });
  const [params, setParams] = useState<DevelopParams>(() => pick(readSearch(currentSearch(router))));
  useEffect(() => {
    const sync = () => setParams((cur) => {
      const next = pick(readSearch(currentSearch(router)));
      return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
    });
    sync();
    globalThis.addEventListener('popstate', sync);
    const unsubscribe = router?.history?.subscribe?.(sync);
    return () => {
      globalThis.removeEventListener('popstate', sync);
      unsubscribe?.();
    };
  }, [router]);
  return params;
}

/**
 * The page these views are mounted on. Develop views also render inside other
 * phases (the Performance Center lives under /deliver), so in-place param
 * updates must stay on the current path rather than jump to /develop.
 */
function currentPath(router?: { history?: { location?: { pathname?: string } } } | null): string {
  const p = router?.history?.location?.pathname ?? (typeof location !== 'undefined' ? location.pathname : undefined);
  return p && p !== '/' ? p : '/develop';
}

/** Patch the params of the current page in place (no new history entry). */
export function useSetDevelopParams() {
  const router = useRouter({ warn: false });
  return useCallback(
    (patch: DevelopParams) => {
      if (router) {
        void router.navigate({
          to: currentPath(router),
          search: ((prev: Record<string, unknown>) => clean({ ...prev, ...patch })) as never,
          replace: true,
        });
        return;
      }
      writeUrl(currentPath(), clean({ ...readSearch(), ...patch }), true);
    },
    [router],
  );
}

/** Sections of the Develop module that the console shows under another phase. */
const HOSTED_ELSEWHERE: Partial<Record<DevelopSection, string>> = { performance: '/deliver' };

/** Go to another Develop section, optionally straight to one item. */
export function useGoDevelop() {
  const router = useRouter({ warn: false });
  return useCallback(
    (section: DevelopSection, params: DevelopParams = {}) => {
      const search = clean({ section, ...params });
      const to = HOSTED_ELSEWHERE[section] ?? '/develop';
      if (router) {
        void router.navigate({ to, search: search as never });
        return;
      }
      writeUrl(to, search, false);
    },
    [router],
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
