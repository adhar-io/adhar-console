import flowCss from '@xyflow/react/dist/style.css?inline'

/**
 * React Flow's stylesheet, injected once, for every canvas in this module.
 *
 * React Flow ships its CSS separately, and a federated remote does not carry
 * its stylesheet to the host, so the canvas injects it (the same pattern as the
 * terminal). Two canvases use it — the knowledge graph and the workflow canvas
 * (design 0026 §6.2) — so the base sheet goes in ONCE under one id, and each
 * canvas adds only its own chrome rules, scoped to its root class, under an id
 * of its own. Before this was shared, whichever canvas injected first under the
 * common id would have stopped the other's rules from ever being added.
 *
 * This module imports React Flow's CSS, so only a canvas chunk may import it:
 * `workflows/chunks_test.ts` keeps it (and `@xyflow`) out of the Home and
 * Workflows overview chunks.
 */

const BASE_ID = 'adhar-xyflow-css'

/** The controls / minimap / edge-label chrome every canvas wants, scoped to `.${scope}`. */
export function chromeRules(scope: string): string {
  const s = `.${scope}`
  return `${s} .react-flow__attribution{display:none}
${s} .react-flow__controls{box-shadow:none;border:1px solid var(--color-edge-default);border-radius:10px;overflow:hidden}
${s} .react-flow__controls-button{background:var(--color-surface-raised);border-bottom:1px solid var(--color-edge-subtle);color:var(--color-content-muted)}
${s} .react-flow__controls-button:hover{background:var(--color-surface-sunken)}
${s} .react-flow__controls-button svg{fill:currentColor}
${s} .react-flow__minimap{border:1px solid var(--color-edge-default);border-radius:10px;overflow:hidden;background:var(--color-surface-raised)}
${s} .react-flow__edge-textbg{fill:var(--color-surface-raised)}
${s} .react-flow__edge-text{fill:var(--color-content-muted);font-size:10px}
`
}

/**
 * Inject React Flow's base stylesheet (once per document) and, when given, the
 * rules for one canvas scope (once per scope). Safe to call on every render.
 */
export function ensureFlowCss(scope?: string, rules?: string): void {
  if (typeof document === 'undefined') return
  if (!document.getElementById(BASE_ID)) {
    const el = document.createElement('style')
    el.id = BASE_ID
    el.textContent = flowCss
    document.head.appendChild(el)
  }
  if (!scope) return
  const id = `${BASE_ID}-${scope}`
  if (document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = rules ?? chromeRules(scope)
  document.head.appendChild(el)
}
