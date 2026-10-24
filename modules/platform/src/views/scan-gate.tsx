import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, CONSOLE_PERMISSIONS, Field, Modal, POLL_FLOOR_MS, Textarea, useAccessReview, useLiveRefetch, useToast } from '@adhar/shell-ui';
import { cn } from '@adhar/utils';
import { DrawerSection } from './resource-drawer.tsx';

/**
 * The scan gate of one PipelineRun, on the Builds drawer.
 *
 * The console server reads the run (as the user) and works out the gate state
 * from what the platform published; approving or rejecting goes back through
 * the server (`POST /api/security/gate`), which checks `approve scan-waivers`
 * (CONSOLE_PERMISSIONS.waiverApprove — the same SSAR the buttons ask) and
 * writes the decision annotation as the user. The annotation's name lives on
 * the server only. Renders nothing for a run without scan results or a gate.
 */

/**
 * The gate is derived from the PipelineRun itself (its scan results and the
 * decision annotation), so the run's watch is the change signal. Same params
 * as the Builds drawer's run watch, so the live hub shares the one upstream
 * watch.
 */
const PIPELINERUNS = { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true };

type GateState = 'awaiting' | 'approved' | 'rejected' | 'passed' | 'failed' | 'warned' | 'none';

interface GateView {
  namespace: string;
  name: string;
  app?: string;
  digest?: string;
  state: GateState;
  summary?: Partial<Record<'critical' | 'high' | 'medium' | 'low' | 'unknown' | 'fixable', number>>;
  findings?: string[];
  decision?: { value: 'approved' | 'rejected'; by?: string; at?: string; comment?: string };
}

interface GatesResponse {
  items: GateView[];
  state: string;
  me?: { canApprove: boolean };
}

const LABEL: Record<GateState, { text: string; cls: string }> = {
  awaiting: { text: 'Awaiting approval', cls: 'bg-indigo-50 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-500/15 dark:text-indigo-200' },
  approved: { text: 'Approved', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-200' },
  rejected: { text: 'Rejected', cls: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200' },
  passed: { text: 'Passed', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-200' },
  failed: { text: 'Failed', cls: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200' },
  warned: { text: 'Passed with warnings', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-200' },
  none: { text: 'No gate', cls: 'bg-surface-sunken text-content-muted ring-edge-subtle' },
};

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { detail?: string; error?: string }).detail ?? (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function ScanGateSection({ namespace, name, running }: { namespace?: string; name: string; running: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [comment, setComment] = useState('');
  // Approve/Reject are hidden unless RBAC allows the decision (and while asking).
  const approval = useAccessReview(CONSOLE_PERMISSIONS.waiverApprove);
  const canApprove = approval.allowed;
  const key = ['security', 'gates', namespace ?? '', name];
  // Pushed on any change to the run; the timer is only the socket-down fallback while it runs.
  const liveInterval = useLiveRefetch({ ...PIPELINERUNS, namespace }, [key], POLL_FLOOR_MS, Boolean(namespace && name));
  const gate = useQuery({
    queryKey: key,
    enabled: Boolean(namespace && name),
    queryFn: () =>
      fetch(`/api/security/gates?namespace=${encodeURIComponent(namespace!)}&name=${encodeURIComponent(name)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then((r) => readJson<GatesResponse>(r)),
    refetchInterval: running ? liveInterval : false,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (d: 'approved' | 'rejected') =>
      fetch('/api/security/gate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ namespace, name, decision: d, comment: comment.trim() }),
      }).then((r) => readJson<{ ok: boolean }>(r)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['security'] }),
  });

  const g = gate.data?.items?.[0];
  if (!g || (g.state === 'none' && !g.summary)) return null;
  const t = LABEL[g.state];

  const submit = async () => {
    if (!decision) return;
    try {
      await decide.mutateAsync(decision);
      toast.success(decision === 'approved' ? 'Scan gate approved — the run continues' : 'Scan gate rejected — the run stops');
      setDecision(null);
      setComment('');
    } catch (e) {
      toast.error('Could not record the decision', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <DrawerSection
      title='Scan gate'
      actions={g.state === 'awaiting' && canApprove
        ? (
          <div className='flex gap-2'>
            <Button size='xs' variant='danger' onClick={() => setDecision('rejected')}>Reject</Button>
            <Button size='xs' variant='primary' onClick={() => setDecision('approved')}>Approve</Button>
          </div>
        )
        : undefined}
    >
      <div className='space-y-2 text-[12px]'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', t.cls)}>{t.text}</span>
          {g.summary
            ? (['critical', 'high', 'medium', 'low'] as const).filter((s) => g.summary?.[s] !== undefined).map((s) => (
              <span key={s} className='text-content-muted'>
                <b className='tabular-nums text-content'>{g.summary![s]}</b> {s}
              </span>
            ))
            : null}
          {g.summary?.fixable !== undefined ? <span className='text-content-subtle'>· {g.summary.fixable} fixable</span> : null}
        </div>
        {g.decision
          ? (
            <p className='text-content-muted'>
              {g.decision.value === 'approved' ? 'Approved' : 'Rejected'}
              {g.decision.by ? ` by ${g.decision.by}` : ''}
              {g.decision.at ? ` · ${new Date(g.decision.at).toLocaleString()}` : ''}
              {g.decision.comment ? ` — ${g.decision.comment}` : ''}
            </p>
          )
          : null}
        {g.state === 'awaiting' && !approval.loading && !canApprove
          ? <p className='text-content-subtle'>Waiting for a security reviewer — deciding needs <code>approve scan-waivers.console.adhar.io</code>.</p>
          : null}
        <a href='/deliver?section=scans&tab=review' className='inline-block font-medium text-brand-700 hover:underline dark:text-brand-300'>
          Open the security review queue →
        </a>
      </div>
      <Modal
        open={decision !== null && canApprove}
        onClose={() => setDecision(null)}
        title={decision === 'approved' ? 'Approve scan gate' : 'Reject scan gate'}
        description={`${namespace}/${name}`}
        footer={
          <div className='flex justify-end gap-2'>
            <Button onClick={() => setDecision(null)}>Cancel</Button>
            <Button variant={decision === 'approved' ? 'primary' : 'danger'} onClick={submit} loading={decide.isPending} disabled={!comment.trim()}>
              {decision === 'approved' ? 'Approve and continue' : 'Reject run'}
            </Button>
          </div>
        }
      >
        <Field label='Comment' required hint='Recorded on the PipelineRun and in the audit trail.'>
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </Modal>
    </DrawerSection>
  );
}
