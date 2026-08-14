import { StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { useCompliance, type ComplianceStatus } from '../data/enterprise.ts'
import {
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

const STATUS_KIND: Record<ComplianceStatus, StatusKind> = {
  certified: 'healthy',
  'in-progress': 'progressing',
  'not-started': 'unknown',
}
const STATUS_LABEL: Record<ComplianceStatus, string> = {
  certified: 'Certified',
  'in-progress': 'In progress',
  'not-started': 'Not started',
}

export function Compliance() {
  const q = useCompliance()
  const all = q.data ?? []
  const certified = all.filter((c) => c.status === 'certified').length
  const inProgress = all.filter((c) => c.status === 'in-progress').length
  const totalControls = all.reduce((s, c) => s + c.controlsTotal, 0)
  const passingControls = all.reduce((s, c) => s + c.controlsPassing, 0)

  return (
    <ViewShell
      title="Compliance"
      description="Frameworks, controls, and audit reports. Evidence is generated continuously from the platform’s own observability + policy stack."
      required={['security', 'owner']}
      actions={
        <SecondaryButton>
          <IconExternal /> Trust center
        </SecondaryButton>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Certified" value={certified} tone="good" />
        <StatTile label="In progress" value={inProgress} tone="warn" />
        <StatTile
          label="Controls passing"
          value={`${passingControls}/${totalControls}`}
          tone={passingControls === totalControls ? 'good' : 'warn'}
        />
        <StatTile label="Frameworks" value={all.length} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {all.map((c) => {
          const pct = c.controlsTotal > 0 ? Math.round((c.controlsPassing / c.controlsTotal) * 100) : 0
          return (
            <SettingsCard
              key={c.id}
              title={c.name}
              actions={<StatusBadge kind={STATUS_KIND[c.status]}>{STATUS_LABEL[c.status]}</StatusBadge>}
            >
              <div className="space-y-3">
                <div>
                  <div className="flex items-baseline justify-between text-[12px]">
                    <span className="text-content-muted">Controls</span>
                    <span className="font-mono tabular-nums text-content">
                      {c.controlsPassing} / {c.controlsTotal}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{
                        width: `${pct}%`,
                        backgroundColor:
                          pct === 100 ? 'var(--color-brand-500)' : pct >= 70 ? '#f59e0b' : '#f43f5e',
                      }}
                    />
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  <Pair label="Certified" value={c.certifiedAt ?? '—'} />
                  <Pair label="Next audit" value={c.nextAuditAt ?? '—'} />
                </dl>

                <div className="flex justify-end gap-2">
                  {c.reportUrl ? (
                    <a
                      href={c.reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
                    >
                      <IconExternal /> Download report
                    </a>
                  ) : null}
                  <SecondaryButton>View controls</SecondaryButton>
                </div>
              </div>
            </SettingsCard>
          )
        })}
      </div>
    </ViewShell>
  )
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-content-subtle">{label}</dt>
      <dd className="text-right font-mono tabular-nums text-content-muted">{value}</dd>
    </>
  )
}

function IconExternal() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

export default Compliance
