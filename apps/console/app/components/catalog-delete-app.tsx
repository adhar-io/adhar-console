import { useEffect, useMemo, useState } from 'react'
import { Button, canResource, CONSOLE_PERMISSIONS, Modal, useCan, useGiteaOrg, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type Entity, useUnregisterEntity } from '~/data/catalog.ts'
import { useEntityDeployment } from '~/data/catalog-deployment.ts'
import { entityRepoUrl, planTeardown } from '~/data/catalog-teardown.ts'
import { CONTROL_PLANE_NAMESPACE } from '~/data/catalog-custom-apps.ts'
import {
  composedRefs,
  deletionTimestampOf,
  useApplicationXR,
  useDeleteApplication,
} from '~/data/catalog-app-delete.ts'
import { DeleteEntityDialog } from './catalog-delete.tsx'

/**
 * How a catalog entity is deleted.
 *
 *   - `application` — a Component backed by an Application XR. Deleting the XR
 *     is the only delete that sticks (Crossplane recreates anything it composed
 *     that is deleted directly); it needs `delete applications.console.adhar.io`
 *     (CONSOLE_PERMISSIONS.applicationsDelete), which `/api/apps/delete` checks.
 *   - `teardown` — everything else: the generic teardown of Argo CD apps,
 *     build, pipeline runs, namespace and repository (catalog-delete.tsx). The
 *     server deletes the Argo CD Applications as the user, so the entry point
 *     needs `delete applications.argoproj.io` where they live.
 *   - `forbidden` — the user may do neither (or the answer is still loading):
 *     every delete entry point is hidden, never disabled (docs/rbac.md).
 */
export type DeleteMode = 'application' | 'forbidden' | 'teardown'

/** Argo CD Applications — what the teardown deletes first, as the signed-in user. */
const ARGO_APPLICATIONS = { group: 'argoproj.io', resource: 'applications', namespaced: true } as const

export function useEntityDeleteMode(entity: Entity): DeleteMode {
  const { xr } = useApplicationXR(entity.metadata.name, entity.kind === 'Component')
  const isApp = entity.kind === 'Component' && Boolean(xr)
  // Read the shared Argo CD list from cache only (never fetch per card); the
  // Applications live in Argo CD's namespace, `argocd` unless they say otherwise.
  const deployment = useEntityDeployment(entity, false)
  const argoNs = deployment.primary?.metadata.namespace ?? deployment.apps[0]?.metadata.namespace ?? 'argocd'
  // An entry registered in this browser with nothing deployed is only a local record.
  const localOnly = entity.origin === 'registered' && deployment.apps.length === 0
  const canDeleteApp = useCan(CONSOLE_PERMISSIONS.applicationsDelete, { enabled: isApp })
  const canTeardown = useCan(canResource(ARGO_APPLICATIONS, 'delete', { namespace: argoNs }), { enabled: !isApp && !localOnly })
  if (isApp) return canDeleteApp ? 'application' : 'forbidden'
  return localOnly || canTeardown ? 'teardown' : 'forbidden'
}

/**
 * The catalog's delete dialog: the Application delete for XR-backed apps, the
 * generic teardown otherwise. Same props as DeleteEntityDialog so the route
 * swaps one for the other.
 */
export function CatalogDeleteDialog(props: {
  entity: Entity
  open: boolean
  onClose(): void
  onDeleted?(entity: Entity): void
}) {
  const mode = useEntityDeleteMode(props.entity)
  const { isLoading } = useApplicationXR(props.entity.metadata.name, props.entity.kind === 'Component')
  if (isLoading) return null
  if (mode === 'forbidden') return null
  if (mode === 'teardown') return <DeleteEntityDialog {...props} />
  return <DeleteApplicationDialog {...props} />
}

export function DeleteApplicationDialog({
  entity,
  open,
  onClose,
  onDeleted,
}: {
  entity: Entity
  open: boolean
  onClose(): void
  onDeleted?(entity: Entity): void
}) {
  const name = entity.metadata.name
  const title = entity.metadata.title ?? name
  const { xr } = useApplicationXR(name, open)
  const deletingSince = deletionTimestampOf(xr)
  const deployment = useEntityDeployment(entity, open)
  const argoApps = useMemo(() => (deployment?.apps ?? []).map((a) => a.metadata.name).sort(), [deployment?.apps])
  const composed = useMemo(() => composedRefs(xr), [xr])

  // The repository the server would delete is `<catalog org>/<name>`; offer it
  // only when this entity's source really is that repo on this Gitea.
  const org = useGiteaOrg()
  const giteaHost = safeHost(useToolPublicUrl('gitea'))
  const repo = useMemo(() => planTeardown(entity, undefined, entityRepoUrl(entity), giteaHost).repo, [entity, giteaHost])
  const repoLabel = `${org}/${name}`
  const repoOffered = Boolean(repo?.onGitea && repo.label.toLowerCase() === repoLabel.toLowerCase())

  const [typed, setTyped] = useState('')
  const [deleteRepo, setDeleteRepo] = useState(false)
  const del = useDeleteApplication()
  const unregister = useUnregisterEntity()
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    setTyped('')
    setDeleteRepo(false) // the repository is opt-in, every time
  }, [open, entity])

  const confirmed = typed.trim() === name
  const busy = del.isPending

  const run = async () => {
    if (!confirmed || busy) return
    try {
      const res = await del.mutateAsync({ name, deleteRepo: deleteRepo && repoOffered })
      if (!res.ok) {
        const failed = res.steps.find((s) => !s.ok)
        toast.error(`Could not delete ${title}`, {
          description: failed ? `${failed.label}: ${failed.detail ?? 'failed'}` : 'A step did not complete.',
        })
        return
      }
      // A scaffolded app is also registered in this browser's store; drop it
      // so the card does not outlive the application.
      await unregister.mutateAsync({ kind: entity.kind, metadata: entity.metadata }).catch(() => {})
      const repoStep = res.steps.find((s) => s.id === 'repo')
      const repoNote = repoStep && !repoStep.skipped ? ' The repository was deleted.' : ''
      toast.success(res.deleting ? `Deleting ${title}…` : `Deleted ${title}`, {
        description: res.deleting
          ? `Crossplane is removing its Argo CD apps and composed resources; the entry disappears once that finishes.${repoNote}`
          : `The application is gone.${repoNote}`,
      })
      onClose()
      onDeleted?.(entity)
    } catch (e) {
      toast.error(`Could not delete ${title}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      width="md"
      title={`Delete application ${title}`}
      description="This removes the application from the platform, not only from the catalog. It cannot be undone."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={run} disabled={!confirmed} loading={busy}>
            {busy ? 'Deleting…' : 'Delete application'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {deletingSince ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden />
            <span>
              <span className="font-medium">Deleting…</span> since {formatTime(deletingSince)}. Crossplane is still removing what this application composed.
              {repoOffered ? ' You can still delete its repository below.' : ''}
            </span>
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">What will be removed</div>
          <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-app/60">
            <Row
              label="Application resource"
              detail={`${CONTROL_PLANE_NAMESPACE}/${name} — deleting it is what removes everything below`}
              tone="on"
            />
            <Row
              label="Argo CD applications, one per environment"
              detail={argoApps.length ? argoApps.join(', ') : deployment?.isLoading ? 'looking them up…' : 'none found right now — anything composed is still removed'}
              tone="on"
            />
            <Row
              label="Composed resources"
              detail={composed.length ? summariseRefs(composed) : 'databases, caches and event pools the application declared'}
              tone="on"
            />
            {repoOffered ? (
              <li>
                <label className={cn('flex cursor-pointer items-start gap-3 px-3 py-2.5', busy && 'cursor-default')}>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[12px] font-medium text-content', !deleteRepo && 'text-content-muted')}>
                      Also delete the Gitea repository <span className="font-mono">{repoLabel}</span>
                    </span>
                    <span className={cn('mt-0.5 block text-[11px] leading-snug', deleteRepo ? 'font-medium text-rose-600 dark:text-rose-300' : 'text-content-subtle')}>
                      Permanent: the code, its history, issues and pull requests are erased and cannot be recovered. Off by default.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={deleteRepo}
                    disabled={busy}
                    onChange={(e) => setDeleteRepo(e.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0 accent-rose-600"
                    aria-label={`Also delete the Gitea repository ${repoLabel}`}
                  />
                </label>
              </li>
            ) : null}
          </ul>
        </div>

        <label className="block">
          <span className="text-[12px] text-content-muted">
            Type <code className="rounded bg-surface-sunken px-1 py-px font-mono text-[11px] text-content">{name}</code> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run() }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label={`Type ${name} to confirm`}
            placeholder={name}
            className={cn(
              'mt-1.5 h-9 w-full rounded-lg border bg-surface-app px-3 font-mono text-[13px] text-content outline-none transition-colors placeholder:text-content-subtle focus:ring-2',
              confirmed ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20' : 'border-edge-default focus:border-edge-strong focus:ring-edge-default/40',
            )}
          />
        </label>
      </div>
    </Modal>
  )
}

function Row({ label, detail, tone }: { label: string; detail?: string; tone: 'on' | 'none' }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px] font-medium', tone === 'none' ? 'text-content-muted' : 'text-content')}>{label}</span>
        {detail ? <span className="mt-0.5 block break-words text-[11px] leading-snug text-content-subtle">{detail}</span> : null}
      </span>
      <span className={cn('mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wider', tone === 'on' ? 'text-rose-600 dark:text-rose-300' : 'text-content-subtle')}>
        {tone === 'on' ? 'removed' : '—'}
      </span>
    </li>
  )
}

function summariseRefs(refs: Array<{ kind: string; name: string }>): string {
  const shown = refs.slice(0, 6).map((r) => `${r.kind} ${r.name}`)
  return refs.length > 6 ? `${shown.join(', ')} and ${refs.length - 6} more` : shown.join(', ')
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function safeHost(url: string): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined
  } catch {
    return undefined
  }
}
