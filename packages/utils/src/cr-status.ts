/**
 * Health of an arbitrary custom resource, read the way its operator reports
 * it. Operators disagree on shape — Argo CD writes `status.health.status`,
 * Crossplane and most controller-runtime operators write conditions
 * (`Ready`, `Synced`, `Available`, `Succeeded`), others a `status.phase` —
 * so this checks each in turn and says which one it used.
 *
 * Shared by every remote that shows a custom resource's health (the Platform
 * module's Explore/XR views and Develop → Functions read the same answer).
 * No I/O; `modules/platform/src/data/crd-status_test.ts` covers the shapes the
 * platform's operators use.
 */

export type CrHealth = 'healthy' | 'progressing' | 'degraded' | 'unknown'

export interface CrStatus {
  health: CrHealth
  label: string
  /** The operator's own explanation of the health, when it gives one. */
  message?: string
  /** Secondary state worth showing beside it (Argo CD's sync status). */
  note?: string
}

interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
}

const GOOD = new Set(['healthy', 'succeeded', 'steady', 'active', 'ready', 'running', 'bound', 'established', 'completed', 'available', 'synced', 'valid', 'deployed', 'cluster in healthy state'])
const BAD = new Set(['failed', 'error', 'degraded', 'missing', 'invalid', 'crashloopbackoff', 'unhealthy', 'aborted'])
const BUSY = new Set(['progressing', 'pending', 'running…', 'creating', 'deleting', 'terminating', 'new', 'inprogress', 'in progress', 'waiting', 'suspended', 'paused', 'outofsync', 'unknown'])

function fromWord(word: string, message?: string): CrStatus {
  const w = word.trim().toLowerCase()
  if (GOOD.has(w)) return { health: 'healthy', label: word, message }
  if (BAD.has(w) || w.includes('fail') || w.includes('error')) return { health: 'degraded', label: word, message }
  if (BUSY.has(w)) return { health: 'progressing', label: word, message }
  return { health: 'unknown', label: word, message }
}

/** Condition types that, when True, mean "this object is fine". */
const READY_TYPES = ['Ready', 'Available', 'Succeeded', 'Healthy', 'Established', 'Synced']

export function crStatus(obj: { status?: unknown }): CrStatus {
  const s = (obj.status ?? {}) as Record<string, unknown>

  const health = s.health as { status?: unknown; message?: unknown } | undefined
  if (health && typeof health === 'object' && typeof health.status === 'string') {
    // Argo CD rarely sets a health message; its sync state is the useful detail,
    // kept apart so a "Synced" note is never presented as the health reason.
    const sync = (s.sync as { status?: unknown; revision?: unknown } | undefined)
    const syncNote = typeof sync?.status === 'string'
      ? `${sync.status}${typeof sync.revision === 'string' && sync.revision ? ` at ${sync.revision.slice(0, 7)}` : ''}`
      : undefined
    const st = fromWord(health.status, typeof health.message === 'string' && health.message ? health.message : undefined)
    return syncNote ? { ...st, note: syncNote } : st
  }

  const conditions = Array.isArray(s.conditions) ? (s.conditions as Condition[]) : []
  if (conditions.length) {
    // A failing readiness condition outranks a passing one: Crossplane reports
    // Synced=True while Ready=False, and that object is not healthy.
    const ready = READY_TYPES.map((t) => conditions.find((c) => c.type === t)).filter(Boolean) as Condition[]
    const failing = ready.find((c) => c.status === 'False')
    if (failing) {
      const word = failing.reason || `${failing.type} false`
      const st = fromWord(word, failing.message)
      return { ...st, health: st.health === 'progressing' ? 'progressing' : 'degraded' }
    }
    const pending = ready.find((c) => c.status === 'Unknown')
    if (pending) return { health: 'progressing', label: pending.reason || `${pending.type}…`, message: pending.message }
    if (ready.length) return { health: 'healthy', label: ready[0].type!, message: ready[0].message }
    const stalled = conditions.find((c) => /stall|degrad|error|fail/i.test(c.type ?? '') && c.status === 'True')
    if (stalled) return { health: 'degraded', label: stalled.reason || stalled.type!, message: stalled.message }
  }

  if (typeof s.phase === 'string' && s.phase) return fromWord(s.phase, typeof s.message === 'string' ? s.message : undefined)
  if (typeof s.state === 'string' && s.state) return fromWord(s.state)
  return { health: 'unknown', label: 'No status' }
}
