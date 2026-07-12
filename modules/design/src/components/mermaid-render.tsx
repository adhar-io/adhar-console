import { useEffect, useId, useRef, useState } from 'react'

/**
 * Lazy Mermaid renderer.
 *
 * Mermaid is loaded via a `<script>` tag (UMD bundle from jsDelivr) so the
 * browser-native loader handles it — no Vite transform, no esm.sh wrapper,
 * no MF runtime interference. The script sets `window.mermaid` once and we
 * cache the api on `window.__adharMermaid` so every preview reuses it.
 *
 * Mermaid is heavy (~600 KB), so first mount pays the load cost; everything
 * after is instant.
 */

interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  render(id: string, source: string): Promise<{ svg: string }>
  parse?(s: string): boolean
}

declare global {
  interface Window {
    mermaid?: MermaidApi
    __adharMermaid?: Promise<MermaidApi>
  }
}

const CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js'

let initialized = false

function loadMermaid(): Promise<MermaidApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Mermaid requires a browser environment'))
  }
  if (window.__adharMermaid) return window.__adharMermaid

  window.__adharMermaid = new Promise<MermaidApi>((resolve, reject) => {
    if (window.mermaid) {
      resolve(window.mermaid)
      return
    }
    // Reuse an in-flight script tag if one was injected earlier.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-adhar-mermaid="1"]`,
    )
    const onReady = () => {
      if (window.mermaid) resolve(window.mermaid)
      else reject(new Error('Mermaid loaded but window.mermaid is undefined'))
    }
    if (existing) {
      existing.addEventListener('load', onReady)
      existing.addEventListener('error', () => reject(new Error('Failed to load Mermaid')))
      return
    }
    const s = document.createElement('script')
    s.src = CDN_URL
    s.async = true
    s.dataset.adharMermaid = '1'
    s.onload = onReady
    s.onerror = () => reject(new Error(`Failed to load Mermaid from ${CDN_URL}`))
    document.head.appendChild(s)
  }).then((m) => {
    if (!initialized) {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'base',
        themeVariables: {
          // Pulled from the brand token palette — keep diagrams visually
          // consistent with the rest of the console.
          primaryColor: '#eef2ff',
          primaryBorderColor: '#6366f1',
          primaryTextColor: '#0f172a',
          lineColor: '#94a3b8',
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
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
        flowchart: { curve: 'basis', htmlLabels: true, useMaxWidth: true, padding: 12 },
        sequence: { useMaxWidth: true, mirrorActors: false, boxMargin: 8 },
        gantt: { useMaxWidth: true, fontSize: 12, gridLineStartPadding: 24 },
        er: { useMaxWidth: true },
        c4: { useMaxWidth: true },
        themeCSS: `
          .node rect, .node polygon, .node circle, .node ellipse {
            stroke-width: 1.25px;
          }
          .edgeLabel { background-color: #ffffff !important; padding: 2px 4px; }
          .cluster rect { fill: #f8fafc !important; stroke: #cbd5e1 !important; rx: 8; }
          .messageText { font-weight: 500; }
        `,
      })
      initialized = true
    }
    return m
  })

  return window.__adharMermaid
}

let renderCounter = 0

export function MermaidPreview({
  source,
  className,
  fallback,
  fit = true,
}: {
  source: string
  className?: string
  fallback?: React.ReactNode
  /** When true, the rendered SVG is force-fitted to its container width. */
  fit?: boolean
}) {
  const id = useId().replace(/:/g, '_')
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    if (!source.trim()) {
      setLoading(false)
      if (ref.current) ref.current.innerHTML = ''
      return
    }
    // Debounce: cards on the library page mount in bulk; render serially is
    // fine, but we coalesce rapid source changes from the editor.
    const t = setTimeout(() => {
      ;(async () => {
        try {
          const m = await loadMermaid()
          if (!alive) return
          // Mermaid requires globally-unique ids — collisions across instances
          // produce stale cached output.
          const uid = `mmd-${id}-${++renderCounter}`
          const { svg } = await m.render(uid, source)
          if (!alive) return
          if (ref.current) {
            ref.current.innerHTML = svg
            if (fit) makeSvgResponsive(ref.current)
          }
          setLoading(false)
        } catch (e) {
          if (!alive) return
          // Mermaid sometimes leaves a stray error <div> on document.body.
          document
            .querySelectorAll('[id^="dmermaid"], [id^="mmd-"]')
            .forEach((n) => n.parentElement === document.body && n.remove())
          setError(extractError(e))
          setLoading(false)
        }
      })()
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [source, id, fit])

  if (error) {
    return (
      <div className="space-y-1 rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-800">
        <div className="flex items-center gap-1.5 font-semibold">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          Couldn't render diagram
        </div>
        <div className="whitespace-pre-wrap font-mono leading-relaxed">{error}</div>
      </div>
    )
  }

  return (
    <div className={className ?? 'flex w-full justify-center'}>
      {loading ? (
        <div className="flex h-32 items-center gap-2 text-xs text-content-subtle">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-300 border-t-transparent" />
          {fallback ?? 'Rendering diagram…'}
        </div>
      ) : (
        <div ref={ref} className="mermaid-host max-w-full" />
      )}
    </div>
  )
}

/**
 * Mermaid renders SVGs with explicit pixel `width` + `height` attributes.
 * That makes the diagrams overflow tight containers (cards, drawers). Strip
 * the dimensions so the viewBox alone drives scaling, then constrain via CSS.
 */
function makeSvgResponsive(host: HTMLElement) {
  const svg = host.querySelector('svg')
  if (!svg) return
  // Some renderers wrap with explicit width/height in the style attribute too.
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.style.maxWidth = '100%'
  svg.style.height = 'auto'
  svg.style.display = 'block'
}

function extractError(e: unknown): string {
  if (!e) return 'Unknown error'
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** Render a Mermaid source string to standalone SVG (for download). */
export async function renderToSvg(source: string): Promise<string> {
  const m = await loadMermaid()
  const id = `mmd-export-${Math.random().toString(36).slice(2, 8)}`
  const { svg } = await m.render(id, source)
  return svg
}
