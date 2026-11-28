import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { stringify } from 'yaml'
import { docStore, DocStoreError, type StoredDoc } from '@adhar/shell-ui'
import { parse, print } from '../model/doc.ts'
import { applyOp, DRAFT_EXPIRES_ANNOTATION, DRAFT_LABEL, draftExpiry, OpError } from '../model/ops.ts'
import type { ScopeNamespace } from './scope.ts'

/**
 * The designer's drafts (design 0026 §6.9, W2-C3). There are two, and they
 * are different things:
 *
 *  • the AUTOSAVE: what is on the canvas and not yet published, kept in the
 *    console database (kind `workflows.draft`, client-owned) so a closed tab
 *    or a crashed browser loses nothing. Keyed by user, namespace and template
 *    name. It holds the YAML text exactly as typed — never stamped, never
 *    reprinted — because that is what the person will publish.
 *
 *  • the CLUSTER draft a test run applies: a WorkflowTemplate in a dev
 *    namespace, labelled `adhar.io/workflow-draft: "true"` with
 *    `adhar.io/draft-expires` = now + 7 days (Kyverno #7; the janitor deletes
 *    it after). `prepareTestRun` stamps a COPY of the text for that; the
 *    person's document is untouched, so the label can never be published.
 *    The server stamps it again (and renames it `<name>-draft-<user>`):
 *    the browser is not trusted with either.
 *
 * Both travel as YAML TEXT. JSON made from parsed YAML is YAML 1.2 and the
 * API server reads YAML 1.1 (`mode: 0644`), so a JSON detour would test-run
 * something other than what Argo CD later applies.
 */

export const DRAFT_KIND = 'workflows.draft'
/** The autosave waits this long after the last edit. */
export const AUTOSAVE_MS = 1500

/** The store's id alphabet (`/api/store` ID_RE). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const part = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

/** FNV-1a, 32 bits, as 8 hex digits: enough to keep two lossy ids apart, no crypto needed. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(s)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * One autosave per user, namespace and template name. `<user>.<ns>.<name>`
 * when all three fit the store's alphabet as they are; otherwise each part is
 * folded and cut to fit and a hash of the EXACT triple is appended. Without
 * the hash, two templates whose names differ only after the cut (or only in
 * case or punctuation) shared one id, and the second one's autosave silently
 * replaced the first one's draft.
 */
export function draftId(user: string, namespace: string, name: string): string {
  // Without a user the key would be shared by everyone in the tenant.
  if (!user.trim()) throw new Error('A draft needs a signed-in user (no user).')
  const parts = [user, namespace, name]
  const plain = parts.join('.')
  const lossless = parts.every((p) => p !== '' && part(p) === p) && plain.length <= 128
  const id = lossless ? plain : `${part(user).slice(0, 32)}.${part(namespace).slice(0, 32)}.${part(name).slice(0, 48)}.${fnv1a(parts.join('\n'))}`
  if (!ID_RE.test(id)) throw new Error(`draft id ${id} is outside the store's alphabet`)
  return id
}

export interface DraftData {
  /** The YAML as typed. */
  text: string
  namespace: string
  name: string
  /** Where it began: a starter, an empty canvas, or a template on the cluster (its resourceVersion then). */
  origin: { from: 'starter' | 'empty' | 'template'; starter?: string; resourceVersion?: string }
  /** The signed-in user's id: the store is per tenant, so the id alone does not keep drafts apart. */
  user: string
  savedAt: string
}

export function readDraft(raw: unknown): DraftData | null {
  const r = raw && typeof raw === 'object' ? (raw as Partial<DraftData>) : null
  if (!r || typeof r.text !== 'string' || typeof r.namespace !== 'string' || typeof r.name !== 'string' || typeof r.user !== 'string') return null
  const o = r.origin && typeof r.origin === 'object' ? r.origin : { from: 'empty' as const }
  return { text: r.text, namespace: r.namespace, name: r.name, user: r.user, savedAt: typeof r.savedAt === 'string' ? r.savedAt : '', origin: o }
}

/** The person's own autosaves, newest first. */
export function myDrafts(items: readonly StoredDoc<unknown>[], user: string): Array<DraftData & { id: string }> {
  return items
    .map((d) => ({ id: d.id, data: readDraft(d.data) }))
    .filter((d): d is { id: string; data: DraftData } => d.data !== null && d.data.user === user)
    .map((d) => ({ id: d.id, ...d.data }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/**
 * The person's unsaved draft that a NEW canvas under this namespace and name
 * would land on. A draft is keyed by user, namespace and name, so starting
 * "nightly" again from the gallery — a starter, an empty canvas — wrote its
 * first autosave over the "nightly" they had not published yet. The gallery
 * offers that draft back instead.
 */
export function draftAt<T extends Pick<DraftData, 'namespace' | 'name'>>(drafts: readonly T[], namespace: string, name: string): T | undefined {
  return drafts.find((d) => d.namespace === namespace && d.name === name)
}

/**
 * True when a draft of a cluster template is resumed after that template
 * changed on the cluster (someone published, Argo CD synced): the draft was
 * started from version `origin.resourceVersion` and the cluster now holds
 * another. The draft is still what the person wrote, so it is shown — but they
 * are told, because publishing it would silently replace what changed. An
 * unknown current version (not readable, not found) says nothing.
 */
export function staleDraft(origin: DraftData['origin'], current: string | null | undefined): boolean {
  return origin.from === 'template' && Boolean(origin.resourceVersion) && Boolean(current) && current !== origin.resourceVersion
}

/**
 * The text a test run sends: the person's text with the draft label and a
 * fresh seven-day expiry, placed in `namespace` (where the test run goes).
 * Refuses what does not parse — it is never repaired.
 */
export function prepareTestRun(text: string, now: Date, namespace?: string): { ok: true; yaml: string; expires: string } | { ok: false; detail: string } {
  const doc = parse(text)
  if (doc.errors.length) return { ok: false, detail: `The YAML does not parse: ${doc.errors[0].message}` }
  const expires = draftExpiry(now)
  try {
    let r = applyOp(doc, { op: 'stampDraft', expires })
    // The draft lives where the test run goes; a namespace in the text that says otherwise would be refused by the server.
    if (namespace) r = applyOp(r.doc, { op: 'set', path: ['metadata', 'namespace'], value: namespace })
    return { ok: true, yaml: print(r.doc), expires }
  } catch (e) {
    if (e instanceof OpError) return { ok: false, detail: e.message }
    throw e
  }
}

const SERVER_FIELDS = ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'selfLink', 'managedFields', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'ownerReferences']
const SERVER_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration']

/**
 * A template read from the cluster, as YAML to open in the designer: what the
 * author wrote, without what the API server added (status, uid, managed
 * fields, the last-applied copy). Written as YAML 1.1 so a string the API
 * server would read as something else (`yes`, `0644`, `1e3`) is quoted.
 */
export function objectToYaml(obj: Record<string, unknown>): string {
  const meta = { ...((obj.metadata as Record<string, unknown> | undefined) ?? {}) }
  for (const k of SERVER_FIELDS) delete meta[k]
  const ann = { ...((meta.annotations as Record<string, string> | undefined) ?? {}) }
  for (const k of SERVER_ANNOTATIONS) delete ann[k]
  if (Object.keys(ann).length) meta.annotations = ann
  else delete meta.annotations
  const { status: _status, ...rest } = obj
  return stringify({ ...rest, metadata: meta }, { version: '1.1', lineWidth: 0 })
}

/** Keys a test-run text carries that a PUBLISHED template must not (W3's publish strips or refuses them). */
export const DRAFT_ONLY_KEYS = [DRAFT_LABEL, DRAFT_EXPIRES_ANNOTATION] as const

export interface TestRunTargets {
  /** Namespaces a draft may go to: tier dev. */
  dev: ScopeNamespace[]
  /** The rest, shown disabled with the reason. */
  other: ScopeNamespace[]
  /** The tier of these is not known here (the top-bar namespace); the server decides. */
  unknown: ScopeNamespace[]
}

/** Where a test run may go (§4.5: drafts only in `adhar.io/tier: dev`). The server checks the namespace's label itself. */
export function testRunTargets(namespaces: readonly ScopeNamespace[]): TestRunTargets {
  const out: TestRunTargets = { dev: [], other: [], unknown: [] }
  for (const n of namespaces) {
    const tier = n.tier ?? (n.role === 'environment' ? n.environment : undefined)
    if (n.role === 'platform') out.other.push(n)
    else if (tier === 'dev') out.dev.push(n)
    else if (tier) out.other.push(n)
    else out.unknown.push(n)
  }
  return out
}

/* ─────────────────────────── hooks ─────────────────────────── */

export type AutosaveState =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: string }
  /** The console has no database: say so once, keep working. */
  | { state: 'unavailable'; detail: string }
  | { state: 'error'; detail: string }

export const draftsKey = (user: string) => ['workflows', 'drafts', user]

export function useMyDrafts(user: string | undefined) {
  return useQuery({
    queryKey: draftsKey(user ?? ''),
    queryFn: async () => myDrafts(await docStore.list<unknown>(DRAFT_KIND), user!),
    enabled: Boolean(user),
    staleTime: 10_000,
    retry: false,
  })
}

interface Clock {
  set(f: () => void, ms: number): unknown
  clear(t: unknown): void
}

const realClock: Clock = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

/**
 * The autosave's debounce. A save still WAITING when the designer goes away
 * (back to the gallery, another section) is made then, not dropped: the
 * last 1.5 s of edits were otherwise lost on every close, with no warning
 * (`beforeunload` covers only the tab). A cancelled one is never made — a
 * discarded draft must not be written back on the way out.
 */
export class DebouncedSave {
  #timer: unknown = undefined
  constructor(private readonly run: () => void | Promise<void>, private readonly ms: number, private readonly clock: Clock = realClock) {}
  get pending(): boolean {
    return this.#timer !== undefined
  }
  schedule(): void {
    this.cancel()
    this.#timer = this.clock.set(() => {
      this.#timer = undefined
      void this.run()
    }, this.ms)
  }
  cancel(): void {
    if (this.#timer !== undefined) this.clock.clear(this.#timer)
    this.#timer = undefined
  }
  /** Make the waiting save now; nothing when none is waiting. */
  flush(): void | Promise<void> {
    if (this.#timer === undefined) return
    this.cancel()
    return this.run()
  }
}

/**
 * Save `data` under `id` once the edits stop for `AUTOSAVE_MS`. Nothing is
 * written until `dirty` (opening a template writes no draft), and a write
 * that fails is reported, not retried in a loop.
 */
export function useDraftAutosave(id: string | null, data: DraftData | null, dirty: boolean): { status: AutosaveState; flush(): Promise<void>; discard(): Promise<void> } {
  const [status, setStatus] = useState<AutosaveState>({ state: 'idle' })
  const qc = useQueryClient()
  const latest = useRef<{ id: string | null; data: DraftData | null }>({ id, data })
  latest.current = { id, data }
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const saver = useRef<DebouncedSave | null>(null)
  if (!saver.current) saver.current = new DebouncedSave(() => saveRef.current(), AUTOSAVE_MS)
  const save = useCallback(async () => {
    const { id: key, data: body } = latest.current
    if (!key || !body) return
    setStatus({ state: 'saving' })
    try {
      const savedAt = new Date().toISOString()
      await docStore.put<DraftData>(DRAFT_KIND, key, { ...body, savedAt })
      setStatus({ state: 'saved', at: savedAt })
      void qc.invalidateQueries({ queryKey: draftsKey(body.user) })
    } catch (e) {
      if (e instanceof DocStoreError && (e.code === 'store_unavailable' || e.status === 503)) setStatus({ state: 'unavailable', detail: 'The console database is not available, so unsaved work is kept only in this tab.' })
      else setStatus({ state: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
  }, [qc])
  saveRef.current = save
  const text = data?.text
  useEffect(() => {
    if (!id || !dirty || text === undefined) {
      saver.current?.cancel()
      return
    }
    saver.current?.schedule()
  }, [id, dirty, text])
  // Leaving the designer with a save still waiting: make it now.
  useEffect(() => () => void saver.current?.flush(), [])
  const flush = useCallback(async () => {
    saver.current?.cancel()
    await save()
  }, [save])
  const discard = useCallback(async () => {
    saver.current?.cancel()
    const { id: key, data: body } = latest.current
    if (!key) return
    try {
      await docStore.remove(DRAFT_KIND, key)
    } catch (e) {
      if (!(e instanceof DocStoreError && e.status === 404)) throw e
    }
    setStatus({ state: 'idle' })
    if (body) void qc.invalidateQueries({ queryKey: draftsKey(body.user) })
  }, [qc])
  return { status, flush, discard }
}
