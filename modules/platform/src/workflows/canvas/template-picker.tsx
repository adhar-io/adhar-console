import { useMemo, useState } from 'react'
import { Button } from '@adhar/shell-ui'
import type { CatalogueStep, TemplateRef } from '../model/kinds.ts'
import { parseRef } from './field-ops.ts'

/**
 * The picker a dropped "Template" entry opens (§6.6): the platform's
 * catalogue steps and the WorkflowTemplates in this namespace, or a reference
 * typed as `library/template` (`cluster:` for a ClusterWorkflowTemplate).
 * Pure render from props: `views/designer_test.tsx` renders it.
 */

export interface LocalTemplate {
  name: string
  namespace?: string
  /** The callable templates inside it. */
  templates: string[]
}

export interface PickerOption {
  key: string
  ref: TemplateRef
  title: string
  detail: string
}

export function pickerOptions(catalogue: readonly CatalogueStep[], local: readonly LocalTemplate[]): PickerOption[] {
  return [
    ...catalogue.map((s) => ({ key: `c:${s.ref.name}/${s.ref.template}`, ref: s.ref, title: s.title, detail: `${s.ref.name}/${s.ref.template} · platform` })),
    ...local.flatMap((t) => t.templates.map((x) => ({ key: `l:${t.name}/${x}`, ref: { name: t.name, template: x }, title: `${t.name} → ${x}`, detail: `WorkflowTemplate${t.namespace ? ` in ${t.namespace}` : ''}` }))),
  ]
}

export function TemplatePicker({ catalogue, local, onPick, onCancel }: { catalogue: readonly CatalogueStep[]; local: readonly LocalTemplate[]; onPick(ref: TemplateRef): void; onCancel(): void }) {
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState('')
  const options = useMemo(() => pickerOptions(catalogue, local), [catalogue, local])
  const shown = options.filter((o) => !q || `${o.title} ${o.detail}`.toLowerCase().includes(q.toLowerCase()))
  const typedRef = parseRef(typed)
  return (
    <div role="dialog" aria-label="Pick the template this step calls" className="space-y-2 rounded-xl border border-brand-500/40 bg-surface-raised p-3 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-content">Call which template?</h3>
        <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <input
        autoFocus
        type="search"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder="Search templates"
        aria-label="Search templates"
        className="h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2.5 text-sm focus:border-brand-500 focus:outline-none"
      />
      <ul className="max-h-56 space-y-1 overflow-y-auto" aria-label="Templates">
        {shown.map((o) => (
          <li key={o.key}>
            <button type="button" onClick={() => onPick(o.ref)} className="w-full rounded-lg px-2 py-1 text-left hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
              <span className="block truncate text-[13px] font-medium text-content">{o.title}</span>
              <span className="block truncate font-mono text-[11px] text-content-subtle">{o.detail}</span>
            </button>
          </li>
        ))}
        {!shown.length ? <li className="px-2 text-xs text-content-subtle">No template matches. Type a reference below.</li> : null}
      </ul>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (typedRef) onPick(typedRef)
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          placeholder="library/template or cluster:library/template"
          aria-label="Template reference"
          className="h-8 min-w-0 flex-1 rounded-lg border border-edge-default bg-surface-raised px-2.5 font-mono text-xs focus:border-brand-500 focus:outline-none"
        />
        <Button size="xs" type="submit" disabled={!typedRef}>Use</Button>
      </form>
    </div>
  )
}
