import { parse as parseYaml, stringify } from 'yaml'
import type { Path, WfDoc } from '../model/doc.ts'
import { getIn } from '../model/doc.ts'
import type { InspectorField, TemplateRef } from '../model/kinds.ts'
import type { Op } from '../model/ops.ts'
import { OpError } from '../model/ops.ts'
import type { DesignerGraph, DesignerNode } from '../model/project.ts'
import { specPathOf } from '../model/shape.ts'

/**
 * Inspector fields ⇄ document (design 0026 §6.6, W2-C2). The inspector
 * schema (`kinds.ts` `fieldsFor`) says WHERE a field lives; this says how the
 * value a control holds is read from the document and written back as one
 * operation. Every control's text form is plain: a list is one item per line,
 * environment is `NAME=value`, a secret is `NAME=secret/key`, resources are
 * YAML. Writing an empty value REMOVES the field rather than writing `""`.
 *
 * Pure: `field-ops_test.ts`.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)

/** The workflow spec of the document the graph came from (`spec`, or `spec.workflowSpec` for a CronWorkflow). */
export function specPath(g: DesignerGraph): Path {
  return specPathOf(g.resource.kind)
}

/** Where a field's value lives, or undefined when it has nowhere to live (a template field on a referenced step). */
export function fieldPath(g: DesignerGraph, node: DesignerNode | undefined, field: InspectorField): Path | undefined {
  if (field.target === 'spec') return [...specPath(g), ...field.path]
  if (!node) return undefined
  if (field.target === 'task') return [...node.path, ...field.path]
  return node.templatePath ? [...node.templatePath, ...field.path] : undefined
}

/**
 * Fields that write one of the task's `arguments.parameters` (`setArgument`)
 * rather than a path: the schema marks them with `param` on the task's
 * `arguments.parameters`, whatever control draws them (an approval's timeout
 * is a duration, its approvers a picker).
 */
export function isArgument(field: InspectorField): boolean {
  return field.param !== undefined && field.target === 'task' && field.path[0] === 'arguments'
}

/** The raw document value behind a field. */
export function readField(d: WfDoc, g: DesignerGraph, node: DesignerNode | undefined, field: InspectorField): unknown {
  if (isArgument(field)) {
    if (!node) return undefined
    const params = getIn<unknown[]>(d, [...node.path, 'arguments', 'parameters'])
    const p = Array.isArray(params) ? params.find((x) => isObj(x) && x.name === field.param) : undefined
    return isObj(p) ? p.value : undefined
  }
  const path = fieldPath(g, node, field)
  return path ? getIn(d, path) : undefined
}

const scalar = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : stringify(v, { lineWidth: 0 }).trimEnd())

/** What a control shows for a raw value. A toggle gets a boolean; everything else text. */
export function display(field: InspectorField, raw: unknown): string | boolean {
  switch (field.control) {
    case 'toggle':
      return raw === true || raw === 'true'
    case 'string-list':
      return Array.isArray(raw) ? raw.map(scalar).join('\n') : scalar(raw)
    case 'env':
      return Array.isArray(raw) ? raw.filter((e) => isObj(e) && e.valueFrom === undefined).map((e) => `${(e as Obj).name}=${scalar((e as Obj).value)}`).join('\n') : ''
    case 'secret-env':
      return Array.isArray(raw)
        ? raw.filter((e) => isObj(e) && isObj((e.valueFrom as Obj | undefined)?.secretKeyRef)).map((e) => {
          const ref = ((e as Obj).valueFrom as Obj).secretKeyRef as Obj
          return `${(e as Obj).name}=${scalar(ref.name)}/${scalar(ref.key)}`
        }).join('\n')
        : ''
    case 'headers':
      return Array.isArray(raw) ? raw.filter(isObj).map((h) => `${h.name}: ${scalar(h.value)}`).join('\n') : ''
    case 'volumes':
      return Array.isArray(raw) ? raw.filter((v) => isObj(v) && v.emptyDir !== undefined).map((v) => scalar((v as Obj).name)).join('\n') : ''
    case 'resources':
      return raw === undefined ? '' : stringify(raw, { lineWidth: 0 }).trimEnd()
    case 'template-picker': {
      if (!isObj(raw)) return ''
      return `${raw.clusterScope ? 'cluster:' : ''}${scalar(raw.name)}/${scalar(raw.template)}`
    }
    default:
      return scalar(raw)
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `NAME=value` lines; a malformed line is refused, not dropped. */
function envLines(text: string, what: string): Array<[string, string]> {
  return lines(text).map((l) => {
    const i = l.indexOf('=')
    const name = i > 0 ? l.slice(0, i).trim() : ''
    if (!ENV_NAME.test(name)) throw new OpError('invalid', `${what}: "${l}" is not NAME=value.`)
    return [name, l.slice(i + 1)]
  })
}

/** "cluster:lib/step" or "lib/step" → a reference. */
export function parseRef(text: string): TemplateRef | undefined {
  const m = /^(cluster:)?([a-z0-9]([-a-z0-9.]*[a-z0-9])?)\/([A-Za-z0-9][-A-Za-z0-9_.]*)$/.exec(text.trim())
  return m ? { name: m[2], template: m[4], ...(m[1] ? { clusterScope: true } : {}) } : undefined
}

function convert(field: InspectorField, value: unknown, current: unknown): { set: unknown } | { unset: true } {
  const text = typeof value === 'string' ? value : ''
  const blank = typeof value === 'string' && value.trim() === ''
  switch (field.control) {
    case 'toggle':
      return { set: value === true }
    case 'number': {
      if (blank) return { unset: true }
      const n = Number(text.trim())
      if (!Number.isFinite(n) || n < 0) throw new OpError('invalid', `${field.label} must be a number of 0 or more.`)
      return { set: n }
    }
    case 'string-list':
      return blank ? { unset: true } : { set: text.split('\n').filter((l) => l.trim() !== '') }
    case 'env':
    case 'secret-env': {
      const others = (Array.isArray(current) ? current : []).filter((e) => {
        const secret = isObj(e) && isObj((e.valueFrom as Obj | undefined)?.secretKeyRef)
        // `env` keeps every entry that is not a plain value; `secret-env` every entry that is not a secret.
        return field.control === 'env' ? !(isObj(e) && e.valueFrom === undefined) : !secret
      })
      const mine = field.control === 'env'
        ? envLines(text, field.label).map(([name, v]) => ({ name, value: v }))
        : envLines(text, field.label).map(([name, v]) => {
          const at = v.lastIndexOf('/')
          if (at <= 0 || at === v.length - 1) throw new OpError('invalid', `${field.label}: "${name}=${v}" is not NAME=secret/key.`)
          return { name, valueFrom: { secretKeyRef: { name: v.slice(0, at), key: v.slice(at + 1) } } }
        })
      const all = [...others, ...mine]
      return all.length ? { set: all } : { unset: true }
    }
    case 'headers': {
      if (blank) return { unset: true }
      return {
        set: lines(text).map((l) => {
          const i = l.indexOf(':')
          if (i <= 0) throw new OpError('invalid', `${field.label}: "${l}" is not Name: value.`)
          return { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() }
        }),
      }
    }
    case 'volumes': {
      const others = (Array.isArray(current) ? current : []).filter((v) => !(isObj(v) && v.emptyDir !== undefined))
      const mine = lines(text).map((name) => {
        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) throw new OpError('invalid', `${field.label}: "${name}" is not a volume name.`)
        return { name, emptyDir: {} }
      })
      const all = [...others, ...mine]
      return all.length ? { set: all } : { unset: true }
    }
    case 'resources': {
      if (blank) return { unset: true }
      let parsed: unknown
      try {
        parsed = parseYaml(text)
      } catch (e) {
        throw new OpError('invalid', `Resources are not YAML: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (!isObj(parsed)) throw new OpError('invalid', 'Resources are a map of requests and limits.')
      return { set: parsed }
    }
    case 'template-picker': {
      const ref = isObj(value) ? (value as unknown as TemplateRef) : parseRef(text)
      if (!ref) throw new OpError('invalid', 'Pick a template, or type library/template.')
      return { set: { name: ref.name, template: ref.template, ...(ref.clusterScope ? { clusterScope: true } : {}) } }
    }
    default:
      return blank ? { unset: true } : { set: text }
  }
}

/**
 * The operation an inspector edit makes, or null when it changes nothing.
 * Throws `OpError('invalid')` for a value the control cannot write.
 */
export function fieldOp(d: WfDoc, g: DesignerGraph, node: DesignerNode | undefined, field: InspectorField, value: unknown): Op | null {
  if (isArgument(field)) {
    if (!node) return null
    const v = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
    // A required argument keeps an empty value (validation says so); an optional one is removed.
    return { op: 'setArgument', node: node.uid, name: field.param!, value: v === '' && !field.required ? undefined : v }
  }
  const path = fieldPath(g, node, field)
  if (!path) throw new OpError('not-editable', `${field.label} belongs to the referenced template, which is edited where it lives.`)
  const current = getIn(d, path)
  const next = convert(field, value, current)
  if ('unset' in next) return current === undefined ? null : { op: 'unset', path }
  return { op: 'set', path, value: next.set }
}
