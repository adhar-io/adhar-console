import { useEffect, useState } from 'react'
import { formatRelative } from '@adhar-console/utils'
import {
  DEFAULT_CLOUDS,
  isValidLabelKey,
  isValidNamespacePrefix,
  isValidQuantity,
  useSaveWorkspaceDefaults,
  useWorkspaceDefaults,
  type DefaultCloud,
  type DefaultLabel,
  type DefaultsDoc,
} from '../data/preferences.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const ENVIRONMENTS = ['dev', 'staging', 'prod', 'preview'] as const

/**
 * Resource defaults — org-wide values new projects, apps, and environments
 * inherit at creation time: namespace prefix, environment, cloud/region,
 * container requests/limits, and platform-stamped labels. Singleton
 * `workspace.defaults` doc.
 */
export function WorkspaceDefaults() {
  const q = useWorkspaceDefaults()

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
        <LoadingBlock label="Loading resource defaults…" />
      </Shell>
    )
  }

  const { doc, saved, updatedAt } = q.data
  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Environment" value={doc.defaultEnvironment} hint="new projects start in" />
        <StatTile
          label="Cloud"
          value={DEFAULT_CLOUDS.find((c) => c.value === doc.defaultCloud)?.label ?? doc.defaultCloud}
          hint={doc.defaultRegion || 'no region set'}
        />
        <StatTile
          label="CPU"
          value={`${doc.resources.cpuRequest} / ${doc.resources.cpuLimit}`}
          hint="request / limit"
        />
        <StatTile
          label="Defaults"
          value={saved ? 'Saved' : 'Platform'}
          tone={saved ? 'good' : 'default'}
          hint={saved && updatedAt ? `updated ${formatRelative(updatedAt)}` : 'not saved yet'}
        />
      </div>

      {!saved ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Showing platform defaults — this tenant has not saved its own resource defaults yet.
        </p>
      ) : null}

      <RequirePermission perm="org.write" required={['admin', 'owner']} readOnly>
        <Editor doc={doc} />
      </RequirePermission>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="Resource defaults"
      description="What new resources inherit at creation time. Existing projects and environments are not rewritten — these values apply from the next resource onward."
      required={['admin', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

function Editor({ doc }: { doc: DefaultsDoc }) {
  const save = useSaveWorkspaceDefaults()
  const [namespacePrefix, setNamespacePrefix] = useState(doc.namespacePrefix)
  const [defaultEnvironment, setDefaultEnvironment] = useState(doc.defaultEnvironment)
  const [defaultCloud, setDefaultCloud] = useState<DefaultCloud>(doc.defaultCloud)
  const [defaultRegion, setDefaultRegion] = useState(doc.defaultRegion)
  const [resources, setResources] = useState(doc.resources)
  const [labels, setLabels] = useState<DefaultLabel[]>(doc.labels)

  useEffect(() => {
    setNamespacePrefix(doc.namespacePrefix)
    setDefaultEnvironment(doc.defaultEnvironment)
    setDefaultCloud(doc.defaultCloud)
    setDefaultRegion(doc.defaultRegion)
    setResources(doc.resources)
    setLabels(doc.labels)
  }, [doc])

  const next: DefaultsDoc = {
    namespacePrefix,
    defaultEnvironment,
    defaultCloud,
    defaultRegion,
    resources,
    labels,
  }
  const dirty = JSON.stringify(next) !== JSON.stringify(doc)

  const prefixInvalid = !isValidNamespacePrefix(namespacePrefix.replace(/-$/, ''))
  const quantityInvalid = (Object.keys(resources) as (keyof typeof resources)[]).some(
    (k) => !isValidQuantity(resources[k]),
  )
  const labelsInvalid = labels.some(
    (l) => !isValidLabelKey(l.key) || l.value.trim().length > 63,
  )
  const invalid = prefixInvalid || quantityInvalid || labelsInvalid

  const saveBar = (
    <div className="flex items-center gap-2">
      <SecondaryButton
        disabled={!dirty || save.isPending}
        onClick={() => {
          setNamespacePrefix(doc.namespacePrefix)
          setDefaultEnvironment(doc.defaultEnvironment)
          setDefaultCloud(doc.defaultCloud)
          setDefaultRegion(doc.defaultRegion)
          setResources(doc.resources)
          setLabels(doc.labels)
        }}
      >
        Reset
      </SecondaryButton>
      <PrimaryButton
        disabled={!dirty || invalid || save.isPending}
        onClick={() => save.mutate(next)}
      >
        {save.isPending ? 'Saving…' : 'Save defaults'}
      </PrimaryButton>
    </div>
  )

  return (
    <>
      <SettingsCard
        title="Naming & placement"
        description="Where new workloads land and how their namespaces are named."
        actions={saveBar}
      >
        <SettingsRow
          label="Namespace prefix"
          description="Prepended to generated namespaces. Lowercase DNS-label characters only."
          hint={`Example: ${namespacePrefix || ''}checkout-service`}
        >
          <TextField
            mono
            value={namespacePrefix}
            onChange={setNamespacePrefix}
            placeholder="app-"
          />
          {prefixInvalid ? (
            <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
              Lowercase letters, digits, and hyphens only.
            </p>
          ) : null}
        </SettingsRow>
        <SettingsRow
          label="Default environment"
          description="New projects get this environment first."
        >
          <SelectField
            value={defaultEnvironment}
            onChange={setDefaultEnvironment}
            options={ENVIRONMENTS.map((e) => ({ value: e as string, label: e }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Default cloud"
          description="Pre-selected provider when a new environment or cluster is requested."
        >
          <SelectField<DefaultCloud>
            value={defaultCloud}
            onChange={setDefaultCloud}
            options={DEFAULT_CLOUDS}
          />
        </SettingsRow>
        <SettingsRow
          label="Default region"
          description="Provider region id. Leave empty to force an explicit choice per resource."
        >
          <TextField
            mono
            value={defaultRegion}
            onChange={setDefaultRegion}
            placeholder="us-east-1"
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Container requests & limits"
        description="Applied to workloads that don't declare their own. Kubernetes quantities — 250m, 1, 512Mi, 2Gi."
      >
        <SettingsRow label="CPU request">
          <QuantityField
            value={resources.cpuRequest}
            onChange={(v) => setResources((r) => ({ ...r, cpuRequest: v }))}
            placeholder="100m"
          />
        </SettingsRow>
        <SettingsRow label="CPU limit">
          <QuantityField
            value={resources.cpuLimit}
            onChange={(v) => setResources((r) => ({ ...r, cpuLimit: v }))}
            placeholder="500m"
          />
        </SettingsRow>
        <SettingsRow label="Memory request">
          <QuantityField
            value={resources.memoryRequest}
            onChange={(v) => setResources((r) => ({ ...r, memoryRequest: v }))}
            placeholder="128Mi"
          />
        </SettingsRow>
        <SettingsRow label="Memory limit">
          <QuantityField
            value={resources.memoryLimit}
            onChange={(v) => setResources((r) => ({ ...r, memoryLimit: v }))}
            placeholder="512Mi"
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Default labels"
        description="Stamped on every resource the platform creates — useful for cost allocation and policy selectors."
        actions={
          <SecondaryButton onClick={() => setLabels((ls) => [...ls, { key: '', value: '' }])}>
            Add label
          </SecondaryButton>
        }
      >
        {labels.length === 0 ? (
          <p className="text-sm text-content-muted">
            No default labels. Add one to have it applied to every new resource.
          </p>
        ) : (
          <div className="space-y-2">
            {labels.map((l, i) => {
              const keyBad = l.key !== '' && !isValidLabelKey(l.key)
              const valueBad = l.value.trim().length > 63
              return (
                <div key={i} className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <TextField
                      mono
                      value={l.key}
                      onChange={(v) =>
                        setLabels((ls) => ls.map((x, j) => (j === i ? { ...x, key: v } : x)))
                      }
                      placeholder="team"
                    />
                    {keyBad ? (
                      <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
                        Invalid label key (optional prefix/ + alphanumeric name).
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <TextField
                      mono
                      value={l.value}
                      onChange={(v) =>
                        setLabels((ls) => ls.map((x, j) => (j === i ? { ...x, value: v } : x)))
                      }
                      placeholder="platform"
                    />
                    {valueBad ? (
                      <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
                        Values are limited to 63 characters.
                      </p>
                    ) : null}
                  </div>
                  <SecondaryButton
                    tone="rose"
                    onClick={() => setLabels((ls) => ls.filter((_, j) => j !== i))}
                  >
                    Remove
                  </SecondaryButton>
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>

      {save.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the resource defaults.'}
        </p>
      ) : null}
      {save.isSuccess && !dirty ? (
        <p className="text-[12px] text-emerald-700 dark:text-emerald-400">Defaults saved.</p>
      ) : null}
    </>
  )
}

function QuantityField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange(v: string): void
  placeholder: string
}) {
  const bad = !isValidQuantity(value)
  return (
    <div>
      <TextField mono value={value} onChange={onChange} placeholder={placeholder} />
      {bad ? (
        <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
          Not a valid Kubernetes quantity.
        </p>
      ) : null}
    </div>
  )
}

export default WorkspaceDefaults
