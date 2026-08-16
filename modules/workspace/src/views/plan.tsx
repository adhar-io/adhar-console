import type { ReactNode } from 'react'
import { EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  fmtMoney,
  isStoreUnavailable,
  usePlans,
  useSubscription,
  useUpdateSubscription,
  type PlanDef,
} from '../data/billing.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

function priceLabel(p: PlanDef): string {
  if (p.contactSales) return 'Contact sales'
  if (p.pricePerSeatMonthly === 0) return '$0'
  return `$${p.pricePerSeatMonthly} / seat / mo`
}

export function Plan() {
  const plansQ = usePlans()
  const subQ = useSubscription()
  const update = useUpdateSubscription()

  const summary = subQ.data
  const sub = summary?.item
  const limits = summary?.plan.limits

  const shell = (children: ReactNode) => (
    <ViewShell
      title="Plan & subscription"
      description="Pricing is public and versioned. The plan covers managed operations, SLAs, and support — every capability is also available in the open-source stack."
      required={['billing', 'owner']}
    >
      {children}
    </ViewShell>
  )

  if (subQ.isLoading || plansQ.isLoading) {
    return shell(
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading subscription…
      </div>,
    )
  }
  if (subQ.isError && isStoreUnavailable(subQ.error)) {
    return shell(
      <EmptyState
        title="Connect a database"
        description="Subscriptions are persisted in Postgres. Set DATABASE_URL for the console server to manage billing."
      />,
    )
  }
  if (subQ.isError || plansQ.isError) {
    return shell(
      <EmptyState
        title="Billing unavailable"
        description={(subQ.error ?? plansQ.error) instanceof Error ? ((subQ.error ?? plansQ.error) as Error).message : 'The billing API did not respond.'}
      />,
    )
  }

  const manageSeats = () => {
    if (!sub) return
    const raw = window.prompt('Seats to purchase:', String(sub.seatsPurchased))
    if (!raw) return
    const seats = Number(raw)
    if (!Number.isInteger(seats) || seats < 1) return
    update.mutate({ seatsPurchased: seats })
  }

  return shell(
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Tier"
          value={sub?.tier ?? '—'}
          hint={sub ? sub.status : ''}
          tone={sub?.status === 'active' ? 'good' : 'warn'}
        />
        <StatTile
          label="Seats"
          value={summary ? `${summary.seatsUsed} / ${sub?.seatsPurchased}` : '—'}
          hint="used / purchased"
        />
        <StatTile
          label="Monthly"
          value={summary ? fmtMoney(summary.priceMonthly, summary.currency) : '—'}
          hint={summary?.plan.contactSales ? 'contractual pricing' : 'seat-based billing'}
        />
        <StatTile
          label="Renews"
          value={sub ? formatRelative(sub.renewsAt) : '—'}
          hint={summary?.paymentMethod ?? 'no payment method'}
        />
      </div>

      <SettingsCard
        title="Pricing tiers"
        description="Upgrade unlocks higher quotas and additional security features. Switching updates the persisted subscription immediately."
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(plansQ.data ?? []).map((t) => {
            const active = sub && t.id === sub.tier
            return (
              <div
                key={t.id}
                className={
                  active
                    ? 'rounded-xl border-2 border-brand-500 bg-brand-50/40 p-4 shadow-md'
                    : 'rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm'
                }
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold capitalize text-content">{t.name}</div>
                  {active ? <StatusBadge kind="info">current</StatusBadge> : null}
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums tracking-tight text-content">
                  {priceLabel(t)}
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
                  t.contactSales ? (
                    <PrimaryButton
                      onClick={() => {
                        window.location.href = 'mailto:sales@adhar.io?subject=Enterprise plan'
                      }}
                    >
                      Contact sales
                    </PrimaryButton>
                  ) : (
                    <PrimaryButton
                      disabled={update.isPending}
                      onClick={() => update.mutate({ tier: t.id })}
                    >
                      {update.isPending ? 'Switching…' : `Switch to ${t.name}`}
                    </PrimaryButton>
                  )
                ) : (
                  <SecondaryButton onClick={manageSeats} disabled={update.isPending}>
                    Manage seats
                  </SecondaryButton>
                )}
              </div>
            )
          })}
        </div>
        {update.isError ? (
          <p className="mt-3 text-[12px] text-rose-600">
            {update.error instanceof Error ? update.error.message : 'Update failed.'}
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Plan limits">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Projects" value={limitValue(limits?.projects)} />
          <StatTile label="Environments" value={limitValue(limits?.environments)} />
          <StatTile label="Clusters" value={limitValue(limits?.clusters)} />
          <StatTile
            label="Storage"
            value={limits?.storageGb === null ? 'Unlimited' : limits ? `${limits.storageGb} GB` : '—'}
          />
        </div>
      </SettingsCard>
    </>,
  )
}

function limitValue(n: number | null | undefined): string {
  if (n === undefined) return '—'
  if (n === null) return 'Unlimited'
  return String(n)
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export default Plan
