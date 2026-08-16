import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { k8s } from '@adhar-console/api-clients'
import { formatRelative } from '@adhar-console/utils'
import {
  FRAMEWORK_PRESETS,
  presetToFramework,
  useComplianceDoc,
  useSaveCompliance,
  type ComplianceDoc,
  type ComplianceFrameworkConfig,
  type CompliancePosture,
} from '../data/security.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const POSTURE_KIND: Record<CompliancePosture, StatusKind> = {
  certified: 'healthy',
  'in-progress': 'progressing',
  'not-started': 'unknown',
}
const POSTURE_LABEL: Record<CompliancePosture, string> = {
  certified: 'Certified (self-attested)',
  'in-progress': 'In progress',
  'not-started': 'Not started',
}

/* ─────────── live Kyverno signal (real cluster query) ─────────── */

const kube = k8s.K8sClient.auto()

interface PolicySignal {
  policies: number
  enforce: number
  audit: number
  reportPass: number
  reportFail: number
}

function usePolicySignal() {
  return useQuery<PolicySignal>({
    queryKey: ['ws-security', 'kyverno-signal'],
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const policies = await kube.listGeneric(undefined, {
        group: 'kyverno.io',
        version: 'v1',
        resource: 'clusterpolicies',
        namespaced: false,
      })
      let enforce = 0
      for (const p of policies) {
        if ((p.spec as { validationFailureAction?: string } | undefined)?.validationFailureAction === 'Enforce') {
          enforce++
        }
      }
      let reportPass = 0
      let reportFail = 0
      try {
        const reports = await kube.listGeneric(undefined, {
          group: 'wgpolicyk8s.io',
          version: 'v1alpha2',
          resource: 'clusterpolicyreports',
          namespaced: false,
        })
        for (const r of reports) {
          const summary = (r as unknown as { summary?: { pass?: number; fail?: number } }).summary
          reportPass += summary?.pass ?? 0
          reportFail += summary?.fail ?? 0
        }
      } catch {
        // Reports CRD absent — policies signal alone is still real.
      }
      return { policies: policies.length, enforce, audit: policies.length - enforce, reportPass, reportFail }
    },
  })
}

/* ─────────── view ─────────── */

export function Compliance() {
  const q = useComplianceDoc()
  const save = useSaveCompliance()
  const signal = usePolicySignal()
  const [addId, setAddId] = useState('')

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
        <LoadingBlock label="Loading compliance posture…" />
      </Shell>
    )
  }

  const doc = q.data.doc
  const frameworks = doc.frameworks
  const certified = frameworks.filter((f) => f.posture === 'certified').length
  const evidenceTotal = frameworks.reduce((s, f) => s + f.evidence.length, 0)
  const evidenceDone = frameworks.reduce((s, f) => s + f.evidence.filter((e) => e.done).length, 0)

  const persist = (next: ComplianceDoc) => save.mutate(next)
  const updateFramework = (fw: ComplianceFrameworkConfig) =>
    persist({ frameworks: frameworks.map((f) => (f.id === fw.id ? fw : f)) })
  const removeFramework = (id: string) =>
    persist({ frameworks: frameworks.filter((f) => f.id !== id) })
  const addFramework = () => {
    const preset = FRAMEWORK_PRESETS.find((p) => p.id === addId)
    if (!preset || frameworks.some((f) => f.id === preset.id)) return
    persist({ frameworks: [...frameworks, presetToFramework(preset)] })
    setAddId('')
  }

  const available = FRAMEWORK_PRESETS.filter((p) => !frameworks.some((f) => f.id === p.id))

  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Frameworks tracked" value={frameworks.length} />
        <StatTile label="Certified" value={certified} hint="self-attested" tone={certified ? 'good' : 'default'} />
        <StatTile
          label="Evidence checklist"
          value={evidenceTotal ? `${evidenceDone}/${evidenceTotal}` : '—'}
          hint="items you marked done"
          tone={evidenceTotal && evidenceDone === evidenceTotal ? 'good' : 'default'}
        />
        <StatTile
          label="Policy engine"
          value={signal.isSuccess ? `${signal.data.policies} policies` : 'Not connected'}
          tone={signal.isSuccess ? 'good' : 'default'}
          hint={signal.isSuccess ? 'live from the cluster' : 'cluster unreachable'}
        />
      </div>

      <SettingsCard
        title="Cluster policy signal (Kyverno)"
        description="The only live compliance evidence the console can verify itself — read directly from the cluster's Kyverno ClusterPolicies and PolicyReports. Everything else on this page is recorded posture, clearly labeled self-attested."
        actions={
          <a
            href="/deliver?section=policy"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
          >
            <IconExternal /> Open Deliver → Policy
          </a>
        }
      >
        {signal.isLoading ? (
          <div className="text-sm text-content-muted">Querying the cluster…</div>
        ) : signal.isError ? (
          <div className="flex items-center gap-2 text-sm text-content-muted">
            <StatusBadge kind="unknown">not connected</StatusBadge>
            The cluster policy engine is unreachable from this console — no compliance signal is
            available (nothing is assumed passing).
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="ClusterPolicies" value={signal.data.policies} />
            <StatTile label="Enforce mode" value={signal.data.enforce} hint={`${signal.data.audit} audit`} />
            <StatTile label="Checks passing" value={signal.data.reportPass} tone="good" />
            <StatTile
              label="Checks failing"
              value={signal.data.reportFail}
              tone={signal.data.reportFail ? 'warn' : 'good'}
            />
          </div>
        )}
      </SettingsCard>

      <RequirePermission perm="compliance.write" required={['security', 'owner']} readOnly>
        <SettingsCard
          title="Track a framework"
          description="Adds a posture record with a starter evidence checklist — nothing is pre-checked or pre-certified."
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-64">
              <SelectField<string>
                value={addId}
                onChange={setAddId}
                options={[
                  { value: '', label: available.length ? 'Choose a framework…' : 'All presets tracked' },
                  ...available.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
            <PrimaryButton disabled={!addId || save.isPending} onClick={addFramework}>
              <IconPlus /> Track
            </PrimaryButton>
          </div>
        </SettingsCard>
      </RequirePermission>

      {frameworks.length === 0 ? (
        <SettingsCard title="Frameworks">
          <div className="text-sm text-content-muted">
            No frameworks tracked yet. Posture on this page is recorded by your team — the console
            never fabricates a compliance status.
          </div>
        </SettingsCard>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {frameworks.map((fw) => (
            <FrameworkCard
              key={fw.id}
              fw={fw}
              onChange={updateFramework}
              onRemove={() => removeFramework(fw.id)}
            />
          ))}
        </div>
      )}

      {save.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the compliance record.'}
        </p>
      ) : null}
      {q.data.saved && q.data.updatedAt ? (
        <p className="text-[11px] text-content-subtle">
          Last updated {formatRelative(q.data.updatedAt)} — stored in the tenant document store.
        </p>
      ) : null}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="Compliance"
      description="Recorded compliance posture and evidence checklists, persisted per tenant. Live signals come only from systems the console can actually read (Kyverno); everything self-reported is labeled as such."
      required={['security', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

/* ─────────── framework card ─────────── */

function FrameworkCard({
  fw,
  onChange,
  onRemove,
}: {
  fw: ComplianceFrameworkConfig
  onChange(next: ComplianceFrameworkConfig): void
  onRemove(): void
}) {
  const done = fw.evidence.filter((e) => e.done).length
  const pct = fw.evidence.length ? Math.round((done / fw.evidence.length) * 100) : 0

  return (
    <SettingsCard
      title={fw.name}
      actions={<StatusBadge kind={POSTURE_KIND[fw.posture]}>{POSTURE_LABEL[fw.posture]}</StatusBadge>}
    >
      <div className="space-y-3">
        <RequirePermission perm="compliance.write" required={['security', 'owner']} readOnly>
          <SelectField<CompliancePosture>
            value={fw.posture}
            onChange={(v) => onChange({ ...fw, posture: v })}
            options={[
              { value: 'not-started', label: 'Not started' },
              { value: 'in-progress', label: 'In progress' },
              { value: 'certified', label: 'Certified (self-attested)' },
            ]}
          />
        </RequirePermission>

        <div>
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="text-content-muted">Evidence checklist</span>
            <span className="font-mono tabular-nums text-content">
              {done} / {fw.evidence.length}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full rounded-full bg-brand-500 transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 space-y-1.5">
            {fw.evidence.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-[12px] text-content-muted transition-colors hover:bg-surface-sunken/60"
              >
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() =>
                    onChange({
                      ...fw,
                      evidence: fw.evidence.map((e) =>
                        e.id === item.id ? { ...e, done: !e.done } : e,
                      ),
                    })
                  }
                  className="mt-0.5 h-3.5 w-3.5 accent-brand-600"
                />
                <span className={item.done ? 'text-content line-through opacity-70' : ''}>
                  {item.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-content-subtle">
              Report URL (externally hosted)
            </span>
            <TextField
              mono
              type="url"
              value={fw.reportUrl ?? ''}
              onChange={(v) => onChange({ ...fw, reportUrl: v || undefined })}
              placeholder="https://trust.example.com/soc2"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-2">
          {fw.reportUrl ? (
            <a
              href={fw.reportUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12px] font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
            >
              <IconExternal /> Report
            </a>
          ) : (
            <span className="text-[11px] text-content-subtle">No report linked</span>
          )}
          <RequirePermission perm="compliance.write" required={['security', 'owner']} readOnly>
            <SecondaryButton tone="rose" onClick={onRemove}>
              Untrack
            </SecondaryButton>
          </RequirePermission>
        </div>
      </div>
    </SettingsCard>
  )
}

function IconExternal() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
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

export default Compliance
