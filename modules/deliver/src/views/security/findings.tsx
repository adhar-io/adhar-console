import { type ReactNode, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, EmptyState, Field, Modal, SearchInput, Select, Spinner, Textarea, usePlaneWorkspace, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { plane } from '@adhar/api-clients'
import type { SecurityModel } from '../../data/security-model.ts'
import {
  componentPath,
  type Finding,
  type FindingFilter,
  type FindingStatus,
  matchesFinding,
  SEVERITIES,
  type Severity,
  waiverCovers,
} from '../../data/security-findings.ts'
import { useSbomReports } from '../../data/security-reports.ts'
import { securityLink, useSecurityParams, useSetSecurityParams } from '../../data/security-nav.ts'
import { SCOPE_LABEL, VEX_STATUS_LABEL } from '../../data/security-api.ts'
import { RequestWaiverModal, type WaiverPreset } from './dialogs.tsx'
import { useCanRequestWaiver } from '../../data/security-access.ts'
import { Drawer, fmtDate, KV, Loading, Notice, ReportStateNotice, Section, SEV_TONE, SevChip, shortDigest, TableWrap, TD, TH, WaiverStatusChip } from './shared.tsx'
import { safeExternalUrl } from '../../data/safe-url.ts'

const PAGE = 200

export function Findings({ model }: { model: SecurityModel }) {
  const { findings, statuses, reports, projects } = model
  const params = useSecurityParams()
  const setParams = useSetSecurityParams()
  const [filter, setFilter] = useState<FindingFilter>({ waived: 'open', project: params.project })
  const [limit, setLimit] = useState(PAGE)
  const envs = useMemo(() => [...new Set(findings.flatMap((f) => f.occurrences.map((o) => o.env).filter((e): e is string => Boolean(e))))].sort(), [findings])
  const projectList = useMemo(() => [...new Set([...projects.names, ...findings.flatMap((f) => f.occurrences.map((o) => o.project ?? o.namespace))])].sort(), [findings, projects.names])
  const hasEpss = findings.some((f) => f.epss !== undefined)
  const hasKev = findings.some((f) => f.kev)

  const visible = findings.filter((f) => matchesFinding(f, statuses.get(f.key)!, filter))
  const open = params.finding ? findings.find((f) => f.key === params.finding || f.id === params.finding) : undefined

  if (reports.isLoading) return <Loading text="Reading trivy-operator reports…" />
  const state = reports.data?.state ?? 'error'
  if (state !== 'ok') return <ReportStateNotice state={state} detail={reports.data?.detail} />
  if (!findings.length) {
    return <EmptyState title="No vulnerabilities in running workloads" description="trivy-operator has scanned the running images and reported no known vulnerabilities." />
  }

  const toggleSev = (s: Severity) => setFilter((f) => ({ ...f, severities: f.severities?.includes(s) ? f.severities.filter((x) => x !== s) : [...(f.severities ?? []), s] }))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter.severities?.includes(s) ?? false}
            onClick={() => toggleSev(s)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-opacity',
              SEV_TONE[s].chip,
              filter.severities?.length && !filter.severities.includes(s) && 'opacity-40',
            )}
          >
            {findings.filter((f) => f.severity === s).length} {s}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={Boolean(filter.fixableOnly)}
          onClick={() => setFilter((f) => ({ ...f, fixableOnly: !f.fixableOnly }))}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
            filter.fixableOnly ? 'bg-brand-50 text-brand-800 ring-brand-600/25 dark:bg-brand-500/15 dark:text-brand-200' : 'bg-surface-sunken text-content-muted ring-edge-subtle',
          )}
        >
          fixable only
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <SearchInput value={filter.search ?? ''} onChange={(v) => setFilter((f) => ({ ...f, search: v }))} placeholder="Search CVE, package, app or image…" label="Search findings" />
        </div>
        <Select aria-label="Waiver state" value={filter.waived ?? 'all'} onChange={(e) => setFilter((f) => ({ ...f, waived: e.target.value as FindingFilter['waived'] }))} wrapperClassName="w-40">
          <option value="open">Not fully waived</option>
          <option value="waived">Waived</option>
          <option value="all">All findings</option>
        </Select>
        <Select
          aria-label="Project"
          value={filter.project ?? ''}
          onChange={(e) => {
            setFilter((f) => ({ ...f, project: e.target.value || undefined }))
            setParams({ project: e.target.value || undefined })
          }}
          wrapperClassName="w-40"
        >
          <option value="">All projects</option>
          {projectList.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        {envs.length ? (
          <Select aria-label="Environment" value={filter.env ?? ''} onChange={(e) => setFilter((f) => ({ ...f, env: e.target.value || undefined }))} wrapperClassName="w-36">
            <option value="">All environments</option>
            {envs.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        ) : null}
      </div>
      <div className="text-[11px] text-content-subtle">
        {visible.length.toLocaleString()} of {findings.length.toLocaleString()} findings · runtime reports from trivy-operator
      </div>
      {visible.length === 0 ? (
        <EmptyState compact title="No matching findings" description="Relax the filters or the search." />
      ) : (
        <TableWrap>
          <thead>
            <tr className="border-b border-edge-subtle">
              <th className={TH}>Finding</th>
              <th className={TH}>Package</th>
              <th className={TH}>Where</th>
              {hasEpss ? <th className={TH}>EPSS</th> : null}
              <th className={TH}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {visible.slice(0, limit).map((f) => (
              <FindingRow
                key={f.key}
                f={f}
                st={statuses.get(f.key)!}
                showEpss={hasEpss}
                showKev={hasKev}
                onOpen={() => setParams({ finding: f.key }, { push: true })}
              />
            ))}
          </tbody>
        </TableWrap>
      )}
      {visible.length > limit ? (
        <div className="text-center">
          <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, visible.length - limit)} more</Button>
        </div>
      ) : null}
      {open ? <FindingDrawer finding={open} model={model} onClose={() => setParams({ finding: undefined })} /> : null}
    </div>
  )
}

function FindingRow({ f, st, showEpss, showKev, onOpen }: { f: Finding; st: FindingStatus; showEpss: boolean; showKev: boolean; onOpen(): void }) {
  const apps = [...new Set(f.occurrences.map((o) => `${o.project ?? o.namespace}/${o.app ?? '?'}`))]
  const envs = [...new Set(f.occurrences.map((o) => o.env).filter(Boolean))]
  return (
    <tr className="cursor-pointer transition-colors hover:bg-surface-sunken/50" onClick={onOpen}>
      <td className={TD}>
        <div className="flex items-center gap-2">
          <SevChip severity={f.severity} />
          <button type="button" className="font-mono text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={(e) => (e.stopPropagation(), onOpen())}>
            {f.id}
          </button>
          {showKev && f.kev ? <span className="rounded bg-rose-600 px-1 text-[9px] font-bold uppercase text-white">KEV</span> : null}
        </div>
        {f.title ? <div className="mt-0.5 line-clamp-1 max-w-[340px] text-[11px] text-content-muted">{f.title}</div> : null}
      </td>
      <td className={TD}>
        <div className="font-medium text-content">{f.pkg}</div>
        <div className="font-mono text-[11px] text-content-subtle">
          {f.installedVersions.join(', ')}
          {f.fixable ? <span className="text-emerald-700 dark:text-emerald-300"> → {f.fixedVersions.join(', ')}</span> : <span> · no fix</span>}
        </div>
      </td>
      <td className={TD}>
        <div className="text-content">{apps.slice(0, 2).join(', ')}{apps.length > 2 ? ` +${apps.length - 2}` : ''}</div>
        <div className="text-[11px] text-content-subtle">{envs.length ? envs.join(' · ') : `${f.occurrences.length} workload${f.occurrences.length === 1 ? '' : 's'}`}</div>
      </td>
      {showEpss ? <td className={cn(TD, 'tabular-nums')}>{f.epss !== undefined ? `${(f.epss * 100).toFixed(1)}%` : '—'}</td> : null}
      <td className={TD}>
        {st.coverage === 'waived'
          ? <span className="text-[11px] text-emerald-700 dark:text-emerald-300">Waived · until {fmtDate(st.expiresAt)}</span>
          : st.coverage === 'partial'
          ? <span className="text-[11px] text-amber-700 dark:text-amber-300">Partly waived</span>
          : st.pending
          ? <span className="text-[11px] text-indigo-700 dark:text-indigo-300">Waiver pending</span>
          : <span className="text-[11px] text-content-subtle">Open</span>}
      </td>
    </tr>
  )
}

/* ───────────────────────────── the drawer ───────────────────────────── */

export function FindingDrawer({ finding: f, model, onClose }: { finding: Finding; model: SecurityModel; onClose(): void }) {
  const toast = useToast()
  const setParams = useSetSecurityParams()
  const st = model.statuses.get(f.key)
  const sboms = useSbomReports(true)
  const [preset, setPreset] = useState<WaiverPreset | null>(null)
  const [planeOpen, setPlaneOpen] = useState(false)
  const now = Date.now()

  const targets = f.occurrences.map((o) => ({ project: o.project ?? o.namespace, app: o.app, env: o.env, digest: o.digest, image: o.image, repo: o.repo }))
  const canRequest = useCanRequestWaiver(targets.map((t) => t.project))
  const makePreset = (falsePositive: boolean): WaiverPreset => ({
    kind: 'vuln',
    findingId: f.id,
    severity: f.severity,
    title: f.title,
    package: f.pkg,
    purl: f.purl,
    version: f.installedVersions[0],
    targets,
    falsePositive,
    defaultScope: falsePositive ? 'project' : undefined,
  })

  // Dependency path from the image's root to this package, from the SBOM of an affected image.
  const path = useMemo(() => {
    for (const r of sboms.data?.items ?? []) {
      const dig = r.report?.artifact?.digest
      if (!f.occurrences.some((o) => o.digest && o.digest === dig)) continue
      const bom = r.report?.components
      const c = (bom?.components ?? []).find((c) => (f.purl && c.purl === f.purl) || c.name === f.pkg)
      if (bom && c?.['bom-ref']) {
        const p = componentPath(bom, c['bom-ref'])
        if (p) return p
      }
    }
    return undefined
  }, [sboms.data, f])

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(securityLink({ tab: 'findings', finding: f.key }))
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <Drawer
      widthId="deliver.security-finding"
      onClose={onClose}
      eyebrow="Vulnerability"
      title={<span className="font-mono">{f.id}</span>}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <SevChip severity={f.severity} />
          {f.score ? <span className="tabular-nums">CVSS {f.score}</span> : null}
          {f.epss !== undefined ? <span className="tabular-nums">EPSS {(f.epss * 100).toFixed(1)}%</span> : null}
          {f.kev ? <span className="rounded bg-rose-600 px-1 text-[10px] font-bold uppercase text-white">Known exploited</span> : null}
          {f.published ? <span>published {fmtDate(f.published)}</span> : null}
        </span>
      }
      actions={
        <>
          {canRequest ? (
            <>
              <Button size="sm" variant="primary" onClick={() => setPreset(makePreset(false))}>Request waiver</Button>
              <Button size="sm" onClick={() => setPreset(makePreset(true))}>Mark false positive</Button>
            </>
          ) : null}
          <Button size="sm" onClick={() => setPlaneOpen(true)}>Create Plane issue</Button>
          <Button size="sm" variant="ghost" onClick={copyLink}>Copy link</Button>
        </>
      }
    >
      {st?.coverage === 'waived' ? (
        <Notice tone="info" title={`Waived everywhere it runs, until ${fmtDate(st.expiresAt)}`}>It does not count against the scan gate while the waiver is active.</Notice>
      ) : st?.coverage === 'partial' ? (
        <Notice tone="warn" title="Waived for some of the places it runs">Uncovered workloads are marked below.</Notice>
      ) : null}

      <Section title="Package">
        <KV
          rows={[
            ['Package', <span key="v" className="font-medium">{f.pkg}</span>],
            ['Installed', <span key="v" className="font-mono">{f.installedVersions.join(', ') || '—'}</span>],
            ['Fixed in', f.fixable ? <span key="v" className="font-mono text-emerald-700 dark:text-emerald-300">{f.fixedVersions.join(', ')}</span> : <span key="v" className="text-content-subtle">No fixed version published yet</span>],
            ...(f.purl ? [['PURL', <span key="v" className="break-all font-mono text-[11px]">{f.purl}</span>] as [string, ReactNode]] : []),
            ...(f.occurrences[0]?.pkgPath ? [['Path in image', <span key="v" className="break-all font-mono text-[11px]">{f.occurrences[0].pkgPath}</span>] as [string, ReactNode]] : []),
          ]}
        />
      </Section>

      <Section title="SBOM component path">
        {sboms.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Reading SBOMs…</div>
        ) : path ? (
          <ol className="flex flex-wrap items-center gap-1 text-[12px]">
            {path.map((p, i) => (
              <li key={i} className="flex items-center gap-1">
                {i ? <span className="text-content-subtle">→</span> : null}
                <span className={cn('rounded bg-surface-sunken px-1.5 py-0.5 font-mono', i === path.length - 1 && 'font-semibold text-content')}>{p}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[12px] text-content-subtle">
            {sboms.data?.state === 'absent'
              ? 'trivy-operator is not producing SBOM reports, so the dependency path is unknown.'
              : 'No SBOM of an affected image records how this package is pulled in (OS packages are installed directly).'}
          </p>
        )}
      </Section>

      {f.title || f.description ? (
        <Section title="Description">
          {f.title ? <p className="text-[13px] font-medium text-content">{f.title}</p> : null}
          {f.description ? <p className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-content-muted">{f.description}</p> : null}
        </Section>
      ) : null}
      {f.links.length ? (
        <Section title="References">
          <ul className="space-y-1">
            {f.links.slice(0, 8).map((l) => (
              <li key={l} className="truncate text-[12px]">
                {safeExternalUrl(l)
                  ? <a href={safeExternalUrl(l)} target="_blank" rel="noreferrer noopener" className="text-brand-700 hover:underline dark:text-brand-300">{l}</a>
                  : <span className="text-content-muted">{l}</span>}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={`Affected workloads (${f.occurrences.length})`}>
        <TableWrap>
          <thead>
            <tr className="border-b border-edge-subtle">
              <th className={TH}>Project / env</th>
              <th className={TH}>App</th>
              <th className={TH}>Image</th>
              <th className={TH}>Version</th>
              <th className={TH}>Waiver</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {f.occurrences.map((o, i) => {
              const w = (st?.active ?? []).find((w) => waiverCovers(w, f, o, now))
              return (
                <tr key={i}>
                  <td className={TD}>{o.project ?? o.namespace}{o.env ? <span className="text-content-subtle"> / {o.env}</span> : null}</td>
                  <td className={TD}>{o.app ?? '—'}{o.container ? <div className="text-[11px] text-content-subtle">{o.container}</div> : null}</td>
                  <td className={TD}>
                    <div className="max-w-[220px] truncate font-mono text-[11px]" title={o.image}>{o.repo ?? o.image}{o.tag ? `:${o.tag}` : ''}</div>
                    {o.digest ? <div className="font-mono text-[10px] text-content-subtle">{shortDigest(o.digest)}</div> : null}
                  </td>
                  <td className={cn(TD, 'font-mono text-[11px]')}>{o.installed ?? '—'}{o.fixed ? <div className="text-emerald-700 dark:text-emerald-300">→ {o.fixed}</div> : null}</td>
                  <td className={TD}>
                    {w ? (
                      <button type="button" className="text-[11px] text-emerald-700 hover:underline dark:text-emerald-300" onClick={() => setParams({ tab: 'waivers', waiver: w.id, finding: undefined }, { push: true })}>
                        {SCOPE_LABEL[w.scope]} · {fmtDate(w.expiresAt)}
                      </button>
                    ) : <span className="text-[11px] text-content-subtle">not waived</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </TableWrap>
        <p className="mt-1 text-[11px] text-content-subtle">Scanned {f.occurrences[0]?.scannedAt ? formatRelative(f.occurrences[0].scannedAt) : 'at an unknown time'} by trivy-operator.</p>
      </Section>

      <Section title={`Waivers for this finding (${st?.related.length ?? 0})`}>
        {st?.related.length ? (
          <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
            {st.related.map((w) => (
              <li key={w.id}>
                <button type="button" onClick={() => setParams({ tab: 'waivers', waiver: w.id, finding: undefined }, { push: true })} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-sunken/50">
                  <WaiverStatusChip status={w.status} />
                  <span className="text-[12px] text-content">{SCOPE_LABEL[w.scope]}{w.target.app ? ` · ${w.target.app}` : ''}</span>
                  <span className="text-[11px] text-content-subtle">{VEX_STATUS_LABEL[w.vex.status]} · by {w.requestedBy.label}</span>
                  <span className="ml-auto text-[11px] text-content-subtle">until {fmtDate(w.expiresAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12px] text-content-subtle">None yet.</p>}
      </Section>

      <RequestWaiverModal preset={preset} onClose={() => setPreset(null)} />
      {planeOpen ? <PlaneIssueModal finding={f} onClose={() => setPlaneOpen(false)} /> : null}
    </Drawer>
  )
}

/* ───────────────────────────── Plane ───────────────────────────── */

const planeClient = plane.PlaneClient.auto({ tool: 'plane' })

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function PlaneIssueModal({ finding: f, onClose }: { finding: Finding; onClose(): void }) {
  const toast = useToast()
  const workspace = usePlaneWorkspace()
  const projects = useQuery({ queryKey: ['plane', 'projects', workspace], queryFn: () => planeClient.listProjects(workspace), retry: false, staleTime: 60_000 })
  const [project, setProject] = useState('')
  const [busy, setBusy] = useState(false)
  const apps = [...new Set(f.occurrences.map((o) => `${o.project ?? o.namespace}/${o.app ?? '?'}${o.env ? ` (${o.env})` : ''}`))]
  const [note, setNote] = useState('')
  const pid = project || projects.data?.[0]?.id || ''
  const priority: plane.Priority = f.severity === 'critical' ? 'urgent' : f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low'

  const create = async () => {
    setBusy(true)
    try {
      const html = [
        `<p><strong>${escapeHtml(f.id)}</strong> (${f.severity}) in <code>${escapeHtml(f.pkg)}</code> ${escapeHtml(f.installedVersions.join(', '))}.</p>`,
        f.fixable ? `<p>Fixed in <code>${escapeHtml(f.fixedVersions.join(', '))}</code> — upgrade the package or base image.</p>` : '<p>No fixed version is published yet.</p>',
        f.title ? `<p>${escapeHtml(f.title)}</p>` : '',
        `<p>Affected: ${apps.map(escapeHtml).join(', ')}</p>`,
        note.trim() ? `<p>${escapeHtml(note.trim())}</p>` : '',
        `<p><a href="${escapeHtml(securityLink({ tab: 'findings', finding: f.key }))}">Open in the Adhar console</a></p>`,
      ].join('')
      const issue = await planeClient.createIssue(workspace, pid, { name: `Fix ${f.id} in ${f.pkg}`, description_html: html, priority })
      toast.success('Plane issue created', { description: issue.name })
      onClose()
    } catch (e) {
      toast.error('Could not create the Plane issue', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create a Plane issue to fix it"
      description={`Fix ${f.id} in ${f.pkg} · priority ${priority}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} loading={busy} disabled={!pid}>Create issue</Button>
        </div>
      }
    >
      {projects.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Reading Plane projects…</div>
      ) : projects.isError ? (
        <Notice tone="error" title="Plane is not reachable">{projects.error instanceof Error ? projects.error.message : 'The Plane integration did not answer.'}</Notice>
      ) : !projects.data?.length ? (
        <Notice tone="warn" title={`No projects in Plane workspace ${workspace}`}>Create a project in Plane first.</Notice>
      ) : (
        <div className="space-y-3">
          <Field label="Plane project">
            <Select value={pid} onChange={(e) => setProject(e.target.value)}>
              {projects.data.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.identifier})</option>)}
            </Select>
          </Field>
          <Field label="Note (optional)">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}
