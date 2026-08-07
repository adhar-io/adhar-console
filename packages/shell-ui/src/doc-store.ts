/**
 * Browser client for the console's tenant-scoped document store
 * (`/api/store/<kind>[/<id>]`, backed by Postgres — see the server's
 * `handleDocuments`). This is the REAL persistence the feature modules use for
 * their own domain entities (OKRs, saved views, custom roles, webhooks, design
 * docs, API specs) — there is no stub fallback: a missing/unconfigured database
 * surfaces as an error the caller must handle, never as silent fake data.
 *
 * Each module wraps these calls in its own TanStack Query hooks; this layer is
 * intentionally react-free so shell-ui carries no query dependency.
 */

export interface StoredDoc<T = Record<string, unknown>> {
  id: string
  data: T
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export class DocStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'DocStoreError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/store/${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let code: string | undefined
    try {
      code = ((await res.json()) as { error?: string }).error
    } catch {
      /* non-JSON error body */
    }
    throw new DocStoreError(
      code === 'store_unavailable'
        ? 'The console database is not available.'
        : `Store request failed (${res.status})`,
      res.status,
      code,
    )
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const docStore = {
  /** All documents of a kind for the caller's tenant (oldest-first). */
  async list<T = Record<string, unknown>>(kind: string): Promise<StoredDoc<T>[]> {
    const { items } = await request<{ items: StoredDoc<T>[] }>(enc(kind))
    return items
  },

  /** One document by id, or null if it doesn't exist. */
  async get<T = Record<string, unknown>>(kind: string, id: string): Promise<StoredDoc<T> | null> {
    try {
      const { item } = await request<{ item: StoredDoc<T> }>(`${enc(kind)}/${enc(id)}`)
      return item
    } catch (e) {
      if (e instanceof DocStoreError && e.status === 404) return null
      throw e
    }
  },

  /** Create a document (server assigns the id unless `data.id` is a valid slug). */
  async create<T = Record<string, unknown>>(kind: string, data: T): Promise<StoredDoc<T>> {
    const { item } = await request<{ item: StoredDoc<T> }>(enc(kind), {
      method: 'POST',
      body: JSON.stringify({ data }),
    })
    return item
  },

  /** Upsert a document at an explicit id. */
  async put<T = Record<string, unknown>>(kind: string, id: string, data: T): Promise<StoredDoc<T>> {
    const { item } = await request<{ item: StoredDoc<T> }>(`${enc(kind)}/${enc(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    })
    return item
  },

  /** Delete a document. Returns true when a row was removed. */
  async remove(kind: string, id: string): Promise<boolean> {
    const { ok } = await request<{ ok: boolean }>(`${enc(kind)}/${enc(id)}`, { method: 'DELETE' })
    return ok
  },
}
