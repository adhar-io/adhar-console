import { useMemo } from 'react'
import { useWaivers } from './security-api.ts'
import type { Waiver } from './security-types.ts'
import { buildFindings, type Finding, findingStatus, type FindingStatus, rollup } from './security-findings.ts'
import { useProjectNames, useVulnerabilityReports } from './security-reports.ts'

/**
 * Findings joined with waivers — the shared input of Overview, Findings and
 * the finding drawer, so they always agree on what is waived.
 */
export function useSecurityModel() {
  const reports = useVulnerabilityReports()
  const projects = useProjectNames()
  const waivers = useWaivers()
  const now = Date.now()
  const waiverItems: Waiver[] = useMemo(() => waivers.data?.items ?? [], [waivers.data])
  const findings: Finding[] = useMemo(() => buildFindings(reports.data?.items ?? [], projects.names), [reports.data, projects.names])
  const statuses = useMemo(() => {
    const m = new Map<string, FindingStatus>()
    for (const f of findings) m.set(f.key, findingStatus(f, waiverItems, now))
    return m
    // `now` is deliberately not a dependency: recomputing each render would churn.
  }, [findings, waiverItems]) // eslint-disable-line react-hooks/exhaustive-deps
  const totals = useMemo(() => rollup(findings, statuses), [findings, statuses])
  return { reports, projects, waivers, waiverItems, findings, statuses, totals }
}

export type SecurityModel = ReturnType<typeof useSecurityModel>
