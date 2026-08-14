import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PageHeader, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { Organization } from './views/organization.tsx'
import { Members } from './views/members.tsx'
import { Teams } from './views/teams.tsx'
import { RolesPermissions } from './views/roles.tsx'
import { Projects } from './views/projects.tsx'
import { Environments } from './views/environments.tsx'
import { Integrations } from './views/integrations.tsx'
import { Tokens } from './views/tokens.tsx'
import { AuditLog } from './views/audit-log.tsx'
import { Plan } from './views/plan.tsx'
import { UsageView } from './views/usage.tsx'
import { Webhooks } from './views/webhooks.tsx'
import { DangerZone } from './views/danger-zone.tsx'
import { Theming } from './views/theming.tsx'
import { CloudProviders } from './views/cloud-providers.tsx'
import { Sso } from './views/sso.tsx'
import { Mfa } from './views/mfa-session.tsx'
import { IpAllowlist } from './views/ip-allowlist.tsx'
import { SecurityPolicies } from './views/security-policies.tsx'
import { Compliance } from './views/compliance.tsx'
import { Approvals } from './views/approvals.tsx'
import { PaymentMethods } from './views/payment-methods.tsx'
import { Invoices } from './views/invoices.tsx'
import { CostCenters } from './views/cost-centers.tsx'
import { Budgets } from './views/budgets.tsx'
import { CostAllocation } from './views/cost-allocation.tsx'
import { rolesHavePermission, useCurrentRoles, type Permission, type Role } from './data/access.ts'
import { RoleBadge } from './components/role-gate.tsx'

type Section =
  | 'organization'
  | 'members'
  | 'teams'
  | 'roles'
  | 'sso'
  | 'mfa'
  | 'ip-allowlist'
  | 'security'
  | 'audit'
  | 'compliance'
  | 'approvals'
  | 'clouds'
  | 'projects'
  | 'environments'
  | 'integrations'
  | 'tokens'
  | 'webhooks'
  | 'plan'
  | 'usage'
  | 'payments'
  | 'invoices'
  | 'cost-centers'
  | 'budgets'
  | 'allocation'
  | 'theming'
  | 'danger'

interface NavItem {
  id: Section
  label: string
  description?: string
  icon: ReactNode
  /** Roles allowed to *write* in this section — informational pill. */
  required?: Role[]
  /** Permission required to even read this section. Falsy = all signed-in. */
  readPerm?: Permission
}
interface Group {
  label: string
  caption?: string
  items: NavItem[]
}

const GROUPS: Group[] = [
  {
    label: 'Organization',
    caption: 'Identity, people, and access shape',
    items: [
      { id: 'organization', label: 'General', description: 'Name, domain, region, SSO realm', icon: <IconOrg />, required: ['admin', 'owner'], readPerm: 'org.read' },
      { id: 'members', label: 'Members', description: 'People & lifecycle', icon: <IconUsers />, required: ['admin', 'owner'], readPerm: 'members.read' },
      { id: 'teams', label: 'Teams', description: 'Group people for access grants', icon: <IconTeam />, required: ['admin', 'owner'], readPerm: 'teams.read' },
      { id: 'roles', label: 'Roles & permissions', description: 'Built-in + custom RBAC matrix', icon: <IconShield />, required: ['owner'], readPerm: 'roles.read' },
    ],
  },
  {
    label: 'Identity & access',
    caption: 'Authentication & authorization',
    items: [
      { id: 'sso', label: 'SSO & SCIM', description: 'OIDC / SAML / SCIM provisioning', icon: <IconKey />, required: ['security', 'owner'], readPerm: 'sso.read' },
      { id: 'mfa', label: 'MFA & sessions', description: 'Factors, step-up, lifetimes', icon: <IconLock />, required: ['security', 'owner'], readPerm: 'mfa.read' },
      { id: 'ip-allowlist', label: 'IP allowlist', description: 'CIDR-based access control', icon: <IconNetwork />, required: ['security', 'owner'], readPerm: 'ipallow.read' },
    ],
  },
  {
    label: 'Security & compliance',
    caption: 'Policy, audit, frameworks',
    items: [
      { id: 'security', label: 'Security policies', description: 'Passwords, signing, encryption', icon: <IconBolt />, required: ['security', 'owner'], readPerm: 'security.read' },
      { id: 'audit', label: 'Audit log', description: 'Who did what, when, from where', icon: <IconBookOpen />, required: ['admin', 'security', 'owner'], readPerm: 'audit.read' },
      { id: 'compliance', label: 'Compliance', description: 'SOC 2, ISO, GDPR, HIPAA, PCI', icon: <IconCert />, required: ['security', 'owner'], readPerm: 'compliance.read' },
      { id: 'approvals', label: 'Approval policies', description: 'Multi-person approval gates', icon: <IconCheckList />, required: ['security', 'owner'], readPerm: 'approvals.read' },
    ],
  },
  {
    label: 'Workloads',
    caption: 'Clouds, projects, environments',
    items: [
      { id: 'clouds', label: 'Cloud providers', description: 'AWS · GCP · Azure · Civo · DO · On-prem', icon: <IconCloud />, required: ['admin', 'security', 'owner'], readPerm: 'integrations.read' },
      { id: 'projects', label: 'Projects', description: 'Repos, apps, environments', icon: <IconFolder />, required: ['admin', 'owner'], readPerm: 'projects.read' },
      { id: 'environments', label: 'Environments', description: 'Dev → staging → prod', icon: <IconCloud />, required: ['admin', 'owner'], readPerm: 'environments.read' },
    ],
  },
  {
    label: 'Connectivity',
    caption: 'Tools, tokens, events',
    items: [
      { id: 'integrations', label: 'Integrations', description: 'Backing tool wiring', icon: <IconPlug />, required: ['admin', 'owner'], readPerm: 'integrations.read' },
      { id: 'tokens', label: 'API tokens', description: 'Org tokens for CI', icon: <IconTokens />, required: ['admin', 'owner'], readPerm: 'tokens.read' },
      { id: 'webhooks', label: 'Webhooks', description: 'Outbound events', icon: <IconWebhook />, required: ['admin', 'owner'], readPerm: 'webhooks.read' },
    ],
  },
  {
    label: 'Billing & finance',
    caption: 'Plan, invoices, costs',
    items: [
      { id: 'plan', label: 'Plan', description: 'Tier, seats, renewal', icon: <IconCreditCard />, required: ['billing', 'owner'], readPerm: 'billing.read' },
      { id: 'usage', label: 'Usage & quotas', description: 'Real-time consumption', icon: <IconGauge />, readPerm: 'billing.read' },
      { id: 'payments', label: 'Payment methods', description: 'Card · ACH · invoice', icon: <IconCard />, required: ['billing', 'owner'], readPerm: 'payments.read' },
      { id: 'invoices', label: 'Invoices', description: 'Statements + line items', icon: <IconInvoice />, required: ['billing', 'finance', 'owner'], readPerm: 'invoices.read' },
      { id: 'cost-centers', label: 'Cost centers', description: 'Chargeback structure', icon: <IconBuilding />, required: ['billing', 'finance', 'owner'], readPerm: 'costcenters.read' },
      { id: 'budgets', label: 'Budgets', description: 'Caps, alerts, forecasts', icon: <IconTarget />, required: ['billing', 'finance', 'owner'], readPerm: 'budgets.read' },
      { id: 'allocation', label: 'Cost allocation', description: 'Spend by project / team / cluster', icon: <IconPieChart />, readPerm: 'allocation.read' },
    ],
  },
  {
    label: 'Appearance',
    items: [{ id: 'theming', label: 'Theming', description: 'Color presets', icon: <IconPalette /> }],
  },
  {
    label: 'Danger zone',
    items: [{ id: 'danger', label: 'Delete org', description: 'Irreversible', icon: <IconAlert />, required: ['owner'] }],
  },
]

const ALL_SECTIONS = new Set<Section>(GROUPS.flatMap((g) => g.items.map((i) => i.id)))

function coerce(section?: string): Section {
  return section && ALL_SECTIONS.has(section as Section) ? (section as Section) : 'organization'
}

export default function WorkspaceHome({ section: urlSection }: { section?: string } = {}) {
  const [section, setSection] = useState<Section>(() => coerce(urlSection))
  const roles = useCurrentRoles()

  useEffect(() => {
    setSection(coerce(urlSection))
  }, [urlSection])

  const activeItem = useMemo(
    () => GROUPS.flatMap((g) => g.items).find((i) => i.id === section),
    [section],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace settings"
        description="Organization, identity, security, billing, and finance — fully transparent and open-source-backed."
        badge={
          <div className="inline-flex flex-wrap items-center gap-1">
            {roles.map((r) => (
              <RoleBadge key={r} role={r} />
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
                {g.label}
              </div>
              {g.caption ? (
                <div className="mb-2 px-2 text-[11px] text-content-subtle/80">{g.caption}</div>
              ) : null}
              <div className="space-y-0.5">
                {g.items.map((it) => {
                  const canRead = !it.readPerm || rolesHavePermission(roles, it.readPerm)
                  if (!canRead) return null
                  const active = section === it.id
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => setSection(it.id)}
                      className={cn(
                        'group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors',
                        active
                          ? 'bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200'
                          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                          active
                            ? 'bg-surface-raised text-brand-700 ring-1 ring-brand-200'
                            : 'text-content-subtle group-hover:text-content',
                        )}
                      >
                        {it.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium">{it.label}</span>
                        {it.description ? (
                          <span
                            className={cn(
                              'block text-[10.5px] leading-tight',
                              active ? 'text-brand-700/70' : 'text-content-subtle',
                            )}
                          >
                            {it.description}
                          </span>
                        ) : null}
                      </span>
                      {it.id === 'danger' ? (
                        <StatusBadge kind="failed">!</StatusBadge>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </aside>

        <div className="min-w-0 space-y-6">
          <SectionBody section={activeItem?.id ?? 'organization'} />
        </div>
      </div>
    </div>
  )
}

function SectionBody({ section }: { section: Section }) {
  switch (section) {
    case 'organization': return <Organization />
    case 'members': return <Members />
    case 'teams': return <Teams />
    case 'roles': return <RolesPermissions />
    case 'sso': return <Sso />
    case 'mfa': return <Mfa />
    case 'ip-allowlist': return <IpAllowlist />
    case 'security': return <SecurityPolicies />
    case 'audit': return <AuditLog />
    case 'compliance': return <Compliance />
    case 'approvals': return <Approvals />
    case 'clouds': return <CloudProviders />
    case 'projects': return <Projects />
    case 'environments': return <Environments />
    case 'integrations': return <Integrations />
    case 'tokens': return <Tokens />
    case 'webhooks': return <Webhooks />
    case 'plan': return <Plan />
    case 'usage': return <UsageView />
    case 'payments': return <PaymentMethods />
    case 'invoices': return <Invoices />
    case 'cost-centers': return <CostCenters />
    case 'budgets': return <Budgets />
    case 'allocation': return <CostAllocation />
    case 'theming': return <Theming />
    case 'danger': return <DangerZone />
  }
}

/* ─────────── inline icons ─────────── */
const ic = 'h-3.5 w-3.5'
function IconOrg() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 9h.01"/><path d="M9 13h.01"/><path d="M9 17h.01"/><path d="M15 9h.01"/><path d="M15 13h.01"/><path d="M15 17h.01"/></svg> }
function IconUsers() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> }
function IconTeam() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 11a3 3 0 1 0-3-3"/><path d="M21 21v-2a4 4 0 0 0-3-3.87"/></svg> }
function IconShield() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> }
function IconKey() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="m18 6 3 3"/><path d="m15 9 3 3"/></svg> }
function IconLock() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> }
function IconNetwork() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/></svg> }
function IconBolt() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg> }
function IconBookOpen() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z"/></svg> }
function IconCert() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="9" r="6"/><path d="m9 14-2 7 5-2 5 2-2-7"/></svg> }
function IconCheckList() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m3 7 2 2 4-4"/><path d="m3 14 2 2 4-4"/><path d="M13 6h8"/><path d="M13 13h8"/><path d="M13 20h8"/></svg> }
function IconFolder() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> }
function IconCloud() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 18a5 5 0 0 0-1.4-9.8 7 7 0 0 0-13 3 5 5 0 0 0 .9 9.8H17"/></svg> }
function IconPlug() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 2v6"/><path d="M15 2v6"/><path d="M5 8h14v3a7 7 0 0 1-14 0V8z"/><path d="M12 18v4"/></svg> }
function IconTokens() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg> }
function IconWebhook() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 16.98c2.69-.07 4.34-3.86 2.62-6.04"/><path d="M5.71 8.27c.85-1.5 3.21-2.39 4.93-1.16"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="6.5" r="2.5"/><circle cx="11" cy="13" r="2.5"/></svg> }
function IconCreditCard() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> }
function IconGauge() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m12 14 4-4"/><path d="M3 12a9 9 0 1 1 18 0"/></svg> }
function IconCard() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 11h20"/></svg> }
function IconInvoice() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/></svg> }
function IconBuilding() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M8 10h.01"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 14h.01"/><path d="M16 14h.01"/><path d="M12 14h.01"/></svg> }
function IconTarget() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> }
function IconPieChart() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg> }
function IconPalette() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.7 1.5-1.5 0-.39-.15-.74-.4-1-.23-.27-.36-.62-.36-1 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.5-9-10-9z"/></svg> }
function IconAlert() { return <svg className={ic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> }
