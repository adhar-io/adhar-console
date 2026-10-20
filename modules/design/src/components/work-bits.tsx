import { useEffect, useState } from 'react'
import { Button, Modal, Select, useToast } from '@adhar/shell-ui'
import { useCreateWorkItems, usePlaneTarget } from '../data/plane.ts'
import type { PlaneDraft } from '../data/plane-map.ts'
import type { PlaneLink } from '../data/types.ts'
import { escapeHtml } from '../data/platform.ts'
import { PlaneLinksList, PrBadge as PullBadge } from './integrations.tsx'

/**
 * Plane work items and pull requests on the architecture artifacts (ADRs,
 * whiteboard stickies, diagrams, specs). This is a thin adapter over the
 * module's single Plane / Gitea-PR implementation (`data/plane.ts`,
 * `components/integrations.tsx`): the same per-scope Plane project setting,
 * sequential creation with per-item failure reporting, and live state index.
 * What it adds is an editable title per item — architecture follow-ups are
 * free text, not drafts derived from a journey or persona.
 */

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

export interface WorkItemInput {
  /** Stable dedupe key, e.g. `adr:<id>` or `sticky:<elementId>`. */
  source: string
  name: string
  description?: string
  context: string
}

/** Confirm-then-create Plane work items with editable titles. */
export function CreateWorkItemsModal({
  open,
  onClose,
  title,
  description,
  items: initial,
  scope,
  backLink,
  onCreated,
}: {
  open: boolean
  onClose(): void
  title: string
  description?: string
  items: WorkItemInput[]
  /** Adhar project the artifact belongs to — picks the remembered Plane project. */
  scope: { slug?: string; name?: string } | undefined
  backLink?: string
  onCreated(links: PlaneLink[]): void
}) {
  const toast = useToast()
  const target = usePlaneTarget(scope)
  const create = useCreateWorkItems()
  const [projectId, setProjectId] = useState('')
  const [items, setItems] = useState(initial)
  useEffect(() => {
    if (open) setItems(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (open) setProjectId(target.projectId ?? '')
  }, [open, target.projectId])
  const valid = items.filter((i) => i.name.trim())
  const disabled = target.enabled === false

  const submit = async () => {
    if (!projectId || !valid.length) return
    if (projectId !== target.projectId || !target.chosen) await target.setProjectId(projectId).catch(() => undefined)
    const drafts: PlaneDraft[] = valid.map((i) => ({
      source: i.source,
      kind: 'job',
      name: i.name.trim().slice(0, 240),
      description_html: i.description ? `<p>${escapeHtml(i.description).replace(/\n/g, '<br/>')}</p>` : '',
      priority: 'none',
      context: i.context,
    }))
    try {
      const res = await create.mutateAsync({ projectId, drafts, backLink })
      if (res.links.length) onCreated(res.links)
      if (res.failed.length) {
        toast.warning(`Created ${res.links.length} of ${drafts.length} work items`, { description: res.failed.slice(0, 3).map((f) => `${f.draft.name}: ${f.error}`).join('\n') })
      } else {
        toast.success(`Created ${res.links.length} work item${res.links.length === 1 ? '' : 's'} in Plane`, {
          description: res.links.map((l) => l.key ?? l.name).slice(0, 4).join(', ') + (res.links.length > 4 ? '…' : ''),
        })
      }
      onClose()
    } catch (e) {
      toast.error('Could not create work items', { description: (e as Error).message })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} loading={create.isPending} disabled={disabled || !projectId || !valid.length || create.isPending}>
            Create {valid.length} work item{valid.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {disabled
        ? (
          <p className="rounded-lg border border-dashed border-edge-strong px-3 py-2 text-xs text-content-muted">
            Plane is not connected to this console. Connect it in Settings → Integrations to file work items from design artifacts.
          </p>
        )
        : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Plane project</span>
              {target.error
                ? <span className="mt-1 block text-[11px] text-rose-600 dark:text-rose-400">Could not list Plane projects: {target.error.message}</span>
                : (
                  <Select
                    aria-label="Plane project"
                    value={projectId}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setProjectId(e.target.value)}
                    className="mt-1.5 h-9 py-1.5 text-sm"
                    options={[
                      { value: '', label: target.loading ? 'Loading projects…' : target.projects.length ? 'Choose a project' : 'No Plane projects yet' },
                      ...target.projects.map((p) => ({ value: p.id, label: `${p.name} (${p.identifier})` })),
                    ]}
                  />
                )}
            </label>
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Work items</span>
              <ul className="mt-1.5 max-h-[40vh] space-y-1.5 overflow-auto">
                {items.map((it, i) => (
                  <li key={it.source} className="flex items-center gap-2">
                    <input
                      value={it.name}
                      onChange={(e) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      className={INPUT}
                      aria-label={`Work item ${i + 1}`}
                    />
                    {items.length > 1
                      ? <button type="button" aria-label="Remove" onClick={() => setItems((cur) => cur.filter((_, j) => j !== i))} className="px-1 text-content-subtle hover:text-content">×</button>
                      : null}
                  </li>
                ))}
              </ul>
              {backLink ? <p className="mt-1.5 text-[11px] text-content-subtle">Each item links back to this artifact in the console.</p> : null}
            </div>
          </div>
        )}
    </Modal>
  )
}

/** Linked work items with live Plane state (the shared list). */
export function WorkItems({ links }: { links: PlaneLink[] }) {
  return <PlaneLinksList links={links} compact />
}

/** A pull request's live state (the shared badge). */
export function PrBadge({ repo, number, url }: { repo: string; number: number; url?: string }) {
  return <PullBadge pr={{ repo, number, url, createdAt: '' }} />
}
