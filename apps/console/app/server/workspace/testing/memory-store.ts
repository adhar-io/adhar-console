import type { DocumentQuery, Store, StoredDoc } from '../store.ts'
import type { DirectorySource } from '../../tenancy/directory.ts'
import { DIRECTORY_KIND, DIRECTORY_TENANT } from '../../tenancy/directory.ts'

/**
 * The console's document store in memory — the same `Store` surface
 * workspace/store.ts gives handlers, over a Map. Enough of `query` for the
 * audit trail and notifications (equals / startsWith / search / range / sort /
 * paging) so the code under test runs unchanged.
 */
export class MemoryDb {
  #docs = new Map<string, Map<string, StoredDoc<Record<string, unknown>>>>()
  /** Every user's preference documents, by scope then user. */
  prefs = new Map<string, Map<string, Record<string, unknown>>>()
  #clock = 0

  #bucket(tenant: string, kind: string) {
    const key = `${tenant}\u0000${kind}`
    let b = this.#docs.get(key)
    if (!b) this.#docs.set(key, (b = new Map()))
    return b
  }

  all<T>(tenant: string, kind: string): StoredDoc<T>[] {
    return [...this.#bucket(tenant, kind).values()] as unknown as StoredDoc<T>[]
  }

  put(tenant: string, kind: string, id: string, data: Record<string, unknown>, userId = 'test'): StoredDoc<Record<string, unknown>> {
    const b = this.#bucket(tenant, kind)
    const at = new Date(Date.UTC(2026, 0, 1) + ++this.#clock).toISOString()
    const prev = b.get(id)
    const doc = {
      id,
      data: structuredClone(data),
      createdBy: prev?.createdBy ?? userId,
      updatedBy: userId,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    }
    b.set(id, doc)
    return structuredClone(doc)
  }

  store(tenant: string): Store {
    const get = (path: string, data: unknown): unknown =>
      path.split('.').filter(Boolean).reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), data)
    const query = <T>(kind: string, q: DocumentQuery) => {
      let rows = this.all<Record<string, unknown>>(tenant, kind)
      for (const f of q.equals ?? []) rows = rows.filter((r) => String(get(f.path, r.data) ?? '') === f.value)
      for (const f of q.startsWith ?? []) {
        rows = rows.filter((r) => String(get(f.path, r.data) ?? '').toLowerCase().startsWith(f.value.toLowerCase()))
      }
      if (q.search?.text.trim()) {
        const needle = q.search.text.trim().toLowerCase()
        rows = rows.filter((r) => q.search!.paths.some((p) => String(get(p, r.data) ?? '').toLowerCase().includes(needle)))
      }
      if (q.range?.from || q.range?.to) {
        const val = (r: StoredDoc<Record<string, unknown>>) => String(q.range!.path ? get(q.range!.path, r.data) ?? '' : r.createdAt)
        if (q.range.from) rows = rows.filter((r) => val(r) >= q.range!.from!)
        if (q.range.to) rows = rows.filter((r) => val(r) <= q.range!.to!)
      }
      const key = (r: StoredDoc<Record<string, unknown>>) => String(q.sort?.path ? get(q.sort.path, r.data) ?? '' : r.createdAt)
      rows.sort((a, b) => (q.sort?.direction === 'asc' ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a))))
      return Promise.resolve({
        items: rows.slice(q.offset, q.offset + q.limit) as unknown as StoredDoc<T>[],
        total: rows.length,
      })
    }
    return {
      conn: null as never,
      mod: { touchUser: () => Promise.resolve() } as never,
      tenant,
      list: <T>(kind: string) => Promise.resolve(structuredClone(this.all<T>(tenant, kind))),
      query,
      get: <T>(kind: string, id: string) => {
        const doc = this.#bucket(tenant, kind).get(id)
        return Promise.resolve(doc ? (structuredClone(doc) as unknown as StoredDoc<T>) : null)
      },
      put: <T extends Record<string, unknown>>(kind: string, id: string, data: T, userId: string) =>
        Promise.resolve(this.put(tenant, kind, id, data, userId) as unknown as StoredDoc<T>),
      remove: (kind: string, id: string) => Promise.resolve(this.#bucket(tenant, kind).delete(id)),
    }
  }

  /** The organisation directory's source, over this database. */
  directorySource(): DirectorySource {
    return {
      listStored: () => Promise.resolve(this.all<Record<string, unknown>>(DIRECTORY_TENANT, DIRECTORY_KIND)),
      putStored: (slug, data, by) => {
        this.put(DIRECTORY_TENANT, DIRECTORY_KIND, slug, data, by)
        return Promise.resolve()
      },
      listRegistries: () =>
        Promise.resolve([...(this.prefs.get('organizations') ?? new Map()).entries()].map(([userId, data]) => ({ userId, data }))),
    }
  }

  setRegistry(userId: string, data: Record<string, unknown>): void {
    let scope = this.prefs.get('organizations')
    if (!scope) this.prefs.set('organizations', (scope = new Map()))
    scope.set(userId, structuredClone(data))
  }

  registry(userId: string): Record<string, unknown> | undefined {
    return this.prefs.get('organizations')?.get(userId)
  }
}
