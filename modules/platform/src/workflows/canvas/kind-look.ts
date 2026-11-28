import type { NodeKind } from '../model/kinds.ts'
import { KIND_LABELS } from '../model/kinds.ts'

/**
 * How each node kind looks (design 0026 §6.8): a hue per kind, as theme-aware
 * classes for the icon tile and a raw colour for the minimap, plus the glyph.
 * Shared by the canvas, the palette and the inspector, so a kind is the same
 * colour wherever it appears. Pure data.
 */

export type Glyph = 'container' | 'script' | 'resource' | 'http' | 'approval' | 'timer' | 'template' | 'platform' | 'group' | 'batch' | 'chaos' | 'fan-out' | 'exit' | 'other'

export interface KindLook {
  label: string
  tile: string
  hex: string
  glyph: Glyph
}

const L = (label: string, tile: string, hex: string, glyph: Glyph): KindLook => ({ label, tile, hex, glyph })

export const KIND_LOOK: Readonly<Record<NodeKind, KindLook>> = {
  container: L(KIND_LABELS.container, 'bg-sky-500/12 text-sky-600 dark:text-sky-300', '#0ea5e9', 'container'),
  script: L(KIND_LABELS.script, 'bg-violet-500/12 text-violet-600 dark:text-violet-300', '#8b5cf6', 'script'),
  resource: L(KIND_LABELS.resource, 'bg-teal-500/12 text-teal-600 dark:text-teal-300', '#14b8a6', 'resource'),
  http: L(KIND_LABELS.http, 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-300', '#6366f1', 'http'),
  approval: L(KIND_LABELS.approval, 'bg-amber-500/15 text-amber-700 dark:text-amber-300', '#f59e0b', 'approval'),
  timer: L(KIND_LABELS.timer, 'bg-slate-500/12 text-content-muted', '#64748b', 'timer'),
  suspend: L(KIND_LABELS.suspend, 'bg-slate-500/12 text-content-muted', '#64748b', 'timer'),
  template: L(KIND_LABELS.template, 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300', '#06b6d4', 'template'),
  'platform-step': L(KIND_LABELS['platform-step'], 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', '#10b981', 'platform'),
  subflow: L(KIND_LABELS.subflow, 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', '#10b981', 'group'),
  'batch-job': L(KIND_LABELS['batch-job'], 'bg-orange-500/12 text-orange-700 dark:text-orange-300', '#f97316', 'batch'),
  chaos: L(KIND_LABELS.chaos, 'bg-rose-500/12 text-rose-700 dark:text-rose-300', '#f43f5e', 'chaos'),
  steps: L(KIND_LABELS.steps, 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', '#10b981', 'group'),
  'container-set': L(KIND_LABELS['container-set'], 'bg-sky-500/12 text-sky-600 dark:text-sky-300', '#0ea5e9', 'container'),
  data: L(KIND_LABELS.data, 'bg-teal-500/12 text-teal-600 dark:text-teal-300', '#14b8a6', 'other'),
  plugin: L(KIND_LABELS.plugin, 'bg-slate-500/12 text-content-muted', '#64748b', 'other'),
  inline: L(KIND_LABELS.inline, 'bg-slate-500/12 text-content-muted', '#64748b', 'other'),
  unknown: L(KIND_LABELS.unknown, 'bg-slate-500/12 text-content-muted', '#94a3b8', 'other'),
}

/** A palette entry's look: its kind's, except the two entries that are a shape rather than a kind. */
export function entryLook(id: string, kind: NodeKind): KindLook {
  if (id === 'fan-out') return { ...KIND_LOOK.container, label: 'Fan-out', glyph: 'fan-out' }
  if (id === 'exit-handler') return { ...KIND_LOOK.timer, label: 'Exit handler', glyph: 'exit' }
  return KIND_LOOK[kind]
}
