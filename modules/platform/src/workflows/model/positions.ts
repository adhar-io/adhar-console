/**
 * The `adhar.io/designer-positions` annotation (design 0026 §4.7, §6.5): where
 * each task was dragged to, as compact JSON `{"<task>": [x, y]}`. It is the
 * only thing the designer stores that Argo does not need, it is optional, and
 * a template without it is laid out by `layout.ts`.
 *
 * Tasks of the entry DAG are keyed by name; tasks of any other DAG template
 * (the exit lane, a sub-flow) by `<template>/<task>` — neither name may hold a
 * slash, so the two never collide. Pure: `positions_test.ts`.
 */

export type Positions = Record<string, { x: number; y: number }>

/** Above this many entries the annotation is ignored: a 200-task DAG (Argo's ceiling) with sub-flows fits well inside. */
export const MAX_POSITIONS = 2000

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Read the annotation. Anything unreadable is no positions at all, never an error: they are cosmetic. */
export function decodePositions(raw: unknown): Positions {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Positions = {}
  let n = 0
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (++n > MAX_POSITIONS) break
    if (Array.isArray(v) && finite(v[0]) && finite(v[1])) out[key] = { x: v[0], y: v[1] }
    else if (v && typeof v === 'object' && finite((v as { x?: unknown }).x) && finite((v as { y?: unknown }).y)) {
      out[key] = { x: (v as { x: number }).x, y: (v as { y: number }).y }
    }
  }
  return out
}

/** Write the annotation: whole pixels, keys sorted, so the same layout is the same string (and no diff). */
export function encodePositions(p: Positions): string {
  const out: Record<string, [number, number]> = {}
  for (const key of Object.keys(p).sort()) {
    const { x, y } = p[key]
    if (finite(x) && finite(y)) out[key] = [Math.round(x), Math.round(y)]
  }
  return JSON.stringify(out)
}

/** The annotation key of a task: its name in the entry DAG, `<template>/<task>` elsewhere. */
export function positionKey(entry: string, dag: string, task: string): string {
  return dag === entry ? task : `${dag}/${task}`
}
