import { StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  useFeatureFlags,
  useSaveFeatureFlag,
  type FeatureFlagState,
} from '../data/preferences.ts'
import {
  SettingsCard,
  StatTile,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

/**
 * Feature previews — org-level opt-ins for console capabilities that are
 * still in beta or experimental. The catalog is fixed in code; only the
 * per-org enabled state persists (singleton `workspace.feature-flags` doc).
 * Toggles save immediately.
 */
export function FeatureFlags() {
  const q = useFeatureFlags()

  if (q.isError) {
    return (
      <Shell>
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      </Shell>
    )
  }
  if (q.isLoading || !q.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading feature previews…" />
      </Shell>
    )
  }

  const { flags, saved, updatedAt } = q.data
  const enabled = flags.filter((f) => f.enabled).length

  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Enabled"
          value={`${enabled}/${flags.length}`}
          tone={enabled > 0 ? 'good' : 'default'}
          hint="preview capabilities"
        />
        <StatTile label="Beta" value={flags.filter((f) => f.stage === 'beta').length} hint="in catalog" />
        <StatTile
          label="Experimental"
          value={flags.filter((f) => f.stage === 'experimental').length}
          hint="in catalog"
        />
        <StatTile
          label="Choices"
          value={saved ? 'Saved' : 'Defaults'}
          tone={saved ? 'good' : 'default'}
          hint={saved && updatedAt ? `updated ${formatRelative(updatedAt)}` : 'nothing opted in yet'}
        />
      </div>

      <RequirePermission perm="org.write" required={['admin', 'owner']} readOnly>
        <FlagList flags={flags} />
      </RequirePermission>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="Feature previews"
      description="Opt this organization into console capabilities that are still maturing. Toggles persist immediately and modules read them at load — flip one off to roll the whole org back instantly."
      required={['admin', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

function FlagList({ flags }: { flags: FeatureFlagState[] }) {
  const save = useSaveFeatureFlag()

  return (
    <>
      <SettingsCard
        title="Preview catalog"
        description="Experimental features may change or be removed without a deprecation window; beta features are on a path to general availability."
      >
        <div className="space-y-2">
          {flags.map((f) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-content">{f.name}</span>
                  <StatusBadge kind={f.stage === 'beta' ? 'info' : 'paused'}>
                    {f.stage}
                  </StatusBadge>
                  <StatusBadge kind={f.enabled ? 'healthy' : 'unknown'}>
                    {f.enabled ? 'enabled' : 'off'}
                  </StatusBadge>
                </div>
                <p className="mt-0.5 max-w-xl text-[12px] text-content-muted">{f.description}</p>
                <p className="mt-1 font-mono text-[10.5px] text-content-subtle">{f.id}</p>
              </div>
              <ToggleField
                checked={f.enabled}
                disabled={save.isPending && save.variables?.id === f.id}
                onChange={(v) => save.mutate({ id: f.id, enabled: v })}
                label={f.enabled ? 'On' : 'Off'}
              />
            </div>
          ))}
        </div>
      </SettingsCard>

      {save.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the feature toggle.'}
        </p>
      ) : null}
    </>
  )
}

export default FeatureFlags
