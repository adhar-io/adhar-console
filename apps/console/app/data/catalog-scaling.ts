import { useSyncExternalStore } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { useLiveToolPoll } from '@adhar/shell-ui'
import type { KObj } from './catalog-composition-model.ts'
import { useWatchInvalidate } from './live-k8s.ts'
import type { RolloutMode, ScalingIntent, ScalingOp } from './catalog-scaling-model.ts'

/**
 * Live reads and writes for the catalog drawer's Scaling section.
 *
 *   - Autoscalers (HPAs) and KEDA ScaledObjects in each environment namespace,
 *     kept current by their apiserver watches — the workloads themselves come
 *     from `useWorkloads` (Rollouts + Deployments, also watched).
 *   - The overlay's declared scaling, from `/api/catalog/scaling` (Gitea has
 *     no watch: re-read when the repository's head commit moves, polled once
 *     a minute by the BFF for every viewer).
 *   - The HPA's last scale event, re-read only when the HPA scales again.
 *   - A change in flight per app/env, kept in a module store so closing and
 *     reopening the drawer keeps following it.
 */

const k8sClient = k8s.K8sClient.auto()

const GVR = {
  hpa: { group: 'autoscaling', version: 'v2', resource: 'horizontalpodautoscalers', namespaced: true },
  scaledObject: { group: 'keda.sh', version: 'v1alpha1', resource: 'scaledobjects', namespaced: true },
} satisfies Record<string, k8s.GVR>

const STALE_MS = 30_000

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

/** A namespace without the KEDA CRD (or that the user cannot list) has no ScaledObjects to show. */
async function listOr404(gvr: k8s.GVR, ns: string): Promise<KObj[]> {
  try {
    return (await k8sClient.listGeneric(undefined, gvr, ns) as unknown as KObj[]).map((o) => ({ ...o, metadata: { ...o.metadata, namespace: o.metadata.namespace ?? ns } }))
  } catch (e) {
    if (statusOf(e) === 404) return []
    throw e
  }
}

export interface Scalers {
  hpas: KObj[]
  scaledObjects: KObj[]
}

/** HPAs and ScaledObjects in the environments' namespaces. */
export function useScalers(namespaces: readonly string[], enabled = true) {
  const key = [...namespaces].sort().join(',')
  const queryKey = ['catalog', 'scalers', key]
  const on = enabled && namespaces.length > 0
  const refetchInterval = useWatchInvalidate(
    on ? namespaces.flatMap((ns) => [{ ...GVR.hpa, namespace: ns }, { ...GVR.scaledObject, namespace: ns }]) : [],
    [queryKey],
    { minGapMs: 3_000 },
  )
  return useQuery({
    queryKey,
    queryFn: async (): Promise<Scalers> => {
      const lists = await Promise.all(namespaces.map(async (ns) => {
        const [hpas, scaledObjects] = await Promise.all([listOr404(GVR.hpa, ns), listOr404(GVR.scaledObject, ns).catch(() => [])])
        return { hpas, scaledObjects }
      }))
      return { hpas: lists.flatMap((l) => l.hpas), scaledObjects: lists.flatMap((l) => l.scaledObjects) }
    },
    enabled: on,
    staleTime: STALE_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

export interface ScaleEvent {
  reason: string
  message: string
  at?: string
  type?: string
}

/** The autoscaler's most recent event (`SuccessfulRescale: New size: 3; reason: …`). */
export function useScaleEvent(hpa: { name: string; namespace: string; lastScaleTime?: string } | undefined) {
  return useQuery({
    // Keyed on lastScaleTime: the HPA's own watch moves it on every rescale,
    // so the event list is read again exactly then — no timer.
    queryKey: ['catalog', 'scaler-event', hpa?.namespace ?? '', hpa?.name ?? '', hpa?.lastScaleTime ?? ''],
    queryFn: async (): Promise<ScaleEvent | null> => {
      const sel = `involvedObject.kind=HorizontalPodAutoscaler,involvedObject.name=${hpa!.name}`
      const res = await fetch(`/api/k8s/api/v1/namespaces/${encodeURIComponent(hpa!.namespace)}/events?fieldSelector=${encodeURIComponent(sel)}&limit=50`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { items?: Array<{ reason?: string; message?: string; type?: string; lastTimestamp?: string; eventTime?: string; metadata?: { creationTimestamp?: string } }> }
      const at = (e: { lastTimestamp?: string; eventTime?: string; metadata?: { creationTimestamp?: string } }) => e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? ''
      const last = [...(body.items ?? [])].sort((a, b) => at(b).localeCompare(at(a)))[0]
      return last ? { reason: last.reason ?? '', message: last.message ?? '', ...(at(last) ? { at: at(last) } : {}), ...(last.type ? { type: last.type } : {}) } : null
    },
    enabled: Boolean(hpa),
    staleTime: Infinity,
    retry: 0,
  })
}

/* ─────────── the BFF ─────────── */

export interface ScalingState {
  app: string
  env: string
  namespace: string
  workload: { kind: 'Rollout' | 'Deployment'; name: string }
  repo: { org: string; repo: string; branch: string; dir: string }
  delivery: 'kargo' | 'argo'
  kargo?: { project: string; stage: string }
  keda?: string
  overlay: 'ok' | 'missing' | 'unsupported' | 'unavailable'
  overlayProblem?: string
  managed?: boolean
  declared?: ScalingIntent
}

export class ScalingError extends Error {
  constructor(readonly status: number, readonly code: string, detail: string) {
    super(detail)
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
  if (!res.ok) throw new ScalingError(res.status, data.error ?? 'error', data.detail ?? `Scaling request failed (HTTP ${res.status}).`)
  return data as T
}

/** Per env: the overlay's declared scaling. `null` when the BFF says the env cannot be scaled (and why, in `refusal`). */
export function useScalingState(app: string, env: string, repo: { org: string; repo: string } | undefined, enabled = true) {
  const queryKey = ['catalog', 'scaling', 'state', app, env]
  const refetchInterval = useLiveToolPoll(
    'gitea',
    repo ? `/api/v1/repos/${repo.org}/${repo.repo}/commits?limit=1&files=false&verification=false` : '',
    60_000,
    [queryKey],
    { enabled: enabled && Boolean(repo) },
  )
  return useQuery({
    queryKey,
    queryFn: async (): Promise<{ state?: ScalingState; refusal?: ScalingError }> => {
      try {
        return { state: await call<ScalingState>('GET', `/api/catalog/scaling?${new URLSearchParams({ app, env })}`) }
      } catch (e) {
        // Refusals (not running yet, not scalable, no access) are answers, not failures.
        if (e instanceof ScalingError && e.status >= 400 && e.status < 500) return { refusal: e }
        throw e
      }
    },
    enabled: enabled && Boolean(app && env),
    staleTime: STALE_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

export interface PlannedFile {
  path: string
  before: string | null
  after: string | null
}

export interface ScalingPlan {
  summary: string
  from?: ScalingIntent
  target: ScalingIntent
  warnings: string[]
  confirm: 'production' | 'offline' | null
  fingerprint: string
  repo: { org: string; repo: string; branch: string; dir: string }
  files: PlannedFile[]
  rollout: RolloutMode
  rolloutReason?: string
}

export interface ScalingResult {
  ok: true
  noop?: boolean
  summary: string
  commit?: string
  promotion?: string
  rollout: RolloutMode
  rolloutReason?: string
}

export const planScaling = (app: string, env: string, intent: ScalingIntent) =>
  call<{ plan: ScalingPlan }>('POST', '/api/catalog/scaling', { app, env, intent, dryRun: true }).then((r) => r.plan)

export const applyScaling = (app: string, env: string, intent: ScalingIntent, fingerprint: string, confirm?: string) =>
  call<ScalingResult>('POST', '/api/catalog/scaling', { app, env, intent, fingerprint, ...(confirm ? { confirm } : {}) })

export const settleScaling = (app: string, env: string) =>
  call<{ ok: true; noop?: boolean; replicas: number }>('POST', '/api/catalog/scaling/settle', { app, env })

/* ─────────── changes in flight ─────────── */

const ops = new Map<string, ScalingOp>()
const listeners = new Set<() => void>()
const opKey = (app: string, env: string) => `${app}\u0000${env}`

function emit() {
  for (const l of listeners) l()
}

export function setScalingOp(op: ScalingOp) {
  ops.set(opKey(op.app, op.env), op)
  emit()
}

export function patchScalingOp(app: string, env: string, patch: Partial<ScalingOp>) {
  const cur = ops.get(opKey(app, env))
  if (!cur) return
  ops.set(opKey(app, env), { ...cur, ...patch })
  emit()
}

export function clearScalingOp(app: string, env: string) {
  if (ops.delete(opKey(app, env))) emit()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useScalingOp(app: string, env: string): ScalingOp | undefined {
  return useSyncExternalStore(subscribe, () => ops.get(opKey(app, env)), () => undefined)
}
