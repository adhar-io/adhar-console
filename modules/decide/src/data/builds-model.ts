/**
 * Tekton PipelineRuns → build-health numbers. Pure, unit-tested.
 *
 *   success rate  succeeded ÷ (succeeded + failed); cancelled runs are left out
 *                 (a person stopped them; they say nothing about the build).
 *   duration      start → completion of finished runs (p50 / p95).
 *   queue time    created → started (waiting for a pod / a free node).
 */

import { percentile } from './dora-model.ts'

export type BuildState = 'succeeded' | 'failed' | 'cancelled' | 'running' | 'pending'

export interface RawRun {
  metadata?: {
    name?: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
  }
  spec?: { pipelineRef?: { name?: string }; params?: Array<{ name?: string; value?: unknown }> }
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
    startTime?: string
    completionTime?: string
  }
}

export interface BuildRun {
  name: string
  namespace: string
  pipeline: string
  repo?: string
  commit?: string
  project?: string
  state: BuildState
  reason?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  durationSec?: number
  queueSec?: number
}

const SHA = /^[0-9a-f]{7,40}$/i

function param(run: RawRun, ...names: string[]): string | undefined {
  for (const p of run.spec?.params ?? []) {
    if (p.name && names.includes(p.name) && typeof p.value === 'string' && p.value) return p.value
  }
  return undefined
}

function ts(v: string | undefined): number | undefined {
  if (!v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** The repository's bare name from a URL or a bare name. */
export function repoNameOf(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.replace(/\.git$/, '').replace(/\/$/, '')
  return s.split('/').filter(Boolean).pop()?.toLowerCase()
}

export function toBuildRun(run: RawRun): BuildRun {
  const c = (run.status?.conditions ?? []).find((x) => x.type === 'Succeeded')
  let state: BuildState
  if (!c) state = run.status?.startTime ? 'running' : 'pending'
  else if (c.status === 'True') state = 'succeeded'
  else if (c.status === 'False') state = /cancel/i.test(c.reason ?? '') ? 'cancelled' : 'failed'
  else state = 'running'
  const labels = run.metadata?.labels ?? {}
  const createdAt = ts(run.metadata?.creationTimestamp) ?? ts(run.status?.startTime) ?? 0
  const startedAt = ts(run.status?.startTime)
  const completedAt = ts(run.status?.completionTime)
  const rev = param(run, 'git-revision', 'revision', 'commit', 'sha') ?? labels['tekton.dev/git-revision']
  return {
    name: run.metadata?.name ?? '',
    namespace: run.metadata?.namespace ?? '',
    pipeline: labels['tekton.dev/pipeline'] ?? run.spec?.pipelineRef?.name ?? 'inline',
    repo: repoNameOf(param(run, 'repo-name', 'repoName') ?? labels['adhar.io/app'] ?? param(run, 'repo-url', 'git-url', 'url')),
    commit: rev && SHA.test(rev) ? rev.toLowerCase() : undefined,
    project: labels['adhar.io/project'],
    state,
    reason: c?.reason,
    createdAt,
    startedAt,
    completedAt,
    durationSec: startedAt != null && completedAt != null ? Math.max(0, (completedAt - startedAt) / 1000) : undefined,
    queueSec: startedAt != null && createdAt ? Math.max(0, (startedAt - createdAt) / 1000) : undefined,
  }
}

export interface PipelineStat {
  pipeline: string
  runs: number
  succeeded: number
  failed: number
  successRate: number | null
  p50: number | null
  p95: number | null
}

export interface BuildStats {
  total: number
  succeeded: number
  failed: number
  cancelled: number
  running: number
  successRate: number | null
  durationP50: number | null
  durationP95: number | null
  queueP50: number | null
  queueP95: number | null
  byPipeline: PipelineStat[]
  recentFailures: BuildRun[]
}

export function buildStats(runs: BuildRun[], from: number, to: number): BuildStats {
  const w = runs.filter((r) => r.createdAt >= from && r.createdAt < to)
  const count = (s: BuildState, list = w) => list.filter((r) => r.state === s).length
  const rate = (list: BuildRun[]) => {
    const ok = count('succeeded', list)
    const bad = count('failed', list)
    return ok + bad ? ok / (ok + bad) : null
  }
  const finished = w.filter((r) => r.durationSec != null && (r.state === 'succeeded' || r.state === 'failed'))
  const durations = finished.map((r) => r.durationSec!)
  const queues = w.map((r) => r.queueSec).filter((v): v is number => v != null)
  const byName = new Map<string, BuildRun[]>()
  for (const r of w) byName.set(r.pipeline, [...(byName.get(r.pipeline) ?? []), r])
  return {
    total: w.length,
    succeeded: count('succeeded'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    running: count('running') + count('pending'),
    successRate: rate(w),
    durationP50: percentile(durations, 0.5),
    durationP95: percentile(durations, 0.95),
    queueP50: percentile(queues, 0.5),
    queueP95: percentile(queues, 0.95),
    byPipeline: [...byName.entries()]
      .map(([pipeline, list]) => {
        const d = list.filter((r) => r.durationSec != null && r.state !== 'cancelled').map((r) => r.durationSec!)
        return {
          pipeline,
          runs: list.length,
          succeeded: count('succeeded', list),
          failed: count('failed', list),
          successRate: rate(list),
          p50: percentile(d, 0.5),
          p95: percentile(d, 0.95),
        }
      })
      .sort((a, b) => b.runs - a.runs),
    recentFailures: w.filter((r) => r.state === 'failed').sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
  }
}

/** Daily succeeded / failed counts over [from, to). */
export function buildSeries(runs: BuildRun[], from: number, to: number, width: number) {
  const ok: Array<[number, number]> = []
  const bad: Array<[number, number]> = []
  for (let s = from; s < to; s += width) {
    const b = runs.filter((r) => r.createdAt >= s && r.createdAt < s + width)
    ok.push([s, b.filter((r) => r.state === 'succeeded').length])
    bad.push([s, b.filter((r) => r.state === 'failed').length])
  }
  return { ok, bad }
}

export function formatSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec - m * 60)
    return s && m < 10 ? `${m}m ${s}s` : `${Math.round(sec / 60)}m`
  }
  return `${(sec / 3600).toFixed(1)}h`
}
