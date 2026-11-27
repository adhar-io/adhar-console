import { useState } from 'react'
import { Button, Can, canResource, Checkbox, Input, Modal, useToast } from '@adhar/shell-ui'
import { deleteRun, resubmitMemoized, resubmitRun, retryRun, setSuspended, shutdownRun } from '../data/api.ts'
import { LABEL, WORKFLOWS } from '../data/gvr.ts'
import { useInvalidateWorkflows, useWorkflowCluster } from '../data/hooks.ts'
import { isFinished, runPhase, type Workflow } from '../data/nodes.ts'

/**
 * A run's actions (design 0026 §6.9), each behind the RBAC check the write
 * needs — hidden, not disabled (§6.10). Stop is the default way to end a run:
 * exit handlers still run. Terminate sits behind "More", needs the run's name
 * typed, says that exit handlers do NOT run, and is never offered for a game
 * day (INV-8).
 */

export function isGameDay(w: Workflow): boolean {
  return Boolean(w.metadata.labels?.[LABEL.gameday])
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function RunActions({ run, compact = false, onDeleted }: { run: Workflow; compact?: boolean; onDeleted?(): void }) {
  const ns = run.metadata.namespace ?? ''
  const name = run.metadata.name
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const refresh = useInvalidateWorkflows()
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'retry' | 'resubmit' | 'terminate' | 'delete'>(null)
  const finished = isFinished(run)
  const phase = runPhase(run)
  const failed = phase === 'Failed' || phase === 'Error'
  const suspended = Boolean(run.spec?.suspend)
  const stopping = Boolean(run.spec?.shutdown)
  const size = compact ? 'xs' : 'sm'

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try {
      const r = (await fn()) as { warning?: unknown } | undefined
      toast.success(done, typeof r?.warning === 'string' ? { description: r.warning } : undefined)
      refresh()
    } catch (e) {
      toast.error(`Could not ${key} ${name}`, { description: errText(e) })
    } finally {
      setBusy(null)
    }
  }

  const patch = canResource(WORKFLOWS, 'patch', { namespace: ns })
  const update = canResource(WORKFLOWS, 'update', { namespace: ns })
  const create = canResource(WORKFLOWS, 'create', { namespace: ns })
  const del = canResource(WORKFLOWS, 'delete', { namespace: ns })

  return (
    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {!finished && !stopping ? (
        <Can check={patch}>
          <Button size={size} variant="secondary" loading={busy === 'stop'} onClick={() => act('stop', () => shutdownRun(ns, name, 'Stop', cluster), `Stopping ${name} — exit handlers still run`)}>
            Stop
          </Button>
          <Button size={size} variant="ghost" loading={busy === 'suspend' || busy === 'resume'} onClick={() => act(suspended ? 'resume' : 'suspend', () => setSuspended(ns, name, !suspended, cluster), suspended ? `Resumed ${name}` : `Suspended ${name}`)}>
            {suspended ? 'Resume' : 'Suspend'}
          </Button>
        </Can>
      ) : null}
      {failed ? (
        <Can check={update}>
          <Button size={size} variant="secondary" onClick={() => setDialog('retry')}>Retry</Button>
        </Can>
      ) : null}
      {finished ? (
        <Can check={create}>
          <Button size={size} variant="ghost" onClick={() => setDialog('resubmit')}>Resubmit</Button>
        </Can>
      ) : null}
      {!compact ? (
        <>
          {!finished && !isGameDay(run) ? (
            <Can check={patch}>
              <Button size={size} variant="ghost" className="text-rose-600 dark:text-rose-400" onClick={() => setDialog('terminate')}>Terminate…</Button>
            </Can>
          ) : null}
          {finished ? (
            <Can check={del}>
              <Button size={size} variant="ghost" className="text-rose-600 dark:text-rose-400" onClick={() => setDialog('delete')}>Delete</Button>
            </Can>
          ) : null}
        </>
      ) : null}

      {dialog === 'retry' ? (
        <RetryDialog
          name={name}
          onClose={() => setDialog(null)}
          onConfirm={(restartSuccessful) => {
            setDialog(null)
            void act('retry', () => retryRun(ns, name, { restartSuccessful }, cluster), `Retrying the failed steps of ${name}`)
          }}
        />
      ) : null}
      {dialog === 'resubmit' ? (
        <ResubmitDialog
          name={name}
          onClose={() => setDialog(null)}
          onConfirm={(memoized) => {
            setDialog(null)
            void act('resubmit', () => (memoized ? resubmitMemoized(ns, name, {}, cluster) : resubmitRun(run, { cluster })), `Resubmitted ${name}`)
          }}
        />
      ) : null}
      {dialog === 'terminate' ? (
        <TypedConfirm
          title={`Terminate ${name}?`}
          body="Terminate stops every step at once and does NOT run the workflow's exit handlers — cleanup and notifications in onExit are skipped. Stop is the safe way to end a run."
          name={name}
          action="Terminate"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void act('terminate', () => shutdownRun(ns, name, 'Terminate', cluster), `Terminated ${name}`)
          }}
        />
      ) : null}
      {dialog === 'delete' ? (
        <TypedConfirm
          title={`Delete ${name}?`}
          body="The run object and its pods go. If the archive is on, its record stays in History."
          name={name}
          action="Delete"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void act('delete', async () => {
              await deleteRun(ns, name, cluster)
              onDeleted?.()
            }, `Deleted ${name}`)
          }}
        />
      ) : null}
    </div>
  )
}

function RetryDialog({ name, onClose, onConfirm }: { name: string; onClose(): void; onConfirm(restartSuccessful: boolean): void }) {
  const [restart, setRestart] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={`Retry ${name}`}
      description="Re-runs the failed steps in place, through argo-server."
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(restart)}>Retry</Button>
        </div>
      }
    >
      <Checkbox checked={restart} onChange={(e) => setRestart(e.currentTarget.checked)} label="Also restart steps that succeeded" description="Without this, finished steps keep their results." />
    </Modal>
  )
}

function ResubmitDialog({ name, onClose, onConfirm }: { name: string; onClose(): void; onConfirm(memoized: boolean): void }) {
  const [memo, setMemo] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title={`Resubmit ${name}`}
      description="Starts a new run from the same template and arguments."
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(memo)}>Resubmit</Button>
        </div>
      }
    >
      <Checkbox checked={memo} onChange={(e) => setMemo(e.currentTarget.checked)} label="Memoized" description="Reuse the results of steps that succeeded (through argo-server)." />
    </Modal>
  )
}

export function TypedConfirm({ title, body, name, action, onClose, onConfirm }: { title: string; body: string; name: string; action: string; onClose(): void; onConfirm(): void }) {
  const [typed, setTyped] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={typed !== name} onClick={onConfirm}>{action}</Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-content-muted">
        <p>{body}</p>
        <label className="block space-y-1">
          <span className="text-xs">Type <span className="font-mono text-content">{name}</span> to confirm</span>
          <Input value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoFocus aria-label="Run name" />
        </label>
      </div>
    </Modal>
  )
}
