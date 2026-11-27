import { useState } from 'react'
import { Button, Can, canResource, StatusBadge, Textarea, useOptionalUser, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { decideApproval } from '../data/api.ts'
import { eligibility, type PendingApproval } from '../data/approvals.ts'
import { WORKFLOWS } from '../data/gvr.ts'
import { useInvalidateWorkflows, useWorkflowCluster } from '../data/hooks.ts'
import { msOf } from '../data/nodes.ts'

/**
 * The approval card (design 0026 §6.9): the question, who may answer, a
 * comment, Approve / Reject. Shown in the run view's node panel and in place
 * on the overview's "Needs your attention". What it offers is the UI's
 * reading of the approver policy; the BFF decides, as the user, and records
 * the approver itself — the card never sends who approved.
 */

export function ApprovalCard({ approval, compact = false }: { approval: PendingApproval; compact?: boolean }) {
  const user = useOptionalUser()
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const refresh = useInvalidateWorkflows()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const can = eligibility(approval, user)
  const waited = msOf(approval.startedAt)
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision)
    try {
      await decideApproval(approval.namespace, approval.run, { nodeId: approval.nodeId, decision, comment: comment.trim() || undefined }, cluster)
      toast.success(decision === 'approve' ? `Approved ${approval.task}` : `Rejected ${approval.task}`, { description: `${approval.run} · recorded as you` })
      setComment('')
      refresh()
    } catch (e) {
      toast.error(`Could not ${decision}`, { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={cn('space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3', compact && 'p-2.5')}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge kind="paused">Approval</StatusBadge>
        {compact ? <span className="font-mono text-content-muted">{approval.namespace}/{approval.run}</span> : null}
        <span className="font-medium text-content">{approval.task}</span>
        {waited ? <span className="ml-auto text-content-subtle">waiting {formatRelative(approval.startedAt!)}</span> : null}
      </div>
      <p className="text-sm text-content">{approval.question || 'Approve to continue the run.'}</p>
      <div className="text-[11px] text-content-subtle">
        {approval.approvers.length ? `Approvers: ${approval.approvers.join(', ')}` : 'Anyone who may update this run can decide.'}
        {approval.forbidSelfApproval ? ' · The submitter cannot approve.' : ''}
        {approval.timeout ? ` · Times out after ${approval.timeout} (rejected).` : ''}
      </div>
      {can.ok ? (
        <Can check={canResource(WORKFLOWS, 'update', { namespace: approval.namespace })}>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.currentTarget.value)} placeholder="Comment (recorded with your decision)" aria-label="Comment" />
          <div className="flex gap-2">
            <Button size="sm" loading={busy === 'approve'} onClick={() => decide('approve')}>Approve</Button>
            <Button size="sm" variant="danger" loading={busy === 'reject'} onClick={() => decide('reject')}>Reject</Button>
          </div>
        </Can>
      ) : (
        <p className="text-xs text-content-muted">{can.reason === 'self' ? 'You submitted this run, and its approval forbids self-approval.' : can.detail}</p>
      )}
    </div>
  )
}

