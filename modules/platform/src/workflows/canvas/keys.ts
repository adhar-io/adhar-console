/**
 * The designer's keyboard (design 0026 §6.8). One table, read by the page's
 * key handler and by the help popover, so what is documented is what is bound.
 * Every command also has a button: the keys are a shortcut, never the only way.
 *
 * Pure: `keys_test.ts`.
 */

export type Command =
  | 'fit'
  | 'search'
  | 'inspect'
  | 'remove'
  | 'nudge-left'
  | 'nudge-right'
  | 'nudge-up'
  | 'nudge-down'
  | 'nudge-left-far'
  | 'nudge-right-far'
  | 'nudge-up-far'
  | 'nudge-down-far'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'save'
  | 'test-run'
  | 'layout'
  | 'deselect'

export interface KeyLike {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/** The help table: what to press, and what it does. */
export const KEYMAP: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: 'f', does: 'Fit the graph to the canvas' },
  { keys: '/', does: 'Search the palette' },
  { keys: 'Enter', does: 'Open the inspector on the selected step (on a palette entry: add it)' },
  { keys: 'Delete', does: 'Remove the selected step' },
  { keys: 'Arrows (⇧ ×10)', does: 'Move the selected step' },
  { keys: '⌘Z / ⇧⌘Z', does: 'Undo / redo' },
  { keys: '⌘C / ⌘V', does: 'Copy / paste the selected step as YAML' },
  { keys: '⌘S', does: 'Save the draft' },
  { keys: '⌘↵', does: 'Test run' },
  { keys: 'l', does: 'Lay the graph out again' },
  { keys: 'Esc', does: 'Clear the selection' },
  // Monaco's own key, not bound here: in the YAML editor Tab indents, so it is
  // the way OUT of the editor for a keyboard user (WCAG 2.1.2, no trap).
  { keys: 'Ctrl+M (⌃⇧M on a Mac)', does: 'In the YAML editor: make Tab move focus on instead of indenting' },
]

const ARROWS: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/**
 * The command a key press means, or null. `inText` is true while focus is in
 * a text field or the YAML editor: there, a letter is a letter, and only the
 * modified commands that cannot mean typing (save, test run) still apply.
 * Undo inside a text field is the field's own.
 */
export function commandFor(e: KeyLike, inText: boolean): Command | null {
  const mod = Boolean(e.metaKey || e.ctrlKey)
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 's') return 'save'
    if (e.key === 'Enter') return 'test-run'
    if (inText) return null
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (k === 'y') return 'redo'
    if (k === 'c') return 'copy'
    if (k === 'v') return 'paste'
    return null
  }
  if (inText || e.altKey || mod) return null
  const arrow = ARROWS[e.key]
  if (arrow) return `nudge-${arrow}${e.shiftKey ? '-far' : ''}` as Command
  switch (e.key) {
    case 'f':
      return 'fit'
    case '/':
      return 'search'
    case 'Enter':
      return 'inspect'
    case 'Delete':
    case 'Backspace':
      return 'remove'
    case 'l':
      return 'layout'
    case 'Escape':
      return 'deselect'
    default:
      return null
  }
}

export interface KeyTarget {
  tagName?: string
  isContentEditable?: boolean
  closest?(sel: string): unknown
}

/**
 * Bare keys that change or copy the SELECTED STEP. They mean that only while
 * focus is on the canvas: on a toolbar or inspector button, an arrow, Delete
 * or ⌘C belongs to that control — Backspace on the inspector's "Remove"
 * (one connection) must not delete the whole step, and an arrow on a tab must
 * not move a card.
 */
const CANVAS_ONLY: ReadonlySet<Command> = new Set<Command>([
  'remove',
  'copy',
  'nudge-left',
  'nudge-right',
  'nudge-up',
  'nudge-down',
  'nudge-left-far',
  'nudge-right-far',
  'nudge-up-far',
  'nudge-down-far',
])

/**
 * The command a key press on the designer page means, given where it
 * happened. `root` is the element the page's handler is on: React delivers
 * key events from a PORTAL (the test-run dialog, the keyboard help) to that
 * handler too, though the dialog is not in the page — a key pressed in a
 * dialog is the dialog's, never the canvas behind it.
 */
export function commandIn(e: KeyLike, target: KeyTarget | null | undefined, root: { contains(n: unknown): boolean } | null | undefined): Command | null {
  if (root && !root.contains(target)) return null
  const c = commandFor(e, isTextTarget(target))
  if (!c) return null
  // Enter on a focused button is the button's own (a palette entry adds its step).
  if (c === 'inspect' && target?.tagName?.toUpperCase() === 'BUTTON') return null
  if (CANVAS_ONLY.has(c) && target !== root && !target?.closest?.('.react-flow')) return null
  return c
}

/** True for an element where typing is text: inputs, text areas, selects, contenteditable and Monaco. */
export function isTextTarget(el: { tagName?: string; isContentEditable?: boolean; closest?(sel: string): unknown } | null | undefined): boolean {
  if (!el) return false
  const tag = el.tagName?.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return Boolean(el.closest?.('.monaco-editor'))
}
