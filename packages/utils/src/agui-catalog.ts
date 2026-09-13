/**
 * The generative-UI catalog — the contract between the agent and the renderer.
 *
 * Two halves of the codebase have to agree on this list and they live on
 * opposite sides of the wire:
 *
 *   • the SERVER builds the `render_ui` tool schema from it, which is the only
 *     way a model learns a component exists, and
 *   • the BROWSER maps each id to a React component in shell-ui's registry.
 *
 * They drifted: the schema listed eight components while the registry had
 * fifteen, so seven were unreachable — the model could not name what it could
 * not see. Keeping the list in one place, in a package both sides already
 * import, is what stops that recurring. It lives in utils rather than shell-ui
 * because the server must not pull a React barrel into its bundle to read a
 * list of strings.
 *
 * Only MODEL-PICKABLE components belong here. The registry also holds
 * components the server maps tool results onto (`pod-diagnostics`,
 * `log-viewer`, `proposal`, …); those are produced by code that knows the tool
 * output's exact shape, and offering them to a model that would have to invent
 * that shape produces worse output than prose.
 */

export interface GenerativeComponentSpec {
  id: string
  /** What it is for, in the terms the model is choosing between. */
  summary: string
  /** The props shape, compactly — this is what the model copies. */
  props: string
}

export const GENERATIVE_CATALOG: readonly GenerativeComponentSpec[] = [
  {
    id: 'table',
    summary: 'rows and columns; the default when several objects share fields',
    props: '{columns:[{key,label,align?}],rows:[{...}]}',
  },
  {
    id: 'metrics',
    summary: 'a row of big current numbers',
    props: '{items:[{label,value,hint?,tone?}]}',
  },
  {
    id: 'stat-grid',
    summary: 'KPI cards with a trend sparkline and change indicator; use over metrics whenever direction matters',
    props: '{items:[{label,value,unit?,delta?,deltaUnit?,direction?:up|down,trend?:[number],hint?,tone?}]} — direction says which way is GOOD (default up)',
  },
  {
    id: 'time-series',
    summary: 'one or more values over time; one series draws a full area chart, several draw compact sparkline rows',
    props: '{series:[{label,points:[number],tone?}],unit?} or {label?,points:[number],unit?}',
  },
  {
    id: 'bar-chart',
    summary: 'labelled magnitudes ranked against each other',
    props: '{items:[{label,value,hint?}],unit?}',
  },
  {
    id: 'gauge',
    summary: 'saturation against a limit — quota, capacity, utilisation; colours itself red past 90%',
    props: '{items:[{label,value,max?,unit?,caption?,tone?}]}',
  },
  {
    id: 'heatmap',
    summary: 'density across buckets — restarts per day, alerts per hour; raw counts, normalised for you',
    props: '{cells:[number],weeks?,unit?,caption?,tone?} — cells run column-major, 7 per column',
  },
  {
    id: 'topology',
    summary: 'a dependency or flow graph — services and what they call, a pipeline, a sync chain',
    props: '{nodes:[{id,label,kind?,status?,layer?}],edges:[{from,to,label?}]} — omit layer and columns are derived from the edges',
  },
  {
    id: 'timeline',
    summary: 'ordered events with timestamps',
    props: '{items:[{at,label,detail?,tone?}]}',
  },
  {
    id: 'checklist',
    summary: 'pass/fail items — a verification, a set of preconditions',
    props: '{items:[{label,status:pass|fail|warn,detail?}]}',
  },
  {
    id: 'comparison',
    summary: 'before/after or expected/actual, side by side',
    props: '{left:{title,items:[{label,value}]},right:{title,items:[{label,value}]}}',
  },
  {
    id: 'diff',
    summary: 'a unified diff — what a change actually does, line by line',
    props: '{path?,diff:"<unified patch text>"} or {path?,lines:[{type:add|del|ctx,text}]}',
  },
  {
    id: 'resource-list',
    summary: 'Kubernetes objects, clickable through to their detail page',
    props: '{items:[{kind,name,namespace?,status?,tone?}]}',
  },
  {
    id: 'callout',
    summary: 'one highlighted statement that must not be missed',
    props: '{tone:info|success|warning|danger,text}',
  },
] as const

/** Component ids a model may pick. */
export const GENERATIVE_COMPONENT_IDS: readonly string[] = GENERATIVE_CATALOG.map((c) => c.id)

/** The `component` enum's description — one line per component. */
export function catalogEnumDescription(): string {
  return GENERATIVE_CATALOG.map((c) => `${c.id}: ${c.summary}`).join('. ')
}

/** The `props` description — the shape to fill in, per component. */
export function catalogPropsDescription(): string {
  return `Shape depends on component. ${GENERATIVE_CATALOG.map((c) => `${c.id}:${c.props}`).join(' · ')}`
}
