import { env } from '@adhar-console/utils'
import { openStore, type Store } from './workspace/store.ts'
import { provisionTenant, type ProvisionStepResult } from './tenant-provisioner.ts'
import { emitNotification } from './notify.ts'
import { isMailConfigured, provisioningMail, sendMail } from './mail.ts'

/**
 * Asynchronous workspace provisioning.
 *
 * Creating an organization returns immediately; the real work (Keycloak group,
 * namespace + RBAC, Argo CD project, Gitea org) runs in the background so the
 * user is never blocked on a multi-second, partially-failing sequence. Progress
 * is persisted as a `console.provisioning` document, so:
 *
 *   • the onboarding screen can watch it live (or the user can close the tab),
 *   • a notification lands in the Notification Center when it finishes,
 *   • and an email goes to the workspace contact when mail is configured.
 *
 * Jobs are keyed by id and owned by the tenant that was just created.
 */

export const PROVISIONING_KIND = 'console.provisioning'

export type JobStatus = 'running' | 'succeeded' | 'partial' | 'failed'

export interface ProvisioningJob {
  id: string
  orgId: string
  orgName: string
  orgSlug: string
  status: JobStatus
  steps: ProvisionStepResult[]
  startedAt: string
  finishedAt?: string
  /** Where the completion email went (when configured). */
  notifiedEmail?: string
  emailStatus?: 'sent' | 'not_configured' | 'failed' | 'skipped'
  requestedBy: { id: string; name: string; email: string }
  [k: string]: unknown
}

/** Steps we report before the provisioner has produced its own results. */
const PENDING_STEPS: ProvisionStepResult[] = [
  { system: 'keycloak', label: 'Identity group & role mapping', status: 'skipped', detail: 'queued' },
  { system: 'namespace', label: 'Namespace & RBAC', status: 'skipped', detail: 'queued' },
  { system: 'argocd', label: 'Argo CD project', status: 'skipped', detail: 'queued' },
  { system: 'gitea', label: 'Git organization', status: 'skipped', detail: 'queued' },
]

function statusOf(steps: ProvisionStepResult[]): JobStatus {
  if (steps.some((s) => s.status === 'failed')) {
    return steps.every((s) => s.status === 'failed') ? 'failed' : 'partial'
  }
  return 'succeeded'
}

/** Public console URL for links in notifications / email. */
function consoleUrl(): string {
  return (env('AUTH_PUBLIC_URL') ?? env('ADHAR_CONSOLE_URL') ?? '').replace(/\/$/, '') || '/'
}

/**
 * Start provisioning in the background and return the job record immediately.
 * Never throws — a provisioning failure is reported through the job, never by
 * failing organization creation.
 */
export async function startProvisioning(input: {
  tenant: string
  orgId: string
  orgName: string
  orgSlug: string
  user: { id: string; name: string; email: string }
  /** Contact address for the completion email; defaults to the requester. */
  contactEmail?: string
  contactName?: string
}): Promise<ProvisioningJob> {
  const job: ProvisioningJob = {
    id: crypto.randomUUID(),
    orgId: input.orgId,
    orgName: input.orgName,
    orgSlug: input.orgSlug,
    status: 'running',
    steps: PENDING_STEPS,
    startedAt: new Date().toISOString(),
    requestedBy: input.user,
  }
  const store = await openStore(input.tenant).catch(() => null)
  if (store) await store.put(PROVISIONING_KIND, job.id, job as Record<string, unknown>, input.user.id).catch(() => {})

  // Fire-and-forget: the HTTP response does not wait for this.
  void (async () => {
    let steps: ProvisionStepResult[] = []
    try {
      steps = await provisionTenant({ slug: input.orgSlug, name: input.orgName, userRef: input.user.email || input.user.id })
    } catch (e) {
      steps = PENDING_STEPS.map((s) => ({ ...s, status: 'failed', detail: e instanceof Error ? e.message : String(e) }))
    }
    const status = statusOf(steps)
    const finished: ProvisioningJob = { ...job, steps, status, finishedAt: new Date().toISOString() }

    // Email the workspace contact (falls back to the requester).
    const to = (input.contactEmail || input.user.email || '').trim()
    if (!to) finished.emailStatus = 'skipped'
    else if (!isMailConfigured()) finished.emailStatus = 'not_configured'
    else {
      const msg = provisioningMail({
        orgName: input.orgName,
        orgSlug: input.orgSlug,
        recipientName: input.contactName || input.user.name,
        consoleUrl: consoleUrl(),
        steps: steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail })),
      })
      const res = await sendMail({ ...msg, to })
      finished.emailStatus = res.sent ? 'sent' : res.reason === 'not_configured' ? 'not_configured' : 'failed'
      if (res.sent) finished.notifiedEmail = to
    }

    const st = store ?? (await openStore(input.tenant).catch(() => null))
    if (st) {
      await st.put(PROVISIONING_KIND, job.id, finished as Record<string, unknown>, input.user.id).catch(() => {})
      await notifyDone(st, finished, input.user.id)
    }
  })()

  return job
}

async function notifyDone(store: Store, job: ProvisioningJob, userId: string) {
  const failed = job.steps.filter((s) => s.status === 'failed')
  const emailNote =
    job.emailStatus === 'sent'
      ? ` A confirmation was emailed to ${job.notifiedEmail}.`
      : job.emailStatus === 'not_configured'
        ? ' Email delivery is not configured on this platform, so no message was sent.'
        : job.emailStatus === 'failed'
          ? ' The confirmation email could not be delivered.'
          : ''
  await emitNotification(
    store,
    {
      kind: job.status === 'succeeded' ? 'success' : job.status === 'partial' ? 'warning' : 'error',
      source: 'workspace',
      title:
        job.status === 'succeeded'
          ? `Workspace "${job.orgName}" is ready`
          : job.status === 'partial'
            ? `Workspace "${job.orgName}" provisioned with warnings`
            : `Workspace "${job.orgName}" could not be provisioned`,
      description:
        (failed.length ? `${failed.map((s) => s.label).join(', ')} need attention. ` : 'Identity, namespace, GitOps project and Git organization are in place. ') + emailNote.trim(),
      href: '/workspace?section=organization',
      target: { type: 'organization', id: job.orgId, label: job.orgName },
      severity: job.status === 'failed' ? 'high' : job.status === 'partial' ? 'medium' : 'low',
      audience: [userId],
      prompt:
        failed.length > 0
          ? `Provisioning the workspace "${job.orgName}" failed at: ${failed.map((s) => `${s.label} (${s.detail ?? 'no detail'})`).join('; ')}. Explain the likely cause and how to fix each one.`
          : undefined,
      at: new Date().toISOString(),
    },
    userId,
  )
}

/** Read one job (tenant-scoped). */
export async function getProvisioningJob(tenant: string, id: string): Promise<ProvisioningJob | null> {
  const store = await openStore(tenant).catch(() => null)
  if (!store) return null
  const doc = await store.get<ProvisioningJob>(PROVISIONING_KIND, id).catch(() => null)
  return doc ? { ...doc.data, id: doc.id } : null
}

/** Most recent jobs for the tenant, newest first. */
export async function listProvisioningJobs(tenant: string, limit = 10): Promise<ProvisioningJob[]> {
  const store = await openStore(tenant).catch(() => null)
  if (!store) return []
  const page = await store
    .query<ProvisioningJob>(PROVISIONING_KIND, { sort: { path: 'startedAt', direction: 'desc' }, limit, offset: 0 })
    .catch(() => null)
  return page ? page.items.map((d) => ({ ...d.data, id: d.id })) : []
}
