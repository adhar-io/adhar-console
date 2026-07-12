import { useMemo, useState } from 'react'
import { Button, Spinner } from '@adhar-console/shell-ui'
import { RemoteModule, getBuilderHost, loadBuilderApp } from '@adhar-console/mf-utils'
import { cn } from '@adhar-console/utils'
import type { Wireframe } from '../data/types.ts'

/**
 * Visual Builder — mounts the shared Adhar Builder via Module Federation
 * with `mode="visual"`. Same federated component as the Code Builder
 * (which mounts it with `mode="code"`); the two pages just hand it a
 * different mode and a different document.
 *
 * No iframe: the builder renders directly into the React tree, so it
 * inherits the host's theme, dark-mode, auth, and router. To the user,
 * it feels like one app.
 *
 *   • Standalone: `<Builder />` mounts the builder against a "scratch" doc.
 *   • Embed:      `<BuilderEmbed doc={...} onBack={...} onSave={...} />`
 *                 hands a wireframe to the federated component for editing
 *                 and receives saves through the `onSave` callback.
 *
 * Setup: see `packages/build-config/src/host.ts`. Set
 * `VITE_ADHAR_BUILDER_URL` to point at the deployed builder; defaults to
 * `http://localhost:5174` for local dev.
 */

type BuilderMode = 'visual' | 'workflow' | 'code' | 'theme'

const MODE_LABEL: Record<BuilderMode, string> = {
  visual: 'Visual Builder',
  workflow: 'Workflow Builder',
  code: 'Code Builder',
  theme: 'Theme Builder',
}

export interface BuilderDoc {
  id: string
  kind: 'wireframe'
  name: string
  blocks?: unknown[]
  payload?: Record<string, unknown>
}

interface BuilderAppProps {
  mode: BuilderMode
  docId?: string
  docName?: string
  onSave?(doc: BuilderDoc): void
  onBack?(): void
}

const loadVisualApp = () => loadBuilderApp<BuilderAppProps>()

/* ───────────────────── public API ───────────────────── */

/** Standalone scratch builder — top-level Design tab. */
export function Builder() {
  return (
    <FederatedBuilder
      mode="visual"
      docName="scratch"
      title="Visual Builder"
      eyebrow="Federated Adhar Builder · scratch document"
    />
  )
}

export interface BuilderEmbedProps {
  doc: Wireframe | BuilderDoc
  onSave?(doc: BuilderDoc): void
  onBack?(): void
  embedded?: boolean
  title?: string
  eyebrow?: string
}

/** Edit a specific wireframe doc inside the federated builder. */
export function BuilderEmbed({
  doc,
  onSave,
  onBack,
  embedded = false,
  title,
  eyebrow,
}: BuilderEmbedProps) {
  return (
    <FederatedBuilder
      mode="visual"
      docId={doc.id}
      docName={doc.name}
      onSave={onSave}
      onBack={onBack}
      embedded={embedded}
      title={title ?? doc.name ?? 'Visual Builder'}
      eyebrow={eyebrow}
    />
  )
}

/* ───────────────────── shared shell ───────────────────── */

interface FederatedBuilderProps {
  mode: BuilderMode
  docId?: string
  docName?: string
  onSave?(doc: BuilderDoc): void
  onBack?(): void
  embedded?: boolean
  title?: string
  eyebrow?: string
}

function FederatedBuilder({
  mode,
  docId,
  docName,
  onSave,
  onBack,
  embedded = false,
  title,
  eyebrow,
}: FederatedBuilderProps) {
  const host = getBuilderHost()
  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => setReloadKey((k) => k + 1)

  const componentProps = useMemo(
    () =>
      ({
        mode,
        docId,
        docName,
        onSave,
        onBack,
      }) as Record<string, unknown>,
    [mode, docId, docName, onSave, onBack],
  )

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', !embedded && 'h-[calc(100vh-180px)]')}>
      <Toolbar
        title={title ?? MODE_LABEL[mode]}
        eyebrow={eyebrow ?? `Federated Adhar Builder · ${mode}`}
        host={host}
        onReload={reload}
        onBack={onBack}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm ring-1 ring-black/5">
        <div className="absolute inset-0 overflow-auto">
          <RemoteModule
            key={reloadKey}
            loader={loadVisualApp}
            label={MODE_LABEL[mode]}
            componentProps={componentProps}
            fallback={<LoadingPanel label={MODE_LABEL[mode]} />}
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

function Toolbar({
  title,
  eyebrow,
  host,
  onReload,
  onBack,
}: {
  title: string
  eyebrow: string
  host: string
  onReload(): void
  onBack?(): void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm">
      <div className="flex items-center gap-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
            aria-label="Back"
          >
            <BackGlyph />
          </button>
        ) : null}
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white shadow-sm">
          <CanvasGlyph />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-content">{title}</div>
          <div className="truncate text-[11px] text-content-muted">{eyebrow}</div>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
          title={`Backed by ${host}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Module-federated
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={onReload}>
          <ReloadGlyph /> Reload
        </Button>
      </div>
    </div>
  )
}

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

function BackGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

export default Builder
