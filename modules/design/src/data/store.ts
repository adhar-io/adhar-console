/**
 * REAL persistence for the Design module.
 *
 * Every design artifact — ADRs, diagrams, whiteboards, personas, journey maps,
 * wireframes, the design-token set, and API specs — is a tenant-scoped document
 * persisted through the console's Postgres-backed document store (`docStore`,
 * one collection per `kind`). This module wraps `docStore` in a small set of
 * TanStack Query hooks; there is NO localStorage and NO stub fallback. If the
 * store is unavailable, `docStore` throws a `DocStoreError` that propagates
 * through the query's `error` so a view can render an error state — never fake
 * data.
 *
 * Documents keep their domain fields in the envelope's `data`; the canonical id
 * is always the document id (`StoredDoc.id`), which `fromDoc` folds back onto
 * the entity so the views can keep using `entity.id` unchanged.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, type StoredDoc } from '@adhar-console/shell-ui'

/* ───── kinds ───── */

/** docStore collection names — one per design entity type. */
export const KIND = {
  adr: 'design.adr',
  diagram: 'design.diagram',
  board: 'design.board',
  persona: 'design.persona',
  journey: 'design.journey',
  wireframe: 'design.wireframe',
  tokenSet: 'design.token-set',
  apiSpec: 'design.api-spec',
} as const

/** Well-known id for the single, workspace-wide design-token document. */
export const TOKEN_SET_ID = 'default'

/* ───── id helper (still used by views for sub-entity ids) ───── */

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/* ───── envelope <-> entity mapping ───── */

/** Every collection entity carries a string `id`. */
export interface Entity {
  id: string
}

type Data = Record<string, unknown>

/** Strip the client-facing `id`; the document id is the source of truth. */
function stripId<T extends Entity>(entity: T): Data {
  const clone: Data = { ...(entity as unknown as Data) }
  delete clone.id
  return clone
}

/** Fold the document id back onto the stored payload. */
function fromDoc<T extends Entity>(doc: StoredDoc<Data>): T {
  return { ...doc.data, id: doc.id } as unknown as T
}

async function listDocs<T extends Entity>(kind: string): Promise<T[]> {
  const docs = await docStore.list<Data>(kind)
  return docs
    .map((d) => fromDoc<T>(d))
    // Newest-first, matching the old store's insert-at-front behaviour.
    .sort((a, b) => (a.id < b.id ? 1 : -1))
}

async function createDoc<T extends Entity>(kind: string, entity: T): Promise<T> {
  const doc = await docStore.create<Data>(kind, stripId(entity))
  return fromDoc<T>(doc)
}

async function putDoc<T extends Entity>(kind: string, entity: T): Promise<T> {
  const doc = await docStore.put<Data>(kind, entity.id, stripId(entity))
  return fromDoc<T>(doc)
}

/* ───── collection hooks ───── */

const listKey = (kind: string) => ['design', kind] as const

export interface CollectionResult<T> {
  items: T[]
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

/** Live list of every document in a collection. */
export function useCollection<T extends Entity>(kind: string): CollectionResult<T> {
  const q = useQuery<T[], Error>({
    queryKey: listKey(kind),
    queryFn: () => listDocs<T>(kind),
    staleTime: 30_000,
  })
  return {
    items: q.data ?? [],
    isLoading: q.isLoading,
    error: q.error ?? null,
    refetch: () => void q.refetch(),
  }
}

/** Create a document; the server assigns the id, returned to the caller. */
export function useCreate<T extends Entity>(kind: string) {
  const qc = useQueryClient()
  return useMutation<T, Error, T>({
    mutationFn: (entity) => createDoc<T>(kind, entity),
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey(kind) }),
  })
}

/** Upsert a document at its own id. */
export function useUpdate<T extends Entity>(kind: string) {
  const qc = useQueryClient()
  return useMutation<T, Error, T>({
    mutationFn: (entity) => putDoc<T>(kind, entity),
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey(kind) }),
  })
}

/** Delete a document by id. */
export function useRemove(kind: string) {
  const qc = useQueryClient()
  return useMutation<boolean, Error, string>({
    mutationFn: (id) => docStore.remove(kind, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey(kind) }),
  })
}

/**
 * Seed a collection with example documents, one-time and on demand (e.g. a
 * "Load examples" button). Each seed keeps its own id via `put`, so any
 * cross-references between seeds (journey → persona) stay intact.
 */
export function useSeedExamples<T extends Entity>(kind: string) {
  const qc = useQueryClient()
  return useMutation<void, Error, T[]>({
    mutationFn: async (seeds) => {
      for (const seed of seeds) {
        await docStore.put<Data>(kind, seed.id, stripId(seed))
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey(kind) }),
  })
}

/* ───── single well-known document (design tokens) ───── */

const docKey = (kind: string, id: string) => ['design', kind, id] as const

export interface DocResult<T> {
  data: T | null
  isLoading: boolean
  error: Error | null
}

/** Read one well-known document by id (its raw `data`, no id folding). */
export function useDoc<T>(kind: string, id: string): DocResult<T> {
  const q = useQuery<T | null, Error>({
    queryKey: docKey(kind, id),
    queryFn: async () => {
      const doc = await docStore.get<T>(kind, id)
      return doc ? doc.data : null
    },
    staleTime: 30_000,
  })
  return {
    data: q.data ?? null,
    isLoading: q.isLoading,
    error: q.error ?? null,
  }
}

/** Upsert one well-known document by id. */
export function useUpsertDoc<T>(kind: string, id: string) {
  const qc = useQueryClient()
  return useMutation<T, Error, T>({
    mutationFn: async (data) => {
      const doc = await docStore.put<T>(kind, id, data)
      return doc.data
    },
    onSuccess: (data) => qc.setQueryData(docKey(kind, id), data),
  })
}
