import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { liveClient, notifyUnauthorized } from '@adhar/shell-ui'
import { type ChaosRunReport, normalizeReport } from './chaos-report.ts'
import { RESULTS_CONFIGMAP, RESULTS_NAMESPACE } from './chaos-suites.ts'
import { watchOf } from './live.ts'

/**
 * Chaos run reports as `/api/resilience/reports` serves them — every run the
 * console's recorder froze, newest first (BFF `resilience-reports.ts`).
 *
 * The whole bounded history is read once and filtered in the page: at most 50
 * reports per application keeps it small, and the previous-run / previous-
 * commit comparisons need the neighbours of whatever is opened anyway.
 */

export interface ChaosReportsState {
  /** False when the console has no database, so no history is kept. */
  configured: boolean
  detail?: string
  items: ChaosRunReport[]
}

/**
 * The BFF recorder freezes a report on its next one-minute tick after the
 * runner rewrites the results ConfigMap — so a change to that ConfigMap is the
 * only moment the reports can change, and this is how long to wait after it.
 */
export const REPORT_RECORD_DELAY_MS = 75_000

const REPORTS_KEY = ['chaos', 'reports'] as const

export function useChaosReports() {
  const qc = useQueryClient()
  // Same watch params as the suites page's results watch, so the hub shares it.
  useEffect(() => {
    let timer: number | undefined
    const unsub = liveClient.subscribe(
      'k8s',
      watchOf({ group: '', version: 'v1', resource: 'configmaps' }, {
        namespace: RESULTS_NAMESPACE,
        fieldSelector: `metadata.name=${RESULTS_CONFIGMAP}`,
      }) as unknown as Record<string, unknown>,
      (msg) => {
        if (msg.op !== 'event') return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void qc.invalidateQueries({ queryKey: REPORTS_KEY }), REPORT_RECORD_DELAY_MS) as unknown as number
      },
    )
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [qc])
  return useQuery({
    queryKey: REPORTS_KEY,
    queryFn: async (): Promise<ChaosReportsState> => {
      const res = await fetch('/api/resilience/reports', { credentials: 'include', headers: { accept: 'application/json' } })
      if (res.status === 401) notifyUnauthorized()
      const body = (await res.json().catch(() => ({}))) as Partial<ChaosReportsState> & { error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail || body.error || `reports could not be read (${res.status})`)
      return { configured: body.configured !== false, ...(body.detail ? { detail: body.detail } : {}), items: (body.items ?? []).map(normalizeReport) }
    },
    retry: false,
    // No timer: reports only change after a run, which the watch above catches.
    staleTime: 5 * 60_000,
  })
}

/* ─────────────────────────── deep links ─────────────────────────── */

/**
 * `/deliver?section=chaos&tab=reports&commit=<sha>&app=<app>&report=<id>`, plus
 * `run=` / `gameday=` / `job=` for a live run and `compare=<id>~<id>`.
 * The host route owns `?section=`; these params sit next to it.
 */
export interface ChaosParams {
  tab?: string
  commit?: string
  app?: string
  report?: string
  /** An experiment (ChaosEngine) whose live canvas is open. */
  run?: string
  /** A game day (Workflow) whose live canvas is open. */
  gameday?: string
  /** A suite run (gate Job) whose live canvas is open. */
  job?: string
  /** Two report ids, `a~b`, open side by side. */
  compare?: string
}

const KEYS = ['tab', 'commit', 'app', 'report', 'run', 'gameday', 'job', 'compare'] as const

export function readChaosParams(search = typeof location === 'undefined' ? '' : location.search): ChaosParams {
  const q = new URLSearchParams(search)
  const out: ChaosParams = {}
  for (const k of KEYS) {
    let v = q.get(k)
    // TanStack Router writes JSON-looking strings quoted.
    if (v && v.startsWith('"')) {
      try {
        const j = JSON.parse(v)
        if (typeof j === 'string') v = j
      } catch { /* keep raw */ }
    }
    if (v) out[k] = v
  }
  return out
}

/** Patch the params in place (replace, not push): filters are not navigation. */
export function writeChaosParams(patch: ChaosParams): void {
  if (typeof location === 'undefined') return
  const q = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v) q.set(k, v)
    else q.delete(k)
  }
  history.replaceState(history.state, '', `${location.pathname}?${q.toString()}`)
}
