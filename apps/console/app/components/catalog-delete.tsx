import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, useToast, useToolPublicUrl } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { type Entity, entityRef, useUnregisterEntity } from '~/data/catalog.ts'
import { useEntityDeployment } from '~/data/catalog-deployment.ts'
import { entityRepoUrl, planTeardown, type TeardownResult, useTeardown } from '~/data/catalog-teardown.ts'

/**
 * "Delete <service>" — the dialog behind the card menu's Delete.
 *
 * Deleting from the catalog means deleting from the PLATFORM: the Argo CD
 * Applications and the workloads they manage, the build, the pipeline runs,
 * and — when the person says so — the namespace and the source repository.
 * So the dialog lists exactly those, with real names and counts, and asks
 * for the entity's name to be typed before the button is live. Once it runs,
 * the same list becomes the report: what went, what was already gone, what
 * refused and why.
 */
export function DeleteEntityDialog({
  entity,
  open,
  onClose,
  onDeleted,
}: {
  entity: Entity
  open: boolean
  onClose(): void
  /** Called after a run that removed the entity, so the caller can close its drawer. */
  onDeleted?(entity: Entity): void
}) {
  const giteaHost = safeHost(useToolPublicUrl('gitea'))
  // The same Argo CD list the cards and the drawer read — one query, shared.
  const deployment = useEntityDeployment(entity, open)
  const repoUrl = entityRepoUrl(entity)
  const plan = useMemo(() => planTeardown(entity, deployment, repoUrl, giteaHost), [entity, deployment, repoUrl, giteaHost])
  const [typed, setTyped] = useState('')
  const [deleteRepo, setDeleteRepo] = useState(false)
  const [deleteNamespace, setDeleteNamespace] = useState(false)
  const [result, setResult] = useState<TeardownResult | null>(null)
  const teardown = useTeardown()
  const unregister = useUnregisterEntity()
  const toast = useToast()

  // Fresh defaults every time the dialog opens for an entity: the repository
  // goes when it is on this platform's Gitea, the namespace when it is this
  // entity's own.
  useEffect(() => {
    if (!open) return
    setTyped('')
    setResult(null)
    setDeleteRepo(Boolean(plan.repo?.onGitea))
    setDeleteNamespace(plan.namespaceDedicated)
  }, [open, plan.repo?.onGitea, plan.namespaceDedicated, entity])

  const title = entity.metadata.title ?? entity.metadata.name
  const sample = entity.origin === 'seed'
  const confirmed = typed.trim() === entity.metadata.name
  const busy = teardown.isPending

  const run = async () => {
    if (!confirmed || busy) return
    try {
      const res = await teardown.mutateAsync({ plan, options: { deleteRepo, deleteNamespace } })
      // The catalog record itself: registered entries live in this browser's
      // store; live entries disappear with the repository or the workload.
      await unregister.mutateAsync({ kind: entity.kind, metadata: entity.metadata })
      setResult(res)
      if (res.ok) toast.success('Deleted', { description: `${title} was removed from the platform.` })
      else toast.error('Deleted with problems', { description: `${title}: some steps did not complete — see the report.` })
    } catch (e) {
      toast.error('Could not delete', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const finish = () => {
    onClose()
    if (result) onDeleted?.(entity)
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : result ? finish : onClose}
      width="md"
      title={result ? `Deleted ${title}` : `Delete ${title}`}
      description={
        result
          ? result.ok ? 'Everything that was on the platform for this service is gone.' : 'Some steps did not complete. Nothing that failed was changed.'
          : sample
            ? 'This is a sample entity from the built-in catalog, shown because no live source is available. It has nothing on the platform to remove.'
            : 'This removes the service from the platform, not only from the catalog. It cannot be undone.'
      }
      footer={
        result ? (
          <Button variant="secondary" size="sm" onClick={finish}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={run} disabled={!confirmed || sample} loading={busy}>
              {busy ? 'Deleting…' : 'Delete from platform'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Report result={result} />
      ) : (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">What will be removed</div>
            <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-app/60">
              <Row
                icon={<IconArgo />}
                label="Argo CD applications and their workloads"
                detail={plan.apps.length ? plan.apps.map((a) => `${a.name}${a.health ? ` · ${a.health}` : ''}`).join(', ') : 'none matched — nothing is running under this name'}
                tone={plan.apps.length ? 'on' : 'none'}
              />
              {plan.deployable ? (
                <Row icon={<IconBuild />} label="Build image (kpack)" detail={plan.name} tone="on" />
              ) : null}
              {plan.deployable ? (
                <Row
                  icon={<IconPipeline />}
                  label="Pipeline runs"
                  detail={plan.pipelinesNamespace ? `labelled adhar.io/component=${plan.name} in ${plan.pipelinesNamespace}` : 'no namespace known — skipped'}
                  tone={plan.pipelinesNamespace ? 'on' : 'none'}
                />
              ) : null}
              {plan.namespace ? (
                <Row
                  icon={<IconNamespace />}
                  label={`Namespace ${plan.namespace}`}
                  detail={plan.namespaceDedicated ? 'named after this service, so it is likely its own' : 'may hold other services — off unless you say so'}
                  tone={deleteNamespace ? 'on' : 'off'}
                  checkbox={{ checked: deleteNamespace, onChange: setDeleteNamespace, disabled: busy }}
                />
              ) : null}
              {plan.repo ? (
                <Row
                  icon={<IconRepo />}
                  label={`Source repository ${plan.repo.label}`}
                  detail={plan.repo.onGitea ? 'on this platform’s Gitea — the code goes with it' : 'hosted elsewhere — left untouched'}
                  tone={plan.repo.onGitea ? (deleteRepo ? 'on' : 'off') : 'none'}
                  checkbox={plan.repo.onGitea ? { checked: deleteRepo, onChange: setDeleteRepo, disabled: busy } : undefined}
                />
              ) : null}
              <Row icon={<IconCatalog />} label="Catalog entry" detail={entityRef(entity)} tone="on" />
            </ul>
          </div>

          {!sample ? (
            <label className="block">
              <span className="text-[12px] text-content-muted">
                Type <code className="rounded bg-surface-sunken px-1 py-px font-mono text-[11.5px] text-content">{entity.metadata.name}</code> to confirm
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void run() }}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-label={`Type ${entity.metadata.name} to confirm`}
                className={cn(
                  'mt-1.5 h-9 w-full rounded-lg border bg-surface-app px-3 font-mono text-[13px] text-content outline-none transition-colors placeholder:text-content-subtle focus:ring-2',
                  confirmed ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20' : 'border-edge-default focus:border-edge-strong focus:ring-edge-default/40',
                )}
                placeholder={entity.metadata.name}
              />
            </label>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

function Row({
  icon,
  label,
  detail,
  tone,
  checkbox,
}: {
  icon: React.ReactNode
  label: string
  detail?: string
  /** on = will be removed · off = kept by choice · none = nothing to remove */
  tone: 'on' | 'off' | 'none'
  checkbox?: { checked: boolean; onChange(v: boolean): void; disabled?: boolean }
}) {
  const body = (
    <>
      <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md', tone === 'on' ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300' : 'bg-surface-sunken text-content-subtle')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12.5px] font-medium', tone === 'none' ? 'text-content-muted' : 'text-content', tone === 'off' && 'line-through decoration-content-subtle/60')}>{label}</span>
        {detail ? <span className="mt-0.5 block break-words text-[11px] leading-snug text-content-subtle">{detail}</span> : null}
      </span>
      {checkbox ? (
        <input
          type="checkbox"
          checked={checkbox.checked}
          disabled={checkbox.disabled}
          onChange={(e) => checkbox.onChange(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-rose-600"
          aria-label={label}
        />
      ) : (
        <span className={cn('mt-1 shrink-0 text-[10px] font-semibold uppercase tracking-wider', tone === 'on' ? 'text-rose-600 dark:text-rose-300' : 'text-content-subtle')}>
          {tone === 'on' ? 'removed' : tone === 'off' ? 'kept' : '—'}
        </span>
      )}
    </>
  )
  return (
    <li>
      {checkbox ? (
        <label className={cn('flex cursor-pointer items-start gap-3 px-3 py-2.5', checkbox.disabled && 'cursor-default')}>{body}</label>
      ) : (
        <div className="flex items-start gap-3 px-3 py-2.5">{body}</div>
      )}
    </li>
  )
}

function Report({ result }: { result: TeardownResult }) {
  return (
    <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-app/60">
      {result.steps.map((s) => (
        <li key={s.id} className="flex items-start gap-3 px-3 py-2.5">
          <span
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]',
              !s.ok ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' : s.skipped ? 'bg-surface-sunken text-content-subtle' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
            )}
            aria-hidden
          >
            {!s.ok ? '!' : s.skipped ? '–' : '✓'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className={cn('text-[12.5px] font-medium', !s.ok ? 'text-rose-700 dark:text-rose-300' : 'text-content')}>{s.label}</span>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{!s.ok ? 'failed' : s.skipped ? 'skipped' : 'done'}</span>
            </span>
            {s.detail ? <span className="mt-0.5 block break-words text-[11px] leading-snug text-content-subtle">{s.detail}</span> : null}
          </span>
        </li>
      ))}
      <li className="flex items-start gap-3 px-3 py-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" aria-hidden>✓</span>
        <span className="min-w-0 flex-1">
          <span className="text-[12.5px] font-medium text-content">Catalog entry</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-content-subtle">Removed from this catalog. A live entry reappears only if its repository or workload still exists.</span>
        </span>
      </li>
    </ul>
  )
}

function safeHost(url: string): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined
  } catch {
    return undefined
  }
}

const I = ({ children }: { children: React.ReactNode }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
)
const IconArgo = () => <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></I>
const IconBuild = () => <I><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></I>
const IconPipeline = () => <I><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10" /></I>
const IconNamespace = () => <I><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 21V9" /></I>
const IconRepo = () => <I><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M18 9a9 9 0 0 1-9 9" /></I>
const IconCatalog = () => <I><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></I>
