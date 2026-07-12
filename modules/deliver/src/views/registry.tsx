import { useEffect, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { harbor } from '@adhar-console/api-clients'
import { useArtifacts, useRepositories } from '../data/delivery.ts'

/**
 * Harbor image registry. Two-pane: repos on the left (search + click to
 * select), artifacts on the right with tag chips, digest, size, push time,
 * and a stacked vulnerability summary bar.
 */
export function Registry() {
  const repos = useRepositories()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!selected && repos.data?.length) {
      setSelected(repos.data[0].name)
    }
  }, [selected, repos.data])

  if (repos.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading registry…
      </div>
    )
  }
  if (repos.isError) {
    return <EmptyState title="Couldn't reach Harbor" />
  }

  const all = repos.data ?? []
  const f = search.trim().toLowerCase()
  const list = f ? all.filter((r) => r.name.toLowerCase().includes(f)) : all

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Repositories</div>
            <span className="text-[11px] text-content-subtle">{all.length}</span>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="mt-2 block w-full rounded-md border border-edge-default bg-white px-2 py-1 text-xs focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </CardHeader>
        <CardBody className="p-0!">
          {list.length === 0 ? (
            <EmptyState compact title="No repositories" />
          ) : (
            <ul className="max-h-[60vh] divide-y divide-edge-subtle overflow-y-auto">
              {list.map((r) => (
                <RepoRow
                  key={r.id}
                  repo={r}
                  active={selected === r.name}
                  onPick={() => setSelected(r.name)}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <ArtifactsPane repoName={selected} />
    </div>
  )
}

function RepoRow({
  repo: r,
  active,
  onPick,
}: {
  repo: harbor.Repository
  active: boolean
  onPick(): void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={
          active
            ? 'block w-full bg-brand-50 px-4 py-2.5 text-left'
            : 'block w-full px-4 py-2.5 text-left transition-colors hover:bg-surface-sunken'
        }
      >
        <div className="text-sm font-semibold text-content">{r.name.split('/').pop()}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle">{r.name}</div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-content-muted">
          <span>{r.artifact_count} tags</span>
          <span>· {r.pull_count} pulls</span>
          <span>· {formatRelative(r.update_time)}</span>
        </div>
      </button>
    </li>
  )
}

function ArtifactsPane({ repoName }: { repoName: string | null }) {
  if (!repoName) {
    return (
      <Card>
        <CardBody>
          <EmptyState title="Pick a repository" description="Select a repo on the left to see artifacts." />
        </CardBody>
      </Card>
    )
  }
  // Harbor expects the path component after the project (acme/<repo> → <repo>).
  const repoPath = repoName.split('/').slice(1).join('/') || repoName
  return <ArtifactsList repoName={repoName} repoPath={repoPath} />
}

function ArtifactsList({ repoName, repoPath }: { repoName: string; repoPath: string }) {
  const q = useArtifacts(repoPath)
  const list = q.data ?? []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-content">Artifacts</div>
            <div className="text-[11px] font-mono text-content-subtle">{repoName}</div>
          </div>
          {q.isLoading ? <Spinner size={12} /> : <StatusBadge kind="info">{list.length}</StatusBadge>}
        </div>
      </CardHeader>
      <CardBody className="p-0!">
        {list.length === 0 && !q.isLoading ? (
          <EmptyState compact title="No artifacts" description="No images pushed for this repository yet." />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {list.map((a) => (
              <ArtifactRow key={a.digest} artifact={a} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

function ArtifactRow({ artifact: a }: { artifact: harbor.Artifact }) {
  const v = a.vulnerabilities
  return (
    <li className="space-y-2 px-5 py-3 transition-colors hover:bg-brand-50/40">
      <div className="flex flex-wrap items-center gap-2">
        {(a.tags ?? []).map((t) => (
          <span
            key={t.name}
            className="rounded-full bg-brand-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-700"
          >
            {t.name}
          </span>
        ))}
        <code className="font-mono text-[10px] text-content-muted">{a.digest.slice(0, 16)}…</code>
        <span className="text-[11px] text-content-muted">
          · {(a.size / 1024 / 1024).toFixed(1)} MiB · pushed {formatRelative(a.push_time)}
        </span>
      </div>
      {v ? <VulnBar vulns={v} /> : null}
    </li>
  )
}

function VulnBar({
  vulns: v,
}: {
  vulns: NonNullable<harbor.Artifact['vulnerabilities']>
}) {
  const total = v.critical + v.high + v.medium + v.low || 1
  return (
    <div className="space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
        {v.critical > 0 ? <div className="h-full bg-rose-500" style={{ width: `${(v.critical / total) * 100}%` }} /> : null}
        {v.high > 0 ? <div className="h-full bg-amber-500" style={{ width: `${(v.high / total) * 100}%` }} /> : null}
        {v.medium > 0 ? <div className="h-full bg-sky-500" style={{ width: `${(v.medium / total) * 100}%` }} /> : null}
        {v.low > 0 ? <div className="h-full bg-slate-400" style={{ width: `${(v.low / total) * 100}%` }} /> : null}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] font-mono text-content-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
          C {v.critical}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          H {v.high}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
          M {v.medium}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
          L {v.low}
        </span>
      </div>
    </div>
  )
}

export default Registry
