import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Spinner, StatusBadge, useGiteaOrg } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  getStoredBranch,
  getStoredRepo,
  setStoredBranch,
  setStoredRepo,
  useBranches,
  useRepo,
} from '../data/git.ts'
import { RepoPicker } from '../components/repo-picker.tsx'

/**
 * Embedded Visual Studio Code experience.
 *
 * The IDE pane is a sandboxed iframe pointing at a configurable VS Code
 * server. We default to the Adhar-hosted `code-server` deployment when
 * `ADHAR_VSCODE_URL` is set, and fall back to `vscode.dev` so the page
 * always renders something useful in dev.
 *
 * What this page owns:
 *   - Repo + branch context (synced to localStorage)
 *   - Building the iframe URL with the right `?folder` / Gitea path
 *   - Connection-status banner (waiting / connected / unreachable)
 *   - Quick actions: open in dedicated tab, reload, copy clone URL
 *
 * The previous in-house Monaco UI was a placeholder. code-server gives a
 * real VS Code: extensions, terminal, debugger — full fidelity.
 */

const FALLBACK_HOST = 'https://vscode.dev'

function getVscodeHost(): string {
  if (typeof globalThis === 'undefined') return FALLBACK_HOST
  const w = globalThis as { ADHAR_VSCODE_URL?: string }
  return w.ADHAR_VSCODE_URL ?? FALLBACK_HOST
}

function buildVscodeUrl(host: string, org: string, repo?: string, branch?: string): string | null {
  if (!repo) return null
  const stripped = host.replace(/\/$/, '')
  if (host.includes('vscode.dev')) {
    // vscode.dev opens a Gitea path the same way as a github.dev path.
    return `${stripped}/${org}/${repo}${branch ? `/tree/${encodeURIComponent(branch)}` : ''}`
  }
  // code-server takes `?folder=`. Branch is informational; users switch from
  // VS Code's Source Control view.
  const url = new URL(stripped)
  url.searchParams.set('folder', `/workspaces/${repo}`)
  if (branch) url.searchParams.set('branch', branch)
  return url.toString()
}

type ConnectionStatus = 'idle' | 'loading' | 'ready' | 'error'

export function Ide() {
  const [repo, setRepo] = useState<string | undefined>(undefined)
  const [branch, setBranch] = useState<string | undefined>(undefined)
  const [reloadKey, setReloadKey] = useState(0)
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [showSettings, setShowSettings] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Restore last selection
  useEffect(() => {
    const r = getStoredRepo()
    if (r) setRepo(r)
  }, [])

  useEffect(() => {
    if (!repo) return
    setStoredRepo(repo)
    const b = getStoredBranch(repo)
    if (b) setBranch(b)
    else setBranch(undefined)
  }, [repo])

  useEffect(() => {
    if (repo && branch) setStoredBranch(repo, branch)
  }, [repo, branch])

  const org = useGiteaOrg()
  const repoQ = useRepo(repo)
  const branchesQ = useBranches(repo)

  // Default branch when none is picked yet.
  useEffect(() => {
    if (repo && !branch && repoQ.data?.defaultBranch) {
      setBranch(repoQ.data.defaultBranch)
    }
  }, [repo, branch, repoQ.data?.defaultBranch])

  const vscodeHost = useMemo(() => getVscodeHost(), [])
  const url = useMemo(
    () => buildVscodeUrl(vscodeHost, org, repo, branch),
    [vscodeHost, org, repo, branch],
  )

  // Track iframe load — switch to "ready" once it fires `load`, or "error"
  // after a 12 s timeout (most likely indicates an unreachable code-server).
  useEffect(() => {
    if (!url) {
      setStatus('idle')
      return
    }
    setStatus('loading')
    const timer = window.setTimeout(() => {
      setStatus((s) => (s === 'loading' ? 'error' : s))
    }, 12_000)
    return () => window.clearTimeout(timer)
  }, [url, reloadKey])

  const onIframeLoad = () => setStatus('ready')

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-[520px] flex-col gap-3">
      <Toolbar
        repo={repo}
        onRepoChange={setRepo}
        branch={branch}
        onBranchChange={setBranch}
        branches={branchesQ.data ?? []}
        host={vscodeHost}
        url={url}
        status={status}
        onReload={() => setReloadKey((k) => k + 1)}
        onSettings={() => setShowSettings((v) => !v)}
        repoSshUrl={repoQ.data?.sshUrl}
      />

      {showSettings ? (
        <SettingsBanner host={vscodeHost} onClose={() => setShowSettings(false)} />
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-edge-default bg-slate-950 shadow-sm ring-1 ring-black/5">
        {!url ? (
          <div className="flex h-full items-center justify-center bg-surface-app">
            <EmptyState
              title="Pick a repository to open"
              description="Visual Studio Code launches here with the selected repo + branch checked out."
            />
          </div>
        ) : (
          <>
            <iframe
              key={`${url}-${reloadKey}`}
              ref={iframeRef}
              src={url}
              title="Visual Studio Code"
              onLoad={onIframeLoad}
              className="absolute inset-0 h-full w-full border-0 bg-slate-950"
              allow="clipboard-read; clipboard-write; cross-origin-isolated"
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals allow-presentation allow-storage-access-by-user-activation"
            />
            {status === 'loading' ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/80 text-slate-200">
                <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/90 px-4 py-3 text-sm shadow-2xl">
                  <Spinner size={14} />
                  <span>
                    Booting VS Code{' '}
                    <span className="font-mono text-[11px] text-slate-400">
                      {repo}
                      {branch ? `@${branch}` : ''}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}
            {status === 'error' ? (
              <UnreachableOverlay host={vscodeHost} onRetry={() => setReloadKey((k) => k + 1)} />
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function Toolbar({
  repo,
  onRepoChange,
  branch,
  onBranchChange,
  branches,
  host,
  url,
  status,
  onReload,
  onSettings,
  repoSshUrl,
}: {
  repo?: string
  onRepoChange(r: string): void
  branch?: string
  onBranchChange(b: string): void
  branches: { name: string }[]
  host: string
  url: string | null
  status: ConnectionStatus
  onReload(): void
  onSettings(): void
  repoSshUrl?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0078d4] text-white shadow-sm">
          <VsCodeGlyph />
        </span>
        <RepoPicker value={repo} onChange={onRepoChange} />
        {repo ? (
          <select
            value={branch ?? ''}
            onChange={(e) => onBranchChange(e.target.value)}
            className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 font-mono text-[12px] text-content shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          >
            {branches.length === 0 ? <option value="">main</option> : null}
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        ) : null}
        <ConnectionPill status={status} host={host} />
      </div>

      <div className="flex items-center gap-1.5">
        {repoSshUrl ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigator.clipboard?.writeText(repoSshUrl)}
            title="Copy SSH clone URL"
          >
            <CopyGlyph /> SSH
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onReload} disabled={!url}>
          <ReloadGlyph /> Reload
        </Button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 text-xs font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
          >
            <ExternalGlyph /> Open in tab
          </a>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onSettings} aria-label="VS Code settings">
          <GearGlyph />
        </Button>
      </div>
    </div>
  )
}

function ConnectionPill({ status, host }: { status: ConnectionStatus; host: string }) {
  const isVscodeDev = host.includes('vscode.dev')
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium',
        status === 'ready'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : status === 'loading'
            ? 'border-sky-200 bg-sky-50 text-sky-700'
            : status === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-edge-default bg-surface-sunken text-content-muted',
      )}
      title={`Backed by ${host}`}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'ready'
            ? 'bg-emerald-500'
            : status === 'loading'
              ? 'animate-pulse bg-sky-500'
              : status === 'error'
                ? 'bg-rose-500'
                : 'bg-content-subtle',
        )}
      />
      {status === 'ready'
        ? 'VS Code · ready'
        : status === 'loading'
          ? 'Connecting…'
          : status === 'error'
            ? 'Unreachable'
            : 'Idle'}
      {isVscodeDev ? (
        <span className="text-content-subtle">· vscode.dev</span>
      ) : (
        <span className="text-content-subtle">· code-server</span>
      )}
    </span>
  )
}

function SettingsBanner({ host, onClose }: { host: string; onClose(): void }) {
  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/40 px-4 py-3 text-[12px] text-content">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-content">VS Code source</div>
          <p className="mt-1 text-content-muted">
            The IDE iframe loads from{' '}
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px]">{host}</code>.
            Set{' '}
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px]">
              ADHAR_VSCODE_URL
            </code>{' '}
            in the BFF env to point at your self-hosted{' '}
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px]">code-server</code>{' '}
            deployment, e.g. <code className="font-mono">https://vscode.adhar.local</code>.
          </p>
          <p className="mt-2 text-content-muted">
            <StatusBadge kind="info">vscode.dev (default)</StatusBadge> opens public Gitea
            mirrors but cannot edit private repos.{' '}
            <StatusBadge kind="healthy">code-server</StatusBadge> is the full, in-cluster
            Visual Studio Code experience with extensions, terminal, debugger, and Copilot.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="rounded-md p-1 text-content-subtle hover:bg-surface-raised hover:text-content"
        >
          <XGlyph />
        </button>
      </div>
    </div>
  )
}

function UnreachableOverlay({ host, onRetry }: { host: string; onRetry(): void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-slate-950/85 px-6">
      <div className="max-w-md rounded-2xl border border-rose-300 bg-surface-raised p-5 text-sm shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-rose-100 text-rose-700">
            <ErrorGlyph />
          </span>
          <div>
            <div className="font-semibold text-content">VS Code didn't load in time</div>
            <p className="mt-1 text-[12px] text-content-muted">
              The browser couldn't reach{' '}
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">
                {host}
              </code>{' '}
              within 12 s. Confirm code-server is running and reachable, then retry.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={onRetry}>
                <ReloadGlyph /> Retry
              </Button>
              <a
                href={host}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800"
              >
                <ExternalGlyph /> Open directly
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────────── glyphs ─────────── */

function VsCodeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 100 100" fill="currentColor" aria-hidden>
      <path d="M75 12 95 30v40L75 88 30 60V40L75 12Zm-30 38v0l30 18V32L45 50Z" />
    </svg>
  )
}
function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
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
function ExternalGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}
function GearGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
function XGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
function ErrorGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  )
}

export default Ide
