import { useState } from 'react'
import { Button, Spinner } from '@adhar-console/shell-ui'
import { RemoteModule, getBuilderHost, loadBuilderApp } from '@adhar-console/mf-utils'

/**
 * Code Builder — mounts the shared Adhar Builder via Module Federation
 * with `mode="code"`. Same federated component powers the Design Builder
 * (with `mode="visual"`) so the two pages always stay in sync without
 * duplicated UI.
 *
 * No iframe: the builder mounts directly into the React tree so it shares
 * theme, dark-mode, auth, and router with the host — feels like one app.
 *
 * Setup: set `VITE_ADHAR_BUILDER_URL` to point at the deployed builder;
 * defaults to `http://localhost:5174` for local dev. The actual federation
 * loading happens via the runtime API in `@adhar-console/mf-utils/builder`.
 */

interface BuilderAppProps {
  mode: 'code' | 'visual' | 'workflow' | 'theme'
  docId?: string
  docName?: string
  onSave?(doc: unknown): void
}

const loadCodeApp = () => loadBuilderApp<BuilderAppProps>()

export function CodeBuilder() {
  const host = getBuilderHost()
  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => setReloadKey((k) => k + 1)

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-130 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white shadow-sm">
            <CanvasGlyph />
          </span>
          <div>
            <div className="text-sm font-semibold text-content">Code Builder</div>
            <div className="text-[11px] text-content-muted">
              Federated Adhar Builder · code mode
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Module-federated
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={reload}>
            <ReloadGlyph /> Reload
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm ring-1 ring-black/5">
        <div className="absolute inset-0 overflow-auto">
          <RemoteModule
            key={reloadKey}
            loader={loadCodeApp}
            label="Code Builder"
            componentProps={{ mode: 'code' }}
            fallback={<LoadingPanel label="Code Builder" />}
          />
        </div>
      </div>

      <div className="text-[11px] text-content-subtle">
        External app at{' '}
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[10px] text-content-muted">
          {host}
        </code>{' '}
        · override via{' '}
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[10px] text-content-muted">
          VITE_ADHAR_BUILDER_URL
        </code>
        .
      </div>
    </div>
  )
}

/* ─────────── helpers ─────────── */

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-3 rounded-xl border border-edge-default bg-surface-raised px-4 py-3 text-sm text-content-muted shadow-sm">
        <Spinner size={14} />
        <span>Loading {label}…</span>
      </div>
    </div>
  )
}

function CanvasGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function ReloadGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

export default CodeBuilder
