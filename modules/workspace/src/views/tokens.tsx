import { useState } from 'react'
import { DataTable, EmptyState, Modal } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  isDbUnavailable,
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  type WsApiToken,
} from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const SCOPE_OPTIONS = [
  'projects:read',
  'projects:write',
  'deployments:read',
  'deployments:write',
  'audit:read',
  'members:read',
]

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
] as const

export function Tokens() {
  const q = useApiTokens()
  const revoke = useRevokeApiToken()
  const [createOpen, setCreateOpen] = useState(false)
  const [minted, setMinted] = useState<{ token: string; item: WsApiToken } | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<WsApiToken | null>(null)

  const all = q.data ?? []
  const expiring = all.filter(
    (t) => t.expiresAt && new Date(t.expiresAt).getTime() - Date.now() < 14 * 24 * 3600_000,
  ).length

  return (
    <ViewShell
      title="API tokens"
      description="Org-scoped tokens for CI runners, CLIs, and service-to-service calls. Only a SHA-256 hash is stored — the secret is shown once."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="tokens.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton onClick={() => setCreateOpen(true)}>
            <IconPlus /> New token
          </PrimaryButton>
        </RequirePermission>
      }
    >
      {q.isError ? (
        <StoreErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Tokens" value={q.isLoading ? '…' : all.length} />
            <StatTile label="Expiring soon" value={expiring} tone={expiring ? 'warn' : 'good'} hint="next 14d" />
            <StatTile
              label="Never expires"
              value={all.filter((t) => !t.expiresAt).length}
              hint="recommend rotation"
            />
            <StatTile
              label="Used (24h)"
              value={
                all.filter(
                  (t) => t.lastUsedAt && Date.now() - new Date(t.lastUsedAt).getTime() < 24 * 3600_000,
                ).length
              }
            />
          </div>

          <SettingsCard title="Tokens">
            {revoke.isError ? (
              <p className="mb-3 text-[12px] text-rose-700 dark:text-rose-400">
                {(revoke.error as Error)?.message}
              </p>
            ) : null}
            <DataTable
              loading={q.isLoading}
              rows={all}
              rowKey={(t) => t.id}
              empty={
                <EmptyState
                  title="No API tokens"
                  description="Generate one to let CI runners or CLIs call the Adhar API."
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  cell: (t) => (
                    <div>
                      <div className="font-medium text-content">{t.name}</div>
                      {t.createdBy ? (
                        <div className="text-[11px] text-content-muted">by {t.createdBy}</div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'prefix',
                  header: 'Token',
                  cell: (t) => (
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                      {t.prefix}…{t.last4 ?? ''}
                    </code>
                  ),
                },
                {
                  key: 'scopes',
                  header: 'Scopes',
                  cell: (t) => (
                    <div className="flex flex-wrap gap-1">
                      {t.scopes.map((s) => (
                        <code
                          key={s}
                          className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                        >
                          {s}
                        </code>
                      ))}
                    </div>
                  ),
                },
                {
                  key: 'lastUsed',
                  header: 'Last used',
                  cell: (t) => (t.lastUsedAt ? formatRelative(t.lastUsedAt) : 'never'),
                },
                {
                  key: 'expires',
                  header: 'Expires',
                  cell: (t) => (t.expiresAt ? formatRelative(t.expiresAt) : 'never'),
                },
                { key: 'created', header: 'Created', cell: (t) => formatRelative(t.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (t) => (
                    <RequirePermission perm="tokens.write" required={['admin', 'owner']} fallback={<span />}>
                      <div className="flex justify-end">
                        <SecondaryButton tone="rose" onClick={() => setPendingRevoke(t)}>
                          Revoke
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

      <CreateTokenModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onMinted={(r) => {
          setCreateOpen(false)
          setMinted(r)
        }}
      />
      <ShowOnceModal minted={minted} onClose={() => setMinted(null)} />
      <ConfirmRevokeModal
        token={pendingRevoke}
        pending={revoke.isPending}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (!pendingRevoke) return
          revoke.mutate(pendingRevoke.id, { onSuccess: () => setPendingRevoke(null) })
        }}
      />
    </ViewShell>
  )
}

/* ─────────────────── create + show-once ─────────────────── */

function CreateTokenModal({
  open,
  onClose,
  onMinted,
}: {
  open: boolean
  onClose(): void
  onMinted(r: { token: string; item: WsApiToken }): void
}) {
  const create = useCreateApiToken()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<string>>(new Set(['projects:read']))
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]['value']>('90')

  const toggleScope = (s: string) =>
    setScopes((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  const submit = () => {
    const expiresAt = expiry === 'never'
      ? undefined
      : new Date(Date.now() + Number(expiry) * 86400_000).toISOString()
    create.mutate(
      { name: name.trim(), scopes: [...scopes], expiresAt },
      {
        onSuccess: (r) => {
          setName('')
          setScopes(new Set(['projects:read']))
          setExpiry('90')
          create.reset()
          onMinted(r)
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      title="New API token"
      description="The secret is minted server-side and stored only as a SHA-256 hash."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!name.trim() || scopes.size === 0 || create.isPending} onClick={submit}>
            {create.isPending ? 'Creating…' : 'Create token'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Name</span>
          <TextField value={name} onChange={setName} placeholder="e.g. ci-deployer" />
        </label>
        <div>
          <span className="mb-1 block text-xs font-medium text-content">Scopes</span>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {SCOPE_OPTIONS.map((s) => {
              const on = scopes.has(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleScope(s)}
                  className={
                    on
                      ? 'flex items-center justify-between rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-left font-mono text-[11px] text-brand-900 dark:border-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                      : 'flex items-center justify-between rounded-lg border border-edge-default bg-surface-raised px-2.5 py-1.5 text-left font-mono text-[11px] text-content-muted hover:bg-surface-sunken'
                  }
                >
                  {s}
                  {on ? <span aria-hidden>✓</span> : null}
                </button>
              )
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Expiry</span>
          <SelectField<(typeof EXPIRY_OPTIONS)[number]['value']>
            value={expiry}
            onChange={setExpiry}
            options={[...EXPIRY_OPTIONS]}
          />
        </label>
        {create.isError ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-400">
            {(create.error as Error)?.message ?? 'Could not create the token.'}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

function ShowOnceModal({
  minted,
  onClose,
}: {
  minted: { token: string; item: WsApiToken } | null
  onClose(): void
}) {
  return (
    <Modal
      open={minted !== null}
      onClose={onClose}
      branded
      title="Copy your new token"
      description="This is the only time the secret is shown. It is stored server-side as a hash only."
      footer={<PrimaryButton onClick={onClose}>I've copied it</PrimaryButton>}
    >
      {minted ? (
        <div className="space-y-3">
          <div className="text-[12px] text-content-muted">
            {minted.item.name} · scopes: {minted.item.scopes.join(', ')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 font-mono text-[12px] text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              {minted.token}
            </code>
            <SecondaryButton onClick={() => navigator.clipboard?.writeText(minted.token)}>
              Copy
            </SecondaryButton>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

function ConfirmRevokeModal({
  token,
  pending,
  onCancel,
  onConfirm,
}: {
  token: WsApiToken | null
  pending: boolean
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={token !== null}
      onClose={onCancel}
      title="Revoke token"
      description="Callers using this token will start failing immediately."
      footer={
        <>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SecondaryButton tone="rose" disabled={pending} onClick={onConfirm}>
            {pending ? 'Revoking…' : 'Revoke'}
          </SecondaryButton>
        </>
      }
    >
      {token ? (
        <p className="text-sm text-content">
          Revoke <span className="font-medium">{token.name}</span> (
          <code className="font-mono text-[12px]">
            {token.prefix}…{token.last4 ?? ''}
          </code>
          )?
        </p>
      ) : null}
    </Modal>
  )
}

/** DB-unavailable / fetch-error state — no fake data, ever. */
function StoreErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="API tokens persist to Postgres. Set DATABASE_URL for the console server to enable them — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load tokens"
      description={(error as Error)?.message ?? 'Unexpected error.'}
      action={<SecondaryButton onClick={retry}>Retry</SecondaryButton>}
    />
  )
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default Tokens
