import { memo, useEffect, useMemo, useState } from 'react'
import { stringify } from 'yaml'
import { Button, Checkbox, Select } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { WfDoc } from '../model/doc.ts'
import { getIn } from '../model/doc.ts'
import { CONDITIONS, type Condition } from '../model/depends.ts'
import type { CatalogueStep, InspectorField, PaletteEntry } from '../model/kinds.ts'
import { fieldsFor } from '../model/kinds.ts'
import type { DesignerGraph, DesignerNode } from '../model/project.ts'
import { allNodes, findNode } from '../model/project.ts'
import type { Diagnostic } from '../model/validate.ts'
import type { Action } from './designer-state.ts'
import { display, isArgument, readField } from './field-ops.ts'
import { KindTile } from './glyph.tsx'
import { KIND_LOOK } from './kind-look.ts'

/**
 * The inspector (design 0026 §6.8): what the selected step is and every field
 * the kind registry gives it (`kinds.ts` `fieldsFor`), grouped in the tabs
 * General · Inputs & outputs · Retry & timeout · Conditions · Resources ·
 * Advanced (a tab with nothing in it is not shown). Fields commit on blur or
 * Enter, so a half-typed value never reaches the document.
 *
 * "Runs after" lists the step's incoming connections with a Remove button
 * each, and adds one from a select: the keyboard's way to draw an edge
 * (acceptance 6). With nothing selected it shows the workflow itself.
 */

export type InspectorTab = 'general' | 'io' | 'retry' | 'conditions' | 'resources' | 'advanced'

export const TAB_LABELS: Record<InspectorTab, string> = {
  general: 'General',
  io: 'Inputs & outputs',
  retry: 'Retry & timeout',
  conditions: 'Conditions',
  resources: 'Resources',
  advanced: 'Advanced',
}

const RESOURCE_IDS = new Set(['resources', 'volumes', 'nonRoot'])
const RETRY_IDS = new Set(['retries', 'deadline', 'timeoutSeconds'])
const CONDITION_IDS = new Set(['when', 'depends', 'successCondition', 'failureCondition'])

/** Which tab a field sits in. Arguments are "Inputs & outputs", except on a step that has nothing else to show. */
export function groupFields(fields: readonly InspectorField[]): Array<{ tab: InspectorTab; fields: InspectorField[] }> {
  const by: Record<InspectorTab, InspectorField[]> = { general: [], io: [], retry: [], conditions: [], resources: [], advanced: [] }
  for (const f of fields) {
    if (RESOURCE_IDS.has(f.id)) by.resources.push(f)
    else if (RETRY_IDS.has(f.id)) by.retry.push(f)
    else if (CONDITION_IDS.has(f.id)) by.conditions.push(f)
    else if (isArgument(f)) by.io.push(f)
    else by.general.push(f)
  }
  if (!by.general.length && by.io.length) {
    by.general = by.io
    by.io = []
  }
  return (Object.keys(by) as InspectorTab[]).filter((t) => by[t].length || t === 'conditions' || t === 'advanced').map((t) => ({ tab: t, fields: by[t] }))
}

/* ─────────────────────────── one control ─────────────────────────── */

const MULTILINE = new Set(['textarea', 'code', 'yaml', 'string-list', 'env', 'secret-env', 'headers', 'volumes', 'resources'])

const PLACEHOLDERS: Partial<Record<string, string>> = {
  'string-list': 'one per line',
  env: 'NAME=value, one per line',
  'secret-env': 'NAME=secret-name/key, one per line',
  headers: 'Name: value, one per line',
  volumes: 'one volume name per line',
  resources: 'requests: {cpu: 100m, memory: 128Mi}\nlimits: {cpu: 500m, memory: 256Mi}',
  'template-picker': 'library/template',
}

export const FieldInput = memo(function FieldInput({ field, value, disabled, onCommit }: { field: InspectorField; value: string | boolean; disabled?: boolean; onCommit(raw: unknown): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const label = `${field.label}${field.required ? ' (required)' : ''}`
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  let control
  if (field.control === 'toggle') {
    control = <Checkbox checked={draft === true} disabled={disabled} onChange={(e) => onCommit(e.currentTarget.checked)} label={field.label} />
  } else if (field.options?.length && (field.control === 'select' || isArgument(field))) {
    control = (
      <Select
        aria-label={label}
        disabled={disabled}
        value={String(draft)}
        onChange={(e) => onCommit(e.currentTarget.value)}
        options={[{ value: '', label: field.placeholder ? `default (${field.placeholder})` : '—' }, ...field.options.map((o) => ({ value: o, label: o }))]}
      />
    )
  } else if (MULTILINE.has(field.control)) {
    control = (
      <textarea
        aria-label={label}
        disabled={disabled}
        value={String(draft)}
        rows={field.control === 'code' || field.control === 'yaml' ? 8 : 3}
        spellCheck={false}
        placeholder={field.placeholder ?? PLACEHOLDERS[field.control]}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        className="w-full rounded-lg border border-edge-default bg-surface-raised px-2 py-1.5 font-mono text-xs text-content focus:border-brand-500 focus:outline-none disabled:opacity-60"
      />
    )
  } else {
    control = (
      <input
        aria-label={label}
        disabled={disabled}
        value={String(draft)}
        inputMode={field.control === 'number' ? 'numeric' : undefined}
        placeholder={field.placeholder ?? PLACEHOLDERS[field.control]}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setDraft(value)
        }}
        className="h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-[13px] text-content focus:border-brand-500 focus:outline-none disabled:opacity-60"
      />
    )
  }
  return (
    <div className="space-y-1">
      {field.control !== 'toggle' ? (
        <div className="flex items-baseline gap-1 text-[12px] font-medium text-content">
          <span>{field.label}</span>
          {field.required ? <span aria-hidden className="text-rose-600">*</span> : null}
        </div>
      ) : null}
      {control}
      {field.help ? <p className="text-[11px] text-content-subtle">{field.help}</p> : null}
    </div>
  )
})

/* ─────────────────────────── runs after ─────────────────────────── */

function RunsAfter({ graph, node, disabled, dispatch }: { graph: DesignerGraph; node: DesignerNode; disabled: boolean; dispatch(a: Action): void }) {
  const edges = (node.lane === 'exit' ? graph.exitLane?.edges ?? [] : graph.edges).filter((e) => e.target === node.uid)
  const candidates = allNodes(graph).filter((n) => n.lane === node.lane && n.dag === node.dag && n.uid !== node.uid && !edges.some((e) => e.source === n.uid))
  const [source, setSource] = useState('')
  const [condition, setCondition] = useState<Condition>('Succeeded')
  return (
    <div className="space-y-2" aria-label="Runs after">
      <div className="text-[12px] font-medium text-content">Runs after</div>
      {edges.length ? (
        <ul className="space-y-1">
          {edges.map((e) => (
            <li key={e.id} className="flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">{e.source}</span>
              <span className="text-content-subtle">{e.condition === 'Succeeded' ? 'succeeds' : e.condition}</span>
              {e.condition !== 'Expression' ? (
                <button type="button" disabled={disabled} className="text-content-subtle hover:text-rose-600 disabled:opacity-40" aria-label={`Stop waiting for ${e.source}`} onClick={() => dispatch({ type: 'disconnect', source: e.source, target: node.uid })}>Remove</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-[11px] text-content-subtle">Starts as soon as the workflow starts.</p>}
      {candidates.length && !node.badges.expression ? (
        <div className="flex items-center gap-1.5">
          <select aria-label="Add a step this one waits for" disabled={disabled} value={source} onChange={(e) => setSource(e.currentTarget.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-edge-default bg-surface-raised px-1.5 text-xs">
            <option value="">Wait for…</option>
            {candidates.map((c) => <option key={c.uid} value={c.uid}>{c.id}</option>)}
          </select>
          <select aria-label="Condition" disabled={disabled} value={condition} onChange={(e) => setCondition(e.currentTarget.value as Condition)} className="h-8 w-28 rounded-lg border border-edge-default bg-surface-raised px-1.5 text-xs">
            {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled || !source}
            onClick={() => {
              dispatch({ type: 'connect', source, target: node.uid, condition: condition === 'Succeeded' ? undefined : condition })
              setSource('')
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
      {node.badges.expression ? <p className="text-[11px] text-content-subtle">This step's depends is an expression (|| or !): edit it in the Depends on field.</p> : null}
    </div>
  )
}

/* ─────────────────────────── the panel ─────────────────────────── */

export interface InspectorProps {
  graph: DesignerGraph
  doc: WfDoc
  frozen: boolean
  selected: string | null
  catalogue: readonly CatalogueStep[]
  palette: readonly PaletteEntry[]
  diagnostics: readonly Diagnostic[]
  dispatch(a: Action): void
  className?: string
}

/** The palette entry a node came from, for its guardrails. */
export function entryFor(node: DesignerNode, palette: readonly PaletteEntry[]): PaletteEntry | undefined {
  const ref = node.template.ref
  if (ref) return palette.find((e) => e.ref && e.ref.name === ref.name && e.ref.template === ref.template)
  if (node.badges.fanOut) return palette.find((e) => e.id === 'fan-out')
  return palette.find((e) => e.id === node.kind && e.action === 'local')
}

export function Inspector(props: InspectorProps) {
  const node = props.selected ? findNode(props.graph, props.selected) : undefined
  return (
    <aside aria-label="Inspector" className={cn('min-h-0 overflow-y-auto', props.className)}>
      {node ? <NodeInspector key={node.uid} {...props} node={node} /> : <WorkflowInspector {...props} />}
    </aside>
  )
}

function NodeInspector({ graph, doc, frozen, catalogue, palette, diagnostics, dispatch, node }: InspectorProps & { node: DesignerNode }) {
  const look = KIND_LOOK[node.kind]
  const editable = !frozen && (node.lane === 'main' ? graph.editable : Boolean(graph.exitLane?.editable))
  const fields = useMemo(() => fieldsFor(node.kind, node.template.ref, catalogue, node.template.local !== undefined), [node.kind, node.template.ref, node.template.local, catalogue])
  const groups = useMemo(() => groupFields(fields), [fields])
  const [tab, setTab] = useState<InspectorTab>('general')
  const active = groups.some((g) => g.tab === tab) ? tab : groups[0].tab
  const [name, setName] = useState(node.id)
  useEffect(() => setName(node.id), [node.id])
  const entry = entryFor(node, palette)
  const mine = diagnostics.filter((d) => d.task?.uid === node.uid || (node.template.local !== undefined && !d.task && d.template === node.template.local))
  const commitName = () => {
    if (name && name !== node.id) dispatch({ type: 'rename', node: node.uid, to: name })
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <KindTile look={look} size={36} />
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-content-subtle">{node.title ?? look.label}</div>
          <input
            aria-label="Step name"
            value={name}
            disabled={!editable}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') setName(node.id)
            }}
            className="h-7 w-full rounded-md border border-transparent bg-transparent px-1 font-mono text-[14px] font-semibold text-content hover:border-edge-default focus:border-brand-500 focus:outline-none"
          />
        </div>
      </div>
      {node.sharedBy > 0 ? (
        <p role="note" className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
          {node.sharedBy} other step{node.sharedBy === 1 ? '' : 's'} run{node.sharedBy === 1 ? 's' : ''} the same template "{node.template.local}": editing its fields changes {node.sharedBy === 1 ? 'it' : 'them'} too.
        </p>
      ) : null}
      {entry?.guardrails.length ? (
        <ul className="space-y-1 rounded-md bg-surface-sunken px-2 py-1.5 text-[11px] text-content-muted">
          {entry.guardrails.map((g) => <li key={g}>{g}</li>)}
        </ul>
      ) : null}
      {mine.length ? (
        <ul className="space-y-1" aria-label="Problems with this step">
          {mine.map((d, i) => (
            <li key={i} className={cn('rounded-md px-2 py-1 text-[11px]', d.level === 'error' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : d.level === 'warning' ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300' : 'bg-surface-sunken text-content-muted')}>{d.message}</li>
          ))}
        </ul>
      ) : null}
      <div role="tablist" aria-label="Step settings" className="flex flex-wrap gap-1 border-b border-edge-subtle pb-1">
        {groups.map((g) => (
          <button key={g.tab} type="button" role="tab" aria-selected={active === g.tab} onClick={() => setTab(g.tab)} className={cn('rounded-md px-2 py-0.5 text-[12px]', active === g.tab ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:text-content')}>
            {TAB_LABELS[g.tab]}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TAB_LABELS[active]} className="space-y-3">
        {groups.find((g) => g.tab === active)!.fields.map((f) => (
          <FieldInput
            key={`${node.uid}:${f.id}`}
            field={f}
            disabled={!editable || (f.target === 'template' && !node.templatePath)}
            value={display(f, readField(doc, graph, node, f))}
            onCommit={(raw) => dispatch({ type: 'field', node: node.uid, field: f, raw })}
          />
        ))}
        {active === 'conditions' ? <RunsAfter graph={graph} node={node} disabled={!editable} dispatch={dispatch} /> : null}
        {active === 'advanced' ? (
          <div className="space-y-2">
            <div className="text-[12px] font-medium text-content">The task as YAML</div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-surface-sunken p-2 font-mono text-[11px] text-content-muted">{stringify(getIn(doc, node.path) ?? {}, { lineWidth: 0 })}</pre>
            <p className="text-[11px] text-content-subtle">Anything not shown in the tabs is edited in the YAML panel; it is kept as written.</p>
          </div>
        ) : null}
      </div>
      <div className="flex gap-2 border-t border-edge-subtle pt-3">
        <Button size="xs" variant="danger" disabled={!editable} onClick={() => dispatch({ type: 'remove', node: node.uid })}>Remove step</Button>
      </div>
    </div>
  )
}

function WorkflowInspector({ graph, frozen }: InspectorProps) {
  return (
    <div className="space-y-3 text-[13px]">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-content-subtle">{graph.resource.kind ?? 'Document'}</div>
        <div className="font-mono text-[14px] font-semibold text-content">{graph.resource.name || '—'}</div>
        {graph.resource.namespace ? <div className="text-xs text-content-subtle">in {graph.resource.namespace}</div> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-content-subtle">Entry</dt>
        <dd className="font-mono">{graph.entry || '—'}</dd>
        <dt className="text-content-subtle">Steps</dt>
        <dd>{allNodes(graph).length}</dd>
        <dt className="text-content-subtle">Templates</dt>
        <dd>{graph.templates.length}</dd>
      </dl>
      <div>
        <div className="mb-1 text-[12px] font-medium text-content">Parameters</div>
        {graph.params.length ? (
          <ul className="space-y-1">
            {graph.params.map((p) => (
              <li key={p.name} className="rounded-md bg-surface-sunken px-2 py-1 text-xs">
                <span className="font-mono">{p.name}</span>
                {p.value !== undefined ? <span className="text-content-subtle"> = {p.value}</span> : null}
                {p.description ? <div className="text-[11px] text-content-subtle">{p.description}</div> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-[11px] text-content-subtle">None. Add them under spec.arguments.parameters in the YAML.</p>}
      </div>
      <p className="text-[11px] text-content-subtle">{frozen ? 'The YAML has errors: fix them in the YAML panel to edit the canvas again.' : 'Select a step to edit it.'}</p>
    </div>
  )
}
