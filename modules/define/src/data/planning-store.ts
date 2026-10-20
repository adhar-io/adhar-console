import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, DocStoreError, type StoredDoc } from '@adhar/shell-ui'
import type { Absence, DayKey, HealthOverride, Metric, SlaPolicy, SprintSnapshot } from './planning-model.ts'
import type { AutomationRule, WorkflowRules } from './planning-workflow.ts'
import type { Release } from './planning-releases.ts'

/**
 * What Define keeps in the console's own store — everything Plane's public
 * API cannot hold — keyed by Plane ids. Tenant-scoped, Postgres-backed
 * (`/api/store/<kind>/<id>`); when the console has no database these reads
 * fail with `DocStoreError` and the views say so instead of inventing data.
 *
 *   define.project     id = Plane project   health override, Adhar project/team
 *                                            link, notification prefs, estimate scale
 *   define.workflow    id = Plane project   transition rules (console-enforced)
 *   define.automation  id = Plane project   automation rules, watched repos, run log
 *   define.sprintplan  id = Plane cycle     goal, capacity, daily snapshots,
 *                                            commitment, retrospective
 *   define.points      id = Plane project   story points per work item
 *   define.release     id = generated       releases / versions
 *   define.intake      id = Plane project   triage SLA policy, form settings
 *   define.member      id = Plane user      weekly capacity, absences
 *   define.membership  id = project.user    ProjectMember pk (role change / removal)
 *   define.epic        id = Plane module    linked OKRs and releases
 */

export const KIND = {
  project: 'define.project',
  workflow: 'define.workflow',
  automation: 'define.automation',
  // `define.sprint` is the work-item views' own (goal + total capacity);
  // sprint planning keeps its richer record apart so neither clobbers the other.
  sprint: 'define.sprintplan',
  points: 'define.points',
  release: 'define.release',
  intake: 'define.intake',
  member: 'define.member',
  membership: 'define.membership',
  epic: 'define.epic',
} as const

/* ───── document shapes ───── */

export interface NotificationPrefs {
  sprintStarted?: boolean
  sprintCompleted?: boolean
  intakeBreached?: boolean
  releaseShipped?: boolean
  releaseDue?: boolean
  /** Send to everyone in the organization rather than only the actor. */
  broadcast?: boolean
}

export interface EstimateScale {
  kind: 'fibonacci' | 'linear' | 'powers' | 'tshirt' | 'custom'
  values: number[]
  /** Labels for t-shirt sizes, same order as values. */
  labels?: string[]
}

export const ESTIMATE_PRESETS: Record<Exclude<EstimateScale['kind'], 'custom'>, EstimateScale> = {
  fibonacci: { kind: 'fibonacci', values: [1, 2, 3, 5, 8, 13, 21] },
  linear: { kind: 'linear', values: [1, 2, 3, 4, 5, 6, 7, 8] },
  powers: { kind: 'powers', values: [1, 2, 4, 8, 16, 32] },
  tshirt: { kind: 'tshirt', values: [1, 2, 3, 5, 8], labels: ['XS', 'S', 'M', 'L', 'XL'] },
}

export interface ProjectMeta {
  healthOverride?: HealthOverride | null
  /** Adhar workspace project slug this Plane project belongs to. */
  adharProject?: string | null
  /** Adhar team slugs, when linked directly rather than through a project. */
  teams?: string[]
  notifications?: NotificationPrefs
  estimate?: EstimateScale
  /** Default sprint length in days for "Start sprint". */
  sprintDays?: number
}

export interface AutomationDoc {
  rules: AutomationRule[]
  /** `org/repo` Gitea repositories watched for linked pull requests. */
  repos?: string[]
  /** PR keys (`org/repo#12:merged`) already acted on. */
  processed?: string[]
  log?: Array<{ at: string; rule: string; issue: string; summary: string }>
}

export interface Retro {
  well?: string
  improve?: string
  actions?: string
  /** 1–5 team mood, optional. */
  mood?: number
}

export interface SprintMeta {
  project: string
  goal?: string
  metric?: Metric
  /** Capacity per Plane user id, in the sprint's metric. */
  capacity?: Record<string, number>
  snapshots?: Record<DayKey, SprintSnapshot>
  /** Recorded at "Start sprint" — the committed scope. */
  commitment?: { ids: string[]; points?: Record<string, number>; at: string }
  startedAt?: string
  completedAt?: string
  /** Cycle the unfinished work went to, or 'backlog'. */
  carriedTo?: string
  retro?: Retro
}

export interface IntakeMeta {
  sla?: SlaPolicy
  /** Shareable request-form note shown with the intake link. */
  formNote?: string
}

export interface MemberMeta {
  /** Points per week this person can take on. */
  weeklyCapacity?: number
  absences?: Absence[]
}

export interface MembershipDoc {
  project: string
  member: string
  /** ProjectMember pk from Plane's POST response. */
  pk: string
  role: number
}

export interface EpicMeta {
  project: string
  okrs?: string[]
  releases?: string[]
}

/* ───── errors ───── */

export function storeError(e: unknown): string {
  if (e instanceof DocStoreError) {
    if (e.code === 'store_unavailable' || e.status === 503) return 'The console database is not configured, so console-side planning data (goals, capacity, releases, rules) cannot be saved or read.'
    if (e.status === 401) return 'Sign in again to load planning data.'
    if (e.status === 403) return 'You do not have permission to change planning data in this organization.'
    return e.message
  }
  return e instanceof Error ? e.message : 'The console store request failed.'
}

export function storeUnavailable(e: unknown): boolean {
  return e instanceof DocStoreError && (e.code === 'store_unavailable' || e.status === 503)
}

/* ───── generic hooks ───── */

const STALE = 30_000
const key = (kind: string, id?: string) => (id === undefined ? ['define-store', kind] : ['define-store', kind, id])

export function useStoreDoc<T>(kind: string, id: string | undefined) {
  return useQuery({
    queryKey: key(kind, id ?? ''),
    queryFn: async () => (await docStore.get<T>(kind, id!))?.data ?? null,
    enabled: !!id,
    staleTime: STALE,
    retry: (n, e) => !(e instanceof DocStoreError) && n < 2,
  })
}

export function useStoreList<T>(kind: string, enabled = true) {
  return useQuery({
    queryKey: key(kind),
    queryFn: () => docStore.list<T>(kind),
    staleTime: STALE,
    enabled,
    retry: (n, e) => !(e instanceof DocStoreError) && n < 2,
  })
}

/**
 * Read-modify-write against the latest stored copy, so two panels writing
 * different fields of one document (a goal and a snapshot) never clobber
 * each other.
 */
export async function patchDoc<T extends object>(kind: string, id: string, fn: (cur: T | null) => T): Promise<StoredDoc<T>> {
  const cur = await docStore.get<T>(kind, id)
  return docStore.put<T>(kind, id, fn(cur?.data ?? null))
}

export function useStorePatch<T extends object>(kind: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, fn }: { id: string; fn: (cur: T | null) => T }) => patchDoc<T>(kind, id, fn),
    onMutate: async ({ id, fn }) => {
      // Optimistic: the panel reflects the change before the round trip.
      await qc.cancelQueries({ queryKey: key(kind, id) })
      const prev = qc.getQueryData<T | null>(key(kind, id))
      qc.setQueryData(key(kind, id), fn(prev ?? null))
      return { prev }
    },
    onError: (_e, { id }, ctx) => {
      if (ctx) qc.setQueryData(key(kind, id), ctx.prev)
    },
    onSettled: (_d, _e, { id }) => {
      qc.invalidateQueries({ queryKey: key(kind, id) })
      qc.invalidateQueries({ queryKey: key(kind), exact: true })
    },
  })
}

export function useStoreRemove(kind: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(kind, id),
    onSettled: (_d, _e, id) => {
      qc.invalidateQueries({ queryKey: key(kind, id) })
      qc.invalidateQueries({ queryKey: key(kind), exact: true })
    },
  })
}

/* ───── typed bindings ───── */

export const useProjectMeta = (projectId?: string) => useStoreDoc<ProjectMeta>(KIND.project, projectId)
export const useProjectMetas = () => useStoreList<ProjectMeta>(KIND.project)
export const usePatchProjectMeta = () => useStorePatch<ProjectMeta>(KIND.project)

export const useWorkflowRules = (projectId?: string) => useStoreDoc<WorkflowRules>(KIND.workflow, projectId)
export const usePatchWorkflowRules = () => useStorePatch<WorkflowRules>(KIND.workflow)

export const useAutomationDoc = (projectId?: string) => useStoreDoc<AutomationDoc>(KIND.automation, projectId)
export const useAutomationDocs = () => useStoreList<AutomationDoc>(KIND.automation)
export const usePatchAutomation = () => useStorePatch<AutomationDoc>(KIND.automation)

export const useSprintMeta = (cycleId?: string) => useStoreDoc<SprintMeta>(KIND.sprint, cycleId)
/** The work-item views' sprint record (`define.sprint`: goal + total capacity), read for its goal. */
export const useWorkSprintDoc = (cycleId?: string) => useStoreDoc<{ goal?: string; capacity?: number | null }>('define.sprint', cycleId)
export const useSprintMetas = () => useStoreList<SprintMeta>(KIND.sprint)
export const usePatchSprintMeta = () => useStorePatch<SprintMeta>(KIND.sprint)

export const useIntakeMeta = (projectId?: string) => useStoreDoc<IntakeMeta>(KIND.intake, projectId)
export const usePatchIntakeMeta = () => useStorePatch<IntakeMeta>(KIND.intake)

export const useMemberMetas = () => useStoreList<MemberMeta>(KIND.member)
export const usePatchMemberMeta = () => useStorePatch<MemberMeta>(KIND.member)

export const useMemberships = () => useStoreList<MembershipDoc>(KIND.membership)
export const usePatchMembership = () => useStorePatch<MembershipDoc>(KIND.membership)
export const useRemoveMembershipDoc = () => useStoreRemove(KIND.membership)
export const membershipId = (project: string, member: string) => `${project}.${member}`

export const useEpicMetas = () => useStoreList<EpicMeta>(KIND.epic)
export const usePatchEpicMeta = () => useStorePatch<EpicMeta>(KIND.epic)

export const useReleaseDocs = () => useStoreList<Omit<Release, 'id'>>(KIND.release)
export const usePatchRelease = () => useStorePatch<Omit<Release, 'id'>>(KIND.release)
export const useRemoveRelease = () => useStoreRemove(KIND.release)

/** Releases as flat records (the doc id is the release id). */
export function toReleases(docs: Array<StoredDoc<Omit<Release, 'id'>>> | undefined, project?: string): Release[] {
  return (docs ?? [])
    .map((d) => ({ ...d.data, id: d.id, issues: d.data.issues ?? [] }))
    .filter((r) => !project || r.project === project)
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ───── story points (exported for the issue views) ───── */

export function useIssuePoints(projectId?: string) {
  const q = useStoreDoc<{ points: Record<string, number> }>(KIND.points, projectId)
  return { ...q, points: q.data?.points ?? {} }
}

/** Record (or clear with null) a work item's story points in the console store. */
export function useSetIssuePoints(projectId?: string) {
  const patch = useStorePatch<{ points: Record<string, number> }>(KIND.points)
  return useMutation({
    mutationFn: async ({ issue, points }: { issue: string; points: number | null }) => {
      if (!projectId) throw new Error('Pick a project first.')
      await patch.mutateAsync({
        id: projectId,
        fn: (cur) => {
          const next = { ...(cur?.points ?? {}) }
          if (points === null) delete next[issue]
          else next[issue] = points
          return { points: next }
        },
      })
    },
  })
}

/* ───── OKRs (read-only, owned by the OKR view) ───── */

export interface OkrRef {
  id: string
  title: string
  quarter?: string
  project?: string
}

export function useOkrRefs() {
  const q = useStoreList<{ title?: string; quarter?: string; project?: string }>('okr.objective')
  return { ...q, refs: (q.data ?? []).map((d) => ({ id: d.id, title: d.data.title ?? d.id, quarter: d.data.quarter, project: d.data.project })) as OkrRef[] }
}
