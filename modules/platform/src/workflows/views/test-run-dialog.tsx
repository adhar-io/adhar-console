import { useMemo, useState } from 'react'
import { Button, Checkbox, Field, Input, Modal, Select } from '@adhar/shell-ui'
import { testRunDraft, type TestRunResult } from '../data/api.ts'
import { prepareTestRun, testRunTargets } from '../data/drafts.ts'
import { useWorkflowCluster } from '../data/hooks.ts'
import type { ScopeNamespace } from '../data/scope.ts'
import type { DesignerParam } from '../model/project.ts'
import { looksSecret } from '../model/validate.ts'

/**
 * Test run (design 0026 §6.4, §6.9; W2-C3): save the canvas as YOUR draft in
 * a dev namespace and start a run of it, as you, through
 * `POST /api/workflows/drafts/:ns/test-run`. The run then opens in the run
 * view like any other run.
 *
 * Only dev namespaces are offered (Kyverno #7 refuses the rest, and the BFF
 * checks the namespace's tier itself); a namespace whose tier the console
 * cannot see here is offered with a note — the server decides. "Check only"
 * is validation level B: the same apply as a dry run, nothing saved or run.
 */

export interface TestRunTarget {
  namespace: string
  label: string
  disabled?: string
}

export function targetOptions(namespaces: readonly ScopeNamespace[]): TestRunTarget[] {
  const t = testRunTargets(namespaces)
  const label = (n: ScopeNamespace) => (n.project ? `${n.namespace} (${n.project}${n.environment ? ` · ${n.environment}` : ''})` : n.namespace)
  return [
    ...t.dev.map((n) => ({ namespace: n.namespace, label: label(n) })),
    ...t.unknown.map((n) => ({ namespace: n.namespace, label: `${label(n)} — tier checked on submit` })),
    ...t.other.map((n) => ({ namespace: n.namespace, label: label(n), disabled: n.role === 'platform' ? 'the platform namespace takes no drafts' : `tier ${n.tier ?? n.environment}: drafts are for dev` })),
  ]
}

export interface TestRunFormProps {
  namespaces: readonly ScopeNamespace[]
  params: readonly DesignerParam[]
  text: string
  /** The namespace the template names, preferred when it is a dev one. */
  preferred?: string
  onStarted(run: { namespace: string; name: string }, result: TestRunResult): void
  onChecked?(result: TestRunResult): void
  onCancel(): void
}

export function TestRunForm({ namespaces, params, text, preferred, onStarted, onChecked, onCancel }: TestRunFormProps) {
  const { cluster } = useWorkflowCluster()
  const targets = useMemo(() => targetOptions(namespaces), [namespaces])
  const usable = targets.filter((t) => !t.disabled)
  const [namespace, setNamespace] = useState(usable.find((t) => t.namespace === preferred)?.namespace ?? usable[0]?.namespace ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [checkOnly, setCheckOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<string | null>(null)
  const editable = params.filter((p) => !p.secretRef)

  const submit = async () => {
    setBusy(true)
    setError(null)
    setChecked(null)
    try {
      const prepared = prepareTestRun(text, new Date(), namespace)
      if (!prepared.ok) throw new Error(prepared.detail)
      const parameters = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
      const r = await testRunDraft(namespace, { yaml: prepared.yaml, parameters, dryRun: checkOnly }, cluster)
      if (checkOnly) {
        setChecked(`The API server and admission policies accept ${r.draft?.name ?? 'the draft'} in ${namespace}. Nothing was saved or run.`)
        onChecked?.(r)
        return
      }
      if (!r.workflow?.name) throw new Error('The draft was saved but no run came back.')
      onStarted({ namespace: r.workflow.namespace ?? namespace, name: r.workflow.name }, r)
    } catch (e) {
      // Kyverno, RBAC and the tier check speak here, in their own words.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {usable.length ? (
        <Field label="Dev namespace" hint="drafts expire after 7 days">
          <Select aria-label="Dev namespace" value={namespace} onChange={(e) => setNamespace(e.currentTarget.value)}>
            {targets.map((t) => (
              <option key={t.namespace} value={t.namespace} disabled={Boolean(t.disabled)}>{t.disabled ? `${t.label} — ${t.disabled}` : t.label}</option>
            ))}
          </Select>
        </Field>
      ) : (
        <p role="alert" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          None of your namespaces is a dev namespace (<span className="font-mono">adhar.io/tier: dev</span>). Test runs and drafts go only there; pick a dev namespace in the top bar, or ask your platform team for one.
        </p>
      )}
      {editable.length ? (
        <div className="space-y-3">
          {editable.map((p) => (
            <Field key={p.name} label={p.name} hint={p.value !== undefined ? `default: ${p.value}` : undefined}>
              {p.enum ? (
                <Select aria-label={p.name} value={values[p.name] ?? p.value ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.currentTarget.value }))} options={p.enum.map((o) => ({ value: o, label: o }))} />
              ) : (
                <Input
                  aria-label={p.name}
                  value={values[p.name] ?? ''}
                  disabled={looksSecret(p.name)}
                  placeholder={looksSecret(p.name) ? 'Secrets come from Kubernetes Secrets, not from here' : p.value ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.currentTarget.value }))}
                />
              )}
              {p.description ? <p className="mt-1 text-xs text-content-subtle">{p.description}</p> : null}
            </Field>
          ))}
        </div>
      ) : <p className="text-sm text-content-subtle">This workflow takes no parameters.</p>}
      <Checkbox checked={checkOnly} onChange={(e) => setCheckOnly(e.currentTarget.checked)} label="Check only" description="Ask the API server and the admission policies; save and run nothing." />
      <p className="text-xs text-content-subtle">
        Saved as <span className="font-mono">&lt;name&gt;-draft-&lt;you&gt;</span>, runs as <span className="font-mono">adhar-workflow</span> in <span className="font-mono">{namespace || '—'}</span>. Your canvas is not changed.
      </p>
      {checked ? <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">{checked}</p> : null}
      {error ? <p role="alert" className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={submit} disabled={!namespace} loading={busy}>{checkOnly ? 'Check' : 'Save draft and run'}</Button>
      </div>
    </div>
  )
}

export function TestRunDialog(props: TestRunFormProps & { name: string }) {
  return (
    <Modal open onClose={props.onCancel} width="lg" title={`Test run ${props.name}`} description="A draft in a dev namespace, run as you. Publish to put it anywhere else.">
      <TestRunForm {...props} />
    </Modal>
  )
}
