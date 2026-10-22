/**
 * Record shapes of the console server's `/api/security/*` (scan waivers, scan
 * policy, the manual scan gate). They mirror `apps/console/app/server/
 * scan-waivers-model.ts` — keep them in step. Import-free so the pure
 * security model and its tests do not pull React in.
 */

export type WaiverKind = 'vuln' | 'license' | 'misconfig' | 'secret'
export type WaiverScope = 'digest' | 'app' | 'project' | 'platform'
export type WaiverStatus = 'requested' | 'approved' | 'rejected' | 'expired' | 'revoked'
export type VexStatus = 'not_affected' | 'affected' | 'fixed' | 'under_investigation'
export type VexJustification =
  | 'component_not_present'
  | 'vulnerable_code_not_present'
  | 'vulnerable_code_not_in_execute_path'
  | 'vulnerable_code_cannot_be_controlled_by_adversary'
  | 'inline_mitigations_already_exist'

export const VEX_STATUS_LABEL: Record<VexStatus, string> = {
  not_affected: 'Not affected',
  affected: 'Affected — risk accepted',
  fixed: 'Fixed',
  under_investigation: 'Under investigation',
}
export const VEX_JUSTIFICATION_LABEL: Record<VexJustification, string> = {
  component_not_present: 'Component not present',
  vulnerable_code_not_present: 'Vulnerable code not present',
  vulnerable_code_not_in_execute_path: 'Vulnerable code not in execute path',
  vulnerable_code_cannot_be_controlled_by_adversary: 'Cannot be controlled by an adversary',
  inline_mitigations_already_exist: 'Inline mitigations already exist',
}
export const SCOPE_LABEL: Record<WaiverScope, string> = {
  digest: 'This image digest',
  app: 'This app',
  project: 'Whole project',
  platform: 'Platform-wide',
}

export interface Actor {
  id: string
  label: string
}

export interface WaiverTarget {
  project: string
  app?: string
  repo?: string
  image?: string
  digest?: string
  package?: string
  purl?: string
  version?: string
  path?: string
}

export interface WaiverEvent {
  at: string
  by: Actor
  action: string
  from?: WaiverStatus
  to?: WaiverStatus
  comment?: string
  selfApproveReason?: string
}

export interface Waiver {
  id: string
  kind: WaiverKind
  scope: WaiverScope
  target: WaiverTarget
  findingId: string
  severity?: string
  title?: string
  justification: string
  vex: { status: VexStatus; justification?: VexJustification; impact?: string }
  falsePositive?: boolean
  requestedBy: Actor
  requestedAt: string
  approvedBy?: Actor
  approvedAt?: string
  decidedBy?: Actor
  decidedAt?: string
  selfApproved?: boolean
  expiresAt: string
  status: WaiverStatus
  supersedes?: string
  supersededBy?: string
  source?: { pipelineRun?: string }
  history: WaiverEvent[]
  sync?: { at: string; ok: boolean; detail: string }
}

/**
 * Who the caller is — used only to recognise their own requests (withdraw,
 * self-approval). What they may DO is Kubernetes RBAC, asked in the browser
 * with the same checks the BFF enforces (data/security-access.ts); the
 * capability flags the API still returns alongside are not read.
 */
export interface Me {
  id: string
  label: string
}

export interface ConfigMapWrite {
  namespace: string
  name: string
  ok: boolean
  changed: boolean
  detail: string
  count?: number
}

export interface ScanPolicy {
  failOnSeverity: string[]
  ignoreUnfixed: boolean
  licenseDeny: string[]
  licenseWarn: string[]
  scanners: string[]
  mode: 'enforce' | 'warn'
  manualApproval: boolean
  maxWaiverDays: number
}

export interface PolicyRead {
  exists: boolean
  policy: ScanPolicy
  error?: string
}

export interface PolicyResponse {
  global: PolicyRead
  project?: PolicyRead
  effective: ScanPolicy
  defaults: ScanPolicy
  platformEnforces: boolean
  me: Me
}

export interface ScanSummary {
  critical?: number
  high?: number
  medium?: number
  low?: number
  unknown?: number
  fixable?: number
  licenses?: number
  secrets?: number
  misconfigs?: number
}

export type GateState = 'awaiting' | 'approved' | 'rejected' | 'passed' | 'failed' | 'warned' | 'none'

export interface GateView {
  namespace: string
  name: string
  pipeline?: string
  app?: string
  image?: string
  digest?: string
  createdAt?: string
  done: boolean
  succeeded?: boolean
  state: GateState
  summary?: ScanSummary
  findings?: string[]
  decision?: { value: 'approved' | 'rejected'; by?: string; at?: string; comment?: string }
}

export interface GatesResponse {
  items: GateView[]
  state: 'ok' | 'absent' | 'forbidden' | 'error'
  detail?: string
  me: Me
}

export interface WaiversResponse {
  items: Waiver[]
  counts: { requested: number; active: number; expiringSoon: number }
  sweep: ConfigMapWrite[]
  me: Me
  now: string
}

