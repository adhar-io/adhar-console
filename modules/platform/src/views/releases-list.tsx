import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Input,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { kube } from '@adhar-console/api-clients/k8s'
import { GVRS } from '../data/gvr.ts'
import { useDecodedRelease, useHelmReleases, type HelmRelease } from '../data/releases.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sPermissionDenied, K8sRolePill } from '../components/role-gate.tsx'
import { age } from '../data/format.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'

/**
 * Helm release inventory read live from the cluster's `helm.sh/release.v1`
 * Secrets (label `owner=helm`) — the same storage `helm list` reads. The
 * list works purely from the Secrets' labels (name / version / status), so
 * it needs no decompression and no new dependency; chart + app version are
 * decoded in-browser with the native `DecompressionStream` when available,
 * with an honest "can't decode" fallback otherwise. Uninstall deletes the
 * release's Secrets behind a typed confirm.
 */

const STATUS_KIND: Record<string, StatusKind> = {
  deployed: 'healthy',
  superseded: 'paused',
  failed: 'failed',
  uninstalling: 'degraded',
  uninstalled: 'unknown',
  'pending-install': 'progressing',
  'pending-upgrade': 'progressing',
  'pending-rollback': 'progressing',
}

function ReleaseStatusBadge({ status }: { status: string }) {
  return <StatusBadge kind={STATUS_KIND[status] ?? 'unknown'}>{status}</StatusBadge>
}

export function ReleasesView({ namespace }: { namespace?: string }) {
  const canRead = useHasK8sPermission('secrets.read')
  if (!canRead) {
    return <K8sPermissionDenied perm="secrets.read" />
  }
  return <ReleasesList namespace={namespace} />
}

function ReleasesList({ namespace }: { namespace?: string }) {
  const { releases, isLoading, isError, error, refetch } = useHelmReleases(namespace)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      releases.filter(
        (r) => matchesSearch(r.name, search) || matchesSearch(r.namespace, search),
      ),
    [releases, search],
  )

  if (isError) {
    return (
      <EmptyState
        title="Couldn't read Helm release Secrets"
        description={error?.message ?? 'Listing helm.sh/release.v1 Secrets failed — check your Secret read access.'}
      />
    )
  }

  const selectedRelease = selected ? releases.find((r) => r.key === selected) : undefined

  return (
    <>
      <ListShell
        title="Helm releases"
        total={releases.length}
        visible={rows.length}
        loading={isLoading}
        onRefresh={refetch}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by release or namespace…"
        caption="from helm.sh/release.v1 Secrets"
      >
        <DataTable
          loading={isLoading}
          onRowClick={(r) => setSelected(r.key)}
          columns={[
            {
              key: 'name',
              header: 'Release',
              cell: (r) => (
                <div>
                  <div className="font-medium text-content">{r.name}</div>
                  <div className="text-xs text-content-muted">{r.namespace}</div>
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (r) => <ReleaseStatusBadge status={r.latest.status} />,
            },
            { key: 'revision', header: 'Revision', numeric: true, cell: (r) => r.latest.revision },
            {
              key: 'chart',
              header: 'Chart',
              cell: (r) => <ChartCell release={r} />,
            },
            {
              key: 'updated',
              header: 'Updated',
              cell: (r) =>
                r.latest.updated ? (
                  <span title={r.latest.updated}>{age(r.latest.updated)} ago</span>
                ) : (
                  <span className="text-content-subtle">—</span>
                ),
            },
            {
              key: 'history',
              header: 'History',
              numeric: true,
              cell: (r) => `${r.history.length} rev${r.history.length === 1 ? '' : 's'}`,
            },
          ]}
          rows={rows}
          rowKey={(r) => r.key}
          empty={
            <EmptyState
              title="No Helm releases"
              description="Releases installed with Helm 3 store their state as helm.sh/release.v1 Secrets and appear here."
            />
          }
        />
      </ListShell>

      {selectedRelease ? (
        <ReleaseDrawer release={selectedRelease} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

/** Chart name/version decoded from the live payload — honest "—" otherwise. */
function ChartCell({ release }: { release: HelmRelease }) {
  const decoded = useDecodedRelease(release.latest.secret)
  if (decoded.isLoading) return <span className="text-content-subtle">…</span>
  const meta = decoded.data?.chart?.metadata
  if (!meta?.name) {
    return (
      <span className="text-content-subtle" title="Chart details require decoding the release payload">
        —
      </span>
    )
  }
  return (
    <div>
      <code className="text-xs text-content">
        {meta.name}
        {meta.version ? `-${meta.version}` : ''}
      </code>
      {meta.appVersion ? <div className="text-[11px] text-content-muted">app {meta.appVersion}</div> : null}
    </div>
  )
}

/* ── drawer ────────────────────────────────────────────────────────────── */

function ReleaseDrawer({ release, onClose }: { release: HelmRelease; onClose(): void }) {
  const canUninstall = useHasK8sPermission('secrets.write')
  const decoded = useDecodedRelease(release.latest.secret)
  const [confirming, setConfirming] = useState(false)

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-edge-default bg-surface-raised shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">Helm release</div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{release.name}</h2>
            <div className="mt-0.5 text-xs text-content-muted">
              {release.namespace} · revision {release.latest.revision}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ReleaseStatusBadge status={release.latest.status} />
            {canUninstall ? (
              <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                Uninstall
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
                Uninstall <K8sRolePill perm="secrets.write" />
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-content-muted hover:bg-surface-sunken hover:text-content"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Details</div>
            </CardHeader>
            <CardBody className="space-y-2 text-sm">
              <DetailRow label="Namespace" value={release.namespace} mono />
              <DetailRow label="Revision" value={String(release.latest.revision)} mono />
              <DetailRow label="Status" value={release.latest.status} mono />
              <DetailRow
                label="Updated"
                value={release.latest.updated ? `${release.latest.updated} (${age(release.latest.updated)} ago)` : '—'}
                mono
              />
              <DetailRow label="Storage Secret" value={release.latest.secretName} mono />
              {decoded.isLoading ? (
                <div className="text-xs text-content-subtle">Decoding release payload…</div>
              ) : decoded.data ? (
                <>
                  <DetailRow
                    label="Chart"
                    value={
                      decoded.data.chart?.metadata?.name
                        ? `${decoded.data.chart.metadata.name}${decoded.data.chart.metadata.version ? `-${decoded.data.chart.metadata.version}` : ''}`
                        : '—'
                    }
                    mono
                  />
                  <DetailRow label="App version" value={decoded.data.chart?.metadata?.appVersion ?? '—'} mono />
                  <DetailRow label="First deployed" value={decoded.data.info?.first_deployed ?? '—'} mono />
                  <DetailRow label="Last deployed" value={decoded.data.info?.last_deployed ?? '—'} mono />
                  {decoded.data.info?.description ? (
                    <DetailRow label="Description" value={decoded.data.info.description} />
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-edge-default bg-surface-sunken/60 px-3 py-2 text-xs text-content-muted">
                  Chart and deployment details require decoding the gzipped release payload, which this
                  browser can't do (or the payload is unreadable) — details require server-side decode.
                  Name, revision, status and history above come from the Secret's labels and are accurate.
                </div>
              )}
            </CardBody>
          </Card>

          {decoded.data?.info?.notes ? (
            <Card>
              <CardHeader>
                <div className="text-sm font-semibold text-content">Notes</div>
              </CardHeader>
              <CardBody>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
                  {decoded.data.info.notes}
                </pre>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">
                History{' '}
                <span className="font-mono text-xs font-normal text-content-subtle">
                  {release.history.length} revision{release.history.length === 1 ? '' : 's'}
                </span>
              </div>
            </CardHeader>
            <CardBody>
              <div className="overflow-x-auto rounded-lg border border-edge-default">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-edge-default bg-surface-sunken text-left">
                      {['Revision', 'Status', 'Updated', 'Secret'].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-content-muted"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge-subtle">
                    {release.history.map((rev) => (
                      <tr key={rev.revision}>
                        <td className="px-3 py-1.5 font-mono text-xs tabular-nums">{rev.revision}</td>
                        <td className="px-3 py-1.5">
                          <ReleaseStatusBadge status={rev.status} />
                        </td>
                        <td className="px-3 py-1.5 text-xs text-content-muted">
                          {rev.updated ? <span title={rev.updated}>{age(rev.updated)} ago</span> : '—'}
                        </td>
                        <td className="max-w-56 truncate px-3 py-1.5 font-mono text-[11px] text-content-subtle">
                          {rev.secretName}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </div>

        {confirming ? (
          <UninstallBar release={release} onCancel={() => setConfirming(false)} onDone={onClose} />
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-content-muted">{label}</span>
      <span className={`min-w-0 break-all text-right text-content ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}

/* ── uninstall (typed confirm; deletes the release's storage Secrets) ──── */

function UninstallBar({
  release,
  onCancel,
  onDone,
}: {
  release: HelmRelease
  onCancel(): void
  onDone(): void
}) {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')

  const mut = useMutation({
    mutationFn: async () => {
      // Delete every revision Secret — equivalent to wiping the release from
      // Helm's storage. Sequential so a failure stops cleanly mid-way.
      const failures: string[] = []
      for (const rev of release.history) {
        try {
          await kube.delete(GVRS.secrets, release.namespace, rev.secretName)
        } catch (e) {
          failures.push(`${rev.secretName}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (failures.length) throw new Error(`Some Secrets weren't deleted — ${failures.join('; ')}`)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onDone()
    },
  })

  return (
    <div
      className="border-t border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-4"
      role="alert"
    >
      <div className="text-sm font-semibold text-rose-900 dark:text-rose-300">
        Uninstall release {release.name}?
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
        This deletes the release's {release.history.length} storage Secret
        {release.history.length === 1 ? '' : 's'} in <code className="font-mono">{release.namespace}</code>,
        removing it (and its whole history) from Helm. <strong>It does not delete the workloads the
        chart installed</strong> — they keep running but Helm can no longer manage or roll them back.
        Prefer <code className="font-mono">helm uninstall</code> when you also want the resources removed.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type "${release.name}" to confirm`}
          className="h-8 max-w-64 font-mono text-xs"
          aria-label="Type the release name to confirm uninstall"
        />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={mut.isPending}>
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={typed !== release.name || mut.isPending}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? 'Removing…' : 'Uninstall'}
        </Button>
      </div>
      {mut.isError ? (
        <div className="mt-2 text-xs text-rose-700 dark:text-rose-300">{(mut.error as Error).message}</div>
      ) : null}
    </div>
  )
}
