import { useEffect, useState } from 'react'
import { type MermaidIssue, parseMermaidError, withDirective } from '../data/mermaid-util.ts'

/**
 * Mermaid, bundled and lazy — no network at runtime.
 *
 * Mermaid is an npm dependency that Vite splits into its own chunk; the
 * dynamic `import()` keeps it out of the initial payload and it is fetched
 * from this origin the first time a diagram is drawn. The api is cached on
 * `globalThis.__adharMermaid` so every preview reuses one instance.
 *
 * `securityLevel: 'strict'` — diagram sources are shared tenant documents, so
 * click handlers and raw HTML in labels are sanitised rather than executed.
 *
 * The preview renders into React state (an SVG string) rather than poking a
 * ref, so the result can never be lost to a spinner unmounting the host node.
 */

interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  render(id: string, source: string): Promise<{ svg: string }>
  parse(source: string, opts?: { suppressErrors?: boolean }): Promise<unknown>
}

declare global {
  // eslint-disable-next-line no-var
  var __adharMermaid: Promise<MermaidApi> | undefined
}

const CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  themeVariables: {
    primaryColor: '#eef2ff',
    primaryBorderColor: '#6366f1',
    primaryTextColor: '#0f172a',
    lineColor: '#94a3b8',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: '13px',
    background: '#ffffff',
    mainBkg: '#eef2ff',
    secondaryColor: '#fef3c7',
    tertiaryColor: '#dcfce7',
    clusterBkg: '#f8fafc',
    clusterBorder: '#cbd5e1',
    edgeLabelBackground: '#ffffff',
    actorBkg: '#eef2ff',
    actorBorder: '#6366f1',
    actorTextColor: '#0f172a',
    signalColor: '#475569',
    signalTextColor: '#0f172a',
    noteBkgColor: '#fef3c7',
    noteBorderColor: '#f59e0b',
  },
  flowchart: { curve: 'basis', htmlLabels: true, useMaxWidth: false, padding: 12 },
  sequence: { useMaxWidth: false, mirrorActors: false, boxMargin: 8 },
  gantt: { useMaxWidth: false, fontSize: 12, gridLineStartPadding: 24 },
  er: { useMaxWidth: false },
  c4: { useMaxWidth: false },
  journey: { useMaxWidth: false },
  class: { useMaxWidth: false },
  state: { useMaxWidth: false },
  themeCSS: `
    .node rect, .node polygon, .node circle, .node ellipse { stroke-width: 1.25px; }
    .edgeLabel { background-color: #ffffff !important; padding: 2px 4px; }
    .cluster rect { fill: #f8fafc !important; stroke: #cbd5e1 !important; rx: 8; }
    .messageText { font-weight: 500; }
  `,
}

export function loadMermaid(): Promise<MermaidApi> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Mermaid requires a browser environment'))
  }
  if (globalThis.__adharMermaid) return globalThis.__adharMermaid
  globalThis.__adharMermaid = import('mermaid')
    .then((mod) => {
      const m = ((mod as { default?: MermaidApi }).default ?? mod) as MermaidApi
      m.initialize(CONFIG)
      return m
    })
    .catch((err) => {
      globalThis.__adharMermaid = undefined
      throw err instanceof Error ? err : new Error(String(err))
    })
  return globalThis.__adharMermaid
}

let renderCounter = 0

/** Mermaid leaves its scratch nodes on <body> when a render throws. */
function cleanupStrays() {
  if (typeof document === 'undefined') return
  document
    .querySelectorAll('body > [id^="dmmd-"], body > [id^="mmd-"], body > [id^="dmermaid"]')
    .forEach((n) => n.remove())
}

/** Render a Mermaid source to an SVG string, or throw a MermaidIssue-able error. */
/**
 * Mermaid keeps global render state (config, scratch DOM), so concurrent
 * renders — a grid of thumbnails mounting at once — clobber each other and
 * surface as bogus syntax errors. Every render goes through one queue.
 */
let queue: Promise<unknown> = Promise.resolve()
function renderSvg(source: string, prefix = 'mmd'): Promise<string> {
  const run = queue.then(() => renderNow(source, prefix))
  queue = run.catch(() => undefined)
  return run
}

async function renderNow(source: string, prefix: string): Promise<string> {
  const m = await loadMermaid()
  const uid = `${prefix}-${Date.now().toString(36)}-${++renderCounter}`
  try {
    const { svg } = await m.render(uid, source)
    return svg
  } finally {
    cleanupStrays()
  }
}

export interface MermaidRenderState {
  svg: string | null
  issue: MermaidIssue | null
  loading: boolean
}

/** Debounced render of `source`; keeps the last good SVG while the user types. */
export function useMermaidSvg(source: string, delay = 200): MermaidRenderState {
  const [state, setState] = useState<MermaidRenderState>({ svg: null, issue: null, loading: true })
  useEffect(() => {
    let alive = true
    if (!source.trim()) {
      setState({ svg: null, issue: null, loading: false })
      return
    }
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      renderSvg(source)
        .then((svg) => alive && setState({ svg, issue: null, loading: false }))
        .catch((e) => alive && setState((s) => ({ svg: s.svg, issue: parseMermaidError(e, source), loading: false })))
    }, delay)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [source, delay])
  return state
}

/**
 * Thumbnail / inline preview. Shows the last good render; on error shows the
 * message unless `quietErrors` (library cards).
 */
export function MermaidPreview({
  source,
  className,
  fallback,
  quietErrors = false,
}: {
  source: string
  className?: string
  fallback?: React.ReactNode
  quietErrors?: boolean
}) {
  const { svg, issue, loading } = useMermaidSvg(source, 120)
  if (issue && !svg) {
    return quietErrors
      ? (
        <div className="flex h-full w-full items-center justify-center text-[11px] text-rose-600">
          Syntax error on line {issue.line}
        </div>
      )
      : (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 font-mono text-xs text-rose-800">
          Line {issue.line}: {issue.message}
        </div>
      )
  }
  if (!svg) {
    return (
      <div className={className ?? 'flex w-full justify-center'}>
        {loading
          ? (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
              {fallback ?? 'Rendering diagram…'}
            </div>
          )
          : null}
      </div>
    )
  }
  return (
    <div
      className={`${className ?? 'flex w-full justify-center'} [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:max-w-full`}
      // Mermaid output, rendered with securityLevel 'strict' (DOMPurify-sanitised).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** Render a Mermaid source string to standalone SVG (for download). */
export async function renderToSvg(source: string, opts: { raster?: boolean } = {}): Promise<string> {
  const src = opts.raster
    ? withDirective(source, { htmlLabels: false, flowchart: { htmlLabels: false } })
    : source
  let svg = await renderSvg(src, 'mmd-export')
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  return svg
}
