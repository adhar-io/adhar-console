import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
  useHarborProject,
  useToast,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import type { harbor } from '@adhar-console/api-clients'
import {
  useAddTag,
  useArtifactVulnerabilities,
  useArtifacts,
  useDeleteArtifact,
  useDeleteTag,
  useHarborProjects,
  useProjectRepositories,
  useRegistryHost,
  useScanArtifact,
} from '../data/delivery.ts'

/**
 * Harbor image registry — a full registry console, not just a browser.
 *
 *  - stats strip: projects, repositories, artifacts, storage used vs quota,
 *    scan coverage and critical/high findings across the loaded repository;
 *  - project selector (every project the credential can see, with quota),
 *    repository list with search and sort (updated / pulls / artifacts / name);
 *  - artifact table: tags, digest, platform, size, pushed, last pull, scan
 *    status with severity bar, labels — with per-artifact actions: copy pull
 *    command, scan now, add / remove tags, delete;
 *  - artifact drawer: full CVE list (severity, package, installed → fixed
 *    version, CVSS, links) with a severity filter.
 * Every read and write goes to Harbor's API through the console proxy.
 */
export function Registry() {
  const defaultProject = useHarborProject()
  const projects = useHarborProjects()
  const [project, setProject] = useState<string>('')
  const repos = useProjectRepositories(project || defaultProject)
  const host = useRegistryHost()
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
  const totalArtifacts = all.reduce((s, r) => s + r.artifact_count, 0)
  const totalPulls = all.reduce((s, r) => s + r.pull_count, 0)

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
      {/* ── stats strip ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Projects" value={projects.data?.length ?? '—'} hint={current ? (current.public ? 'viewing a public project' : 'viewing a private project') : undefined} />
        <Stat label="Repositories" value={all.length} hint={current ? `in ${current.name}` : undefined} />
        <Stat label="Artifacts" value={fmtNum(totalArtifacts)} hint={`${fmtNum(totalPulls)} pulls total`} />
        <Stat
          label="Storage"
          value={current?.storageUsed !== undefined ? fmtBytes(current.storageUsed) : '—'}
          hint={current?.storageQuota !== undefined && current.storageQuota > 0 ? `of ${fmtBytes(current.storageQuota)} quota` : current?.storageQuota === -1 ? 'no quota' : undefined}
          tone={current?.storageQuota && current.storageQuota > 0 && current.storageUsed !== undefined && current.storageUsed / current.storageQuota > 0.85 ? 'degraded' : undefined}
        />
        <Stat label="Registry" value={host.data ? host.data.split('/')[0] : '—'} hint="docker pull host" mono />
        <Stat label="Updated" value={all[0] ? formatRelative(list.slice().sort((a, b) => b.update_time.localeCompare(a.update_time))[0]?.update_time ?? all[0].update_time) : '—'} hint="most recent push" />
      </div>

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
        {selected ? <ArtifactsPane repoName={selected} host={host.data ?? ''} /> : (
          <Card><CardBody><EmptyState title="Pick a repository" description="Select a repository on the left to see its artifacts." /></CardBody></Card>
        )}
      </div>
    </div>
  )
}

/* ─────────── pieces ─────────── */

function Stat({ label, value, hint, tone, mono = false }: { label: string; value: number | string; hint?: string; tone?: StatusKind; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-edge-default bg-surface-raised px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('truncate text-lg font-semibold leading-none tracking-tight', mono && 'font-mono text-[13px] leading-5', tone === 'degraded' ? 'text-amber-600 dark:text-amber-300' : 'text-content')} title={String(value)}>{value}</span>
      {hint ? <span className="truncate text-[10.5px] text-content-subtle">{hint}</span> : null}
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

function ArtifactsPane({ repoName, host }: { repoName: string; host: string }) {
  const q = useArtifacts(repoName)
  const scan = useScanArtifact()
  const del = useDeleteArtifact()
  const addTag = useAddTag()
  const delTag = useDeleteTag()
  const toast = useToast()
  const [open, setOpen] = useState<harbor.Artifact | null>(null)
  const [tagFor, setTagFor] = useState<harbor.Artifact | null>(null)
  const [confirm, setConfirm] = useState<harbor.Artifact | null>(null)
  const [severityF, setSeverityF] = useState<'all' | 'critical' | 'high' | 'unscanned'>('all')
  const list = useMemo(() => q.data ?? [], [q.data])
  const repoPath = repoName.split('/').slice(1).join('/') || repoName

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

  const stats = useMemo(() => {
    const s = { scanned: 0, critical: 0, high: 0, size: 0 }
    for (const a of list) {
      if (a.vulnerabilities) s.scanned++
      s.critical += a.vulnerabilities?.critical ?? 0
      s.high += a.vulnerabilities?.high ?? 0
      s.size += a.size
    }
    return s
  }, [list])

  const filtered = list.filter((a) => {
    if (severityF === 'critical') return (a.vulnerabilities?.critical ?? 0) > 0
    if (severityF === 'high') return (a.vulnerabilities?.high ?? 0) > 0
    if (severityF === 'unscanned') return !a.vulnerabilities
    return true
  })

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-content">Artifacts</div>
            <div className="truncate font-mono text-[11px] text-content-subtle" title={repoName}>{repoName}</div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip on={severityF === 'all'} onClick={() => setSeverityF('all')}>{list.length} all</Chip>
            <Chip on={severityF === 'critical'} onClick={() => setSeverityF(severityF === 'critical' ? 'all' : 'critical')} tone="failed">{stats.critical} critical</Chip>
            <Chip on={severityF === 'high'} onClick={() => setSeverityF(severityF === 'high' ? 'all' : 'high')} tone="degraded">{stats.high} high</Chip>
            <Chip on={severityF === 'unscanned'} onClick={() => setSeverityF(severityF === 'unscanned' ? 'all' : 'unscanned')}>{list.length - stats.scanned} unscanned</Chip>
            <span className="text-[11px] text-content-subtle">· {fmtBytes(stats.size)}</span>
            {q.isFetching ? <Spinner size={12} /> : null}
          </div>
        </div>
      </CardHeader>
      <CardBody className="p-0!">
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-5 text-sm text-content-muted"><Spinner size={14} /> Loading artifacts…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6"><EmptyState compact title={list.length === 0 ? 'No artifacts' : 'No matches'} description={list.length === 0 ? 'No images pushed for this repository yet.' : 'Nothing matches the severity filter.'} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-surface-sunken/50 text-[10px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="px-3 py-2 text-left">Tags</th>
                  <th className="px-3 py-2 text-left">Digest</th>
                  <th className="px-3 py-2 text-left">Platform</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2 text-left">Pushed</th>
                  <th className="px-3 py-2 text-left">Vulnerabilities</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {filtered.map((a) => (
                  <tr key={a.digest} className="align-top hover:bg-surface-sunken/40">
                    <td className="max-w-56 px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(a.tags ?? []).length === 0 ? <span className="text-[11px] text-content-subtle">untagged</span> : null}
                        {(a.tags ?? []).map((t) => (
                          <span key={t.name} className="group inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300" title={t.immutable ? 'immutable tag' : t.push_time ? `pushed ${formatRelative(t.push_time)}` : undefined}>
                            {t.name}
                            {!t.immutable ? (
                              <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => act(`Tag ${t.name} removed.`, () => delTag.mutateAsync({ repo: repoName, ref: a.digest, tag: t.name }))} className="hidden text-brand-500 hover:text-rose-600 group-hover:inline">×</button>
                            ) : null}
                          </span>
                        ))}
                        <button type="button" onClick={() => setTagFor(a)} className="rounded-full border border-dashed border-edge-strong px-1.5 py-0.5 text-[10px] text-content-subtle hover:text-content" title="Add a tag">+ tag</button>
                      </div>
                      {a.labels?.length ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {a.labels.map((l) => <span key={l.name} className="rounded px-1.5 py-0.5 text-[9.5px] font-medium text-white" style={{ background: l.color || 'var(--color-slate-500)' }}>{l.name}</span>)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => copy(a.digest)} className="font-mono text-[11px] text-content-muted hover:text-content" title={`${a.digest} — click to copy`}>{a.digest.replace('sha256:', '').slice(0, 12)}</button>
                      {a.type && a.type !== 'IMAGE' ? <div className="text-[10px] uppercase text-content-subtle">{a.type}</div> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-content-muted">{a.platform ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-content-muted">{fmtBytes(a.size)}</td>
                    <td className="px-3 py-2 text-content-muted">
                      <div title={formatAbsolute(a.push_time)}>{formatRelative(a.push_time)}</div>
                      {a.pull_time ? <div className="text-[10.5px] text-content-subtle" title={formatAbsolute(a.pull_time)}>pulled {formatRelative(a.pull_time)}</div> : null}
                    </td>
                    <td className="min-w-48 px-3 py-2">
                      {a.vulnerabilities ? (
                        <button type="button" onClick={() => setOpen(a)} className="block w-full text-left" title="Open the vulnerability report">
                          <VulnBar vulns={a.vulnerabilities} />
                          {a.scan ? <div className="mt-1 text-[10px] text-content-subtle">{a.scan.total ?? ''}{a.scan.fixable !== undefined ? ` · ${a.scan.fixable} fixable` : ''}{a.scan.scanner ? ` · ${a.scan.scanner}` : ''}{a.scan.endTime ? ` · ${formatRelative(a.scan.endTime)}` : ''}</div> : null}
                        </button>
                      ) : a.scan?.status && a.scan.status !== 'Success' ? (
                        <StatusBadge kind={a.scan.status === 'Running' || a.scan.status === 'Pending' ? 'progressing' : a.scan.status === 'Error' ? 'failed' : 'unknown'}>{a.scan.status}</StatusBadge>
                      ) : (
                        <span className="text-[11px] text-content-subtle">not scanned</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button size="sm" variant="secondary" onClick={() => copy(pullCmd(a))} title={pullCmd(a)}>Pull</Button>
                        <Button size="sm" variant="secondary" onClick={() => act('Scan requested.', () => scan.mutateAsync({ repo: repoName, ref: a.digest }))} loading={scan.isPending && scan.variables?.ref === a.digest}>Scan</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(a)} title="Delete this artifact">Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>

      {open ? <VulnDrawer repo={repoName} artifact={open} onClose={() => setOpen(null)} /> : null}

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

function Chip({ on, onClick, tone, children }: { on: boolean; onClick(): void; tone?: StatusKind; children: React.ReactNode }) {
  const tones: Record<string, string> = { failed: 'text-rose-700 dark:text-rose-300', degraded: 'text-amber-700 dark:text-amber-300' }
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : cn('border-edge-default bg-surface-raised hover:border-edge-strong', tone ? tones[tone] : 'text-content-muted'))}>
      {children}
    </button>
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

const SEV_KIND: Record<string, StatusKind> = { Critical: 'failed', High: 'degraded', Medium: 'info', Low: 'unknown', Negligible: 'unknown', Unknown: 'unknown' }

function VulnDrawer({ repo, artifact: a, onClose }: { repo: string; artifact: harbor.Artifact; onClose(): void }) {
  const q = useArtifactVulnerabilities(repo, a.digest)
  const [sev, setSev] = useState<'all' | harbor.Vulnerability['severity']>('all')
  const [fixableOnly, setFixableOnly] = useState(false)
  const [text, setText] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null
  const all = q.data ?? []
  const f = text.trim().toLowerCase()
  const list = all.filter((v) => (sev === 'all' || v.severity === sev) && (!fixableOnly || !!v.fixVersion) && (!f || v.id.toLowerCase().includes(f) || v.package.toLowerCase().includes(f)))
  const counts = all.reduce<Record<string, number>>((m, v) => ((m[v.severity] = (m[v.severity] ?? 0) + 1), m), {})

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Vulnerability report">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px] dark:bg-black/60" />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Vulnerability report</div>
              <h2 className="mt-1 truncate font-mono text-base font-semibold text-content">{repo}{a.tags?.[0] ? `:${a.tags[0].name}` : ''}</h2>
              <div className="mt-1 text-[11px] text-content-subtle">{a.digest}{a.scan?.scanner ? ` · ${a.scan.scanner}` : ''}{a.scan?.endTime ? ` · scanned ${formatRelative(a.scan.endTime)}` : ''}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">✕</button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Chip on={sev === 'all'} onClick={() => setSev('all')}>{all.length} findings</Chip>
            {(['Critical', 'High', 'Medium', 'Low'] as const).map((s) => (
              <Chip key={s} on={sev === s} onClick={() => setSev(sev === s ? 'all' : s)} tone={s === 'Critical' ? 'failed' : s === 'High' ? 'degraded' : undefined}>{counts[s] ?? 0} {s.toLowerCase()}</Chip>
            ))}
            <Chip on={fixableOnly} onClick={() => setFixableOnly((v) => !v)}>fixable only</Chip>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="CVE or package…" className="ml-auto h-7 w-44 rounded-lg border border-edge-default bg-surface-app px-2 text-[11px] text-content placeholder:text-content-subtle focus:outline-none" />
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {q.isLoading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-content-muted"><Spinner size={14} /> Loading report…</div>
          ) : q.isError ? (
            <div className="p-6"><EmptyState compact title="No report" description={q.error instanceof Error ? q.error.message : 'Harbor did not return a vulnerability report for this artifact.'} /></div>
          ) : list.length === 0 ? (
            <div className="p-6"><EmptyState compact title={all.length === 0 ? 'No vulnerabilities found' : 'No matches'} /></div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-surface-raised text-[10px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="px-4 py-2 text-left">Severity</th>
                  <th className="px-4 py-2 text-left">Vulnerability</th>
                  <th className="px-4 py-2 text-left">Package</th>
                  <th className="px-4 py-2 text-left">Installed → fixed</th>
                  <th className="px-4 py-2 text-right">CVSS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {list.map((v) => (
                  <tr key={`${v.id}-${v.package}-${v.version}`} className="align-top">
                    <td className="px-4 py-2"><StatusBadge kind={SEV_KIND[v.severity]}>{v.severity}</StatusBadge></td>
                    <td className="px-4 py-2">
                      {v.links[0] ? <a href={v.links[0]} target="_blank" rel="noreferrer" className="font-mono text-brand-700 hover:underline dark:text-brand-300">{v.id}</a> : <span className="font-mono text-content">{v.id}</span>}
                      {v.description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-content-muted" title={v.description}>{v.description}</p> : null}
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-content">{v.package}</td>
                    <td className="px-4 py-2 font-mono text-[11px]"><span className="text-content-muted">{v.version}</span>{v.fixVersion ? <> → <span className="text-emerald-700 dark:text-emerald-300">{v.fixVersion}</span></> : <span className="ml-1 text-content-subtle">no fix</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-content-muted">{v.cvssScore?.toFixed(1) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </div>,
    document.body,
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
