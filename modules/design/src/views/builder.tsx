import { useMemo } from 'react'
import { AdharSymbol, Spinner } from '@adhar-console/shell-ui'
import { RemoteModule, loadBuilderApp } from '@adhar-console/mf-utils'
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
        eyebrow={eyebrow ?? MODE_LABEL[mode]}
        onBack={onBack}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm ring-1 ring-black/5">
        <div className="absolute inset-0 overflow-auto">
          <RemoteModule
            loader={loadVisualApp}
            label={MODE_LABEL[mode]}
            componentProps={componentProps}
            fallback={<LoadingPanel label={MODE_LABEL[mode]} />}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The builder's own header.
 *
 * It used to carry a Reload button, a "Module-federated" pill and a footer
 * naming the remote's host and the `VITE_ADHAR_BUILDER_URL` override. All
 * three describe how the page is BUILT, not what it does — the person
 * editing a wireframe has no use for the federation topology, and a config
 * env var is not something to put in front of them. Back stays: when a
 * wireframe is open the builder replaces the list, so it is the only way out.
 *
 * The mark is the real Adhar symbol rather than the generic four-square glyph
 * that stood in for it, on a soft brand-tinted tile instead of a flat fill.
 */
function Toolbar({
  title,
  eyebrow,
  onBack,
}: {
  title: string
  eyebrow: string
  onBack?(): void
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5 shadow-sm">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
          aria-label="Back"
        >
          <BackGlyph />
        </button>
      ) : null}

      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-50 ring-1 ring-inset ring-brand-200/70 dark:bg-brand-500/12 dark:ring-brand-400/25">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/70 to-transparent dark:from-white/10"
        />
        <AdharSymbol size={22} className="relative" />
      </span>

      <div className="min-w-0">
        <div className="truncate text-sm font-semibold tracking-tight text-content">{title}</div>
        <div className="truncate text-[11.5px] text-content-muted">{eyebrow}</div>
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


function BackGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

export default Builder
