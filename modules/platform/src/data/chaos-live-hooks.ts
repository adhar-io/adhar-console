import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { notifyUnauthorized, POLL_FLOOR_MS, useLiveRefetch } from '@adhar/shell-ui'
import {
  deltaFromFirst,
  type MetricSeries,
  METRIC_DEFS,
  missingReason,
  type MissingMetric,
  parseRunnerTimeline,
  pointsFromMatrix,
  rateFor,
  runMetricQueries,
  type RunnerTimeline,
  stepFor,
  WINDOW_PAD_MS,
} from '@adhar/utils'
import type { ChaosResult } from './chaos-kinds.ts'
import { isNotFound, useChaosCluster } from './chaos.ts'
import { addProbeSample, type PodLike, type ProbeSample, targetPods, type TargetPods } from './chaos-live.ts'
import { promRangeAt } from './prom.ts'
import { watchOf } from './live.ts'
import { useFollowedRunLog } from './run-log-follow.ts'

/**
 * The I/O behind the live run canvas: the target's pods (Kubernetes API), its
 * metrics over the run window (Prometheus through the BFF), the probe state
 * the page observes change by change (ChaosResult), a suite run's timestamped
 * log (resilience runner), and the scorer's resilience grades.
 *
 * Kubernetes reads are pushed by apiserver watches over the live socket; the
 * runner's log is followed as a stream while the run is active; only the
 * Prometheus range reads run on a timer, at the 60 s floor and only while the
 * run is active (a range read returns full-resolution points regardless).
 */

const PODS = { group: '', version: 'v1', resource: 'pods', namespaced: true }
const CONFIG_MAPS = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }

/**
 * The pods a run targets: `namespace` + one label (`app=cart`), kept current
 * by a pod watch with the same namespace and selector. `live` is kept for
 * callers; readiness and restarts are pushed whether or not the run is active.
 */
export function useTargetPods(input: { namespace?: string; selector?: string; live: boolean; enabled?: boolean }) {
  const { cluster, key } = useChaosCluster()
  const enabled = (input.enabled ?? true) && !!input.namespace
  const queryKey = ['chaos', 'target-pods', key, input.namespace, input.selector ?? '']
  const interval = useLiveRefetch(
    watchOf(PODS, { namespace: input.namespace, labelSelector: input.selector || undefined, cluster }),
    [queryKey],
    POLL_FLOOR_MS,
    enabled,
  )
  return useQuery({
    queryKey,
    queryFn: async (): Promise<TargetPods & { raw: PodLike[] }> => {
      const res = await kube.list<PodLike>(PODS, { namespace: input.namespace, labelSelector: input.selector || undefined, cluster })
      const raw = res.items ?? []
      return { ...targetPods(raw), raw }
    },
    enabled,
    retry: false,
    refetchInterval: enabled ? interval : false,
  })
}

export interface LiveMetrics {
  series: MetricSeries[]
  missing: MissingMetric[]
  window: { start: number; end: number; stepSeconds: number }
}

/**
 * The target's metrics from a run's start until now (or its end, padded),
 * re-read at the poll floor (60 s) while it runs — each read is a range query,
 * so the chart keeps its full resolution. The window starts two minutes before the
 * run so the steady state is on the chart to compare against.
 */
export function useLiveTargetMetrics(input: { namespace?: string; podRegex?: string; start?: number; end?: number; active: boolean }) {
  const enabled = !!(input.namespace && input.podRegex && input.start)
  return useQuery({
    queryKey: ['chaos', 'live-metrics', input.namespace, input.podRegex, input.start, input.active ? 'live' : input.end],
    queryFn: async (): Promise<LiveMetrics> => {
      const now = Date.now()
      const start = input.start! - WINDOW_PAD_MS
      const end = input.active || !input.end ? now : Math.min(now, input.end + WINDOW_PAD_MS)
      const window = { start, end, stepSeconds: stepFor(start, end, 150, 10) }
      const queries = runMetricQueries({ namespace: input.namespace!, podRegex: input.podRegex!, rate: rateFor(Math.max(15, window.stepSeconds)) })
      const answers = await Promise.allSettled(queries.map((q) => promRangeAt(q.query, window)))
      // Prometheus not wired at all: one honest error rather than seven.
      const notConfigured = answers.find((a) => a.status === 'rejected' && /not configured/.test(String((a.reason as Error)?.message)))
      if (notConfigured) throw (notConfigured as PromiseRejectedResult).reason
      const series: MetricSeries[] = []
      const missing: MissingMetric[] = []
      queries.forEach((q, i) => {
        const def = METRIC_DEFS.find((d) => d.id === q.id)!
        const a = answers[i]
        if (a.status === 'rejected') {
          missing.push({ id: q.id, label: def.label, reason: (a.reason as Error)?.message ?? 'query failed' })
          return
        }
        let pts = pointsFromMatrix(a.value[0]?.values)
        if (q.id === 'restarts') pts = deltaFromFirst(pts)
        if (pts.length < 2) missing.push({ id: q.id, label: def.label, reason: missingReason(q.id) })
        else series.push({ id: q.id, label: def.label, unit: def.unit, points: pts })
      })
      return { series, missing, window }
    },
    enabled,
    retry: false,
    refetchInterval: enabled && input.active ? POLL_FLOOR_MS : false,
    staleTime: input.active ? 30_000 : 5 * 60_000,
  })
}

/**
 * The steady-state probe as this page saw it: one sample per poll of the
 * ChaosResult, compressed. Litmus only writes the probe success percentage at
 * the end of a run, so while it runs this observed strip is the only live
 * view of the probe there is — and it is labelled as observed.
 */
export function useProbeTimeline(result: ChaosResult | null | undefined, resetKey: string | undefined): ProbeSample[] {
  const [samples, setSamples] = useState<ProbeSample[]>([])
  const key = useRef(resetKey)
  useEffect(() => {
    if (key.current !== resetKey) {
      key.current = resetKey
      setSamples([])
    }
  }, [resetKey])
  useEffect(() => {
    if (!result) return
    setSamples((prev) => addProbeSample(prev, result, Date.now()))
  }, [result])
  return samples
}

/**
 * A suite run's log, read with timestamps and parsed into phases. Read once
 * through the BFF (which resolves the run's newest pod), then — while the run
 * is live — followed as a log stream, so phases appear as the runner prints
 * them instead of on a timer. A new pod (a Job retry) is picked up by the
 * run-log hook's pod watch.
 */
export function useRunTimeline(job: string | null, app: string, live: boolean) {
  const query = useQuery({
    queryKey: ['chaos', 'run-timeline', job, app],
    queryFn: async (): Promise<RunnerTimeline & { pod: string | null; log: string }> => {
      const res = await fetch(`/api/resilience/runs/log?job=${encodeURIComponent(job!)}&timestamps=1`, { credentials: 'include' })
      if (res.status === 401) notifyUnauthorized()
      const body = (await res.json().catch(() => ({}))) as { pod?: string | null; log?: string; error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail || body.error || `log could not be read (${res.status})`)
      return { ...parseRunnerTimeline(body.log ?? '', app), pod: body.pod ?? null, log: body.log ?? '' }
    },
    enabled: !!job,
    retry: false,
    // A finished run's log no longer changes.
    staleTime: live ? 30_000 : Infinity,
  })
  const followed = useFollowedRunLog({
    job,
    pod: query.data?.pod ?? null,
    live,
    timestamps: true,
    queryKeys: [['chaos', 'run-timeline', job, app]],
  })
  const data = useMemo(
    () => (followed !== undefined && query.data ? { ...parseRunnerTimeline(followed, app), pod: query.data.pod, log: followed } : query.data),
    [followed, query.data, app],
  )
  return { ...query, data }
}

/* ─────────────────────────── scorer ─────────────────────────── */

export interface ScorerApp {
  name: string
  score?: number
  grade?: string
  /** The resilience category, 0–100. */
  resilience?: number
  /** Overall score per scorer run, oldest first (the history ConfigMap). */
  history: Array<{ at: string; score: number }>
}

/**
 * The platform scorer's view of each application (adhar-scorecards in
 * adhar-system): its current resilience category and the trend of its overall
 * score. Optional — the scorecards package may be absent, or the reader may
 * not be allowed to read it; both read as "no scorer data".
 */
export function useScorerResilience() {
  return useQuery({
    queryKey: ['chaos', 'scorer'],
    queryFn: async (): Promise<Map<string, ScorerApp>> => {
      const out = new Map<string, ScorerApp>()
      const [summary, history] = await Promise.all([
        kube.get<{ data?: Record<string, string> }>(CONFIG_MAPS, 'adhar-system', 'adhar-scorecards').catch((e) => (isNotFound(e) ? null : Promise.reject(e))),
        kube.get<{ data?: Record<string, string> }>(CONFIG_MAPS, 'adhar-system', 'adhar-scorecards-history').catch(() => null),
      ])
      try {
        const s = JSON.parse(summary?.data?.['summary.json'] ?? 'null') as { services?: Array<Record<string, unknown>> } | null
        for (const svc of s?.services ?? []) {
          if (typeof svc.name !== 'string' || (svc.kind && svc.kind !== 'application')) continue
          const cats = (svc.categories ?? {}) as Record<string, unknown>
          out.set(svc.name, {
            name: svc.name,
            ...(typeof svc.score === 'number' ? { score: svc.score } : {}),
            ...(typeof svc.grade === 'string' ? { grade: svc.grade } : {}),
            ...(typeof cats.resilience === 'number' ? { resilience: cats.resilience } : {}),
            history: [],
          })
        }
      } catch { /* unreadable summary: no scorer data */ }
      try {
        const h = JSON.parse(history?.data?.['history.json'] ?? '[]') as Array<{ at?: string; services?: Record<string, { score?: number }> }>
        for (const entry of Array.isArray(h) ? h : []) {
          for (const [name, v] of Object.entries(entry.services ?? {})) {
            const app = out.get(name)
            if (app && typeof v?.score === 'number' && entry.at) app.history.push({ at: entry.at, score: v.score })
          }
        }
      } catch { /* history is an enhancement */ }
      return out
    },
    retry: false,
    // The scorer rewrites these on its own schedule (a CronJob, hours apart):
    // read once per visit, not on a timer.
    staleTime: 10 * 60_000,
  })
}
