import { useMemo, useState } from 'react'
import { Button, Checkbox, Field, Input, Modal, Select, useToast } from '@adhar/shell-ui'
import { submitRun } from '../data/api.ts'
import { ALLOWED_RUN_LABELS, buildRun, type CatalogEntry, templateVersion, validateRun } from '../data/catalog.ts'
import { useInvalidateWorkflows, useWorkflowCluster } from '../data/hooks.ts'
import type { Workflow } from '../data/nodes.ts'
import type { ScopeNamespace } from '../data/scope.ts'

/**
 * The run form (design 0026 §6.9), generated from the template's
 * `spec.arguments.parameters`: an `enum` is a select, a `description` is the
 * help text, a parameter read from a ConfigMap/Secret is shown and not
 * editable, and a parameter whose name reads as a secret takes no value.
 * Advanced: allow-listed `adhar.io/*` labels, priority, and a server-side dry
 * run. It states where the run goes and that it runs as `adhar-workflow` —
 * there is no service-account field, and the submit never sets one.
 */

export function RunForm({ entry, namespaces, onClose, onSubmitted }: {
  entry: CatalogEntry
  /** Where a ClusterWorkflowTemplate may be run; a namespaced template runs in its own namespace. */
  namespaces: readonly ScopeNamespace[]
  onClose(): void
  onSubmitted(w: Workflow): void
}) {
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const refresh = useInvalidateWorkflows()
  const fixedNs = entry.kind === 'ClusterWorkflowTemplate' ? undefined : entry.namespace
  const [namespace, setNamespace] = useState(fixedNs ?? namespaces.find((n) => n.role !== 'platform')?.namespace ?? namespaces[0]?.namespace ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [advanced, setAdvanced] = useState(false)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [priority, setPriority] = useState('')
  const [dryRun, setDryRun] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const req = useMemo(() => ({
    entry,
    namespace,
    values,
    labels: Object.fromEntries(Object.entries(labels).filter(([, v]) => v)),
    priority: priority.trim() ? Number(priority) : undefined,
  }), [entry, namespace, values, labels, priority])
  const errors = validateRun(req)
  const blocking = Object.keys(errors).length > 0

  const submit = async () => {
    setBusy(true)
    setServerError(null)
    try {
      const manifest = buildRun(req, await templateVersion(entry))
      const created = await submitRun(manifest, { dryRun, cluster })
      if (dryRun) {
        toast.success('Dry run passed', { description: 'The apiserver and admission policies accepted this run. Nothing was created.' })
        return
      }
      toast.success(`Started ${created.metadata.name}`)
      refresh()
      onSubmitted(created)
    } catch (e) {
      // Admission (Kyverno, RBAC) speaks here: show its words in the form.
      setServerError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={`Run ${entry.title}`}
      description={`${entry.kind}${entry.namespace ? ` · ${entry.namespace}` : ''}${entry.description ? ` — ${entry.description}` : ''}`}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-content-subtle">Runs as <span className="font-mono text-content">adhar-workflow</span> in <span className="font-mono text-content">{namespace || '—'}</span></span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={blocking} loading={busy}>{dryRun ? 'Dry run' : 'Run'}</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Namespace" hint={fixedNs ? 'A WorkflowTemplate runs where it lives' : undefined} error={errors['']}>
          {fixedNs ? (
            <Input value={fixedNs} readOnly aria-label="Namespace" />
          ) : (
            <Select
              aria-label="Namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.currentTarget.value)}
              options={namespaces.map((n) => ({ value: n.namespace, label: n.project ? `${n.namespace} (${n.project}${n.environment ? ` · ${n.environment}` : ''})` : n.namespace }))}
            />
          )}
        </Field>
        {entry.params.length ? (
          <div className="space-y-3">
            {entry.params.map((p) => (
              <Field
                key={p.name}
                label={p.name}
                required={p.required}
                hint={p.fromRef ? 'from the template' : p.value !== undefined ? `default: ${p.value}` : undefined}
                error={errors[p.name]}
              >
                {p.enum ? (
                  <Select
                    aria-label={p.name}
                    value={values[p.name] ?? p.value ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.currentTarget.value }))}
                    options={[...(p.value === undefined ? [{ value: '', label: 'Choose…' }] : []), ...p.enum.map((o) => ({ value: o, label: o }))]}
                  />
                ) : (
                  <Input
                    aria-label={p.name}
                    value={values[p.name] ?? ''}
                    placeholder={p.secretLike ? 'Secrets are read from Kubernetes Secrets, not passed here' : p.value ?? ''}
                    disabled={p.fromRef || p.secretLike}
                    onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.currentTarget.value }))}
                  />
                )}
                {p.description ? <p className="mt-1 text-xs text-content-subtle">{p.description}</p> : null}
              </Field>
            ))}
          </div>
        ) : <p className="text-sm text-content-subtle">This template takes no parameters.</p>}
        <button type="button" className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>
        {advanced ? (
          <div className="space-y-3 rounded-lg border border-edge-subtle p-3">
            {ALLOWED_RUN_LABELS.map((k) => (
              <Field key={k} label={k} error={errors[`label:${k}`]}>
                <Input aria-label={k} value={labels[k] ?? ''} onChange={(e) => setLabels((l) => ({ ...l, [k]: e.currentTarget.value }))} />
              </Field>
            ))}
            <Field label="Priority" hint="higher runs first when the namespace is at its parallelism limit" error={errors.priority}>
              <Input aria-label="Priority" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.currentTarget.value)} />
            </Field>
            <Checkbox checked={dryRun} onChange={(e) => setDryRun(e.currentTarget.checked)} label="Dry run" description="Ask the apiserver and the admission policies; create nothing." />
          </div>
        ) : null}
        {serverError ? <p role="alert" className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{serverError}</p> : null}
      </div>
    </Modal>
  )
}
