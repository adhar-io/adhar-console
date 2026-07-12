import { useState } from 'react'
import { StatusBadge } from '@adhar-console/shell-ui'
import { useMfaPolicy, useSessionPolicy } from '../data/enterprise.ts'
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
import { RequirePermission } from '../components/role-gate.tsx'
import { ALL_ROLES, ROLE_LABEL, type Role } from '../data/access.ts'

export function MfaAndSession() {
  const mfa = useMfaPolicy()
  const session = useSessionPolicy()

  return (
    <ViewShell
      title="MFA & sessions"
      description="Multi-factor enforcement, factor strength, recovery codes, and session lifetime — applied at the realm level."
      required={['security', 'owner']}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="MFA"
          value={mfa.data?.enforced ? 'Enforced' : 'Optional'}
          tone={mfa.data?.enforced ? 'good' : 'warn'}
        />
        <StatTile
          label="Min factor"
          value={mfa.data?.minimumFactor.toUpperCase() ?? '—'}
          hint="WebAuthn = phishing-resistant"
        />
        <StatTile
          label="Unenrolled"
          value={mfa.data?.unenrolledMembers ?? 0}
          tone={(mfa.data?.unenrolledMembers ?? 0) > 0 ? 'warn' : 'good'}
          hint="Members without MFA"
        />
        <StatTile
          label="Session"
          value={`${session.data?.idleMinutes ?? 0}m / ${session.data?.absoluteHours ?? 0}h`}
          hint="idle / absolute"
        />
      </div>

      <RequirePermission perm="mfa.enforce" required={['security', 'owner']} readOnly>
        <MfaCard />
      </RequirePermission>
      <RequirePermission perm="session.write" required={['security', 'owner']} readOnly>
        <SessionCard />
      </RequirePermission>
    </ViewShell>
  )
}

function MfaCard() {
  const q = useMfaPolicy()
  const [enforced, setEnforced] = useState<boolean | null>(null)
  const [minFactor, setMinFactor] = useState<'totp' | 'webauthn' | null>(null)
  const [remember, setRemember] = useState<number | null>(null)

  const data = q.data
  const _enforced = enforced ?? data?.enforced ?? false
  const _factor = minFactor ?? data?.minimumFactor ?? 'totp'
  const _remember = remember ?? data?.rememberDeviceDays ?? 7

  return (
    <SettingsCard
      title="Multi-factor authentication"
      description="Enforced at the IdP for SSO members; built-in TOTP / WebAuthn for password fallback."
      actions={
        <>
          <SecondaryButton onClick={() => { setEnforced(null); setMinFactor(null); setRemember(null) }}>
            Reset
          </SecondaryButton>
          <PrimaryButton>Save policy</PrimaryButton>
        </>
      }
    >
      <SettingsRow
        label="Require MFA"
        description="Block sign-in until a factor is enrolled. Existing sessions are not interrupted."
      >
        <ToggleField
          checked={_enforced}
          onChange={setEnforced}
          label={_enforced ? 'Required' : 'Optional'}
          description={_enforced ? 'All members must enroll before next sign-in' : 'Members may opt-in'}
        />
      </SettingsRow>
      <SettingsRow
        label="Minimum factor strength"
        description="WebAuthn (passkey / hardware key) is phishing-resistant and recommended."
      >
        <SelectField<'totp' | 'webauthn'>
          value={_factor}
          onChange={setMinFactor}
          options={[
            { value: 'totp', label: 'TOTP authenticator app' },
            { value: 'webauthn', label: 'WebAuthn (passkey or hardware key)' },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Roles always required"
        description="These roles must use MFA regardless of org-level enforcement."
      >
        <div className="flex flex-wrap gap-1.5">
          {(data?.enforcedRoles ?? []).map((r) => (
            <StatusBadge key={r} kind="paused">
              {r}
            </StatusBadge>
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
            value={String(_remember)}
            onChange={(v) => setRemember(Number(v) || 0)}
          />
          <span className="text-xs text-content-muted">days</span>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Recovery codes"
        description={`${data?.recoveryCodeCount ?? 10} one-time codes issued at enrolment.`}
      >
        <SecondaryButton>Regenerate for all members</SecondaryButton>
      </SettingsRow>
    </SettingsCard>
  )
}

function SessionCard() {
  const q = useSessionPolicy()
  const data = q.data
  const [idle, setIdle] = useState<number | null>(null)
  const [absolute, setAbsolute] = useState<number | null>(null)
  const [stepUpRisky, setStepUpRisky] = useState<boolean | null>(null)
  const [stepUpBilling, setStepUpBilling] = useState<boolean | null>(null)
  const [single, setSingle] = useState<boolean | null>(null)

  const v = {
    idle: idle ?? data?.idleMinutes ?? 30,
    absolute: absolute ?? data?.absoluteHours ?? 12,
    stepUpRisky: stepUpRisky ?? data?.stepUpForRisky ?? true,
    stepUpBilling: stepUpBilling ?? data?.stepUpForBilling ?? true,
    single: single ?? data?.singleConcurrent ?? false,
  }

  return (
    <SettingsCard
      title="Sessions"
      description="Session timeouts, step-up auth, and concurrent-session limits."
      actions={<PrimaryButton>Save policy</PrimaryButton>}
    >
      <SettingsRow
        label="Idle timeout"
        description="Sign out after this many minutes of inactivity."
      >
        <div className="flex items-center gap-2">
          <TextField type="number" value={String(v.idle)} onChange={(s) => setIdle(Number(s) || 0)} />
          <span className="text-xs text-content-muted">minutes</span>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Absolute lifetime"
        description="Hard upper bound regardless of activity."
      >
        <div className="flex items-center gap-2">
          <TextField type="number" value={String(v.absolute)} onChange={(s) => setAbsolute(Number(s) || 0)} />
          <span className="text-xs text-content-muted">hours</span>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Step-up for risky actions"
        description="Re-authenticate before destructive operations (delete, transfer, RBAC, exports)."
      >
        <ToggleField checked={v.stepUpRisky} onChange={setStepUpRisky} label={v.stepUpRisky ? 'On' : 'Off'} />
      </SettingsRow>
      <SettingsRow
        label="Step-up for billing"
        description="Re-authenticate before payment, plan, or budget changes."
      >
        <ToggleField checked={v.stepUpBilling} onChange={setStepUpBilling} label={v.stepUpBilling ? 'On' : 'Off'} />
      </SettingsRow>
      <SettingsRow
        label="Single concurrent session"
        description="A new sign-in invalidates the previous session for that user."
      >
        <ToggleField checked={v.single} onChange={setSingle} label={v.single ? 'On' : 'Off'} />
      </SettingsRow>
    </SettingsCard>
  )
}

/* Render the same component under both URL slugs for convenience. */
export const Mfa = MfaAndSession
export default MfaAndSession

/* helper for outside files */
export const ALL_ROLE_OPTIONS: { value: Role; label: string }[] = ALL_ROLES.map((r) => ({
  value: r,
  label: ROLE_LABEL[r],
}))
