import { useMemo, useState } from 'react'
import { DataTable, EmptyState, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import {
  CLOUD_BY_ID,
  CLOUD_CATALOG,
  CLOUD_TONE_CHIP,
  CLOUD_TONE_TILE,
  useAddConnection,
  useCloudConnections,
  useCloudMappings,
  useRemoveConnection,
  useUpdateMapping,
  type CloudConnection,
  type CloudProvider,
  type CloudProviderId,
  type EnvKind,
  type EnvironmentMapping,
} from '../data/clouds.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'
import { fmtMoney } from '../data/billing.ts'

const STATUS_KIND: Record<CloudConnection['status'], StatusKind> = {
  connected: 'healthy',
  pending: 'progressing',
  paused: 'paused',
  error: 'failed',
}

const ENV_ORDER: EnvKind[] = ['production', 'staging', 'preview', 'dev']
const ENV_LABEL: Record<EnvKind, string> = {
  production: 'Production',
  staging: 'Staging',
  preview: 'Preview',
  dev: 'Development',
}
const ENV_TONE: Record<EnvKind, 'rose' | 'amber' | 'sky' | 'emerald'> = {
  production: 'rose',
  staging: 'amber',
  preview: 'sky',
  dev: 'emerald',
}

export function CloudProviders() {
  const conns = useCloudConnections()
  const maps = useCloudMappings()
  const update = useUpdateMapping()
  const remove = useRemoveConnection()
  const [adding, setAdding] = useState(false)

  const allConns = conns.data ?? []
  const allMaps = maps.data ?? []
  const usedProviders = new Set(allConns.map((c) => c.providerId))
  const totalSpend = allConns.reduce((s, c) => s + c.monthlySpend, 0)
  const dual = useMemo(() => isDualMode(allMaps, allConns), [allMaps, allConns])
  const storeError = (conns.error ?? maps.error) as Error | null

  return (
    <ViewShell
      title="Cloud providers"
      description="Connect any combination of clouds and decide per-environment which one runs the workload. Run a fully-on-AWS estate, or split production on GCP and non-prod on Civo — Adhar handles the abstraction."
      required={['admin', 'security', 'owner']}
      actions={
        <RequirePermission perm="integrations.write" required={['admin', 'security', 'owner']} readOnly>
          <PrimaryButton onClick={() => setAdding(true)}>
            <IconPlus /> Connect cloud
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Connections" value={allConns.length} />
        <StatTile
          label="Providers"
          value={usedProviders.size}
          hint={[...usedProviders].map((p) => CLOUD_BY_ID[p].shortName).join(' · ')}
        />
        <StatTile
          label="Mode"
          value={dual ? 'Dual-cloud' : allConns.length ? 'Single-cloud' : '—'}
          tone={dual ? 'good' : 'default'}
          hint={dual ? 'prod ≠ non-prod cloud' : 'prod & non-prod share cloud'}
        />
        <StatTile
          label="Monthly spend"
          value={fmtMoney(totalSpend)}
          hint="as reported by cost ingestion"
        />
      </div>

      {storeError ? (
        <StoreErrorBlock
          error={storeError}
          onRetry={() => {
            conns.refetch()
            maps.refetch()
          }}
        />
      ) : null}

      {adding ? <AddConnectionForm onClose={() => setAdding(false)} /> : null}

      <SettingsCard
        title="Catalog"
        description="Adhar abstracts these via Crossplane compositions. Connect what you need; mix and match without lock-in."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {CLOUD_CATALOG.map((c) => (
            <CloudTile
              key={c.id}
              cloud={c}
              connectionCount={allConns.filter((x) => x.providerId === c.id).length}
              onConnect={() => setAdding(true)}
            />
          ))}
        </div>
      </SettingsCard>

      {storeError ? null : (
      <>
      <SettingsCard
        title="Environment → cloud mapping"
        description="Drives Crossplane provisioning and Argo CD destination clusters. Switching production providers is gated by the destructive-RBAC approval policy."
      >
        {maps.isLoading || conns.isLoading ? (
          <LoadingBlock label="Loading environment mappings…" />
        ) : allConns.length === 0 ? (
          <EmptyState
            compact
            title="No clouds connected yet"
            description="Environments can be mapped once at least one cloud connection is recorded above."
          />
        ) : (
          <div className="space-y-3">
            {ENV_ORDER.map((env) => {
              const mapping = allMaps.find((m) => m.env === env)
              return (
                <EnvMappingRow
                  key={env}
                  env={env}
                  mapping={mapping}
                  connections={allConns}
                  onChange={(next) => update.mutate(next)}
                />
              )
            })}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Connections"
        description="Recorded configuration — a connection stays pending until the platform verifies its credentials; the console never marks one connected on its own."
      >
        <DataTable
          loading={conns.isLoading}
          rows={allConns}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              title="No clouds connected"
              description="Pick a provider above to get started — nothing is pre-connected."
            />
          }
          columns={[
            {
              key: 'cloud',
              header: 'Provider',
              cell: (c) => {
                const cloud = CLOUD_BY_ID[c.providerId]
                return (
                  <div className="flex items-center gap-2.5">
                    <CloudIcon cloud={cloud} size="sm" />
                    <div>
                      <div className="font-medium text-content">{c.label}</div>
                      <code className="font-mono text-[11px] text-content-muted">
                        {cloud.shortName} · {c.region}
                      </code>
                    </div>
                  </div>
                )
              },
            },
            {
              key: 'account',
              header: 'Account',
              cell: (c) => (
                <code className="font-mono text-[11px] text-content-muted">{c.accountId}</code>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (c) => <StatusBadge kind={STATUS_KIND[c.status]}>{c.status}</StatusBadge>,
            },
            { key: 'clusters', header: 'Clusters', cell: (c) => c.clusters.length, numeric: true },
            {
              key: 'spend',
              header: 'Monthly',
              cell: (c) => (
                <span className="font-mono tabular-nums">{fmtMoney(c.monthlySpend)}</span>
              ),
              numeric: true,
            },
            {
              key: 'last',
              header: 'Credential check',
              cell: (c) => (c.lastCheckedAt ? formatRelative(c.lastCheckedAt) : 'not yet run'),
            },
            { key: 'owner', header: 'Owner', cell: (c) => c.ownerEmail },
            {
              key: 'actions',
              header: '',
              cell: (c) => (
                <RequirePermission
                  perm="integrations.write"
                  required={['admin', 'security', 'owner']}
                  readOnly
                >
                  <div className="flex justify-end gap-1.5">
                    <SecondaryButton
                      tone="rose"
                      disabled={remove.isPending && remove.variables === c.id}
                      onClick={() => remove.mutate(c.id)}
                    >
                      Remove
                    </SecondaryButton>
                  </div>
                </RequirePermission>
              ),
            },
          ]}
        />
      </SettingsCard>
      </>
      )}
    </ViewShell>
  )
}

/* ─────────── catalog tile ─────────── */

function CloudTile({
  cloud,
  connectionCount,
  onConnect,
}: {
  cloud: CloudProvider
  connectionCount: number
  onConnect(): void
}) {
  return (
    <div
      className={cn(
        'group flex h-full flex-col gap-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm transition-colors hover:border-brand-300',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <CloudIcon cloud={cloud} size="md" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-content">{cloud.name}</div>
            <code className="font-mono text-[11px] text-content-muted">
              {cloud.k8sService} · {cloud.regions.length === 1 ? cloud.regions[0] : `${cloud.regions.length} regions`}
            </code>
          </div>
        </div>
        {connectionCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {connectionCount}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-[12px] leading-relaxed text-content-muted">
        {cloud.description}
      </p>
      <div className="flex flex-wrap gap-1">
        {cloud.bestFor.slice(0, 3).map((b) => (
          <span
            key={b}
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset',
              CLOUD_TONE_CHIP[cloud.tone],
            )}
          >
            {b}
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-end pt-1">
        {connectionCount > 0 ? (
          <SecondaryButton onClick={onConnect}>
            <IconPlus /> Add region
          </SecondaryButton>
        ) : (
          <SecondaryButton onClick={onConnect}>Connect</SecondaryButton>
        )}
      </div>
    </div>
  )
}

function CloudIcon({ cloud, size }: { cloud: CloudProvider; size: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 32 : 44
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl text-sm font-semibold shadow-sm ring-1',
        CLOUD_TONE_TILE[cloud.tone],
      )}
      style={{ width: dim, height: dim }}
    >
      {cloud.shortName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase()}
    </span>
  )
}

/* ─────────── per-environment mapping row ─────────── */

function EnvMappingRow({
  env,
  mapping,
  connections,
  onChange,
}: {
  env: EnvKind
  mapping?: EnvironmentMapping
  connections: CloudConnection[]
  onChange(next: EnvironmentMapping): void
}) {
  const tone = ENV_TONE[env]
  const m: EnvironmentMapping = mapping ?? {
    env,
    connectionId: connections[0]?.id ?? '',
    capacity: 'small',
    flags: { blockProdSecrets: env !== 'production', directKubectl: env !== 'production' },
  }
  const conn = connections.find((c) => c.id === m.connectionId)
  const cloud = conn ? CLOUD_BY_ID[conn.providerId] : undefined

  return (
    <div className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-lg text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset',
              CLOUD_TONE_CHIP[tone],
            )}
          >
            {env.slice(0, 3)}
          </span>
          <div>
            <div className="text-sm font-semibold text-content">{ENV_LABEL[env]}</div>
            <div className="text-[11px] text-content-muted">
              {cloud
                ? `Running on ${cloud.shortName} · ${conn?.region ?? '—'}`
                : 'Not yet mapped'}
            </div>
          </div>
        </div>
        {cloud ? <CloudIcon cloud={cloud} size="sm" /> : null}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FieldShell label="Cloud connection">
          <SelectField<string>
            value={m.connectionId}
            onChange={(v) => onChange({ ...m, connectionId: v })}
            options={connections.map((c) => ({
              value: c.id,
              label: `${CLOUD_BY_ID[c.providerId].shortName} — ${c.label}`,
            }))}
          />
        </FieldShell>
        <FieldShell label="Failover (DR)">
          <SelectField<string>
            value={m.failoverConnectionId ?? ''}
            onChange={(v) => onChange({ ...m, failoverConnectionId: v || undefined })}
            options={[
              { value: '', label: 'None' },
              ...connections
                .filter((c) => c.id !== m.connectionId)
                .map((c) => ({
                  value: c.id,
                  label: `${CLOUD_BY_ID[c.providerId].shortName} — ${c.label}`,
                })),
            ]}
          />
        </FieldShell>
        <FieldShell label="Capacity">
          <SelectField<'small' | 'medium' | 'large'>
            value={m.capacity}
            onChange={(v) => onChange({ ...m, capacity: v })}
            options={[
              { value: 'small', label: 'Small (3-5 nodes)' },
              { value: 'medium', label: 'Medium (6-12 nodes)' },
              { value: 'large', label: 'Large (12+ nodes)' },
            ]}
          />
        </FieldShell>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ToggleField
          checked={m.flags.blockProdSecrets}
          onChange={(v) => onChange({ ...m, flags: { ...m.flags, blockProdSecrets: v } })}
          label="Block prod-tagged secrets"
          description="Refuse manifests referencing secrets labeled production."
        />
        <ToggleField
          checked={m.flags.directKubectl}
          onChange={(v) => onChange({ ...m, flags: { ...m.flags, directKubectl: v } })}
          label="Allow direct kubectl"
          description="Off in production by default — go via the Platform UI."
        />
      </div>
    </div>
  )
}

/* ─────────── add-connection form ─────────── */

function AddConnectionForm({ onClose }: { onClose(): void }) {
  const add = useAddConnection()
  const [providerId, setProviderId] = useState<CloudProviderId>('aws')
  const cloud = CLOUD_BY_ID[providerId]
  const [label, setLabel] = useState('')
  const [region, setRegion] = useState(cloud.regions[0])
  const [accountId, setAccountId] = useState('')
  const [owner, setOwner] = useState('')

  return (
    <SettingsCard title="Connect a new cloud">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FieldShell label="Provider">
          <SelectField<CloudProviderId>
            value={providerId}
            onChange={(id) => {
              setProviderId(id)
              setRegion(CLOUD_BY_ID[id].regions[0])
            }}
            options={CLOUD_CATALOG.map((c) => ({ value: c.id, label: `${c.shortName} — ${c.name}` }))}
          />
        </FieldShell>
        <FieldShell label="Region">
          <SelectField<string>
            value={region}
            onChange={setRegion}
            options={cloud.regions.map((r) => ({ value: r, label: r }))}
          />
        </FieldShell>
        <FieldShell label="Label" hint="Shown in pickers and audit logs.">
          <TextField value={label} onChange={setLabel} placeholder={`${cloud.shortName} — ${region}`} />
        </FieldShell>
        <FieldShell label="Account / project ID">
          <TextField mono value={accountId} onChange={setAccountId} placeholder="e.g. 123456789012" />
        </FieldShell>
        <FieldShell label="Owner email">
          <TextField type="email" value={owner} onChange={setOwner} placeholder="ops@acme.com" />
        </FieldShell>
        <FieldShell label="Auth modality" hint={`This cloud uses ${cloud.auth}.`}>
          <TextField mono readOnly value={cloud.auth} />
        </FieldShell>
      </div>
      {add.isError ? (
        <p className="mt-3 text-[12px] text-rose-700 dark:text-rose-400">
          {(add.error as Error)?.message ?? 'Could not save the connection.'}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-content-subtle">
          Saved as <span className="font-semibold">pending</span> until the platform verifies the
          credentials.
        </span>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!label || !accountId || !owner || add.isPending}
          onClick={() => {
            add.mutate(
              {
                providerId,
                label: label || `${cloud.shortName} — ${region}`,
                region,
                accountId,
                ownerEmail: owner,
              },
              { onSuccess: onClose },
            )
          }}
        >
          {add.isPending ? 'Saving…' : 'Save connection'}
        </PrimaryButton>
      </div>
    </SettingsCard>
  )
}

function FieldShell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] text-content-subtle">{hint}</span> : null}
    </label>
  )
}

function isDualMode(maps: EnvironmentMapping[], conns: CloudConnection[]): boolean {
  const prod = maps.find((m) => m.env === 'production')
  const others = maps.filter((m) => m.env !== 'production')
  if (!prod || !others.length) return false
  const prodCloud = conns.find((c) => c.id === prod.connectionId)?.providerId
  return others.some((m) => {
    const c = conns.find((x) => x.id === m.connectionId)?.providerId
    return c && prodCloud && c !== prodCloud
  })
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default CloudProviders
