import { useCallback, useEffect, useState } from 'react';

/**
 * Deep links for Deliver → Delivery Flow:
 *   `/deliver?section=flow&app=<project>/<app>&commit=<sha>&stage=<stage id>`
 *
 * The host route owns `?section=`; these params sit next to it and are written
 * with the History API + `popstate` (Deliver does not share the host router).
 * Values are encoded the way TanStack Router writes them: a string that would
 * parse as JSON — a short sha like `12e4567` — is quoted, and read back as the
 * string it was.
 */

export interface FlowParams {
  app?: string;
  commit?: string;
  stage?: string;
  platform?: string;
}

const KEYS = ['app', 'commit', 'stage', 'platform'] as const;

export function decodeParam(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw);
      if (typeof v === 'string') return v;
    } catch { /* keep raw */ }
  }
  return raw;
}

export function encodeParam(v: string): string {
  try {
    JSON.parse(v);
    return JSON.stringify(v);
  } catch {
    return v;
  }
}

function read(): FlowParams {
  if (typeof location === 'undefined') return {};
  const q = new URLSearchParams(location.search);
  const out: FlowParams = {};
  for (const k of KEYS) {
    const v = q.get(k);
    if (v) out[k] = decodeParam(v);
  }
  return out;
}

export function useFlowParams(): FlowParams {
  const [p, setP] = useState<FlowParams>(read);
  useEffect(() => {
    const sync = () =>
      setP((cur) => {
        const next = read();
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
      });
    globalThis.addEventListener('popstate', sync);
    return () => globalThis.removeEventListener('popstate', sync);
  }, []);
  return p;
}

/** Patch the params; `push` adds a history entry, default replaces. */
export function useSetFlowParams() {
  return useCallback((patch: FlowParams, opts: { push?: boolean } = {}) => {
    if (typeof location === 'undefined') return;
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') q.delete(k);
      else q.set(k, encodeParam(v));
    }
    const url = `${location.pathname}?${q.toString()}`;
    if (opts.push) history.pushState(history.state, '', url);
    else history.replaceState(history.state, '', url);
    globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, []);
}

/** Absolute link to this view's current selection. */
export function flowLink(p: FlowParams): string {
  const q = new URLSearchParams({ section: 'flow' });
  for (const k of KEYS) if (p[k]) q.set(k, encodeParam(p[k]!));
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return `${origin}/deliver?${q.toString()}`;
}
