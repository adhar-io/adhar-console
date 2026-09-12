import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'
import { coder } from '@adhar-console/api-clients'
import { useCoderInfo, useWorkspaces } from '../data/coder.ts'
import { IconExternal } from './repo-bits.tsx'

/**
 * "Open in Cloud Env" — jump from a repository straight into an editor running
 * on the cluster, in a new tab.
 *
 * A Coder workspace is not per-repository, so this does the honest thing rather
 * than pretending it is:
 *   • it lists the workspaces that are actually **running**, because a stopped
 *     one cannot serve an editor;
 *   • it opens that workspace's editor app (code-server / VS Code) with
 *     `?folder=` pointing at the conventional checkout path, which code-server
 *     honours when the directory exists and otherwise ignores;
 *   • it offers the clone command alongside, since whether the repo is already
 *     checked out depends on the workspace template — so if the folder isn't
 *     there you are one paste away.
 *
 * With no running workspace it routes to Cloud Envs instead of opening a dead
 * tab, and when Coder is not reachable at all the control hides itself.
 */

/** Where workspace templates conventionally check code out. */
function folderFor(repo: string): string {
  return `/home/coder/${repo}`
}

/** The editor app on a workspace's first connected agent, if it has one. */
function editorOf(w: coder.Workspace): { agent: string; app: coder.WorkspaceApp } | null {
  for (const r of w.latest_build.resources ?? []) {
    for (const a of r.agents ?? []) {
      const app = a.apps?.find((x) => /code-server|vscode|code|jetbrains|cursor/i.test(x.slug))
      if (app) return { agent: a.name, app }
    }
  }
  return null
}

export interface CloudEnvLaunchProps {
  /** Repository name — used for the checkout folder hint. */
  repo: string
  /** HTTPS clone URL, offered when the repo may not be checked out yet. */
  cloneUrl?: string
  /** Compact icon-only trigger for dense rows. */
  compact?: boolean
  className?: string
}

export function CloudEnvLaunch({ repo, cloneUrl, compact = false, className }: CloudEnvLaunchProps) {
  const navigate = useNavigate()
  const info = useCoderInfo()
  const workspaces = useWorkspaces()
  const [open, setOpen] = useState(false)

  const dashboard = info.data?.dashboard_url ?? ''
  const running = useMemo(
    () => (workspaces.data ?? []).filter((w) => w.latest_build.status === 'running' && editorOf(w)),
    [workspaces.data],
  )

  // Coder unreachable or not configured — don't offer a door that opens onto
  // nothing.
  if (workspaces.isError || (!workspaces.isLoading && !dashboard)) return null

  const launch = (w: coder.Workspace) => {
    const ed = editorOf(w)
    if (!ed) return
    const base = coder.appUrl(dashboard, w, ed.agent, ed.app)
    if (!base) return
    const url = `${base}${base.includes('?') ? '&' : '?'}folder=${encodeURIComponent(folderFor(repo))}`
    globalThis.open(url, '_blank', 'noopener,noreferrer')
    setOpen(false)
  }

  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        type='button'
        onClick={() => {
          // One running workspace is the common case — go straight there.
          if (running.length === 1) launch(running[0])
          else setOpen((o) => !o)
        }}
        title={
          running.length === 1
            ? `Open ${repo} in ${running[0].name}`
            : running.length
              ? 'Open this repository in a cloud environment'
              : 'Start a cloud environment to open this repository'
        }
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-edge-default bg-surface-raised text-xs font-medium text-content transition-colors hover:border-brand-400 hover:text-brand-700 dark:hover:text-brand-300',
          compact ? 'h-7 px-1.5' : 'h-8 px-2',
        )}
      >
        <IconCloudCode />
        {compact ? null : <span>Cloud Env</span>}
        {!compact && running.length !== 1 ? <IconExternal /> : null}
      </button>

      {open ? (
        <>
          <div className='fixed inset-0 z-30' aria-hidden onClick={() => setOpen(false)} />
          <div className='absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl'>
            {running.length ? (
              <>
                <div className='px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>
                  Open {repo} in
                </div>
                {running.map((w) => (
                  <button
                    key={w.id}
                    type='button'
                    onClick={() => launch(w)}
                    className='block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken'
                  >
                    <div className='truncate text-[12.5px] font-medium text-content'>{w.name}</div>
                    <div className='truncate text-[10.5px] text-content-subtle'>
                      {w.owner_name} · {w.template_display_name || w.template_name}
                    </div>
                  </button>
                ))}
              </>
            ) : (
              <div className='px-2 py-2'>
                <p className='text-[12px] text-content-muted'>
                  No cloud environment is running. Start one and it will show up here.
                </p>
              </div>
            )}

            <div className='mt-1 border-t border-edge-subtle pt-1'>
              <button
                type='button'
                onClick={() => {
                  setOpen(false)
                  navigate({ to: '/develop', search: { section: 'environments' } as never })
                }}
                className='block w-full rounded-md px-2 py-1.5 text-left text-[11.5px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content'
              >
                {running.length ? 'Manage cloud environments →' : 'Start a cloud environment →'}
              </button>
              {cloneUrl ? (
                <button
                  type='button'
                  onClick={() => {
                    void navigator.clipboard?.writeText(`git clone ${cloneUrl}`)
                    setOpen(false)
                  }}
                  title='In case the repository is not checked out in that workspace yet'
                  className='block w-full rounded-md px-2 py-1.5 text-left text-[11.5px] text-content-muted hover:bg-surface-sunken hover:text-content'
                >
                  Copy clone command
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </span>
  )
}

function IconCloudCode() {
  return (
    <svg
      width='13'
      height='13'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      <path d='M6.5 18A4.5 4.5 0 0 1 6 9.05 6 6 0 0 1 17.7 8 4.5 4.5 0 0 1 17.5 18' />
      <path d='m9.5 13.5-1.5 1.5 1.5 1.5' />
      <path d='m14.5 13.5 1.5 1.5-1.5 1.5' />
    </svg>
  )
}
