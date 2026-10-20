import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input, Textarea, useOverlayDismiss, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { DesignReview, ReviewState, Wireframe } from '../data/types.ts'
import type { Listed as ListedT } from '../data/store.ts'
import type { DesignScope } from '../data/design-scope.ts'
import { designHref, useGoDesign } from '../data/nav.ts'
import { mergeLinks, wireframeDraft } from '../data/plane-map.ts'
import { usePlaneSearch, usePlaneTarget } from '../data/plane.ts'
import { useMe } from '../data/me.ts'
import { useDesignerRepos } from '../data/designer-repos.ts'
import { ComponentSelect, CreateWorkItemsModal, PanelLabel, type PickableApp, PlaneLinksList, PrBadge, REVIEW_META, ReviewBadge } from './integrations.tsx'
import { ProjectTagSelect } from './ux-integrations.tsx'
import { FrameCanvas } from './frame-canvas.tsx'
import { IconArrowRight, IconX } from './ux-kit.tsx'

/**
 * A wireframe's platform links, in a side drawer: the catalog component it is
 * for, Plane work items, design review, the pull requests opened from it, and
 * "Implement in repo" — the repo-first Visual Designer on the component's
 * repository with this frame added as a new page.
 */
export function FrameDetails({
  frame,
  scope,
  apps,
  onClose,
  onEdit,
  onSave,
}: {
  frame: ListedT<Wireframe>
  scope: DesignScope
  apps: PickableApp[]
  onClose(): void
  onEdit(): void
  onSave(next: Wireframe): Promise<unknown>
}) {
  useOverlayDismiss(true, onClose)
  const toast = useToast()
  const go = useGoDesign()
  const me = useMe()
  const repos = useDesignerRepos()
  const [planeOpen, setPlaneOpen] = useState(false)
  const [note, setNote] = useState(frame.review?.note ?? '')
  const [busy, setBusy] = useState<string | null>(null)

  const save = async (patch: Partial<Wireframe>, label?: string) => {
    const { _createdAt: _a, _updatedAt: _b, _updatedBy: _c, ...plain } = frame
    try {
      await onSave({ ...(plain as Wireframe), ...patch })
      if (label) toast.success(label)
    } catch (e) {
      toast.error('Could not save the wireframe', { description: (e as Error).message })
    }
  }

  const setReview = async (state: ReviewState) => {
    setBusy(state)
    const who = me.data?.name || me.data?.email || null
    const now = new Date().toISOString()
    const review: DesignReview = state === 'in-review'
      ? { state, requestedBy: who, requestedAt: now, note: note.trim() || undefined }
      : state === 'draft'
      ? { state }
      : { ...(frame.review ?? { state }), state, decidedBy: who, decidedAt: now, note: note.trim() || undefined }
    await save({ review }, state === 'in-review' ? 'Review requested — it shows on the Design dashboard' : state === 'approved' ? 'Wireframe approved' : state === 'changes-requested' ? 'Changes requested' : 'Moved back to draft')
    setBusy(null)
  }

  const link = typeof location !== 'undefined' ? `${location.origin}${designHref('wireframes', { doc: frame.id, ...(frame.project ? { project: frame.project } : {}) })}` : undefined
  const drafts = useMemo(() => (frame.planeLinks ?? []).some((l) => l.source === `wireframe:${frame.id}`) ? [] : [wireframeDraft(frame, link)], [frame, link])
  const project = scope.projects.find((p) => p.slug === frame.project)

  // The component's repository, as Gitea knows it (default branch for the designer).
  const repo = frame.component?.repo
  const giteaRepo = repo ? (repos.data ?? []).find((r) => r.full_name.toLowerCase() === repo.toLowerCase() || r.name.toLowerCase() === repo.split('/').pop()?.toLowerCase()) : undefined
  const implement = () => {
    if (!giteaRepo) return
    go('builder', { repo: giteaRepo.full_name, branch: giteaRepo.default_branch, from: frame.id })
  }

  const state = frame.review?.state ?? 'draft'
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={frame.name}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start gap-3 border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-content-subtle">{frame.flow} · step {frame.order}</div>
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-content">{frame.name}</h2>
              <ReviewBadge review={frame.review} />
            </div>
            <div className="text-[11px] text-content-subtle">
              {frame._updatedAt ? `Edited ${formatRelative(frame._updatedAt)}${frame._updatedBy ? ` by ${frame._updatedBy}` : ''}` : null}
            </div>
          </div>
          <Button size="sm" onClick={onEdit}>Edit design</Button>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-2 text-content-subtle hover:bg-surface-sunken hover:text-content">
            <IconX size={14} />
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <FrameCanvas blocks={frame.blocks} />

          <section className="space-y-2">
            <PanelLabel>Catalog component</PanelLabel>
            <ComponentSelect apps={apps} value={frame.component} onChange={(component) => void save({ component }, component ? `Linked to ${component.name}` : 'Component unlinked')} />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {repo ? <span className="font-mono text-content-muted">{repo}</span> : <span className="text-content-subtle">{frame.component ? 'This application declares no repository.' : 'Link the application this screen belongs to.'}</span>}
              <div className="ml-auto">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!giteaRepo}
                  title={!repo ? 'Link a component with a repository first' : !giteaRepo && !repos.isLoading ? `${repo} is not in this Gitea organisation` : undefined}
                  onClick={implement}
                  trailing={<IconArrowRight size={11} />}
                >
                  Implement in repo
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-content-subtle">Opens the Visual Designer on the repository with this frame as a new page; Review &amp; commit opens a pull request, which shows here.</p>
          </section>

          <section className="space-y-2">
            <PanelLabel>Pull requests</PanelLabel>
            {frame.prs?.length ? (
              <ul className="space-y-1">
                {frame.prs.map((pr) => (
                  <li key={`${pr.repo}#${pr.number}`} className="flex items-center gap-2 text-xs">
                    <PrBadge pr={pr} />
                    <span className="font-mono text-content-subtle">{pr.branch}</span>
                    <span className="ml-auto text-content-subtle">{formatRelative(pr.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-content-muted">None yet.</p>
            )}
          </section>

          <section className="space-y-2">
            <PanelLabel
              action={
                <Button size="xs" variant="ghost" disabled={!drafts.length} onClick={() => setPlaneOpen(true)} title={drafts.length ? undefined : 'Already tracked'}>
                  Create work item
                </Button>
              }
            >
              Plane
            </PanelLabel>
            {frame.planeLinks?.length ? (
              <PlaneLinksList compact links={frame.planeLinks} onUnlink={(l) => void save({ planeLinks: (frame.planeLinks ?? []).filter((x) => x.issueId !== l.issueId) }, 'Work item unlinked')} />
            ) : null}
            <LinkExisting
              scope={project ? { slug: project.slug, name: project.name } : undefined}
              onPick={(hit) => void save({
                planeLinks: mergeLinks(frame.planeLinks, [{
                  projectId: hit.project_id,
                  issueId: hit.id,
                  key: `${hit.project__identifier}-${hit.sequence_id}`,
                  name: hit.name,
                  source: `linked:${hit.id}`,
                  createdAt: new Date().toISOString(),
                }]),
              }, `Linked ${hit.project__identifier}-${hit.sequence_id}`)}
            />
          </section>

          <section className="space-y-2">
            <PanelLabel>Design review</PanelLabel>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the reviewer, or the review outcome…" />
            <div className="flex flex-wrap gap-2">
              {state !== 'in-review' ? (
                <Button size="sm" variant="primary" loading={busy === 'in-review'} onClick={() => setReview('in-review')}>Request review</Button>
              ) : (
                <>
                  <Button size="sm" loading={busy === 'approved'} onClick={() => setReview('approved')}>Approve</Button>
                  <Button size="sm" loading={busy === 'changes-requested'} onClick={() => setReview('changes-requested')}>Request changes</Button>
                </>
              )}
              {state !== 'draft' ? <Button size="sm" variant="ghost" loading={busy === 'draft'} onClick={() => setReview('draft')}>Back to draft</Button> : null}
            </div>
            {frame.review && frame.review.state !== 'draft' ? (
              <p className="text-[11px] text-content-subtle">
                {REVIEW_META[frame.review.state].label}
                {frame.review.requestedAt ? ` · requested ${formatRelative(frame.review.requestedAt)}${frame.review.requestedBy ? ` by ${frame.review.requestedBy}` : ''}` : ''}
                {frame.review.decidedAt ? ` · decided ${formatRelative(frame.review.decidedAt)}${frame.review.decidedBy ? ` by ${frame.review.decidedBy}` : ''}` : ''}
              </p>
            ) : null}
          </section>

          <section className="space-y-2">
            <PanelLabel>Project</PanelLabel>
            <ProjectTagSelect scope={scope} value={frame.project} onChange={(p) => void save({ project: p }, p ? `Moved to ${p}` : 'Now workspace-wide')} />
          </section>
        </div>
      </aside>
      <CreateWorkItemsModal
        open={planeOpen}
        onClose={() => setPlaneOpen(false)}
        title={`Work item for “${frame.name}”`}
        drafts={drafts}
        scope={project ? { slug: project.slug, name: project.name } : undefined}
        backLink={link}
        onCreated={(added) => save({ planeLinks: mergeLinks(frame.planeLinks, added) })}
      />
    </div>,
    document.body,
  )
}

/** Search Plane for an existing work item to link. */
function LinkExisting({ scope, onPick }: { scope: { slug?: string; name?: string } | undefined; onPick(hit: { id: string; name: string; sequence_id: number; project_id: string; project__identifier: string }): void }) {
  const target = usePlaneTarget(scope)
  const [q, setQ] = useState('')
  const search = usePlaneSearch(q, target.projectId)
  useEffect(() => setQ(''), [scope?.slug])
  if (target.enabled === false) return <p className="text-xs text-content-muted">Plane is not connected to this console.</p>
  return (
    <div className="space-y-1">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Link an existing item — name or KEY-123" className="h-8 text-xs" />
      {q.trim().length >= 2 ? (
        search.error ? (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">{(search.error as Error).message}</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-edge-default">
            {(search.data ?? []).length === 0 ? (
              <li className="px-3 py-2 text-[11px] text-content-subtle">{search.isLoading ? 'Searching…' : 'No matches.'}</li>
            ) : (
              (search.data ?? []).map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => { onPick(h); setQ('') }} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-sunken')}>
                    <span className="font-mono text-[10px] text-content-subtle">{h.project__identifier}-{h.sequence_id}</span>
                    <span className="min-w-0 flex-1 truncate text-content">{h.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )
      ) : null}
    </div>
  )
}
