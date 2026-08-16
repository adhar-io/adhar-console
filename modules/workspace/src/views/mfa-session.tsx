import { useEffect, useState } from 'react'
import { StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  useCurrentSession,
  useSaveSecurityPolicy,
  useSecurityPolicy,
  type MfaMethod,
  type SecurityPolicyDoc,
} from '../data/security.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const METHOD_LABEL: Record<MfaMethod, string> = {
  totp: 'TOTP app',
  webauthn: 'WebAuthn / passkey',
  'recovery-code': 'Recovery codes',
}

export function MfaAndSession() {
  const q = useSecurityPolicy()

  if (q.isError) {
    return (
      <Shell>
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      </Shell>
    )
  }
  if (q.isLoading || !q.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading MFA & session policy…" />
      </Shell>
    )
  }

  const { policy, saved, updatedAt } = q.data
  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="MFA"
          value={policy.mfa.required ? 'Required' : 'Optional'}
          tone={policy.mfa.required ? 'good' : 'warn'}
        />
        <StatTile
          label="Min factor"
          value={policy.mfa.minimumFactor.toUpperCase()}
          hint="WebAuthn = phishing-resistant"
        />
        <StatTile
          label="Session"
          value={`${policy.session.idleMinutes}m / ${policy.session.absoluteHours}h`}
          hint="idle / absolute"
        />
        <StatTile
          label="Policy"
          value={saved ? 'Saved' : 'Defaults'}
          tone={saved ? 'good' : 'default'}
          hint={saved && updatedAt ? `updated ${formatRelative(updatedAt)}` : 'not saved yet'}
        />
      </div>

      {!saved ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Showing recommended defaults — this tenant has not saved a policy yet. Nothing is
          enforced until you save.
        </p>
      ) : null}

      <RequirePermission perm="mfa.enforce" required={['security', 'owner']} readOnly>
        <MfaCard policy={policy} />
      </RequirePermission>
      <RequirePermission perm="session.write" required={['security', 'owner']} readOnly>
        <SessionCard policy={policy} />
      </RequirePermission>

      <ActiveSessionsCard />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="MFA & sessions"
      description="Multi-factor enforcement, factor strength, and session lifetime. Saved to the tenant document store; realm-level enforcement is applied through Keycloak."
      required={['security', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

/* ─────────────────── MFA policy ─────────────────── */

function MfaCard({ policy }: { policy: SecurityPolicyDoc }) {
  const save = useSaveSecurityPolicy()
  const [draft, setDraft] = useState(policy.mfa)
  useEffect(() => setDraft(policy.mfa), [policy.mfa])

  const dirty = JSON.stringify(draft) !== JSON.stringify(policy.mfa)
  const toggleMethod = (m: MfaMethod) =>
    setDraft((d) => ({
      ...d,
      allowedMethods: d.allowedMethods.includes(m)
        ? d.allowedMethods.filter((x) => x !== m)
        : [...d.allowedMethods, m],
    }))

  return (
    <SettingsCard
      title="Multi-factor authentication"
      description="Recorded here and applied at the Keycloak realm for SSO members."
      actions={
        <>
          <SecondaryButton disabled={!dirty || save.isPending} onClick={() => setDraft(policy.mfa)}>
            Reset
          </SecondaryButton>
          <PrimaryButton
            disabled={!dirty || save.isPending || draft.allowedMethods.length === 0}
            onClick={() => save.mutate({ mfa: draft })}
          >
            {save.isPending ? 'Saving…' : 'Save policy'}
          </PrimaryButton>
        </>
      }
    >
      <SettingsRow
        label="Require MFA"
        description="Block sign-in until a factor is enrolled. Existing sessions are not interrupted."
      >
        <ToggleField
          checked={draft.required}
          onChange={(v) => setDraft((d) => ({ ...d, required: v }))}
          label={draft.required ? 'Required' : 'Optional'}
          description={draft.required ? 'All members must enroll' : 'Members may opt-in'}
        />
      </SettingsRow>
      <SettingsRow
        label="Minimum factor strength"
        description="WebAuthn (passkey / hardware key) is phishing-resistant and recommended."
      >
        <SelectField<'totp' | 'webauthn'>
          value={draft.minimumFactor}
          onChange={(v) => setDraft((d) => ({ ...d, minimumFactor: v }))}
          options={[
            { value: 'totp', label: 'TOTP authenticator app' },
            { value: 'webauthn', label: 'WebAuthn (passkey or hardware key)' },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Allowed methods"
        description="Factors members may enroll. At least one must stay enabled."
      >
        <div className="space-y-2">
          {(Object.keys(METHOD_LABEL) as MfaMethod[]).map((m) => (
            <ToggleField
              key={m}
              checked={draft.allowedMethods.includes(m)}
              onChange={() => toggleMethod(m)}
              label={METHOD_LABEL[m]}
            />
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        label="Remember device"
        description="Trust the device for this many days; 0 disables device trust."
      >
        <div className="flex items-center gap-2">
          <TextField
            type="number"
            value={String(draft.rememberDeviceDays)}
            onChange={(v) => setDraft((d) => ({ ...d, rememberDeviceDays: Math.max(0, Number(v) || 0) }))}
          />
          <span className="text-xs text-content-muted">days</span>
        </div>
      </SettingsRow>
      {save.isError ? (
        <p className="mt-3 text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the MFA policy.'}
        </p>
      ) : null}
    </SettingsCard>
  )
}

/* ─────────────────── Session policy ─────────────────── */

function SessionCard({ policy }: { policy: SecurityPolicyDoc }) {
  const save = useSaveSecurityPolicy()
  const [draft, setDraft] = useState(policy.session)
  useEffect(() => setDraft(policy.session), [policy.session])

  const dirty = JSON.stringify(draft) !== JSON.stringify(policy.session)

  return (
    <SettingsCard
      title="Sessions"
      description="Session timeouts, step-up auth, and concurrent-session limits."
      actions={
        <PrimaryButton
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ session: draft })}
        >
          {save.isPending ? 'Saving…' : 'Save policy'}
        </PrimaryButton>
      }
    >
      <SettingsRow label="Idle timeout" description="Sign out after this many minutes of inactivity.">
        <div className="flex items-center gap-2">
          <TextField
            type="number"
            value={String(draft.idleMinutes)}
            onChange={(s) => setDraft((d) => ({ ...d, idleMinutes: Math.max(1, Number(s) || 0) }))}
          />
          <span className="text-xs text-content-muted">minutes</span>
        </div>
      </SettingsRow>
      <SettingsRow label="Absolute lifetime" description="Hard upper bound regardless of activity.">
        <div className="flex items-center gap-2">
          <TextField
            type="number"
            value={String(draft.absoluteHours)}
            onChange={(s) => setDraft((d) => ({ ...d, absoluteHours: Math.max(1, Number(s) || 0) }))}
          />
          <span className="text-xs text-content-muted">hours</span>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Step-up for risky actions"
        description="Re-authenticate before destructive operations (delete, transfer, RBAC, exports)."
      >
        <ToggleField
          checked={draft.stepUpForRisky}
          onChange={(v) => setDraft((d) => ({ ...d, stepUpForRisky: v }))}
          label={draft.stepUpForRisky ? 'On' : 'Off'}
        />
      </SettingsRow>
      <SettingsRow
        label="Step-up for billing"
        description="Re-authenticate before payment, plan, or budget changes."
      >
        <ToggleField
          checked={draft.stepUpForBilling}
          onChange={(v) => setDraft((d) => ({ ...d, stepUpForBilling: v }))}
          label={draft.stepUpForBilling ? 'On' : 'Off'}
        />
      </SettingsRow>
      <SettingsRow
        label="Single concurrent session"
        description="A new sign-in invalidates the previous session for that user."
      >
        <ToggleField
          checked={draft.singleConcurrent}
          onChange={(v) => setDraft((d) => ({ ...d, singleConcurrent: v }))}
          label={draft.singleConcurrent ? 'On' : 'Off'}
        />
      </SettingsRow>
      {save.isError ? (
        <p className="mt-3 text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the session policy.'}
        </p>
      ) : null}
    </SettingsCard>
  )
}

/* ─────────────────── Active sessions (real, this-browser only) ─────────────────── */

function ActiveSessionsCard() {
  const q = useCurrentSession()
  const s = q.data

  return (
    <SettingsCard
      title="Active sessions"
      description="Live from the auth server. The console can only see this browser's session — the full per-user device list lives in Keycloak (Account → Sessions)."
    >
      {q.isLoading ? (
        <div className="text-sm text-content-muted">Checking session…</div>
      ) : !s?.available ? (
        <div className="text-sm text-content-muted">
          No auth server is reachable in this environment (SPA dev mode) — session data cannot be
          shown.
        </div>
      ) : !s.authenticated ? (
        <div className="text-sm text-content-muted">Not signed in — no active session.</div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge-default bg-surface-sunken/40 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-content">{s.name ?? s.email ?? 'This session'}</span>
              <StatusBadge kind="healthy">current</StatusBadge>
            </div>
            <div className="mt-0.5 text-[11px] text-content-muted">
              {s.email ?? '—'}
              {s.activeTenant ? ` · tenant ${s.activeTenant}` : ''}
              {s.expiresAt ? ` · expires ${formatRelative(new Date(s.expiresAt).toISOString())}` : ''}
            </div>
          </div>
          <span className="text-[11px] text-content-subtle">This browser</span>
        </div>
      )}
    </SettingsCard>
  )
}

/* Render the same component under both URL slugs for convenience. */
export const Mfa = MfaAndSession
export default MfaAndSession
