import { useMemo, useState } from 'react'
import { Button, EmptyState, SearchInput, Select } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { buildLicenses, type LicenseRisk, licenseWaived, type LicenseRow } from '../../data/security-findings.ts'
import { useSbomReports } from '../../data/security-reports.ts'
import { usePolicy } from '../../data/security-api.ts'
import { useSetSecurityParams } from '../../data/security-nav.ts'
import type { SecurityModel } from '../../data/security-model.ts'
import { RequestWaiverModal, type WaiverPreset } from './dialogs.tsx'
import { fmtDate, Loading, Notice, Section, TableWrap, TD, Tile, TH } from './shared.tsx'

const RISK: Record<LicenseRisk, { label: string; cls: string }> = {
  deny: { label: 'Denied', cls: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200' },
  warn: { label: 'Warn', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-200' },
  unknown: { label: 'Undeclared', cls: 'bg-surface-sunken text-content-muted ring-edge-subtle' },
  ok: { label: 'Allowed', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-200' },
}

function RiskChip({ risk }: { risk: LicenseRisk }) {
  return <span className={cn('inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', RISK[risk].cls)}>{RISK[risk].label}</span>
}

/**
 * OSS licenses: the inventory from trivy-operator's SBOMs, judged against the
 * global scan policy's deny / warn lists, with license waivers.
 */
export function Licenses({ model }: { model: SecurityModel }) {
  const sboms = useSbomReports(true)
  const policy = usePolicy()
  const setParams = useSetSecurityParams()
  const [view, setView] = useState<'license' | 'app'>('license')
  const [risk, setRisk] = useState<LicenseRisk | ''>('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [preset, setPreset] = useState<WaiverPreset | null>(null)
  const now = Date.now()
  const pol = policy.data?.effective
  const inv = useMemo(() => buildLicenses(sboms.data?.items ?? [], model.projects.names, pol), [sboms.data, model.projects.names, pol])
  const licenseWaivers = model.waiverItems.filter((w) => w.kind === 'license')

  if (sboms.isLoading) return <Loading text="Reading SBOMs…" />
  const st = sboms.data?.state
  if (st === 'absent') {
    return <Notice tone="warn" title="No SBOM reports">trivy-operator is not producing SbomReports on this cluster (not installed, or SBOM generation is off), so there is no license inventory to show.</Notice>
  }
  if (st === 'forbidden') return <Notice tone="warn" title="No permission to read SBOM reports">Ask a platform admin for read access to <code>sbomreports.aquasecurity.github.io</code>.</Notice>
  if (st === 'error') return <Notice tone="error" title="Couldn't read SBOM reports">{sboms.data?.detail}</Notice>
  if (!inv.rows.length) return <EmptyState title="No SBOMs yet" description="trivy-operator has not produced an SBOM for any running workload yet." />

  const count = (r: LicenseRisk) => inv.rows.filter((x) => x.risk === r).reduce((n, x) => n + x.packages.length, 0)
  const q = search.trim().toLowerCase()
  const rows = inv.rows.filter((r) => (!risk || r.risk === risk) && (!q || r.license.toLowerCase().includes(q) || r.packages.some((p) => p.name.toLowerCase().includes(q))))

  const requestFor = (row: LicenseRow) => {
    const targets = row.apps.map((a) => {
      const [project, app] = a.split('/')
      return { project, app }
    })
    setPreset({ kind: 'license', findingId: row.license, targets, defaultScope: 'app' })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Denied" value={count('deny')} tone={count('deny') ? 'text-rose-600 dark:text-rose-300' : undefined} hint="packages" active={risk === 'deny'} onClick={() => setRisk((r) => (r === 'deny' ? '' : 'deny'))} />
        <Tile label="Warn" value={count('warn')} tone={count('warn') ? 'text-amber-600 dark:text-amber-300' : undefined} hint="packages" active={risk === 'warn'} onClick={() => setRisk((r) => (r === 'warn' ? '' : 'warn'))} />
        <Tile label="Undeclared" value={count('unknown')} hint="no license in the SBOM" active={risk === 'unknown'} onClick={() => setRisk((r) => (r === 'unknown' ? '' : 'unknown'))} />
        <Tile label="Licenses" value={inv.rows.filter((r) => r.license).length} hint={`${inv.apps.length} workloads`} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-content-muted">
        <span>Policy:</span>
        {pol?.licenseDeny.length ? <span>deny <b className="text-content">{pol.licenseDeny.join(', ')}</b></span> : <span>no denied licenses</span>}
        {pol?.licenseWarn.length ? <span>· warn <b className="text-content">{pol.licenseWarn.join(', ')}</b></span> : null}
        <Button size="xs" variant="ghost" onClick={() => setParams({ tab: 'policy' })}>Edit policy</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search license or package…" label="Search licenses" />
        </div>
        <Select aria-label="Group by" value={view} onChange={(e) => setView(e.target.value as 'license' | 'app')} wrapperClassName="w-40">
          <option value="license">By license</option>
          <option value="app">By workload</option>
        </Select>
      </div>

      {view === 'app' ? (
        <TableWrap>
          <thead>
            <tr className="border-b border-edge-subtle">
              <th className={TH}>Workload</th>
              <th className={cn(TH, 'text-right')}>Components</th>
              <th className={cn(TH, 'text-right')}>Denied</th>
              <th className={cn(TH, 'text-right')}>Warn</th>
              <th className={cn(TH, 'text-right')}>Undeclared</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {inv.apps.filter((a) => !q || a.app.toLowerCase().includes(q)).map((a) => (
              <tr key={`${a.namespace}/${a.app}`}>
                <td className={TD}>{a.app}<div className="text-[11px] text-content-subtle">{a.project ?? a.namespace}{a.env ? ` / ${a.env}` : ''}</div></td>
                <td className={cn(TD, 'text-right tabular-nums')}>{a.components}</td>
                <td className={cn(TD, 'text-right tabular-nums', a.byRisk.deny ? 'text-rose-700 dark:text-rose-300' : 'text-content-subtle')}>{a.byRisk.deny}</td>
                <td className={cn(TD, 'text-right tabular-nums', a.byRisk.warn ? 'text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>{a.byRisk.warn}</td>
                <td className={cn(TD, 'text-right tabular-nums text-content-subtle')}>{a.byRisk.unknown}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {rows.map((r) => {
            const key = r.license || '(none)'
            const waived = r.apps.map((a) => {
              const [p, app] = a.split('/')
              return licenseWaived(licenseWaivers, r.license, p, app, now)
            })
            const waivedCount = waived.filter(Boolean).length
            const expanded = open === key
            return (
              <li key={key}>
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <button type="button" onClick={() => setOpen(expanded ? null : key)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={expanded}>
                    <span className="text-content-subtle">{expanded ? '▾' : '▸'}</span>
                    <RiskChip risk={r.risk} />
                    <span className="truncate text-[13px] font-medium text-content">{r.license || 'No license declared'}</span>
                    <span className="shrink-0 text-[11px] text-content-subtle">{r.packages.length} pkg · {r.apps.length} workload{r.apps.length === 1 ? '' : 's'}</span>
                  </button>
                  {waivedCount ? <span className="text-[11px] text-emerald-700 dark:text-emerald-300">waived in {waivedCount}/{r.apps.length}</span> : null}
                  {(r.risk === 'deny' || r.risk === 'warn') && r.license ? <Button size="xs" onClick={() => requestFor(r)}>Request waiver</Button> : null}
                </div>
                {expanded ? (
                  <div className="border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2">
                    <ul className="space-y-1.5">
                      {r.packages.slice(0, 100).map((p) => (
                        <li key={`${p.name}@${p.version}`} className="text-[12px]">
                          <span className="font-medium text-content">{p.name}</span> <span className="font-mono text-content-muted">{p.version}</span>
                          <span className="text-[11px] text-content-subtle"> · {p.apps.join(', ')}</span>
                          {p.path ? <div className="font-mono text-[10px] text-content-subtle">{p.path.join(' → ')}</div> : null}
                        </li>
                      ))}
                      {r.packages.length > 100 ? <li className="text-[11px] text-content-subtle">…and {r.packages.length - 100} more</li> : null}
                    </ul>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {licenseWaivers.length ? (
        <Section title={`License waivers (${licenseWaivers.length})`}>
          <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
            {licenseWaivers.map((w) => (
              <li key={w.id}>
                <button type="button" onClick={() => setParams({ tab: 'waivers', waiver: w.id }, { push: true })} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-sunken/50">
                  <span className="text-[12px] font-medium text-content">{w.findingId}</span>
                  <span className="text-[11px] text-content-subtle">{w.target.project}{w.target.app ? `/${w.target.app}` : ''} · {w.status}</span>
                  <span className="ml-auto text-[11px] text-content-subtle">until {fmtDate(w.expiresAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <RequestWaiverModal preset={preset} onClose={() => setPreset(null)} />
    </div>
  )
}
