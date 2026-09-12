import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
  useHarborProject,
  useToast,
  useToolPublicUrl,
  type Column,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import type { harbor, nexus } from '@adhar-console/api-clients'
import {
  useAddTag,
  useAdmissionImagePolicies,
  useArtifactBuildHistory,
  useArtifactSbom,
  useArtifactVulnerabilities,
  useArtifacts,
  useDeleteArtifact,
  useDeleteTag,
  useHarborHealth,
  useHarborProjects,
  useHarborScanners,
  useHarborStatistics,
  useHarborSystemInfo,
  useNexusComponents,
  useNexusRepositories,
  useNexusStatus,
  useProjectRepositories,
  useRegistryHost,
  useScanArtifact,
  type AdmissionPolicies,
} from '../data/delivery.ts'

/**
 * Artifact registry — Harbor (container images) and Nexus (language packages)
 * in one page, each rendered in its own model rather than forced into a shared
 * one: Harbor has projects → repositories → artifacts → tags/digests, Nexus has
 * repositories → components → assets. Collapsing them would misrepresent both.
 *
 * The supply-chain material is deliberately *diagnostic*. Harbor only produces
 * scan results, SBOMs and fixable-CVE counts when a scanner adapter is
 * registered, and only reports signatures when cosign has actually signed a
 * digest. Where those inputs are missing the page says so, naming the missing
 * input — it never renders an empty severity chart, because "nothing scanned"
 * and "nothing found" are opposite facts and only one of them is safe.
 *
 * Every claim on the page is attributed to where it came from: a Harbor API
 * field, an OCI image label, `docker history`, a tag convention, or a
 * Kubernetes admission-policy CRD.
 */
export function Registry() {
  const [kind, setKind] = useState<'harbor' | 'nexus'>('harbor')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-edge-default bg-surface-raised p-0.5">
          <SegButton on={kind === 'harbor'} onClick={() => setKind('harbor')}>
            Harbor <span className="font-normal text-content-subtle">· container images</span>
          </SegButton>
          <SegButton on={kind === 'nexus'} onClick={() => setKind('nexus')}>
            Nexus <span className="font-normal text-content-subtle">· packages</span>
          </SegButton>
        </div>
      </div>
      {kind === 'harbor' ? <HarborRegistry /> : <NexusRegistry />}
    </div>
  )
}

function SegButton({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors',
        on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300' : 'text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ══════════════════════ Harbor ══════════════════════ */

function HarborRegistry() {
  const defaultProject = useHarborProject()
  const projects = useHarborProjects()
  const [project, setProject] = useState<string>('')
  const repos = useProjectRepositories(project || defaultProject)
  const host = useRegistryHost()
  const stats = useHarborStatistics()
  const health = useHarborHealth()
  const info = useHarborSystemInfo()
  const scanners = useHarborScanners()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'updated' | 'pulls' | 'artifacts' | 'name'>('updated')
  const [selected, setSelected] = useState<string | null>(null)

  // Default to the platform project when it exists, else the first project.
  useEffect(() => {
    if (project || !projects.data?.length) return
    const preferred = projects.data.find((p) => p.name === defaultProject) ?? projects.data[0]
    setProject(preferred.name)
  }, [project, projects.data, defaultProject])

  const all = useMemo(() => repos.data ?? [], [repos.data])
  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    const out = f ? all.filter((r) => r.name.toLowerCase().includes(f)) : [...all]
    out.sort((a, b) => {
      if (sort === 'pulls') return b.pull_count - a.pull_count
      if (sort === 'artifacts') return b.artifact_count - a.artifact_count
      if (sort === 'name') return a.name.localeCompare(b.name)
      return b.update_time.localeCompare(a.update_time)
    })
    return out
  }, [all, search, sort])

  useEffect(() => {
    if (!selected && list.length) setSelected(list[0].name)
    if (selected && all.length && !all.some((r) => r.name === selected)) setSelected(list[0]?.name ?? null)
  }, [selected, list, all])

  const current = projects.data?.find((p) => p.name === (project || defaultProject))
  const unhealthy = (health.data?.components ?? []).filter((c) => c.status !== 'healthy')

  if (repos.isLoading && !repos.data) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading registry…
      </div>
    )
  }
  if (repos.isError) {
    return <EmptyState title="Couldn't reach Harbor" description={repos.error instanceof Error ? repos.error.message : 'The registry API did not answer.'} />
  }

  return (
    <div className="space-y-4">
      {/* ── overview strip — every tile names the endpoint it came from ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Projects"
          value={stats.data ? stats.data.totalProjects : (projects.data?.length ?? '—')}
          hint={stats.data ? `${stats.data.publicProjects} public · ${stats.data.privateProjects} private` : 'from /projects'}
        />
        <Stat
          label="Repositories"
          value={stats.data ? stats.data.totalRepos : all.length}
          hint={current ? `${all.length} in ${current.name}` : 'instance-wide'}
        />
        <Stat
          label="Storage"
          value={stats.data ? fmtBytes(stats.data.totalStorage) : current?.storageUsed !== undefined ? fmtBytes(current.storageUsed) : '—'}
          hint={stats.data ? 'whole registry' : current?.storageQuota !== undefined && current.storageQuota > 0 ? `of ${fmtBytes(current.storageQuota)} quota` : undefined}
        />
        <Stat
          label="Harbor"
          value={info.data?.harborVersion ?? (info.isLoading ? '…' : '—')}
          hint={info.data?.authMode ? `auth ${info.data.authMode}${info.data.readOnly ? ' · read-only' : ''}` : 'from /systeminfo'}
          mono
        />
        <Stat
          label="Components"
          value={health.data ? `${health.data.components.length - unhealthy.length}/${health.data.components.length}` : '—'}
          hint={health.data ? (unhealthy.length ? `${unhealthy.map((c) => c.name).join(', ')} unhealthy` : 'all healthy') : 'from /health'}
          tone={unhealthy.length ? 'failed' : undefined}
        />
        <Stat
          label="Scanner"
          value={scanners.isLoading ? '…' : scanners.isError ? 'unknown' : (scanners.data?.length ?? 0) === 0 ? 'none' : scanners.data![0].name}
          hint={
            scanners.isError
              ? 'scanner list unreadable'
              : (scanners.data?.length ?? 0) === 0
                ? 'no scan data can exist'
                : `${scanners.data!.length} registered`
          }
          tone={!scanners.isLoading && (scanners.isError || (scanners.data?.length ?? 0) === 0) ? 'degraded' : undefined}
        />
      </div>

      <ScannerNotice scanners={scanners} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ── repositories pane ── */}
        <Card className="flex min-h-0 flex-col">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-content">Repositories</div>
              <span className="text-[11px] text-content-subtle">{list.length === all.length ? all.length : `${list.length}/${all.length}`}</span>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              {projects.data && projects.data.length > 0 ? (
                <select value={project || defaultProject} onChange={(e) => { setProject(e.target.value); setSelected(null) }} aria-label="Project" className="h-8 min-w-0 flex-1 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content focus:outline-none">
                  {projects.data.map((p) => (
                    <option key={p.id} value={p.name}>{p.name}{p.public ? ' (public)' : ''} · {p.repoCount} repo{p.repoCount === 1 ? '' : 's'}</option>
                  ))}
                </select>
              ) : null}
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort" className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content-muted focus:outline-none">
                <option value="updated">Recently updated</option>
                <option value="pulls">Most pulled</option>
                <option value="artifacts">Most artifacts</option>
                <option value="name">Name</option>
              </select>
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repositories…"
              className="mt-2 block h-8 w-full rounded-lg border border-edge-default bg-surface-app px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </CardHeader>
          <CardBody className="p-0!">
            {list.length === 0 ? (
              <EmptyState compact title={all.length === 0 ? 'No repositories' : 'No matches'} description={all.length === 0 ? 'Push an image to this project to see it here.' : undefined} />
            ) : (
              <ul className="max-h-[calc(100vh-24rem)] divide-y divide-edge-subtle overflow-y-auto">
                {list.map((r) => (
                  <RepoRow key={r.id} repo={r} active={selected === r.name} onPick={() => setSelected(r.name)} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* ── artifacts pane ── */}
        {selected ? <ArtifactsPane repoName={selected} host={host.data ?? ''} scanners={scanners} /> : (
          <Card><CardBody><EmptyState title="Pick a repository" description="Select a repository on the left to see its artifacts." /></CardBody></Card>
        )}
      </div>
    </div>
  )
}

type ScannersQuery = ReturnType<typeof useHarborScanners>

/**
 * The single most important honest statement on this page. Harbor's vulnerability
 * data, SBOM generation and fixable-CVE counts all come from a registered scanner
 * adapter; with none registered, *every* artifact reports no findings — which is
 * not the same as being clean.
 */
function ScannerNotice({ scanners }: { scanners: ScannersQuery }) {
  if (scanners.isLoading) return null
  if (scanners.isError) {
    return (
      <Notice tone="warn" title="Harbor's scanner list could not be read">
        Scan results below may be incomplete. {scanners.error instanceof Error ? scanners.error.message : 'The /scanners endpoint did not answer.'}
      </Notice>
    )
  }
  if ((scanners.data?.length ?? 0) > 0) return null
  return (
    <Notice tone="warn" title="No vulnerability scanner is registered in Harbor">
      <code>GET /api/v2.0/scanners</code> returns an empty list, so Harbor cannot produce scan results, SBOMs or
      fixable-CVE counts for any artifact in this registry. Artifacts below will show <em>no scan data</em> — read that as
      “never scanned”, not “no vulnerabilities”. Register an adapter (Trivy, Clair) under Administration →
      Interrogation Services to get real findings.
    </Notice>
  )
}

function ArtifactsPane({ repoName, host, scanners }: { repoName: string; host: string; scanners: ScannersQuery }) {
  const q = useArtifacts(repoName)
  const scan = useScanArtifact()
  const del = useDeleteArtifact()
  const addTag = useAddTag()
  const delTag = useDeleteTag()
  const toast = useToast()
  const [open, setOpen] = useState<harbor.Artifact | null>(null)
  const [tagFor, setTagFor] = useState<harbor.Artifact | null>(null)
  const [confirm, setConfirm] = useState<harbor.Artifact | null>(null)
  const list = useMemo(() => q.data ?? [], [q.data])
  const repoPath = repoName.split('/').slice(1).join('/') || repoName
  const scanningPossible = (scanners.data?.length ?? 0) > 0

  // Keep the open drawer pointed at fresh data after a tag add/remove or rescan.
  const openArtifact = open ? (list.find((a) => a.digest === open.digest) ?? open) : null

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      toast.success(label)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} failed`)
    }
  }
  const pullCmd = (a: harbor.Artifact) => {
    const ref = a.tags?.[0] ? `:${a.tags[0].name}` : `@${a.digest}`
    return `docker pull ${host ? `${host}/` : ''}${repoName}${ref}`
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied to clipboard.')
    } catch {
      toast.error('Clipboard unavailable — select and copy the text instead.')
    }
  }

  const totals = useMemo(() => {
    const t = { size: 0, signed: 0, accessoriesKnown: 0, scanned: 0, sbom: 0 }
    for (const a of list) {
      t.size += a.size
      if (a.accessories !== undefined) t.accessoriesKnown++
      if (a.accessories?.length) t.signed++
      if (a.scan) t.scanned++
      if (a.hasSbom) t.sbom++
    }
    return t
  }, [list])

  const columns: Column<harbor.Artifact>[] = [
    {
      key: 'tags',
      header: 'Tags',
      pinned: true,
      minWidth: 200,
      value: (a) => (a.tags ?? []).map((t) => t.name).join(' ') || 'untagged',
      cell: (a) => (
        <div>
          <div className="flex flex-wrap gap-1">
            {(a.tags ?? []).length === 0 ? <span className="text-[11px] text-content-subtle">untagged</span> : null}
            {(a.tags ?? []).map((t) => (
              <span
                key={t.name}
                className="group inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                title={t.immutable ? 'immutable tag' : t.push_time ? `pushed ${formatRelative(t.push_time)}` : undefined}
              >
                {t.immutable ? <span aria-label="immutable">🔒</span> : null}
                {t.name}
                {!t.immutable ? (
                  <button
                    type="button"
                    aria-label={`Remove tag ${t.name}`}
                    onClick={(e) => { e.stopPropagation(); act(`Tag ${t.name} removed.`, () => delTag.mutateAsync({ repo: repoName, ref: a.digest, tag: t.name })) }}
                    className="hidden text-brand-500 hover:text-rose-600 group-hover:inline"
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            <button type="button" onClick={(e) => { e.stopPropagation(); setTagFor(a) }} className="rounded-full border border-dashed border-edge-strong px-1.5 py-0.5 text-[10px] text-content-subtle hover:text-content" title="Add a tag">+ tag</button>
          </div>
          {a.labels?.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {a.labels.map((l) => <span key={l.name} className="rounded px-1.5 py-0.5 text-[9.5px] font-medium text-white" style={{ background: l.color || 'var(--color-slate-500)' }}>{l.name}</span>)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'digest',
      header: 'Digest',
      width: 130,
      value: (a) => a.digest,
      cell: (a) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); copy(a.digest) }} className="font-mono text-[11px] text-content-muted hover:text-content" title={`${a.digest} — click to copy`}>
          {shortDigest(a.digest)}
        </button>
      ),
    },
    {
      key: 'platform',
      header: 'Platform',
      width: 120,
      value: (a) => a.platform ?? (a.references?.length ? 'multi-arch' : ''),
      cell: (a) =>
        a.references?.length ? (
          <span className="font-mono text-[11px] text-content-muted" title={a.references.map((r) => r.platform ?? r.childDigest).join(', ')}>
            index · {a.references.length} arch
          </span>
        ) : (
          <span className="font-mono text-[11px] text-content-muted">{a.platform ?? '—'}</span>
        ),
    },
    { key: 'size', header: 'Size', numeric: true, width: 90, value: (a) => a.size, cell: (a) => fmtBytes(a.size) },
    {
      key: 'pushed',
      header: 'Pushed',
      width: 140,
      value: (a) => a.push_time,
      cell: (a) => (
        <div className="text-content-muted">
          <div title={formatAbsolute(a.push_time)}>{formatRelative(a.push_time)}</div>
          {a.pull_time ? <div className="text-[10.5px] text-content-subtle" title={formatAbsolute(a.pull_time)}>pulled {formatRelative(a.pull_time)}</div> : null}
        </div>
      ),
    },
    {
      key: 'signature',
      header: 'Signature',
      width: 120,
      value: (a) => signatureLabel(a),
      cell: (a) => <SignatureCell artifact={a} />,
    },
    {
      key: 'scan',
      header: 'Scan',
      minWidth: 180,
      value: (a) => (a.vulnerabilities ? a.vulnerabilities.critical * 1e6 + a.vulnerabilities.high * 1e3 + a.vulnerabilities.medium : -1),
      cell: (a) =>
        a.vulnerabilities ? (
          <div>
            <VulnBar vulns={a.vulnerabilities} />
            {a.scan ? (
              <div className="mt-1 text-[10px] text-content-subtle">
                {a.scan.total ?? ''}{a.scan.fixable !== undefined ? ` · ${a.scan.fixable} fixable` : ''}{a.scan.scanner ? ` · ${a.scan.scanner}` : ''}{a.scan.endTime ? ` · ${formatRelative(a.scan.endTime)}` : ''}
              </div>
            ) : null}
          </div>
        ) : a.scan?.status && a.scan.status !== 'Success' ? (
          <StatusBadge kind={a.scan.status === 'Running' || a.scan.status === 'Pending' ? 'progressing' : a.scan.status === 'Error' ? 'failed' : 'unknown'}>{a.scan.status}</StatusBadge>
        ) : (
          <span className="text-[11px] text-content-subtle" title={scanningPossible ? 'Harbor has no scan report for this digest.' : 'No scanner is registered, so Harbor cannot scan anything.'}>
            {scanningPossible ? 'not scanned' : 'no scanner'}
          </span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: 210,
      sortable: false,
      filter: false,
      cell: (a) => (
        <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" onClick={() => copy(pullCmd(a))} title={pullCmd(a)}>Pull</Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!scanningPossible}
            title={scanningPossible ? 'Ask Harbor to scan this artifact' : 'No scanner adapter is registered in Harbor'}
            onClick={() => act('Scan requested.', () => scan.mutateAsync({ repo: repoName, ref: a.digest }))}
            loading={scan.isPending && scan.variables?.ref === a.digest}
          >
            Scan
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(a)} title="Delete this artifact">Delete</Button>
        </div>
      ),
    },
  ]

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-content">Artifacts</div>
            <div className="truncate font-mono text-[11px] text-content-subtle" title={repoName}>{repoName}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
            <span>{list.length} artifact{list.length === 1 ? '' : 's'}</span>
            <span>· {fmtBytes(totals.size)}</span>
            {totals.accessoriesKnown === list.length && list.length > 0 ? (
              <span title="Artifacts with a cosign signature or attestation attached, as reported by Harbor.">· {totals.signed}/{list.length} signed</span>
            ) : null}
            <span title={scanningPossible ? 'Artifacts with a Harbor scan report.' : 'No scanner is registered, so no artifact can have a report.'}>
              · {scanningPossible ? `${totals.scanned}/${list.length} scanned` : 'scanning unavailable'}
            </span>
            {q.isFetching ? <Spinner size={12} /> : null}
          </div>
        </div>
      </CardHeader>
      <CardBody className="p-0!">
        <DataTable
          tableId="deliver-harbor-artifacts"
          columns={columns}
          rows={list}
          rowKey={(a) => a.digest}
          onRowClick={(a) => setOpen(a)}
          loading={q.isLoading}
          stickyHeader
          features={{ search: true, filters: true, columns: true, density: true, export: true }}
          searchPlaceholder="Search tags, digests, platforms…"
          empty={<EmptyState compact title="No artifacts" description="No images pushed for this repository yet." />}
        />
      </CardBody>

      {openArtifact ? (
        <ArtifactDrawer
          repo={repoName}
          artifact={openArtifact}
          host={host}
          scanners={scanners}
          onClose={() => setOpen(null)}
          onCopy={copy}
        />
      ) : null}

      {tagFor ? (
        <TagModal
          artifact={tagFor}
          onClose={() => setTagFor(null)}
          onAdd={(tag) => act(`Tag ${tag} added.`, () => addTag.mutateAsync({ repo: repoName, ref: tagFor.digest, tag }))}
          loading={addTag.isPending}
        />
      ) : null}

      {confirm ? (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title="Delete artifact?"
          description={`${repoPath}${confirm.tags?.[0] ? `:${confirm.tags[0].name}` : ''} (${confirm.digest.slice(0, 19)}) and all ${confirm.tags?.length ?? 0} of its tags will be removed from the registry. Running workloads keep their pulled layers; new pulls fail.`}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button size="sm" variant="danger" onClick={() => { const a = confirm; setConfirm(null); act('Artifact deleted.', () => del.mutateAsync({ repo: repoName, ref: a.digest })) }} loading={del.isPending}>Delete</Button>
            </>
          }
        >
          <p className="text-[12px] text-content-muted">This cannot be undone.</p>
        </Modal>
      ) : null}
    </Card>
  )
}

/* ─────────── artifact detail drawer ─────────── */

type DrawerTab = 'overview' | 'versions' | 'supply' | 'vulns' | 'sbom' | 'history'

function ArtifactDrawer({
  repo,
  artifact: a,
  host,
  scanners,
  onClose,
  onCopy,
}: {
  repo: string
  artifact: harbor.Artifact
  host: string
  scanners: ScannersQuery
  onClose(): void
  onCopy(text: string): void
}) {
  const [tab, setTab] = useState<DrawerTab>('overview')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  const scanningPossible = (scanners.data?.length ?? 0) > 0
  const hasHistory = a.additions?.includes('build_history') ?? false
  const tabs: Array<{ id: DrawerTab; label: string; hint?: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'versions', label: `Versions${a.tags?.length ? ` (${a.tags.length})` : ''}` },
    { id: 'supply', label: 'Supply chain' },
    { id: 'vulns', label: 'Vulnerabilities' },
    { id: 'sbom', label: 'SBOM' },
    { id: 'history', label: 'Build history' },
  ]

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Artifact detail">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px] dark:bg-black/60" />
      <aside className="relative flex h-full w-full max-w-4xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Artifact</div>
              <h2 className="mt-1 truncate font-mono text-base font-semibold text-content">
                {repo}{a.tags?.[0] ? `:${a.tags[0].name}` : ''}
              </h2>
              <button type="button" onClick={() => onCopy(a.digest)} className="mt-1 block max-w-full truncate font-mono text-[11px] text-content-subtle hover:text-content" title="Click to copy the digest">
                {a.digest}
              </button>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">✕</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tabs.map((t) => (
              <Chip key={t.id} on={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>
            ))}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'overview' ? <OverviewTab artifact={a} repo={repo} host={host} onCopy={onCopy} /> : null}
          {tab === 'versions' ? <VersionsTab artifact={a} repo={repo} host={host} onCopy={onCopy} /> : null}
          {tab === 'supply' ? <SupplyChainTab artifact={a} repo={repo} host={host} scanners={scanners} /> : null}
          {tab === 'vulns' ? <VulnPanel repo={repo} artifact={a} scanningPossible={scanningPossible} /> : null}
          {tab === 'sbom' ? <SbomTab repo={repo} artifact={a} scanningPossible={scanningPossible} /> : null}
          {tab === 'history' ? <HistoryTab repo={repo} artifact={a} available={hasHistory} /> : null}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function OverviewTab({ artifact: a, repo, host, onCopy }: { artifact: harbor.Artifact; repo: string; host: string; onCopy(t: string): void }) {
  const ref = a.tags?.[0] ? `:${a.tags[0].name}` : `@${a.digest}`
  const pull = `docker pull ${host ? `${host}/` : ''}${repo}${ref}`
  return (
    <div className="space-y-4">
      <Section title="Identity" source="Harbor GET /artifacts (with_tag, with_label, with_accessory)">
        <Facts
          rows={[
            ['Digest', <span key="d" className="font-mono">{a.digest}</span>],
            ['Media type', a.manifestMediaType ?? a.media_type ?? '—'],
            ['Artifact type', a.artifactType ?? a.type ?? '—'],
            ['Platform', a.references?.length ? `index · ${a.references.length} referenced manifests` : (a.platform ?? '—')],
            ['Size', fmtBytes(a.size)],
            ['Pushed', `${formatRelative(a.push_time)} (${formatAbsolute(a.push_time)})`],
            ['Last pulled', a.pull_time ? `${formatRelative(a.pull_time)} (${formatAbsolute(a.pull_time)})` : 'never recorded'],
            ['Image created', a.createdAt ? `${formatRelative(a.createdAt)} (${formatAbsolute(a.createdAt)})` : '—'],
            ['Author', a.author ?? '—'],
          ]}
        />
      </Section>

      <Section title="Pull" source="composed from Harbor's registry_url + repository + tag">
        <button type="button" onClick={() => onCopy(pull)} className="block w-full rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-left font-mono text-[11px] text-content hover:border-edge-strong">
          {pull}
        </button>
      </Section>

      {a.entrypoint?.length || a.workingDir || a.user || a.env?.length ? (
        <Section title="Runtime configuration" source="Harbor extra_attrs.config (the image config blob)">
          <Facts
            rows={[
              ['Entrypoint', a.entrypoint?.length ? <code key="e" className="font-mono text-[11px]">{a.entrypoint.join(' ')}</code> : '—'],
              ['Working dir', a.workingDir ?? '—'],
              ['User', a.user ?? 'not set (runs as root unless the pod overrides it)'],
              ['Env', a.env?.length ? `${a.env.length} variables` : '—'],
            ]}
          />
        </Section>
      ) : null}
    </div>
  )
}

function VersionsTab({ artifact: a, repo, host, onCopy }: { artifact: harbor.Artifact; repo: string; host: string; onCopy(t: string): void }) {
  const tags = a.tags ?? []
  const prefix = host ? `${host}/` : ''
  return (
    <div className="space-y-4">
      <Section title="Tags on this digest" source="Harbor GET /artifacts?with_tag=true&with_immutable_status=true">
        {tags.length === 0 ? (
          <p className="text-[12px] text-content-muted">This artifact carries no tags — it is reachable only by digest.</p>
        ) : (
          <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
            {tags.map((t) => (
              <li key={t.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[12px] font-semibold text-content">{t.name}</span>
                    {t.immutable ? <StatusBadge kind="info">immutable</StatusBadge> : null}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-content-subtle">
                    {t.push_time ? `pushed ${formatRelative(t.push_time)}` : 'push time not reported'}
                  </div>
                </div>
                <button type="button" onClick={() => onCopy(`${prefix}${repo}:${t.name}`)} className="font-mono text-[11px] text-brand-700 hover:underline dark:text-brand-300">
                  copy ref
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-content-subtle">
          Every tag above resolves to the same digest, so they are the same bytes — a moving tag such as <code>latest</code> tells you nothing about which build it was.
        </p>
      </Section>

      <Section title="Referenced manifests" source="Harbor references[] — the children of a multi-arch index">
        {a.references === undefined ? (
          <p className="text-[12px] text-content-muted">Harbor did not report a reference list for this artifact.</p>
        ) : a.references.length === 0 ? (
          <p className="text-[12px] text-content-muted">Not an index — this is a single-platform manifest.</p>
        ) : (
          <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
            {a.references.map((r) => (
              <li key={r.childDigest} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="font-mono text-[12px] text-content">{r.platform ?? 'unknown platform'}</span>
                <span className="font-mono text-[11px] text-content-subtle">{shortDigest(r.childDigest)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

/* ─────────── provenance ─────────── */

interface Provenance {
  /** Where the claim came from — always shown next to it. */
  origin: 'oci-labels' | 'build-history' | 'tag' | 'none'
  /** True when the value is inferred rather than recorded by the build. */
  inferred: boolean
  sourceUrl?: string
  revision?: string
  version?: string
  created?: string
  note: string
}

const SHA_IN_TAG = /(?:^|[-_.])([0-9a-f]{7,40})(?:$|[-_.])/

function deriveProvenance(a: harbor.Artifact, history: harbor.BuildHistoryEntry[] | undefined): Provenance {
  const l = a.configLabels
  if (l) {
    const sourceUrl = l['org.opencontainers.image.source'] ?? l['org.label-schema.vcs-url']
    const revision = l['org.opencontainers.image.revision'] ?? l['org.label-schema.vcs-ref']
    const version = l['org.opencontainers.image.version'] ?? l['org.label-schema.version']
    const created = l['org.opencontainers.image.created'] ?? l['org.label-schema.build-date']
    if (sourceUrl || revision || version || created) {
      return {
        origin: 'oci-labels',
        inferred: false,
        sourceUrl,
        revision,
        version,
        created,
        note: 'Recorded by the build in the image config as OCI annotation labels. This is the authoritative in-image provenance.',
      }
    }
  }
  // `docker history` occasionally carries the LABEL instruction even when the
  // final config has none (multi-stage builds that drop it). Read it, but say so.
  const label = history?.find((h) => /LABEL .*(opencontainers\.image\.(source|revision)|vcs-(url|ref))/i.test(h.createdBy ?? ''))
  if (label?.createdBy) {
    const url = /org\.opencontainers\.image\.source=("[^"]+"|\S+)/.exec(label.createdBy)?.[1]?.replace(/"/g, '')
    const rev = /org\.opencontainers\.image\.revision=("[^"]+"|\S+)/.exec(label.createdBy)?.[1]?.replace(/"/g, '')
    return {
      origin: 'build-history',
      inferred: true,
      sourceUrl: url,
      revision: rev,
      note: 'Read out of a LABEL instruction in the image build history. The final image config does not carry these labels, so nothing verifies them at pull time.',
    }
  }
  const tag = (a.tags ?? []).map((t) => t.name).find((n) => SHA_IN_TAG.test(n))
  if (tag) {
    return {
      origin: 'tag',
      inferred: true,
      revision: SHA_IN_TAG.exec(tag)?.[1],
      note: `Guessed from the tag ${tag}, which contains something shaped like a git short SHA. Nothing in the image confirms this — it is a naming convention, not evidence.`,
    }
  }
  return {
    origin: 'none',
    inferred: false,
    note: 'This image records no source. Its config carries no org.opencontainers.image.* labels, the build history has no LABEL instruction, and no tag encodes a commit. There is no way to tell from the registry which commit produced these bytes.',
  }
}

const ORIGIN_LABEL: Record<Provenance['origin'], string> = {
  'oci-labels': 'image config labels',
  'build-history': 'build history (LABEL instruction)',
  tag: 'tag naming convention — unverified',
  none: 'no source recorded',
}

/* ─────────── supply chain tab ─────────── */

function SupplyChainTab({ artifact: a, repo, host, scanners }: { artifact: harbor.Artifact; repo: string; host: string; scanners: ScannersQuery }) {
  const hasHistory = a.additions?.includes('build_history') ?? false
  const history = useArtifactBuildHistory(repo, a.digest, hasHistory && !a.configLabels)
  const policies = useAdmissionImagePolicies()
  const prov = deriveProvenance(a, history.data)
  const signatures = a.accessories?.filter((x) => /signature/i.test(x.type)) ?? []
  const attestations = a.accessories?.filter((x) => !/signature/i.test(x.type)) ?? []
  const imageRef = `${host ? `${host}/` : ''}${repo}`

  return (
    <div className="space-y-4">
      {/* ── 1. source / provenance ── */}
      <Section title="Source" source={`derived from ${ORIGIN_LABEL[prov.origin]}`}>
        {prov.origin === 'none' ? (
          <Notice tone="info" title="No provenance recorded in this image">{prov.note}</Notice>
        ) : (
          <>
            <Facts
              rows={[
                [
                  'Repository',
                  prov.sourceUrl
                    ? <a key="s" href={prov.sourceUrl} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-brand-700 hover:underline dark:text-brand-300">{prov.sourceUrl}</a>
                    : 'not recorded',
                ],
                ['Revision', prov.revision ? <span key="r" className="font-mono text-[11px]">{prov.revision}</span> : 'not recorded'],
                ['Version', prov.version ?? 'not recorded'],
                ['Built', prov.created ? `${formatRelative(prov.created)} (${formatAbsolute(prov.created)})` : a.createdAt ? `${formatRelative(a.createdAt)} (image config created)` : 'not recorded'],
              ]}
            />
            <p className={cn('mt-2 text-[11px]', prov.inferred ? 'text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>
              {prov.inferred ? '⚠ ' : ''}{prov.note}
            </p>
          </>
        )}
        {a.configLabels ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[11px] font-semibold text-content-muted hover:text-content">All image labels ({Object.keys(a.configLabels).length})</summary>
            <dl className="mt-2 space-y-1">
              {Object.entries(a.configLabels).map(([k, v]) => (
                <div key={k} className="flex flex-wrap gap-2 text-[11px]">
                  <dt className="font-mono text-content-subtle">{k}</dt>
                  <dd className="min-w-0 break-all font-mono text-content">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </Section>

      {/* ── 2. signing & attestation ── */}
      <Section title="Signing and attestation" source="Harbor accessories[] (with_accessory=true)">
        {a.accessories === undefined ? (
          <Notice tone="info" title="Not reported">
            Harbor did not return an accessory list for this artifact, so whether it is signed is unknown from here.
          </Notice>
        ) : a.accessories.length === 0 ? (
          <Notice tone="warn" title="Unsigned">
            Harbor lists no cosign signature and no attestation attached to <span className="font-mono">{shortDigest(a.digest)}</span>.
            Nothing cryptographically ties these bytes to a builder, so an admission policy that requires a signature would reject this image.
          </Notice>
        ) : (
          <div className="space-y-2">
            <Facts
              rows={[
                ['Signatures', signatures.length ? `${signatures.length} attached` : 'none'],
                ['Attestations', attestations.length ? `${attestations.length} attached` : 'none'],
              ]}
            />
            <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
              {a.accessories.map((x) => (
                <li key={x.digest} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-content">{x.type}</div>
                    <div className="truncate font-mono text-[10.5px] text-content-subtle">{x.digest}</div>
                  </div>
                  <div className="text-right text-[10.5px] text-content-subtle">
                    {x.size !== undefined ? <div>{fmtBytes(x.size)}</div> : null}
                    {x.createdAt ? <div title={formatAbsolute(x.createdAt)}>{formatRelative(x.createdAt)}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-content-subtle">
              Harbor reports that these accessories exist. It does not verify them — trust-root and identity checks happen at admission time, below.
            </p>
          </div>
        )}
      </Section>

      {/* ── 3. scanning ── */}
      <Section title="Vulnerability scanning" source="Harbor GET /scanners + the artifact's scan_overview">
        {scanners.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Reading Harbor's scanner list…</div>
        ) : scanners.isError ? (
          <Notice tone="warn" title="Scanner list unreadable">
            {scanners.error instanceof Error ? scanners.error.message : 'Harbor did not answer /scanners.'} Whether this artifact can be scanned is unknown.
          </Notice>
        ) : (scanners.data?.length ?? 0) === 0 ? (
          <Notice tone="warn" title="No scanner registered — no scan data can exist">
            Harbor has no scanner adapter, so this artifact has never been scanned and cannot be. No severity counts are shown here
            because there are none to show: that is the absence of a measurement, not a clean result.
          </Notice>
        ) : a.vulnerabilities ? (
          <div className="space-y-2">
            <VulnBar vulns={a.vulnerabilities} />
            <Facts
              rows={[
                ['Scanner', a.scan?.scanner ?? scanners.data![0].name],
                ['Status', a.scan?.status ?? 'unknown'],
                ['Findings', a.scan?.total !== undefined ? `${a.scan.total} total${a.scan.fixable !== undefined ? ` · ${a.scan.fixable} fixable` : ''}` : '—'],
                ['Scanned', a.scan?.endTime ? `${formatRelative(a.scan.endTime)} (${formatAbsolute(a.scan.endTime)})` : 'not recorded'],
              ]}
            />
          </div>
        ) : (
          <Notice tone="info" title="Never scanned">
            A scanner is registered ({scanners.data!.map((s) => s.name).join(', ')}), but Harbor holds no report for this digest. Use “Scan” on the artifact row to request one.
          </Notice>
        )}
      </Section>

      {/* ── 4. cluster-side enforcement ── */}
      <Section title="Admission enforcement in this cluster" source="Kubernetes CRDs: policy.sigstore.dev + policies.kyverno.io">
        <p className="mb-2 text-[11px] text-content-subtle">
          These are the policies that would gate <span className="font-mono">{imageRef}</span> when a pod tries to pull it. They live in the
          cluster, not in Harbor, so they apply regardless of what the registry reports.
        </p>
        {policies.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Reading admission policies…</div>
        ) : policies.isError ? (
          <Notice tone="warn" title="Could not read admission policies">
            {policies.error instanceof Error ? policies.error.message : 'The Kubernetes API did not answer.'}
          </Notice>
        ) : (
          <div className="space-y-2">
            <PolicyGroup
              title="Sigstore ClusterImagePolicy"
              gvr="clusterimagepolicies.policy.sigstore.dev"
              group={policies.data?.sigstore}
              describe={describeSigstore}
            />
            <PolicyGroup
              title="Kyverno ImageValidatingPolicy"
              gvr="imagevalidatingpolicies.policies.kyverno.io"
              group={policies.data?.kyverno}
              describe={describeKyverno}
            />
          </div>
        )}
      </Section>
    </div>
  )
}

type PolicyGroupData = AdmissionPolicies['sigstore']

function PolicyGroup({
  title,
  gvr,
  group,
  describe,
}: {
  title: string
  gvr: string
  group: PolicyGroupData | undefined
  describe(o: Record<string, unknown> | undefined): string
}) {
  if (!group || group.availability === 'not-installed') {
    return (
      <div className="rounded-lg border border-dashed border-edge-default px-3 py-2">
        <div className="text-[12px] font-semibold text-content">{title}</div>
        <div className="mt-0.5 text-[11px] text-content-subtle">
          Not installed — the cluster has no <span className="font-mono">{gvr}</span> resource, so this controller is not enforcing anything.
        </div>
      </div>
    )
  }
  if (group.availability === 'error') {
    return (
      <div className="rounded-lg border border-amber-300 px-3 py-2 dark:border-amber-500/40">
        <div className="text-[12px] font-semibold text-content">{title}</div>
        <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">
          The CRD exists but could not be listed, so enforcement here is unknown.
        </div>
      </div>
    )
  }
  if (group.items.length === 0) {
    return (
      <div className="rounded-lg border border-edge-default px-3 py-2">
        <div className="text-[12px] font-semibold text-content">{title}</div>
        <div className="mt-0.5 text-[11px] text-content-subtle">Installed, but no policies are defined — nothing is gated by this controller.</div>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-edge-default">
      <div className="border-b border-edge-subtle px-3 py-2 text-[12px] font-semibold text-content">{title} · {group.items.length}</div>
      <ul className="divide-y divide-edge-subtle">
        {group.items.map((o) => {
          const summary = describe(o.spec)
          return (
            <li key={o.metadata.name} className="px-3 py-2">
              <div className="font-mono text-[12px] text-content">{o.metadata.name}</div>
              <div className="mt-0.5 text-[11px] text-content-muted">
                {summary || 'Defined, but its spec uses fields this page does not recognise — open it in the cluster to read the rules.'}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Summarise a policy spec from the fields we actually recognise. Returning an
 * empty string when nothing matches is deliberate: a CRD version with a
 * different schema must read as "not understood", never as "matches nothing",
 * which would tell the reader the opposite of the truth.
 */
function describeSigstore(spec: Record<string, unknown> | undefined): string {
  const parts: string[] = []
  const images = (spec?.images as Array<{ glob?: string }> | undefined)?.map((i) => i.glob).filter(Boolean)
  if (images?.length) parts.push(`matches ${images.join(', ')}`)
  const authorities = (spec?.authorities as unknown[] | undefined)?.length
  if (authorities !== undefined) parts.push(`${authorities} authorit${authorities === 1 ? 'y' : 'ies'}`)
  if (typeof spec?.mode === 'string') parts.push(`mode ${spec.mode}`)
  return parts.join(' · ')
}

function describeKyverno(spec: Record<string, unknown> | undefined): string {
  const parts: string[] = []
  const rules = (spec?.imageRules as Array<{ glob?: string }> | undefined)?.map((r) => r.glob).filter(Boolean)
  if (rules?.length) parts.push(`matches ${rules.join(', ')}`)
  const attestors = (spec?.attestors as unknown[] | undefined)?.length
  if (attestors !== undefined) parts.push(`${attestors} attestor${attestors === 1 ? '' : 's'}`)
  const action = (spec?.validationActions as string[] | undefined)?.join(', ')
  if (action) parts.push(action)
  return parts.join(' · ')
}

/* ─────────── SBOM + history tabs ─────────── */

function SbomTab({ repo, artifact: a, scanningPossible }: { repo: string; artifact: harbor.Artifact; scanningPossible: boolean }) {
  const q = useArtifactSbom(repo, a.digest, scanningPossible && (a.hasSbom ?? true))
  if (!scanningPossible) {
    return (
      <Notice tone="warn" title="SBOMs require a scanner">
        Harbor generates SBOMs through its scanner adapter. With none registered there is no SBOM for this artifact and none can be produced.
      </Notice>
    )
  }
  if (a.hasSbom === false) {
    return <Notice tone="info" title="No SBOM">Harbor reports no SBOM overview for this digest. Generate one from Harbor, or attach one as an accessory at build time.</Notice>
  }
  if (q.isLoading) return <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading SBOM…</div>
  if (q.isError) {
    return <Notice tone="warn" title="SBOM unavailable">{q.error instanceof Error ? q.error.message : 'Harbor did not return an SBOM.'}</Notice>
  }
  if (q.data === null || q.data === undefined) {
    return <Notice tone="info" title="No SBOM">Harbor holds no SBOM document for this artifact.</Notice>
  }
  return (
    <Section title="SBOM document" source="Harbor GET /artifacts/{ref}/additions/sbom">
      <pre className="max-h-[60vh] overflow-auto rounded-lg border border-edge-default bg-surface-sunken p-3 font-mono text-[11px] text-content">
        {JSON.stringify(q.data, null, 2)}
      </pre>
    </Section>
  )
}

function HistoryTab({ repo, artifact: a, available }: { repo: string; artifact: harbor.Artifact; available: boolean }) {
  const q = useArtifactBuildHistory(repo, a.digest, available)
  if (!available) {
    return <Notice tone="info" title="No build history">Harbor offers no <span className="font-mono">build_history</span> addition for this artifact — that addition exists only for image manifests.</Notice>
  }
  if (q.isLoading) return <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading build history…</div>
  if (q.isError) {
    return <Notice tone="warn" title="Build history unavailable">{q.error instanceof Error ? q.error.message : 'Harbor did not return the build history.'}</Notice>
  }
  const rows = q.data ?? []
  if (rows.length === 0) return <Notice tone="info" title="Empty build history">Harbor returned no layers for this artifact.</Notice>
  return (
    <Section title="Build history" source="Harbor GET /artifacts/{ref}/additions/build_history — the image's own docker history">
      <ol className="space-y-1">
        {rows.map((h, i) => (
          <li key={`${i}-${h.created ?? ''}`} className={cn('rounded-lg border px-3 py-2', h.emptyLayer ? 'border-dashed border-edge-default' : 'border-edge-default')}>
            <div className="flex items-center justify-between gap-2 text-[10.5px] text-content-subtle">
              <span>#{i + 1}{h.emptyLayer ? ' · metadata only' : ''}</span>
              {h.created ? <span title={formatAbsolute(h.created)}>{formatRelative(h.created)}</span> : null}
            </div>
            <code className="mt-0.5 block break-all font-mono text-[11px] text-content">{h.createdBy ?? h.comment ?? '—'}</code>
          </li>
        ))}
      </ol>
    </Section>
  )
}

/* ─────────── vulnerabilities ─────────── */

const SEV_KIND: Record<string, StatusKind> = { Critical: 'failed', High: 'degraded', Medium: 'info', Low: 'unknown', Negligible: 'unknown', Unknown: 'unknown' }

/**
 * The full CVE report. Enabled only when a scanner exists — otherwise the empty
 * report would read as "clean", which is precisely the lie this page must not
 * tell.
 */
function VulnPanel({ repo, artifact: a, scanningPossible }: { repo: string; artifact: harbor.Artifact; scanningPossible: boolean }) {
  const q = useArtifactVulnerabilities(scanningPossible ? repo : undefined, scanningPossible ? a.digest : undefined)
  const [sev, setSev] = useState<'all' | harbor.Vulnerability['severity']>('all')
  const [fixableOnly, setFixableOnly] = useState(false)
  const [text, setText] = useState('')

  if (!scanningPossible) {
    return (
      <Notice tone="warn" title="No vulnerability data — and none is possible">
        Harbor has no scanner adapter registered, so it has never examined this image. This is not a report of zero
        vulnerabilities; it is the absence of a report. Register a scanner in Harbor, or read the cluster-side findings
        under Deliver → Vulnerability Scans, before treating this image as safe.
      </Notice>
    )
  }

  const all = q.data ?? []
  const f = text.trim().toLowerCase()
  const list = all.filter((v) => (sev === 'all' || v.severity === sev) && (!fixableOnly || !!v.fixVersion) && (!f || v.id.toLowerCase().includes(f) || v.package.toLowerCase().includes(f)))
  const counts = all.reduce<Record<string, number>>((m, v) => ((m[v.severity] = (m[v.severity] ?? 0) + 1), m), {})

  const columns: Column<harbor.Vulnerability>[] = [
    { key: 'severity', header: 'Severity', width: 110, value: (v) => v.severity, cell: (v) => <StatusBadge kind={SEV_KIND[v.severity]}>{v.severity}</StatusBadge> },
    {
      key: 'id',
      header: 'Vulnerability',
      pinned: true,
      minWidth: 200,
      value: (v) => v.id,
      cell: (v) => (
        <div>
          {v.links[0] ? <a href={v.links[0]} target="_blank" rel="noreferrer" className="font-mono text-brand-700 hover:underline dark:text-brand-300">{v.id}</a> : <span className="font-mono text-content">{v.id}</span>}
          {v.description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-content-muted" title={v.description}>{v.description}</p> : null}
        </div>
      ),
    },
    { key: 'package', header: 'Package', width: 160, value: (v) => v.package, cell: (v) => <span className="font-mono text-[11px] text-content">{v.package}</span> },
    {
      key: 'fix',
      header: 'Installed → fixed',
      minWidth: 160,
      value: (v) => v.fixVersion ?? '',
      cell: (v) => (
        <span className="font-mono text-[11px]">
          <span className="text-content-muted">{v.version}</span>
          {v.fixVersion ? <> → <span className="text-emerald-700 dark:text-emerald-300">{v.fixVersion}</span></> : <span className="ml-1 text-content-subtle">no fix</span>}
        </span>
      ),
    },
    { key: 'cvss', header: 'CVSS', numeric: true, width: 80, value: (v) => v.cvssScore ?? -1, cell: (v) => v.cvssScore?.toFixed(1) ?? '—' },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip on={sev === 'all'} onClick={() => setSev('all')}>{all.length} findings</Chip>
        {(['Critical', 'High', 'Medium', 'Low'] as const).map((s) => (
          <Chip key={s} on={sev === s} onClick={() => setSev(sev === s ? 'all' : s)} tone={s === 'Critical' ? 'failed' : s === 'High' ? 'degraded' : undefined}>{counts[s] ?? 0} {s.toLowerCase()}</Chip>
        ))}
        <Chip on={fixableOnly} onClick={() => setFixableOnly((v) => !v)}>fixable only</Chip>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="CVE or package…" className="ml-auto h-7 w-44 rounded-lg border border-edge-default bg-surface-app px-2 text-[11px] text-content placeholder:text-content-subtle focus:outline-none" />
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading report…</div>
      ) : q.isError ? (
        <Notice tone="info" title="No report for this artifact">
          {q.error instanceof Error ? q.error.message : 'Harbor did not return a vulnerability report for this digest.'} A scanner is registered, so requesting a scan should produce one.
        </Notice>
      ) : (
        <DataTable
          tableId="deliver-harbor-vulns"
          columns={columns}
          rows={list}
          rowKey={(v) => `${v.id}-${v.package}-${v.version}`}
          stickyHeader
          dense
          features={{ columns: true, export: true }}
          empty={<EmptyState compact title={all.length === 0 ? 'Report is empty' : 'No matches'} description={all.length === 0 ? 'The scanner ran and recorded no findings for this artifact.' : undefined} />}
        />
      )}
    </div>
  )
}

/* ══════════════════════ Nexus ══════════════════════ */

/**
 * Nexus pane. On this platform Nexus holds language packages, not container
 * images, so it is presented as repositories → components → assets. Nexus OSS
 * has no scanner, no signature store and no SBOM API: the checksums below are
 * integrity (did the bytes change), never a security verdict, and the page says
 * so rather than leaving a reader to assume otherwise.
 */
function NexusRegistry() {
  const repos = useNexusRepositories()
  const status = useNexusStatus()
  const nexusUrl = useToolPublicUrl('nexus')
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [formatF, setFormatF] = useState<string>('all')
  const [detail, setDetail] = useState<nexus.NexusComponent | null>(null)

  const all = useMemo(() => repos.data ?? [], [repos.data])
  const formats = useMemo(() => Array.from(new Set(all.map((r) => r.format))).sort(), [all])
  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    return all
      .filter((r) => (formatF === 'all' || r.format === formatF) && (!f || r.name.toLowerCase().includes(f)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [all, search, formatF])

  useEffect(() => {
    if (!selected && list.length) setSelected(list[0].name)
  }, [selected, list])

  const unhealthy = (status.data ?? []).filter((c) => !c.healthy)
  const dockerRepos = all.filter((r) => r.format === 'docker')

  if (repos.isLoading && !repos.data) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading Nexus…
      </div>
    )
  }
  if (repos.isError) {
    return <EmptyState title="Couldn't reach Nexus" description={repos.error instanceof Error ? repos.error.message : 'The Nexus REST API did not answer.'} />
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Repositories" value={all.length} hint="from /service/rest/v1/repositories" />
        <Stat label="Formats" value={formats.length || '—'} hint={formats.join(', ') || undefined} />
        <Stat label="Hosted" value={all.filter((r) => r.type === 'hosted').length} hint="your own artifacts" />
        <Stat label="Proxied" value={all.filter((r) => r.type === 'proxy').length} hint="mirrored from upstream" />
        <Stat
          label="Health checks"
          value={status.data ? `${status.data.length - unhealthy.length}/${status.data.length}` : status.isError ? 'unknown' : '—'}
          hint={status.isError ? 'status/check unreadable' : unhealthy.length ? unhealthy.map((c) => c.name).join(', ') : 'from /status/check'}
          tone={status.isError || unhealthy.length ? (unhealthy.length ? 'failed' : 'degraded') : undefined}
        />
        <Stat label="Container repos" value={dockerRepos.length} hint={dockerRepos.length ? 'docker format' : 'none — images live in Harbor'} />
      </div>

      <Notice tone="info" title="Nexus OSS records inventory and integrity, not security">
        Nexus has no vulnerability scanner, no signature store and no SBOM endpoint — those are Sonatype Lifecycle features.
        The checksums shown per asset tell you the bytes have not changed since upload; they say nothing about whether the
        package is safe. Scan results for what actually runs are under Deliver → Vulnerability Scans.
        {dockerRepos.length === 0 ? ' This instance also has no docker-format repository, so container images are not served from here.' : ''}
      </Notice>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-content">Repositories</div>
              <span className="text-[11px] text-content-subtle">{list.length === all.length ? all.length : `${list.length}/${all.length}`}</span>
            </div>
            <select value={formatF} onChange={(e) => { setFormatF(e.target.value); setSelected(null) }} aria-label="Format" className="mt-2 h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-[11px] text-content focus:outline-none">
              <option value="all">All formats</option>
              {formats.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repositories…"
              className="mt-2 block h-8 w-full rounded-lg border border-edge-default bg-surface-app px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </CardHeader>
          <CardBody className="p-0!">
            {list.length === 0 ? (
              <EmptyState compact title={all.length === 0 ? 'No repositories' : 'No matches'} />
            ) : (
              <ul className="max-h-[calc(100vh-26rem)] divide-y divide-edge-subtle overflow-y-auto">
                {list.map((r) => (
                  <li key={r.name}>
                    <button type="button" onClick={() => { setSelected(r.name); setDetail(null) }} className={cn('block w-full px-4 py-2.5 text-left transition-colors', selected === r.name ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}>
                      <div className="truncate text-sm font-semibold text-content">{r.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-content-muted">
                        <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px]">{r.format}</span>
                        <span>{r.type}</span>
                        {r.versionPolicy ? <span>· {r.versionPolicy.toLowerCase()}</span> : null}
                      </div>
                      {r.remoteUrl ? <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle" title={`proxies ${r.remoteUrl}`}>↗ {r.remoteUrl}</div> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {selected ? (
          <NexusComponentsPane
            repository={all.find((r) => r.name === selected)!}
            nexusUrl={nexusUrl}
            onOpen={setDetail}
          />
        ) : (
          <Card><CardBody><EmptyState title="Pick a repository" description="Select a repository on the left to see its packages." /></CardBody></Card>
        )}
      </div>

      {detail ? <NexusComponentDrawer component={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  )
}

function NexusComponentsPane({
  repository,
  nexusUrl,
  onOpen,
}: {
  repository: nexus.NexusRepository
  nexusUrl: string
  onOpen(c: nexus.NexusComponent): void
}) {
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const comps = useNexusComponents(repository.name, applied)

  const rows = comps.data?.items ?? []
  const columns: Column<nexus.NexusComponent>[] = [
    {
      key: 'name',
      header: 'Package',
      pinned: true,
      minWidth: 220,
      value: (c) => `${c.group ? `${c.group}:` : ''}${c.name}`,
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[12px] font-semibold text-content">{c.name}</div>
          {c.group ? <div className="truncate font-mono text-[10.5px] text-content-subtle">{c.group}</div> : null}
        </div>
      ),
    },
    { key: 'version', header: 'Version', width: 140, value: (c) => c.version ?? '', cell: (c) => <span className="font-mono text-[11px] text-content">{c.version ?? '—'}</span> },
    { key: 'format', header: 'Format', width: 90, value: (c) => c.format, cell: (c) => <span className="font-mono text-[11px] text-content-muted">{c.format}</span> },
    { key: 'assets', header: 'Assets', numeric: true, width: 80, value: (c) => c.assets.length, cell: (c) => c.assets.length },
    {
      key: 'size',
      header: 'Size',
      numeric: true,
      width: 90,
      value: (c) => c.assets.reduce((s, a) => s + (a.fileSize ?? 0), 0),
      cell: (c) => {
        const total = c.assets.reduce((s, a) => s + (a.fileSize ?? 0), 0)
        return total ? fmtBytes(total) : '—'
      },
    },
    {
      key: 'modified',
      header: 'Last modified',
      width: 140,
      value: (c) => c.assets.map((a) => a.lastModified ?? '').sort().at(-1) ?? '',
      cell: (c) => {
        const t = c.assets.map((a) => a.lastModified).filter(Boolean).sort().at(-1)
        return t ? <span title={formatAbsolute(t)}>{formatRelative(t)}</span> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'integrity',
      header: 'Integrity',
      width: 130,
      value: (c) => (c.assets.every((a) => a.checksum.sha256 || a.checksum.sha512) ? 'sha256+' : c.assets.some((a) => a.checksum.sha1) ? 'sha1 only' : 'none'),
      cell: (c) => {
        const strong = c.assets.filter((a) => a.checksum.sha256 || a.checksum.sha512).length
        if (c.assets.length === 0) return <span className="text-[11px] text-content-subtle">no assets</span>
        if (strong === c.assets.length) return <span className="text-[11px] text-content-muted" title="Every asset has a SHA-256 or SHA-512 checksum recorded.">sha256/512</span>
        if (strong === 0) return <span className="text-[11px] text-amber-700 dark:text-amber-300" title="Only SHA-1/MD5 recorded — adequate for detecting corruption, not for resisting a deliberate collision.">weak digests only</span>
        return <span className="text-[11px] text-content-muted">{strong}/{c.assets.length} strong</span>
      },
    },
  ]

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-content">{repository.name}</div>
            <div className="truncate text-[11px] text-content-subtle">
              {repository.format} · {repository.type}
              {repository.remoteUrl ? <> · proxies <span className="font-mono">{repository.remoteUrl}</span></> : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setApplied(q) }}
              placeholder="Keyword search…"
              className="h-8 w-48 rounded-lg border border-edge-default bg-surface-app px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
            <Button size="sm" variant="secondary" onClick={() => setApplied(q)}>Search</Button>
            {nexusUrl ? <Button size="sm" variant="ghost" onClick={() => globalThis.open(`${nexusUrl}/#browse/browse:${encodeURIComponent(repository.name)}`, '_blank', 'noopener')}>Open in Nexus</Button> : null}
            {comps.isFetching ? <Spinner size={12} /> : null}
          </div>
        </div>
        {comps.data?.truncated ? (
          <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
            Showing the first {rows.length} components — this repository has more than three pages. Narrow with a keyword search to see the rest.
          </div>
        ) : null}
      </CardHeader>
      <CardBody className="p-0!">
        {comps.isError ? (
          <div className="p-6">
            <EmptyState compact title="Couldn't list components" description={comps.error instanceof Error ? comps.error.message : 'Nexus did not answer.'} />
          </div>
        ) : (
          <DataTable
            tableId="deliver-nexus-components"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            onRowClick={onOpen}
            loading={comps.isLoading}
            stickyHeader
            features={{ search: true, filters: true, columns: true, density: true, export: true }}
            searchPlaceholder="Filter loaded packages…"
            empty={<EmptyState compact title="No packages" description="Nexus returned no components for this repository." />}
          />
        )}
      </CardBody>
    </Card>
  )
}

function NexusComponentDrawer({ component: c, onClose }: { component: nexus.NexusComponent; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Package detail">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px] dark:bg-black/60" />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{c.format} package</div>
            <h2 className="mt-1 truncate font-mono text-base font-semibold text-content">{c.group ? `${c.group}:` : ''}{c.name}{c.version ? `:${c.version}` : ''}</h2>
            <div className="mt-1 text-[11px] text-content-subtle">in {c.repository}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">✕</button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <Section title="Assets" source="Nexus GET /service/rest/v1/components — one entry per uploaded file">
            {c.assets.length === 0 ? (
              <p className="text-[12px] text-content-muted">Nexus lists no assets for this component.</p>
            ) : (
              <ul className="space-y-2">
                {c.assets.map((a) => (
                  <li key={a.id} className="rounded-lg border border-edge-default p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="break-all font-mono text-[12px] text-content">{a.path}</div>
                        <div className="mt-0.5 text-[10.5px] text-content-subtle">
                          {a.contentType ?? 'unknown type'}
                          {a.fileSize !== undefined ? ` · ${fmtBytes(a.fileSize)}` : ''}
                          {a.blobStoreName ? ` · blob store ${a.blobStoreName}` : ''}
                        </div>
                      </div>
                      {a.downloadUrl ? (
                        <a href={a.downloadUrl} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-brand-700 hover:underline dark:text-brand-300">download ↗</a>
                      ) : null}
                    </div>
                    <dl className="mt-2 space-y-0.5">
                      {(['sha512', 'sha256', 'sha1', 'md5'] as const).map((alg) =>
                        a.checksum[alg] ? (
                          <div key={alg} className="flex flex-wrap gap-2 text-[10.5px]">
                            <dt className={cn('w-14 shrink-0 font-mono uppercase', alg === 'sha1' || alg === 'md5' ? 'text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>{alg}</dt>
                            <dd className="min-w-0 break-all font-mono text-content-muted">{a.checksum[alg]}</dd>
                          </div>
                        ) : null,
                      )}
                    </dl>
                    <div className="mt-2 flex flex-wrap gap-3 text-[10.5px] text-content-subtle">
                      {a.lastModified ? <span title={formatAbsolute(a.lastModified)}>modified {formatRelative(a.lastModified)}</span> : null}
                      {a.blobCreated ? <span title={formatAbsolute(a.blobCreated)}>stored {formatRelative(a.blobCreated)}</span> : null}
                      {a.lastDownloaded ? <span title={formatAbsolute(a.lastDownloaded)}>last pulled {formatRelative(a.lastDownloaded)}</span> : <span>never pulled through Nexus</span>}
                      {a.uploader ? <span>uploaded by {a.uploader}</span> : null}
                    </div>
                    {a.formatAttributes && Object.keys(a.formatAttributes).length ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[10.5px] font-semibold text-content-muted hover:text-content">Format attributes</summary>
                        <pre className="mt-1 overflow-auto rounded border border-edge-subtle bg-surface-sunken p-2 font-mono text-[10.5px] text-content-muted">{JSON.stringify(a.formatAttributes, null, 2)}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Supply chain" source="what Nexus OSS does and does not record">
            <p className="text-[12px] text-content-muted">
              Checksums above are the only integrity signal Nexus keeps for this package. Nexus OSS records no signature,
              no attestation, no SBOM and no vulnerability data, so nothing here says whether this package is trustworthy —
              only whether it is intact.
            </p>
          </Section>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ══════════════════════ shared pieces ══════════════════════ */

function Stat({ label, value, hint, tone, mono = false }: { label: string; value: number | string; hint?: string; tone?: StatusKind; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-edge-default bg-surface-raised px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span
        className={cn(
          'truncate text-lg font-semibold leading-none tracking-tight',
          mono && 'font-mono text-[13px] leading-5',
          tone === 'failed' ? 'text-rose-600 dark:text-rose-300' : tone === 'degraded' ? 'text-amber-600 dark:text-amber-300' : 'text-content',
        )}
        title={String(value)}
      >
        {value}
      </span>
      {hint ? <span className="truncate text-[10.5px] text-content-subtle" title={hint}>{hint}</span> : null}
    </div>
  )
}

function RepoRow({ repo: r, active, onPick }: { repo: harbor.Repository; active: boolean; onPick(): void }) {
  return (
    <li>
      <button type="button" onClick={onPick} className={cn('block w-full px-4 py-2.5 text-left transition-colors', active ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}>
        <div className="truncate text-sm font-semibold text-content">{r.name.split('/').slice(1).join('/') || r.name}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle">{r.name}</div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-content-muted">
          <span>{r.artifact_count} artifact{r.artifact_count === 1 ? '' : 's'}</span>
          <span>· {fmtNum(r.pull_count)} pulls</span>
          <span title={formatAbsolute(r.update_time)}>· {formatRelative(r.update_time)}</span>
        </div>
      </button>
    </li>
  )
}

function Chip({ on, onClick, tone, children }: { on: boolean; onClick(): void; tone?: StatusKind; children: React.ReactNode }) {
  const tones: Record<string, string> = { failed: 'text-rose-700 dark:text-rose-300', degraded: 'text-amber-700 dark:text-amber-300' }
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : cn('border-edge-default bg-surface-raised hover:border-edge-strong', tone ? tones[tone] : 'text-content-muted'))}>
      {children}
    </button>
  )
}

function Section({ title, source, children }: { title: string; source?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-content">{title}</h3>
        {source ? <span className="font-mono text-[10px] text-content-subtle" title="Where this section's facts come from">{source}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[11px] text-content-subtle">{k}</dt>
          <dd className="min-w-0 break-words text-[12px] text-content">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'info'; title: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3',
        tone === 'warn'
          ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
          : 'border-edge-default bg-surface-raised',
      )}
    >
      <div className={cn('text-[12px] font-semibold', tone === 'warn' ? 'text-amber-800 dark:text-amber-200' : 'text-content')}>{title}</div>
      <div className={cn('mt-1 text-[11.5px] leading-relaxed', tone === 'warn' ? 'text-amber-900/90 dark:text-amber-100/90' : 'text-content-muted')}>{children}</div>
    </div>
  )
}

function signatureLabel(a: harbor.Artifact): string {
  if (a.accessories === undefined) return 'unknown'
  if (a.accessories.length === 0) return 'unsigned'
  return a.accessories.some((x) => /signature/i.test(x.type)) ? 'signed' : 'attested'
}

function SignatureCell({ artifact: a }: { artifact: harbor.Artifact }) {
  const label = signatureLabel(a)
  if (label === 'unknown') return <span className="text-[11px] text-content-subtle" title="Harbor did not report an accessory list.">unknown</span>
  if (label === 'unsigned') {
    return <span className="text-[11px] text-content-subtle" title="Harbor lists no cosign signature or attestation for this digest.">unsigned</span>
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300" title={`${a.accessories!.length} accessory/accessories attached: ${a.accessories!.map((x) => x.type).join(', ')}`}>
      ✓ {label}
    </span>
  )
}

function TagModal({ artifact, onClose, onAdd, loading }: { artifact: harbor.Artifact; onClose(): void; onAdd(tag: string): void; loading: boolean }) {
  const [tag, setTag] = useState('')
  const ok = /^[\w][\w.-]{0,127}$/.test(tag)
  if (typeof document === 'undefined') return null
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a tag"
      description={`Tags point at ${artifact.digest.slice(0, 19)}. Letters, digits, '.', '_' and '-' only.`}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onAdd(tag.trim()); onClose() }} disabled={!ok} loading={loading}>Add tag</Button>
        </>
      }
    >
      <input autoFocus value={tag} onChange={(e) => setTag(e.target.value)} placeholder="v1.2.3" className="block h-9 w-full rounded-lg border border-edge-default bg-surface-app px-3 font-mono text-[12px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20" />
    </Modal>
  )
}

function VulnBar({ vulns: v }: { vulns: NonNullable<harbor.Artifact['vulnerabilities']> }) {
  const total = v.critical + v.high + v.medium + v.low || 1
  return (
    <div className="space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
        {v.critical > 0 ? <div className="h-full bg-rose-500" style={{ width: `${(v.critical / total) * 100}%` }} /> : null}
        {v.high > 0 ? <div className="h-full bg-amber-500" style={{ width: `${(v.high / total) * 100}%` }} /> : null}
        {v.medium > 0 ? <div className="h-full bg-sky-500" style={{ width: `${(v.medium / total) * 100}%` }} /> : null}
        {v.low > 0 ? <div className="h-full bg-slate-400" style={{ width: `${(v.low / total) * 100}%` }} /> : null}
      </div>
      <div className="flex flex-wrap gap-2.5 font-mono text-[10px] text-content-muted">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-rose-500" />C {v.critical}</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />H {v.high}</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-sky-500" />M {v.medium}</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-slate-400" />L {v.low}</span>
      </div>
    </div>
  )
}

function shortDigest(d: string): string {
  return d.replace(/^sha256:/, '').slice(0, 12)
}

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function fmtBytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export default Registry
