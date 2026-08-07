import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, type StatusKind, type StoredDoc } from '@adhar-console/shell-ui'

/**
 * OKRs (Objectives → Key Results) for the Define module.
 *
 * Objectives are REAL, tenant-scoped documents persisted through the console's
 * Postgres-backed document store (`docStore`, kind `okr.objective`). One
 * document per objective; the objective's key results live inside the
 * document's `data`. There is no stub fallback — if the store is unavailable
 * the list query surfaces the `DocStoreError` so the view can show an error
 * state, never fake data.
 *
 * Progress rolls up from each objective's key results; status is pace-aware —
 * it compares realized progress against how much of the quarter has elapsed.
 */

/* ───── types ───── */

export type OkrStatus = 'on-track' | 'at-risk' | 'off-track'

export interface KeyResult {
  id: string
  title: string
  /** Unit label rendered after the numbers — '%', 'ms', 'users', '$k'… */
  unit: string
  /** Baseline the KR started from (supports decreasing metrics). */
  start: number
  /** Goal value. May be lower than `start` for "reduce" metrics. */
  target: number
  /** Latest measured value. */
  current: number
}

export interface Objective {
  id: string
  project: string
  title: string
  description?: string
  /** Owning member id — resolved against `useMembers()` in the view. */
  ownerId: string
  /** Quarter tag, e.g. `2026-Q3`. */
  quarter: string
  key_results: KeyResult[]
  created_at: string
  updated_at: string
}

/* ───── progress + status math ───── */

/** KR completion in 0–100, direction-aware and clamped. */
export function krProgress(kr: KeyResult): number {
  const span = kr.target - kr.start
  if (span === 0) return kr.current >= kr.target ? 100 : 0
  const pct = ((kr.current - kr.start) / span) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** Objective progress = mean of its KR progress. */
export function objectiveProgress(o: Objective): number {
  if (!o.key_results.length) return 0
  const sum = o.key_results.reduce((acc, kr) => acc + krProgress(kr), 0)
  return Math.round(sum / o.key_results.length)
}

/** [start, end) date bounds for a `YYYY-Qn` quarter tag. */
export function quarterRange(quarter: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter)
  if (!m) return null
  const year = Number(m[1])
  const q = Number(m[2])
  const startMonth = (q - 1) * 3
  return {
    start: new Date(year, startMonth, 1),
    end: new Date(year, startMonth + 3, 1),
  }
}

/** Fraction 0–1 of the quarter elapsed as of now (0 future, 1 past). */
function quarterElapsed(quarter: string): number {
  const range = quarterRange(quarter)
  if (!range) return 0.5
  const now = Date.now()
  const total = range.end.getTime() - range.start.getTime()
  const done = now - range.start.getTime()
  return Math.max(0, Math.min(1, done / total))
}

/**
 * Pace-aware status: compare realized progress against the share of the
 * quarter already elapsed. Comfortably ahead → on-track, moderately behind
 * → at-risk, badly behind → off-track. Past quarters judge on raw completion.
 */
export function objectiveStatus(o: Objective): OkrStatus {
  const progress = objectiveProgress(o)
  const elapsed = quarterElapsed(o.quarter)
  // Fully-elapsed quarter: judge on absolute attainment.
  const expected = elapsed >= 1 ? 100 : elapsed * 100
  const delta = progress - expected
  if (delta >= -10) return 'on-track'
  if (delta >= -25) return 'at-risk'
  return 'off-track'
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

/* ───── document store binding ───── */

/** docStore kind under which each objective is persisted (one doc per objective). */
const KIND = 'okr.objective'

const REFRESH_MS = 30_000

let idCounter = 1
function uid(prefix: string): string {
  return `${prefix}-${idCounter++}-${Math.random().toString(36).slice(2, 7)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * The domain fields stored inside a document's `data`. The document `id`,
 * `createdAt`, and `updatedAt` live on the envelope and are flattened back
 * into the `Objective` shape the view expects by `fromDoc`.
 */
export interface ObjectiveData {
  project: string
  title: string
  description?: string
  ownerId: string
  quarter: string
  key_results: KeyResult[]
}

/** Flatten a stored document into the `Objective` shape the view consumes. */
function fromDoc(doc: StoredDoc<ObjectiveData>): Objective {
  return {
    id: doc.id,
    project: doc.data.project,
    title: doc.data.title,
    description: doc.data.description,
    ownerId: doc.data.ownerId,
    quarter: doc.data.quarter,
    key_results: (doc.data.key_results ?? []).map((kr) => ({ ...kr })),
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  }
}

/* ───── payloads ───── */

export interface ObjectiveDraft {
  title: string
  description?: string
  ownerId: string
  quarter: string
  key_results: Array<Omit<KeyResult, 'id'> & { id?: string }>
}

/** Normalize a draft's key results, assigning ids to any new ones. */
function normalizeKrs(krs: ObjectiveDraft['key_results']): KeyResult[] {
  return krs.map((kr) => ({
    id: kr.id ?? uid('kr'),
    title: kr.title,
    unit: kr.unit,
    start: kr.start,
    target: kr.target,
    current: kr.current,
  }))
}

/** Build the persisted `data` payload for a draft under a project. */
function toData(project: string, draft: ObjectiveDraft): ObjectiveData {
  return {
    project,
    title: draft.title,
    description: draft.description,
    ownerId: draft.ownerId,
    quarter: draft.quarter,
    key_results: normalizeKrs(draft.key_results),
  }
}

/** List objectives for a project. The store is tenant-scoped, so filter here. */
async function listObjectives(project: string): Promise<Objective[]> {
  const docs = await docStore.list<ObjectiveData>(KIND)
  return docs
    .filter((d) => d.data.project === project)
    .map(fromDoc)
    // Newest first, matching the old store's insert-at-front behavior.
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
}

async function createObjective(project: string, draft: ObjectiveDraft): Promise<Objective> {
  const doc = await docStore.create<ObjectiveData>(KIND, toData(project, draft))
  return fromDoc(doc)
}

async function updateObjective(
  project: string,
  id: string,
  draft: ObjectiveDraft,
): Promise<Objective> {
  const doc = await docStore.put<ObjectiveData>(KIND, id, toData(project, draft))
  return fromDoc(doc)
}

async function deleteObjective(id: string): Promise<boolean> {
  return docStore.remove(KIND, id)
}

/* ───── hooks ───── */

const key = (project?: string) => ['okr', 'objectives', project] as const

export function useObjectives(projectId?: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => listObjectives(projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useCreateObjective(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (draft: ObjectiveDraft) => createObjective(projectId!, draft),
    onMutate: async (draft) => {
      await qc.cancelQueries({ queryKey: key(projectId) })
      const prev = qc.getQueryData<Objective[]>(key(projectId))
      const ts = nowIso()
      const optimistic: Objective = {
        id: uid('obj-optimistic'),
        project: projectId!,
        title: draft.title,
        description: draft.description,
        ownerId: draft.ownerId,
        quarter: draft.quarter,
        created_at: ts,
        updated_at: ts,
        key_results: normalizeKrs(draft.key_results),
      }
      qc.setQueryData<Objective[]>(key(projectId), (old) => [optimistic, ...(old ?? [])])
      return { prev }
    },
    onError: (_e, _draft, ctx) => {
      if (ctx?.prev) qc.setQueryData(key(projectId), ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  })
}

export function useUpdateObjective(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: ObjectiveDraft }) =>
      updateObjective(projectId!, id, draft),
    onMutate: async ({ id, draft }) => {
      await qc.cancelQueries({ queryKey: key(projectId) })
      const prev = qc.getQueryData<Objective[]>(key(projectId))
      qc.setQueryData<Objective[]>(key(projectId), (old) =>
        (old ?? []).map((o) =>
          o.id === id
            ? {
                ...o,
                title: draft.title,
                description: draft.description,
                ownerId: draft.ownerId,
                quarter: draft.quarter,
                updated_at: nowIso(),
                key_results: normalizeKrs(draft.key_results),
              }
            : o,
        ),
      )
      return { prev }
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key(projectId), ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  })
}

export function useDeleteObjective(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteObjective(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key(projectId) })
      const prev = qc.getQueryData<Objective[]>(key(projectId))
      qc.setQueryData<Objective[]>(key(projectId), (old) => (old ?? []).filter((o) => o.id !== id))
      return { prev }
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key(projectId), ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  })
}
