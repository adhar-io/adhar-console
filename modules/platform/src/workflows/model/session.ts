import type { WfDoc } from './doc.ts'
import { parse, print, sameContent } from './doc.ts'
import type { ApplyOptions, Op, OpResult } from './ops.ts'
import { applyOp } from './ops.ts'
import type { DesignerGraph, ProjectOptions } from './project.ts'
import { project } from './project.ts'

/**
 * One open document in the designer (design 0026 §6.5): the current snapshot,
 * the graph the canvas shows, and undo.
 *
 * The YAML panel and the canvas share the one document. A canvas edit is an
 * `Op`; typing in the panel is `editText`. When the text stops parsing the
 * canvas FREEZES on the last graph that did (`frozen`) and nothing is fixed
 * for the user; the text they typed is still what `text()` returns and what a
 * save would write.
 *
 * Undo keeps snapshots (at most `MAX_UNDO`), so it is exact for every edit,
 * including the ones with no semantic inverse. A plain immutable value: every
 * function returns a new session. Pure: `session_test.ts`.
 */

export const MAX_UNDO = 100

export interface Session {
  /** The current snapshot; it may not parse (after a text edit). */
  readonly doc: WfDoc
  /** The projection of the last snapshot that parsed. */
  readonly graph: DesignerGraph
  /** The current text does not parse: the canvas shows `graph` under a "YAML has errors" banner and refuses edits. */
  readonly frozen: boolean
  /** The text at open or at the last save. */
  readonly baseline: WfDoc
  readonly undo: readonly WfDoc[]
  readonly redo: readonly WfDoc[]
  /** What the last operation changed, in words. */
  readonly changes: readonly string[]
  /** The last entry was typed text: more typing extends the same undo step. */
  readonly typing: boolean
}

export type SessionOptions = ProjectOptions & ApplyOptions

function view(prev: Session | undefined, doc: WfDoc, opts: SessionOptions): Pick<Session, 'doc' | 'graph' | 'frozen'> {
  const g = project(doc, opts)
  if (doc.errors.length && prev) {
    // Keep the last good graph; show the new text's diagnostics on it.
    return { doc, graph: { ...prev.graph, editable: false, readOnly: 'yaml-errors', diagnostics: g.diagnostics }, frozen: true }
  }
  return { doc, graph: g, frozen: doc.errors.length > 0 }
}

export function open(text: string, opts: SessionOptions = {}): Session {
  const doc = parse(text)
  return { ...view(undefined, doc, opts), baseline: doc, undo: [], redo: [], changes: [], typing: false }
}

function push(s: Session, doc: WfDoc, opts: SessionOptions, changes: readonly string[], typing: boolean): Session {
  if (doc.source === s.doc.source) return { ...s, changes }
  const extend = typing && s.typing && s.undo.length > 0
  const undo = extend ? s.undo : [...s.undo, s.doc].slice(-MAX_UNDO)
  return { ...s, ...view(s, doc, opts), undo, redo: [], changes, typing }
}

/** A canvas edit. Throws `OpError` (and leaves the session as it was) when the operation cannot apply. */
export function apply(s: Session, op: Op, opts: SessionOptions = {}): { session: Session; result: OpResult } {
  const result = applyOp(s.doc, op, opts)
  return { session: push(s, result.doc, opts, result.changes, false), result }
}

/** The YAML panel changed (call after the debounce). Consecutive calls are one undo step. */
export function editText(s: Session, text: string, opts: SessionOptions = {}): Session {
  return push(s, parse(text), opts, [], true)
}

export function undo(s: Session, opts: SessionOptions = {}): Session {
  if (!s.undo.length) return s
  const doc = s.undo[s.undo.length - 1]
  return { ...s, ...view(s, doc, opts), undo: s.undo.slice(0, -1), redo: [...s.redo, s.doc], changes: [], typing: false }
}

export function redo(s: Session, opts: SessionOptions = {}): Session {
  if (!s.redo.length) return s
  const doc = s.redo[s.redo.length - 1]
  return { ...s, ...view(s, doc, opts), undo: [...s.undo, s.doc].slice(-MAX_UNDO), redo: s.redo.slice(0, -1), changes: [], typing: false }
}

/** The text a save writes: exactly the current snapshot's. */
export function text(s: Session): string {
  return print(s.doc)
}

/** The text differs from the baseline (the Save button). */
export function isDirty(s: Session): boolean {
  return s.doc.source !== s.baseline.source
}

/** The CONTENT differs from the baseline: false for a change of formatting only, which publishing drops (no commit). */
export function hasChanges(s: Session): boolean {
  return !sameContent(s.doc, s.baseline)
}

export function markSaved(s: Session): Session {
  return { ...s, baseline: s.doc }
}
