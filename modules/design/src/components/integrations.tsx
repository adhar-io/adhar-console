import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Checkbox, Modal, Select, Spinner, useGiteaOrg, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { ComponentLink, DesignReview, PlaneLink, RepoPullRef, ReviewState } from '../data/types.ts'
import { type IssueInfo, useCreateWorkItems, usePlaneIssueIndex, usePlaneItemUrl, usePlaneTarget } from '../data/plane.ts'
import type { IssueStatus, PlaneDraft } from '../data/plane-map.ts'
import { analyticsProblem, type Cohort, useCohorts } from '../data/analytics.ts'
import { giteaClient } from '../data/designer-repos.ts'
import { useAiConfigured } from '../data/ai.ts'
import { IconArrowRight, IconX } from './ux-kit.tsx'

/* ───────────────────────────── Plane ───────────────────────────── */

const STATUS_TONE: Record<IssueStatus, string> = {
  backlog: 'bg-surface-sunken text-content-muted ring-edge-default',
  todo: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300',
  'in-progress': 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
  done: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  cancelled: 'bg-surface-sunken text-content-subtle line-through ring-edge-default',
  unknown: 'bg-surface-sunken text-content-subtle ring-edge-default',
}

export function IssueStateChip({ info, missing }: { info?: IssueInfo; missing?: boolean }) {
  if (missing) {
    return <span className="inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-content-subtle ring-1 ring-inset ring-edge-default" title="Not found in Plane — deleted or moved">not found</span>
  }
  if (!info) return null
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset', STATUS_TONE[info.status])}>
      {info.stateColor ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: info.stateColor }} aria-hidden /> : null}
      {info.stateName ?? info.status}
    </span>
  )
}

/**
 * Linked Plane work items with their live state. Shows nothing when there are
 * no links; says so honestly when Plane can't be read.
 */
export function PlaneLinksList({
  links,
  onUnlink,
  compact,
  label = 'Work items',
}: {
  links: PlaneLink[]
  onUnlink?(l: PlaneLink): void
  compact?: boolean
  label?: string
}) {
  const { index, loading, error } = usePlaneIssueIndex(links)
  const url = usePlaneItemUrl()
  if (!links.length) return null
  const sorted = [...links].sort((a, b) => Number(!!b.parent) - Number(!!a.parent) || b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="space-y-1.5">
      {compact ? null : (
        <div className="flex items-center gap-2 text-[11px] text-content-subtle">
          <span className="font-semibold uppercase tracking-wide">{label}</span>
          <span className="tabular-nums">{links.length}</span>
          {loading ? <Spinner size={11} /> : null}
          {error ? <span className="text-amber-700 dark:text-amber-300">Plane state unavailable: {error.message}</span> : null}
        </div>
      )}
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
        {sorted.map((l) => {
          const info = index.get(l.issueId)
          const href = url(l)
          const missing = !loading && !error && !info
          return (
            <li key={`${l.projectId}:${l.issueId}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="w-16 shrink-0 font-mono text-[10px] text-content-subtle">{info?.key ?? l.key ?? '—'}</span>
              <span className={cn('min-w-0 flex-1 truncate text-content', l.parent && 'font-medium')}>
                {l.parent ? <span className="mr-1 text-[10px] uppercase tracking-wide text-content-subtle">Parent</span> : null}
                {info?.name ?? l.name}
              </span>
              <IssueStateChip info={info} missing={missing} />
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="shrink-0 rounded p-0.5 text-content-subtle hover:text-content" title="Open in Plane" aria-label="Open in Plane">
                  <IconArrowRight size={11} />
                </a>
              ) : null}
              {onUnlink ? (
                <button type="button" onClick={() => onUnlink(l)} className="shrink-0 rounded p-0.5 text-content-subtle hover:text-rose-600" title="Unlink (keeps the item in Plane)" aria-label="Unlink">
                  <IconX size={11} />
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Confirm-then-create for a batch of work items. Every draft is listed and
 * can be unticked; the Plane project is chosen (and remembered per scope);
 * items are created one by one and the result reports exactly what happened.
 */
export function CreateWorkItemsModal({
  open,
  onClose,
  title,
  drafts,
  parent,
  scope,
  backLink,
  onCreated,
  existingParent,
}: {
  open: boolean
  onClose(): void
  title: string
  drafts: PlaneDraft[]
  /** A parent created earlier — new items are added under it (same Plane project only). */
  existingParent?: PlaneLink
  /** Offer to group the items under a new parent item. */
  parent?: PlaneDraft
  scope: { slug?: string; name?: string } | undefined
  backLink?: string
  onCreated(links: PlaneLink[]): Promise<void> | void
}) {
  const target = usePlaneTarget(scope)
  const create = useCreateWorkItems()
  const toast = useToast()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [grouped, setGrouped] = useState(true)
  const [projectId, setProjectId] = useState('')

  useEffect(() => {
    if (!open) return
    setPicked(new Set(drafts.map((d) => d.source)))
    setGrouped((!!parent && drafts.length > 1) || !!existingParent)
  }, [open, drafts, parent])
  useEffect(() => {
    if (open) setProjectId(target.projectId ?? '')
  }, [open, target.projectId])

  const chosen = drafts.filter((d) => picked.has(d.source))
  const submit = async () => {
    if (!projectId || !chosen.length) return
    if (projectId !== target.projectId || !target.chosen) await target.setProjectId(projectId).catch(() => undefined)
    try {
      const useExisting = grouped && existingParent?.projectId === projectId ? existingParent.issueId : undefined
      const res = await create.mutateAsync({ projectId, drafts: chosen, parent: grouped && !useExisting ? parent : undefined, parentId: useExisting, backLink })
      if (res.links.length) await onCreated(res.links)
      const made = res.links.filter((l) => !l.parent).length
      if (res.failed.length) {
        toast.warning(`Created ${made} of ${chosen.length} work items`, { description: res.failed.slice(0, 3).map((f) => `${f.draft.name}: ${f.error}`).join('\n') })
      } else {
        toast.success(`Created ${made} work item${made === 1 ? '' : 's'} in Plane`)
      }
      onClose()
    } catch (e) {
      toast.error('Could not create work items', { description: (e as Error).message })
    }
  }

  const disabled = target.enabled === false
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Each item links back here, and its live state shows next to what it came from."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" loading={create.isPending} disabled={disabled || !projectId || !chosen.length} onClick={submit}>
            Create {chosen.length} work item{chosen.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {disabled ? (
        <p className="rounded-lg border border-dashed border-edge-strong px-3 py-2 text-xs text-content-muted">
          Plane is not connected to this console. Connect it in Settings → Integrations to file work items from design artifacts.
        </p>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Plane project</span>
            {target.error ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">Could not list Plane projects: {target.error.message}</p>
            ) : (
              <Select
                aria-label="Plane project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="h-9 py-1.5 text-sm"
                options={[
                  { value: '', label: target.loading ? 'Loading projects…' : 'Choose a project' },
                  ...target.projects.map((p) => ({ value: p.id, label: `${p.name} (${p.identifier})` })),
                ]}
              />
            )}
          </label>
          {existingParent && existingParent.projectId === projectId ? (
            <Checkbox
              label={`Add under the existing parent ${existingParent.key ?? ''} “${existingParent.name}”`}
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
            />
          ) : parent && drafts.length > 1 ? (
            <Checkbox
              label={`Group under a parent item: “${parent.name}”`}
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
            />
          ) : null}
          {drafts.length === 0 ? (
            <p className="text-xs text-content-muted">Everything here is already linked to a work item.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-edge-subtle overflow-y-auto rounded-lg border border-edge-default">
              {drafts.map((d) => (
                <li key={d.source} className="flex items-start gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={d.name}
                    checked={picked.has(d.source)}
                    onChange={(e) =>
                      setPicked((cur) => {
                        const next = new Set(cur)
                        if (e.target.checked) next.add(d.source)
                        else next.delete(d.source)
                        return next
                      })}
                    className="mt-0.5 h-3.5 w-3.5 accent-brand-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-content">{d.name}</span>
                    <span className="block text-[11px] text-content-subtle">
                      {d.kind === 'pain' ? 'Pain point' : d.kind === 'opportunity' ? 'Opportunity' : d.kind === 'job' ? 'Job to be done' : 'Screen'} · {d.context} · priority {d.priority}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}

/* ───────────────────────────── PostHog ───────────────────────────── */

/** Cohort chooser + live size. `value` is the cohort id. */
export function CohortField({
  value,
  onChange,
}: {
  value: number | string | undefined
  onChange(c: Cohort | null): void
}) {
  const q = useCohorts()
  if (q.error) return <p className="text-xs text-content-muted">{analyticsProblem(q.error)}</p>
  const list = q.data ?? []
  const current = list.find((c) => String(c.id) === String(value ?? ''))
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="PostHog cohort"
        value={value != null ? String(value) : ''}
        onChange={(e) => onChange(list.find((c) => String(c.id) === e.target.value) ?? null)}
        className="h-8 py-1 text-xs"
        wrapperClassName="min-w-0 flex-1 sm:max-w-xs"
        options={[
          { value: '', label: q.isLoading ? 'Loading cohorts…' : list.length ? 'No cohort' : 'No cohorts in PostHog' },
          ...list.map((c) => ({ value: String(c.id), label: c.name })),
        ]}
      />
      {current ? <CohortSize cohort={current} /> : value != null && value !== '' && !q.isLoading ? <span className="text-[11px] text-amber-700 dark:text-amber-300">Cohort {String(value)} no longer exists</span> : null}
    </div>
  )
}

export function CohortSize({ cohort }: { cohort: Cohort }) {
  if (cohort.is_calculating) return <span className="inline-flex items-center gap-1 text-[11px] text-content-subtle"><Spinner size={10} /> calculating…</span>
  if (cohort.count == null) return <span className="text-[11px] text-content-subtle">size not calculated</span>
  return (
    <span className="text-[11px] text-content-muted" title={cohort.last_calculation ? `Calculated ${new Date(cohort.last_calculation).toLocaleString()}` : undefined}>
      <span className="font-semibold tabular-nums text-content">{cohort.count.toLocaleString()}</span> people
      {cohort.last_calculation ? ` · ${formatRelative(cohort.last_calculation)}` : ''}
    </span>
  )
}

/* ───────────────────────────── catalog components ───────────────────────────── */

export interface PickableApp {
  name: string
  repo?: string
  project?: string
}

/** Pick catalog components (platform Applications) — chips + an add menu. */
export function ComponentChips({
  apps,
  value,
  onChange,
  emptyHint = 'No catalog applications in this scope.',
}: {
  apps: PickableApp[]
  value: string[]
  onChange(next: string[]): void
  emptyHint?: string
}) {
  const available = apps.filter((a) => !value.includes(a.name))
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((n) => (
        <span key={n} className="inline-flex items-center gap-1 rounded bg-teal-50 px-1.5 py-0.5 text-[11px] text-teal-800 dark:bg-teal-500/10 dark:text-teal-200">
          {n}
          <button type="button" aria-label={`Remove ${n}`} onClick={() => onChange(value.filter((x) => x !== n))} className="opacity-60 hover:opacity-100">
            <IconX size={9} />
          </button>
        </span>
      ))}
      {available.length ? (
        <select
          aria-label="Add a component"
          value=""
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
          className="h-6 max-w-[9rem] rounded border border-dashed border-edge-strong bg-transparent px-1 text-[11px] text-content-muted"
        >
          <option value="">+ component</option>
          {available.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
        </select>
      ) : value.length === 0 ? (
        <span className="text-[11px] text-content-subtle">{emptyHint}</span>
      ) : null}
    </div>
  )
}

/** Single component picker (wireframes). */
export function ComponentSelect({ apps, value, onChange }: { apps: PickableApp[]; value?: ComponentLink; onChange(v: ComponentLink | undefined): void }) {
  return (
    <Select
      aria-label="Catalog component"
      value={value?.name ?? ''}
      onChange={(e) => {
        const a = apps.find((x) => x.name === e.target.value)
        onChange(a ? { name: a.name, repo: a.repo, project: a.project } : undefined)
      }}
      className="h-8 py-1 text-xs"
      options={[
        { value: '', label: apps.length ? 'No component' : 'No catalog applications' },
        ...(value && !apps.some((a) => a.name === value.name) ? [{ value: value.name, label: `${value.name} (not in scope)` }] : []),
        ...apps.map((a) => ({ value: a.name, label: a.repo ? `${a.name} · ${a.repo}` : a.name })),
      ]}
    />
  )
}

/* ───────────────────────────── Gitea PR status ───────────────────────────── */

export type PrState = 'open' | 'merged' | 'closed'

export function usePullState(pr: Pick<RepoPullRef, 'repo' | 'number'> | undefined) {
  const org = useGiteaOrg()
  const [owner, name] = pr?.repo.includes('/') ? pr.repo.split('/', 2) : [org, pr?.repo ?? '']
  return useQuery({
    queryKey: ['gitea', 'pull', owner, name, pr?.number],
    queryFn: async () => {
      const p = await giteaClient.getPullRequest(owner, name, pr!.number)
      const state: PrState = p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open'
      return { state, url: p.html_url, title: p.title, updated: p.updated_at ?? p.created_at, mergeable: p.mergeable }
    },
    enabled: !!pr,
    staleTime: 60_000,
    refetchInterval: (q) => ((q.state.data as { state?: PrState } | undefined)?.state === 'open' ? 60_000 : false),
    retry: false,
  })
}

const PR_TONE: Record<PrState, string> = {
  open: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  merged: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300',
  closed: 'bg-surface-sunken text-content-muted ring-edge-default',
}

/** `repo#12 · open` with a link to the PR. */
export function PrBadge({ pr, showRepo = true }: { pr: RepoPullRef; showRepo?: boolean }) {
  const q = usePullState(pr)
  const href = q.data?.url ?? pr.url
  const label = `${showRepo ? `${pr.repo.split('/').pop()}` : ''}#${pr.number}`
  const body = (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset', q.data ? PR_TONE[q.data.state] : 'bg-surface-sunken text-content-muted ring-edge-default')}>
      <span className="font-mono">{label}</span>
      {q.isLoading ? <Spinner size={9} /> : q.error ? <span title={(q.error as Error).message}>?</span> : q.data ? q.data.state : null}
    </span>
  )
  return href ? <a href={href} target="_blank" rel="noreferrer" title={q.data?.title ?? 'Open pull request'}>{body}</a> : body
}

/* ───────────────────────────── reviews ───────────────────────────── */

export const REVIEW_META: Record<ReviewState, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-surface-sunken text-content-muted ring-edge-default' },
  'in-review': { label: 'In review', tone: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300' },
  approved: { label: 'Approved', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300' },
  'changes-requested': { label: 'Changes requested', tone: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300' },
}

export function ReviewBadge({ review }: { review?: DesignReview }) {
  const state = review?.state ?? 'draft'
  const m = REVIEW_META[state]
  const who = state === 'in-review' ? review?.requestedBy : review?.decidedBy
  const when = state === 'in-review' ? review?.requestedAt : review?.decidedAt
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset', m.tone)}
      title={[who, when ? new Date(when).toLocaleString() : '', review?.note].filter(Boolean).join(' · ') || undefined}
    >
      {m.label}
    </span>
  )
}

/* ───────────────────────────── Adhar AI ───────────────────────────── */

/** "Ask Adhar AI" button that explains itself when AI isn't configured. */
export function AskAiButton({ onClick, children = 'Ask Adhar AI', size = 'sm' }: { onClick(): void; children?: ReactNode; size?: 'xs' | 'sm' }) {
  const off = useAiConfigured() === false
  return (
    <Button
      size={size}
      variant="ghost"
      onClick={onClick}
      disabled={off}
      title={off ? 'Adhar AI is not configured on this platform (Settings → Adhar AI)' : undefined}
      leading={<Spark />}
    >
      {children}
    </Button>
  )
}

export function Spark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" />
    </svg>
  )
}

/** Small section label used by the integration panels. */
export function PanelLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{children}</div>
      {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
    </div>
  )
}

/** Memo helper: links of many artifacts flattened. */
export function useAllLinks(groups: Array<PlaneLink[] | undefined>): PlaneLink[] {
  const key = groups.map((g) => (g ?? []).map((l) => l.issueId).join(',')).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => groups.flatMap((g) => g ?? []), [key])
}
