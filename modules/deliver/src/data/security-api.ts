import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePollingInterval } from '@adhar/shell-ui'

/**
 * Browser client for the console server's `/api/security/*` — scan waivers,
 * scan policy and the manual scan gate (`apps/console/app/server/scan-waivers.ts`).
 *
 * The server is the gate for every decision (roles, self-approval, policy
 * maximum, RBAC on the ConfigMap write); these hooks only carry requests and
 * surface what it answered. The record shapes mirror the server's
 * `scan-waivers-model.ts` — keep them in step.
 */

export * from './security-types.ts'
import type { ConfigMapWrite, GatesResponse, PolicyResponse, ScanPolicy, VexJustification, VexStatus, Waiver, WaiverKind, WaiversResponse, WaiverScope, WaiverStatus, WaiverTarget } from './security-types.ts'

/** A refusal from the server, with its machine code and the sentence to show. */
export class SecurityApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'SecurityApiError'
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/security/${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`
    throw new SecurityApiError(detail, res.status, typeof body.error === 'string' ? body.error : undefined)
  }
  return body as T
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const securityKeys = {
  waivers: ['security', 'waivers'] as const,
  policy: (project?: string) => ['security', 'policy', project ?? '*'] as const,
  gates: (ns?: string, name?: string) => ['security', 'gates', ns ?? '*', name ?? '*'] as const,
}

/** Every waiver of the tenant (the server sweeps expiries on read). */
export function useWaivers() {
  return useQuery({
    queryKey: securityKeys.waivers,
    queryFn: () => call<WaiversResponse>('waivers'),
    refetchInterval: usePollingInterval(30_000),
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof SecurityApiError && e.status < 500) && n < 1,
  })
}

export function usePolicy(project?: string) {
  return useQuery({
    queryKey: securityKeys.policy(project),
    queryFn: () => call<PolicyResponse>(`policy${project ? `?project=${encodeURIComponent(project)}` : ''}`),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

export function useGates(namespace?: string, name?: string, enabled = true) {
  const qs = namespace && name ? `?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}` : ''
  return useQuery({
    queryKey: securityKeys.gates(namespace, name),
    queryFn: () => call<GatesResponse>(`gates${qs}`),
    refetchInterval: usePollingInterval(20_000),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  })
}

export interface WaiverRequestInput {
  kind: WaiverKind
  scope: WaiverScope
  target: WaiverTarget
  findingId: string
  severity?: string
  title?: string
  justification: string
  vex: { status: VexStatus; justification?: VexJustification; impact?: string }
  falsePositive?: boolean
  expiresAt: string
  comment?: string
}

function useInvalidateSecurity() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['security'] })
}

export function useRequestWaiver() {
  const invalidate = useInvalidateSecurity()
  return useMutation({
    mutationFn: (body: WaiverRequestInput) => post<{ ok: boolean; item: Waiver }>('waivers', body),
    onSuccess: invalidate,
  })
}

export type WaiverActionName = 'approve' | 'reject' | 'revoke' | 'withdraw' | 'comment' | 'extend'

export interface WaiverActionInput {
  id: string
  action: WaiverActionName
  comment?: string
  selfApproveReason?: string
  expiresAt?: string
  justification?: string
}

export interface WaiverActionResult {
  ok: boolean
  item: Waiver
  created?: Waiver
  writes: ConfigMapWrite[]
}

export function useWaiverAction() {
  const invalidate = useInvalidateSecurity()
  return useMutation({
    mutationFn: ({ id, action, ...body }: WaiverActionInput) => post<WaiverActionResult>(`waivers/${encodeURIComponent(id)}/${action}`, body),
    onSuccess: invalidate,
  })
}

export interface BulkResult {
  ok: boolean
  results: Array<{ id: string; ok: boolean; status?: WaiverStatus; detail?: string }>
  writes: ConfigMapWrite[]
}

export function useBulkWaivers() {
  const invalidate = useInvalidateSecurity()
  return useMutation({
    mutationFn: (body: { ids: string[]; action: 'approve' | 'reject' | 'revoke'; comment?: string }) => post<BulkResult>('waivers/bulk', body),
    onSuccess: invalidate,
  })
}

export function useResyncWaivers() {
  const invalidate = useInvalidateSecurity()
  return useMutation({
    mutationFn: (body: { project?: string; global?: boolean } = {}) => post<{ ok: boolean; writes: ConfigMapWrite[] }>('waivers/sync', body),
    onSuccess: invalidate,
  })
}

export function useSavePolicy() {
  const invalidate = useInvalidateSecurity()
  return useMutation({
    mutationFn: (body: { scope: 'global' | 'project'; project?: string; policy: ScanPolicy }) =>
      call<{ ok: boolean; write: ConfigMapWrite; policy: ScanPolicy }>('policy', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })
}

export interface GateDecisionInput {
  namespace: string
  name: string
  decision: 'approved' | 'rejected'
  comment: string
  project?: string
  waiver?: {
    findings: Array<{ findingId: string; package?: string; purl?: string; severity?: string; kind?: WaiverKind; version?: string }>
    expiresAt: string
    justification: string
    vex: { status: VexStatus; justification?: VexJustification }
  }
}

export function useDecideGate() {
  const invalidate = useInvalidateSecurity()
  return useMutation({
    mutationFn: (body: GateDecisionInput) => post<{ ok: boolean; decision: string; waivers: Waiver[]; writes: ConfigMapWrite[]; persisted: boolean }>('gate', body),
    onSuccess: invalidate,
  })
}

/** One sentence about ConfigMap writes for a toast — honest about refusals. */
export function describeWrites(writes: ConfigMapWrite[] | undefined): { ok: boolean; text?: string } {
  if (!writes?.length) return { ok: true }
  const bad = writes.filter((w) => !w.ok)
  if (bad.length) return { ok: false, text: `Recorded, but ${bad.map((w) => `${w.namespace}/${w.name}: ${w.detail}`).join('; ')}. CI keeps the previous waiver list until a reviewer re-syncs.` }
  const changed = writes.filter((w) => w.changed)
  return { ok: true, text: changed.length ? `Updated ${changed.map((w) => `${w.namespace}/${w.name}`).join(', ')}.` : 'Waiver ConfigMaps already up to date.' }
}
