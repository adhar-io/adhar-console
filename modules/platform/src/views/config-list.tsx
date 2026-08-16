import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  DataTable,
  EmptyState,
  StatusBadge,
  Tabs,
  type TabDef,
} from '@adhar-console/shell-ui'
import { kube } from '@adhar-console/api-clients/k8s'
import { useConfigMaps, useSecrets } from '../data/hooks.ts'
import { GVRS } from '../data/gvr.ts'
import { age } from '../data/format.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
import { DrawerSection, ResourceDrawer } from './resource-drawer.tsx'
import { ListShell, matchesSearch } from './list-shell.tsx'

type Sub = 'configmaps' | 'secrets'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'configmaps', label: 'ConfigMaps' },
  { id: 'secrets', label: 'Secrets' },
]

export function ConfigView({ namespace }: { namespace?: string }) {
  return (
    <Tabs<Sub> tabs={SUB_TABS} defaultValue="configmaps" ariaLabel="Config & secrets">
      {(active) => (
        <>
          {active === 'configmaps' && <ConfigMapsTable namespace={namespace} />}
          {active === 'secrets' && <SecretsTable namespace={namespace} />}
        </>
      )}
    </Tabs>
  )
}

/* ── base64 helpers (Secrets store values base64-encoded) ───────────────── */

function b64Decode(value: string): { ok: boolean; text: string } {
  try {
    const bin = atob(value)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Control characters (except tab/newline/CR) mean binary content.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return { ok: false, text: value }
    return { ok: true, text }
  } catch {
    return { ok: false, text: value }
  }
}

function b64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/* ── ConfigMaps ─────────────────────────────────────────────────────────── */

interface ConfigMapObj {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    uid?: string
  }
  data?: Record<string, string>
  binaryData?: Record<string, string>
}

function ConfigMapsTable({ namespace }: { namespace?: string }) {
  const q = useConfigMaps(namespace)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ConfigMapObj | null>(null)
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (c) =>
          matchesSearch(c.metadata.name, search) || matchesSearch(c.metadata.namespace, search),
      ),
    [all, search],
  )
  return (
    <>
      <ListShell
        title="ConfigMaps"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
        lastUpdatedAt={q.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(c) => setSelected(c as unknown as ConfigMapObj)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (c) => (
                <div>
                  <div className="font-medium text-content">{c.metadata.name}</div>
                  <div className="text-xs text-content-muted">{c.metadata.namespace}</div>
                </div>
              ),
            },
            {
              key: 'keys',
              header: 'Keys',
              numeric: true,
              cell: (c) => Object.keys((c as unknown as { data?: object }).data ?? {}).length,
            },
            {
              key: 'preview',
              header: 'Preview',
              cell: (c) => {
                const data = (c as unknown as { data?: Record<string, string> }).data ?? {}
                const keys = Object.keys(data)
                if (!keys.length) return <span className="text-content-subtle">empty</span>
                return (
                  <div className="flex flex-wrap gap-1">
                    {keys.slice(0, 4).map((k) => (
                      <code
                        key={k}
                        className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                      >
                        {k}
                      </code>
                    ))}
                    {keys.length > 4 ? (
                      <span className="text-[11px] text-content-subtle">+{keys.length - 4}</span>
                    ) : null}
                  </div>
                )
              },
            },
            { key: 'age', header: 'Age', cell: (c) => age(c.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(c) => `${c.metadata.namespace}/${c.metadata.name}`}
          empty={<EmptyState title="No ConfigMaps" />}
        />
      </ListShell>
      {selected ? (
        <ConfigMapDrawer configMap={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

function ConfigMapDrawer({
  configMap,
  onClose,
}: {
  configMap: ConfigMapObj
  onClose(): void
}) {
  const canEdit = useHasK8sPermission('configmaps.write')
  const qc = useQueryClient()
  const ns = configMap.metadata.namespace ?? 'default'
  // Saved values overlay the (possibly stale) row data until the refetch lands.
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const data: Record<string, string> = { ...(configMap.data ?? {}), ...saved }
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b))
  const binaryKeys = Object.keys(configMap.binaryData ?? {})

  const saveMut = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      await kube.patch(
        GVRS.configmaps,
        ns,
        configMap.metadata.name,
        { data: { [key]: value } },
        'merge',
      )
      return { key, value }
    },
    onSuccess: ({ key, value }) => {
      setSaved((prev) => ({ ...prev, [key]: value }))
      setEditingKey(null)
      qc.invalidateQueries({ queryKey: ['k8s', 'configmaps'] })
    },
  })

  return (
    <ResourceDrawer
      resource={{ ...configMap, apiVersion: 'v1', kind: 'ConfigMap' }}
      kindLabel="ConfigMap"
      onClose={onClose}
    >
      <DrawerSection
        title="Data"
        actions={
          canEdit ? (
            <span className="text-xs text-content-subtle">{keys.length} keys</span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-content-muted">
              Editing requires <K8sRolePill perm="configmaps.write" />
            </span>
          )
        }
      >
        {keys.length ? (
          <ul className="divide-y divide-edge-subtle">
            {keys.map((k) => {
              const editing = editingKey === k
              return (
                <li key={k} className="space-y-2 px-1 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <code className="font-mono text-xs font-semibold text-content">{k}</code>
                    {canEdit && !editing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setEditingKey(k)
                          setDraft(data[k])
                        }}
                      >
                        Edit
                      </Button>
                    ) : null}
                  </div>
                  {editing ? (
                    <div className="space-y-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
                        className="w-full rounded-lg border border-edge-default bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-content outline-none focus:ring-2 focus:ring-brand-500/30"
                        aria-label={`Value for ${k}`}
                        spellCheck={false}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setEditingKey(null)}
                          disabled={saveMut.isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          disabled={saveMut.isPending || draft === data[k]}
                          onClick={() => saveMut.mutate({ key: k, value: draft })}
                        >
                          {saveMut.isPending ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                      {saveMut.isError ? (
                        <p className="text-[11px] text-rose-700 dark:text-rose-300">
                          Error: {(saveMut.error as Error).message}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <pre className="max-h-48 overflow-auto rounded-lg bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-content-muted">
                      {data[k]}
                    </pre>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyState compact title="No data keys" />
        )}
        {binaryKeys.length ? (
          <p className="mt-2 text-[11px] text-content-subtle">
            {binaryKeys.length} binary key{binaryKeys.length === 1 ? '' : 's'} not shown:{' '}
            {binaryKeys.join(', ')}
          </p>
        ) : null}
      </DrawerSection>
    </ResourceDrawer>
  )
}

/* ── Secrets ────────────────────────────────────────────────────────────── */

interface SecretObj {
  apiVersion?: string
  kind?: string
  type?: string
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    uid?: string
  }
  data?: Record<string, string>
}

function SecretsTable({ namespace }: { namespace?: string }) {
  const q = useSecrets(namespace)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<SecretObj | null>(null)
  const all = q.data ?? []
  const rows = useMemo(
    () =>
      all.filter(
        (s) =>
          matchesSearch(s.metadata.name, search) ||
          matchesSearch(s.metadata.namespace, search) ||
          matchesSearch((s as unknown as { type?: string }).type, search),
      ),
    [all, search],
  )
  return (
    <>
      <ListShell
        title="Secrets"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
        lastUpdatedAt={q.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
        caption="values redacted until explicitly revealed"
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(s) => setSelected(s as unknown as SecretObj)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (s) => (
                <div>
                  <div className="font-medium text-content">{s.metadata.name}</div>
                  <div className="text-xs text-content-muted">{s.metadata.namespace}</div>
                </div>
              ),
            },
            {
              key: 'type',
              header: 'Type',
              cell: (s) => {
                const t = (s as unknown as { type?: string }).type ?? 'Opaque'
                const kind = t === 'Opaque' ? 'info' : t.startsWith('kubernetes.io/') ? 'progressing' : 'info'
                return <StatusBadge kind={kind}>{t}</StatusBadge>
              },
            },
            {
              key: 'keys',
              header: 'Keys',
              numeric: true,
              cell: (s) => Object.keys((s as unknown as { data?: object }).data ?? {}).length,
            },
            {
              key: 'preview',
              header: 'Preview',
              cell: (s) => {
                const data = (s as unknown as { data?: Record<string, string> }).data ?? {}
                const keys = Object.keys(data)
                if (!keys.length) return <span className="text-content-subtle">empty</span>
                return (
                  <div className="flex flex-wrap gap-1">
                    {keys.slice(0, 4).map((k) => (
                      <code
                        key={k}
                        title={`${k} (value redacted)`}
                        className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted"
                      >
                        {k}
                      </code>
                    ))}
                    {keys.length > 4 ? (
                      <span className="text-[11px] text-content-subtle">+{keys.length - 4}</span>
                    ) : null}
                  </div>
                )
              },
            },
            { key: 'age', header: 'Age', cell: (s) => age(s.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(s) => `${s.metadata.namespace}/${s.metadata.name}`}
          empty={
            <EmptyState
              title="No Secrets"
              description="Values stay redacted until explicitly revealed key by key."
            />
          }
        />
      </ListShell>
      {selected ? <SecretDrawer secret={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function SecretDrawer({ secret, onClose }: { secret: SecretObj; onClose(): void }) {
  const canReveal = useHasK8sPermission('secrets.read')
  const canEdit = useHasK8sPermission('secrets.write')
  const qc = useQueryClient()
  const ns = secret.metadata.namespace ?? 'default'
  const [saved, setSaved] = useState<Record<string, string>>({}) // key → base64
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const data: Record<string, string> = { ...(secret.data ?? {}), ...saved }
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b))

  const saveMut = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const encoded = b64Encode(value)
      await kube.patch(
        GVRS.secrets,
        ns,
        secret.metadata.name,
        { data: { [key]: encoded } },
        'merge',
      )
      return { key, encoded }
    },
    onSuccess: ({ key, encoded }) => {
      setSaved((prev) => ({ ...prev, [key]: encoded }))
      setEditingKey(null)
      qc.invalidateQueries({ queryKey: ['k8s', 'secrets'] })
    },
  })

  const copyValue = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    } catch {
      /* clipboard unavailable — nothing to surface */
    }
  }

  return (
    <ResourceDrawer
      resource={{ ...secret, apiVersion: 'v1', kind: 'Secret' }}
      kindLabel="Secret"
      statusBadge={<StatusBadge kind="info">{secret.type ?? 'Opaque'}</StatusBadge>}
      onClose={onClose}
    >
      <DrawerSection
        title="Data"
        actions={<span className="text-xs text-content-subtle">{keys.length} keys</span>}
      >
        <div
          className="mb-3 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200"
          role="note"
        >
          Sensitive material — values stay redacted until you reveal them per key. Revealed values
          are visible on screen and copied to your clipboard in plain text.
        </div>

        {keys.length ? (
          <ul className="divide-y divide-edge-subtle">
            {keys.map((k) => {
              const decoded = b64Decode(data[k])
              const isRevealed = Boolean(revealed[k]) && canReveal
              const editing = editingKey === k
              return (
                <li key={k} className="space-y-2 px-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="font-mono text-xs font-semibold text-content">{k}</code>
                    <div className="flex items-center gap-1.5">
                      {canReveal ? (
                        <Button
                          size="xs"
                          variant={isRevealed ? 'secondary' : 'ghost'}
                          onClick={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}
                          title={isRevealed ? 'Hide the decoded value' : 'Decode and show this value'}
                        >
                          {isRevealed ? 'Hide' : 'Reveal'}
                        </Button>
                      ) : (
                        <K8sRolePill perm="secrets.read" />
                      )}
                      {isRevealed ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => copyValue(k, decoded.ok ? decoded.text : data[k])}
                          title={decoded.ok ? 'Copy decoded value' : 'Copy base64 value (binary content)'}
                        >
                          {copied === k ? 'Copied' : 'Copy'}
                        </Button>
                      ) : null}
                      {canEdit && isRevealed && decoded.ok && !editing ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setEditingKey(k)
                            setDraft(decoded.text)
                          }}
                        >
                          Edit
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {editing ? (
                    <div className="space-y-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
                        className="w-full rounded-lg border border-amber-300 dark:border-amber-500/40 bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-content outline-none focus:ring-2 focus:ring-amber-500/30"
                        aria-label={`Decoded value for ${k}`}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <span className="mr-auto text-[10px] text-content-subtle">
                          Saved re-encoded as base64 via a merge patch.
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setEditingKey(null)}
                          disabled={saveMut.isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          disabled={saveMut.isPending || draft === decoded.text}
                          onClick={() => saveMut.mutate({ key: k, value: draft })}
                        >
                          {saveMut.isPending ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                      {saveMut.isError ? (
                        <p className="text-[11px] text-rose-700 dark:text-rose-300">
                          Error: {(saveMut.error as Error).message}
                        </p>
                      ) : null}
                    </div>
                  ) : isRevealed ? (
                    <pre className="max-h-48 overflow-auto rounded-lg border border-amber-200/60 dark:border-amber-500/20 bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-content">
                      {decoded.ok ? decoded.text : `${data[k]}  (binary — showing base64)`}
                    </pre>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-2 py-1.5">
                      <span className="font-mono text-xs tracking-widest text-content-subtle">
                        ••••••••••••
                      </span>
                      <span className="text-[10px] text-content-subtle">
                        {Math.ceil((data[k].length * 3) / 4)} bytes
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyState compact title="No data keys" />
        )}

        {!canEdit ? (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-content-muted">
            Editing secret values requires <K8sRolePill perm="secrets.write" />
          </p>
        ) : null}
      </DrawerSection>
    </ResourceDrawer>
  )
}
