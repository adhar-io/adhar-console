import { useState, type ReactElement } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@adhar-console/utils'
import { useToast } from '@adhar-console/shell-ui'
import { coder } from '@adhar-console/api-clients'
import { coderClient, editorOf, ensureRepoWorkspace, ideSessionUrl, useCoderInfo, useRepoWorkspace } from '../data/coder.ts'

/**
 * Open a repository in an IDE running on the cluster — VS Code (code-server in
 * the browser) or IntelliJ IDEA (JetBrains Gateway on the desktop).
 *
 * The rule that makes this honest: **one workspace per repository, owned by
 * the person clicking.** The platform's Coder template takes a `git_repo`
 * parameter, clones it into `/home/coder/<repo>` on every start, and both
 * IDE apps open that folder. So:
 *   • the folder always exists — code-server no longer answers
 *     "Workspace does not exist" for a repo nobody had cloned;
 *   • the workspace belongs to the signed-in user, so Coder's owner-only IDE
 *     apps open for them instead of ending in "Access denied" on a workspace
 *     the console's proxy identity created;
 *   • the first click creates the workspace (a minute or two) and then opens
 *     it; every later click opens it directly.
 *
 * When Coder is not reachable at all the control hides itself.
 */

export interface CloudEnvLaunchProps {
  /** Repository name — the workspace is named after it. */
  repo: string
  /** HTTPS clone URL the template checks out. */
  cloneUrl?: string
  /** Compact icon-only trigger for dense rows. */
  compact?: boolean
  className?: string
}

type Ide = 'vscode' | 'intellij'

export function CloudEnvLaunch({ repo, cloneUrl, compact = false, className }: CloudEnvLaunchProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const info = useCoderInfo()
  const { owner, workspace, isLoading, blocked } = useRepoWorkspace(repo)
  const [busy, setBusy] = useState<Ide | null>(null)

  const dashboard = info.data?.dashboard_url ?? ''
  // Coder unreachable or not configured — don't offer a door that opens onto nothing.
  if (info.isError || (!info.isLoading && !dashboard)) return null

  const open = async (w: coder.Workspace, ide: Ide) => {
    const ed = editorOf(w, ide)
    if (!ed) {
      toast.error(ide === 'vscode' ? 'This environment has no code-server app yet.' : 'This environment has no IntelliJ app yet — it needs the platform template.')
      return
    }
    // The IDE is served from Coder's own domain, where this tab has no
    // session: a plain app link always landed on Coder's sign-in page, and a
    // workspace the visitor could not see answered 404. The BFF mints a
    // short-lived token for the workspace's owner and returns a URL carrying
    // it, which Coder swaps for a cookie on first load.
    const session = await ideSessionUrl({ workspace: w.name, agent: ed.agent, app: ed.app.slug })
    if (session.external) {
      toast.info(
        ide === 'intellij' ? 'Opening JetBrains Gateway…' : 'Opening your desktop editor…',
        { description: 'Install Gateway or Toolbox if nothing happens.' },
      )
      globalThis.location.assign(session.url)
      return
    }
    const tab = globalThis.open(session.url, '_blank', 'noopener,noreferrer')
    // A blocked pop-up is silent — say so rather than leaving a dead click.
    if (!tab) {
      toast.warning('Your browser blocked the new tab', { description: 'Allow pop-ups for the console, or use the link in Cloud Envs.' })
    }
  }

  const launch = async (ide: Ide) => {
    if (busy) return
    if (!owner) {
      toast.error('No Coder account for you yet', { description: blocked })
      return
    }
    setBusy(ide)
    try {
      if (workspace && workspace.latest_build.status === 'running') {
        await open(workspace, ide)
        return
      }
      if (!cloneUrl) {
        toast.error('This repository has no clone URL to check out.')
        return
      }
      let w = workspace
      if (!w) {
        toast.info(`Creating a cloud environment for ${repo} — this takes a minute or two…`)
        w = await ensureRepoWorkspace({ repo, cloneUrl, owner })
      } else if (w.latest_build.status !== 'running') {
        toast.info(`Starting ${w.name}…`)
        await coderClient.startWorkspace(w.id, w.template_active_version_id)
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2_000))
          w = await coderClient.getWorkspace(w.id)
          if (['running', 'failed', 'canceled'].includes(w.latest_build.status)) break
        }
      }
      void qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] })
      if (w.latest_build.status === 'running') {
        // The agent needs a moment after the build to report its apps.
        for (let i = 0; i < 15 && !editorOf(w, ide); i++) {
          await new Promise((r) => setTimeout(r, 2_000))
          w = await coderClient.getWorkspace(w.id)
        }
        await open(w, ide)
      } else {
        toast.error(`${w.name} did not start (${w.latest_build.status}). Opening environments so you can see why.`)
        navigate({ to: '/develop', search: { section: 'environments' } as never })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const state = workspace
    ? workspace.latest_build.status === 'running' ? 'ready' : 'stopped'
    : 'none'
  const hint = (ide: Ide) =>
    // `blocked` already carries the reason and what to do about it.
    blocked
      ? blocked
      : state === 'ready'
      ? `Open ${repo} in ${ide === 'vscode' ? 'VS Code' : 'IntelliJ IDEA'}`
      : state === 'stopped'
        ? `Start your ${repo} environment and open ${ide === 'vscode' ? 'VS Code' : 'IntelliJ IDEA'}`
        : `Create your cloud environment for ${repo} and open ${ide === 'vscode' ? 'VS Code' : 'IntelliJ IDEA'}`

  const btn = (ide: Ide, label: string, Icon: () => ReactElement) => (
    <button
      type='button'
      // A control that cannot work is disabled and says why, rather than
      // looking live and failing on every click.
      disabled={isLoading || Boolean(busy) || Boolean(blocked)}
      onClick={() => void launch(ide)}
      title={hint(ide)}
      className={cn(
        'inline-flex items-center gap-1 border border-edge-default bg-surface-raised text-xs font-medium text-content transition-colors hover:border-brand-400 hover:text-brand-700 disabled:opacity-60 dark:hover:text-brand-300',
        compact ? 'h-7 px-1.5' : 'h-8 px-2',
        ide === 'vscode' ? 'rounded-l-md' : '-ml-px rounded-r-md',
      )}
    >
      {busy === ide ? <Spinner /> : <Icon />}
      {compact ? null : <span>{label}</span>}
    </button>
  )

  return (
    <span className={cn('relative inline-flex', className)}>
      {btn('vscode', 'VS Code', IconVSCode)}
      {btn('intellij', 'IntelliJ IDEA', IconIntelliJ)}
    </span>
  )
}

function Spinner() {
  return <span className='h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent' aria-hidden />
}

function IconVSCode() {
  return (
    <svg width='13' height='13' viewBox='0 0 24 24' fill='currentColor' aria-hidden>
      <path d='M17.6 2.4 8.2 11 4.4 8.1 2 9.4v5.2l2.4 1.3L8.2 13l9.4 8.6 4.4-2.1V4.5l-4.4-2.1zm0 4.1v11L11 12l6.6-5.5z' />
    </svg>
  )
}

function IconIntelliJ() {
  return (
    <svg width='13' height='13' viewBox='0 0 24 24' fill='currentColor' aria-hidden>
      <path d='M3 3h18v18H3V3zm2.5 13.5v2h6v-2h-6zm0-11v2h1.6v5.4H5.5v2h5.4v-2H9.3V7.5h1.6v-2H5.5z' />
    </svg>
  )
}
