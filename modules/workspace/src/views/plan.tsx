import { useQuery } from '@tanstack/react-query'
import { StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'
import { fmtMoney } from '../data/enterprise.ts'

const TIERS: { id: 'free' | 'team' | 'business' | 'enterprise'; price: string; summary: string; includes: string[] }[] = [
  {
    id: 'free',
    price: '$0',
    summary: 'Solo devs and side projects.',
    includes: ['1 project', '2 environments', 'Public status page', 'Community support'],
  },
  {
    id: 'team',
    price: '$29 / user / mo',
    summary: 'Small teams standardizing on the Adhar stack.',
    includes: ['10 projects', '30 environments', 'SSO via Keycloak', 'Email support'],
  },
  {
    id: 'business',
    price: '$79 / user / mo',
    summary: 'Multi-team orgs with compliance needs.',
    includes: ['50 projects', '200 environments', 'Audit log (365d)', 'SAML/OIDC federation', 'Priority support'],
  },
  {
    id: 'enterprise',
    price: 'Contact sales',
    summary: 'Large orgs, air-gapped, or custom SLAs.',
    includes: [
      'Unlimited projects',
      'Unlimited environments',
      'Dedicated support + SLA',
      'On-prem / air-gapped install',
      'Source-available + commercial terms',
    ],
  },
]

export function Plan() {
  const q = useQuery({
    queryKey: ['ws', 'plan', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.getPlan(CURRENT_ORG_SLUG),
  })
  const p = q.data
  return (
    <ViewShell
      title="Plan & subscription"
      description="Pricing is public and versioned. The plan covers managed operations, SLAs, and support — every capability is also available in the open-source stack."
      required={['billing', 'owner']}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Tier" value={p?.tier ?? '—'} hint={p ? 'active' : ''} tone="good" />
        <StatTile label="Seats" value={p ? `${p.seatsUsed} / ${p.seats}` : '—'} hint="used / total" />
        <StatTile
          label="Monthly"
          value={p ? fmtMoney(p.priceMonthly, p.currency) : '—'}
          hint="line-item billing"
        />
        <StatTile
          label="Renews"
          value={p ? formatRelative(p.renewsAt) : '—'}
          hint={p?.paymentMethod ?? 'no payment method'}
        />
      </div>

      <SettingsCard
        title="Pricing tiers"
        description="Upgrade unlocks higher quotas and additional security features."
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {TIERS.map((t) => {
            const active = p && t.id === p.tier
            return (
              <div
                key={t.id}
                className={
                  active
                    ? 'rounded-xl border-2 border-brand-500 bg-brand-50/40 p-4 shadow-md'
                    : 'rounded-xl border border-edge-default bg-white p-4 shadow-sm'
                }
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold capitalize text-content">{t.id}</div>
                  {active ? <StatusBadge kind="info">current</StatusBadge> : null}
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums tracking-tight text-content">
                  {t.price}
                </div>
                <p className="mt-1 text-[12px] text-content-muted">{t.summary}</p>
                <ul className="mt-4 space-y-1.5 text-[12px] text-content">
                  {t.includes.map((x) => (
                    <li key={x} className="flex items-start gap-2">
                      <span className="mt-1 text-emerald-600">
                        <CheckGlyph />
                      </span>
                      {x}
                    </li>
                  ))}
                </ul>
                {!active ? (
                  <PrimaryButton onClick={() => alert(`Switch to ${t.id} — wizard pending.`)}>
                    {t.id === 'enterprise' ? 'Contact sales' : `Switch to ${t.id}`}
                  </PrimaryButton>
                ) : (
                  <SecondaryButton>Manage seats</SecondaryButton>
                )}
              </div>
            )
          })}
        </div>
      </SettingsCard>

      <SettingsCard title="Plan limits">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Projects" value={p?.limits.projects ?? '—'} />
          <StatTile label="Environments" value={p?.limits.environments ?? '—'} />
          <StatTile label="Clusters" value={p?.limits.clusters ?? '—'} />
          <StatTile label="Storage" value={p ? `${p.limits.storageGb} GB` : '—'} />
        </div>
      </SettingsCard>
    </ViewShell>
  )
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export default Plan
