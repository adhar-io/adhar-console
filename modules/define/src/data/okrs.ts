import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, type StatusKind, type StoredDoc } from '@adhar/shell-ui'
import { type Objective, type OkrStatus, upgradeObjective } from './okrs-model.ts'

export * from './okrs-model.ts'

/**
 * OKR persistence for the Define module.
 *
 * Objectives are tenant-scoped documents in the console's Postgres-backed
 * document store under the kind `okr.objective` (the kind the first OKR
 * release used — kept so existing objectives carry over; documents of that
 * release are upgraded on read by `upgradeObjective`). Plane has no goals
 * API, so this is console-side data and the view labels it that way.
 *
 * One query reads every objective of the tenant: alignment crosses projects
 * (a team objective aligns to a company one), and OKR sets are small.
 */

const KIND = 'okr.objective'
const REFRESH_MS = 60_000

export type ObjectiveData = Omit<Objective, 'id' | 'created_at' | 'updated_at'>

function fromDoc(doc: StoredDoc<ObjectiveData>): Objective {
  return upgradeObjective({
    ...(doc.data as ObjectiveData),
    project: doc.data.project ?? '',
    key_results: (doc.data.key_results ?? []).map((kr) => ({ ...kr })),
    id: doc.id,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  })
}

function toData(o: Objective | ObjectiveData): ObjectiveData {
  const { id: _i, created_at: _c, updated_at: _u, ...rest } = o as Objective
  return rest
}

const KEY = ['okr', 'objectives', 'all'] as const

export function useAllObjectives() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await docStore.list<ObjectiveData>(KIND)).map(fromDoc),
    staleTime: REFRESH_MS,
    retry: false,
  })
}

let seq = 1
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Create, replace and delete objectives with optimistic cache updates. */
export function useObjectiveMutations() {
  const qc = useQueryClient()
  const snapshot = async () => {
    await qc.cancelQueries({ queryKey: KEY })
    return qc.getQueryData<Objective[]>(KEY)
  }
  const rollback = (_e: unknown, _v: unknown, ctx?: { prev?: Objective[] }) => {
    if (ctx?.prev) qc.setQueryData(KEY, ctx.prev)
  }
  const settle = () => qc.invalidateQueries({ queryKey: KEY })
  return {
    create: useMutation({
      mutationFn: async (data: ObjectiveData) => fromDoc(await docStore.create<ObjectiveData>(KIND, data)),
      onMutate: async (data) => {
        const prev = await snapshot()
        const ts = new Date().toISOString()
        qc.setQueryData<Objective[]>(KEY, (old) => [...(old ?? []), { ...data, id: uid('obj-pending'), created_at: ts, updated_at: ts }])
        return { prev }
      },
      onError: rollback,
      onSettled: settle,
    }),
    save: useMutation({
      mutationFn: async (o: Objective) => fromDoc(await docStore.put<ObjectiveData>(KIND, o.id, toData(o))),
      onMutate: async (o) => {
        const prev = await snapshot()
        qc.setQueryData<Objective[]>(KEY, (old) => (old ?? []).map((x) => (x.id === o.id ? { ...o, updated_at: new Date().toISOString() } : x)))
        return { prev }
      },
      onError: rollback,
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => docStore.remove(KIND, id),
      onMutate: async (id) => {
        const prev = await snapshot()
        qc.setQueryData<Objective[]>(KEY, (old) => (old ?? []).filter((x) => x.id !== id && x.parentId !== id).concat(
          (old ?? []).filter((x) => x.parentId === id).map((x) => ({ ...x, parentId: undefined })),
        ))
        return { prev }
      },
      onError: rollback,
      onSettled: settle,
    }),
  }
}

export function statusMeta(s: OkrStatus): { label: string; kind: StatusKind } {
  switch (s) {
    case 'on-track':
      return { label: 'On track', kind: 'healthy' }
    case 'at-risk':
      return { label: 'At risk', kind: 'paused' }
    case 'off-track':
      return { label: 'Off track', kind: 'failed' }
  }
}
