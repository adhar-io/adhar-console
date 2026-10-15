import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@adhar/utils'
import { useToast } from '@adhar/shell-ui'
import type { coder } from '@adhar/api-clients'
import {
  coderClient,
  editorOf,
  ensureRepoWorkspace,
  ideSessionUrl,
  type IdeKind,
  mainAgent,
  repoFolder,
  useCoderInfo,
  useRepoWorkspace,
} from '../data/coder.ts'

/**
 * Open a repository in an IDE — VS Code Desktop, IntelliJ IDEA (desktop, via
 * JetBrains Gateway) or Code Server in the browser — straight into the
 * repository's folder.
 *
 * One workspace per repository, owned by the person clicking. The platform's
 * Coder template takes a `git_repo` parameter and clones it into
 * `/home/coder/<repo>` on every start, so the folder always exists; the first
 * open creates the workspace (a minute or two), later opens start or reuse it.
 *
 * The control is a split button: the main part opens the IDE used last time
 * (remembered per browser), the chevron offers all three with what each
 * needs. Progress is one toast updated in place, not a stream of them.
 * Code Server reserves its tab on the click itself — a tab opened after a
 * two-minute build is a pop-up, and browsers block it.
 *
 * When Coder is not reachable at all the control hides itself.
 */

export interface CloudEnvLaunchProps {
  /** Repository name — the workspace is named after it. */
  repo: string
  /** HTTPS clone URL the template checks out. */
  cloneUrl?: string
  /** Icon-only trigger for dense rows. */
  compact?: boolean
  className?: string
}

interface IdeDef {
  id: IdeKind
  label: string
  short: string
  where: string
  needs: string
  help?: { label: string; href: string }
  Icon(): ReactElement
}

const IDES: IdeDef[] = [
  {
    id: 'vscode-desktop',
    label: 'VS Code',
    short: 'VS Code',
    where: 'Desktop',
    needs: 'Needs VS Code with the Coder Remote extension.',
    help: { label: 'Install extension', href: 'vscode:extension/coder.coder-remote' },
    Icon: IconVSCode,
  },
  {
    id: 'intellij',
    label: 'IntelliJ IDEA',
    short: 'IntelliJ',
    where: 'Desktop',
    needs: 'Needs JetBrains Gateway (or Toolbox) with the Coder plugin.',
    help: { label: 'Get Gateway', href: 'https://www.jetbrains.com/remote-development/gateway/' },
    Icon: IconIntelliJ,
  },
  {
    id: 'code-server',
    label: 'Code Server',
    short: 'Code Server',
    where: 'Browser',
    needs: 'VS Code in a browser tab — nothing to install. Dark theme by default.',
    Icon: IconBrowserCode,
  },
]

const PREF_KEY = 'adhar.develop.ide'
function loadPref(): IdeKind {
  try {
    const v = localStorage.getItem(PREF_KEY) as IdeKind | null
    if (v && IDES.some((i) => i.id === v)) return v
  } catch { /* storage unavailable */ }
  return 'vscode-desktop'
}
function savePref(v: IdeKind) {
  try {
    localStorage.setItem(PREF_KEY, v)
  } catch { /* storage unavailable */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function CloudEnvLaunch({ repo, cloneUrl, compact = false, className }: CloudEnvLaunchProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const info = useCoderInfo()
  const { owner, workspace, isLoading, blocked, note } = useRepoWorkspace(repo)
  const [busy, setBusy] = useState<IdeKind | null>(null)
  const [pref, setPref] = useState<IdeKind>(loadPref)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const closeMenu = useCallback(() => setMenu(false), [])

  // The menu is portalled and fixed, so table scrollers and cards with
  // `overflow-hidden` cannot clip it; place it under (or over) the trigger.
  useLayoutEffect(() => {
    if (!menu) return
    const place = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const up = r.bottom + 360 > globalThis.innerHeight && r.top > 360
      setPos({ top: up ? r.top - 6 : r.bottom + 6, right: Math.max(8, globalThis.innerWidth - r.right), up })
    }
    place()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeMenu()
      }
    }
    // Outside = neither the menu nor its trigger. (shell-ui's useClickOutside
    // treats anything inside a dialog as inside, and the repo drawer IS a
    // dialog — the menu would never close there.)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || ref.current?.contains(t)) return
      closeMenu()
    }
    globalThis.addEventListener('resize', place)
    globalThis.addEventListener('scroll', place, true)
    globalThis.addEventListener('keydown', onKey, true)
    globalThis.addEventListener('pointerdown', onDown, true)
    return () => {
      globalThis.removeEventListener('resize', place)
      globalThis.removeEventListener('scroll', place, true)
      globalThis.removeEventListener('keydown', onKey, true)
      globalThis.removeEventListener('pointerdown', onDown, true)
    }
  }, [menu, closeMenu])

  const dashboard = info.data?.dashboard_url ?? ''
  // Coder unreachable or not configured — don't offer a door that opens onto nothing.
  if (info.isError || (!info.isLoading && !dashboard)) return null

  const folder = repoFolder(cloneUrl, repo)
  const status = workspace?.latest_build.status
  const state: 'none' | 'running' | 'busy' | 'stopped' = !workspace
    ? 'none'
    : status === 'running'
    ? 'running'
    : ['starting', 'pending', 'stopping', 'canceling', 'deleting'].includes(status ?? '')
    ? 'busy'
    : 'stopped'

  const launch = async (ide: IdeKind) => {
    if (busy) return
    setMenu(false)
    setPref(ide)
    savePref(ide)
    const def = IDES.find((i) => i.id === ide)!
    if (!owner) {
      toast.error('No Coder account for you yet', { description: blocked })
      return
    }

    // Reserve the browser tab NOW, inside the click. Opened after the awaits
    // below it would be a pop-up and most browsers would block it silently.
    let tab: Window | null = null
    if (ide === 'code-server') {
      tab = globalThis.open('', '_blank')
      if (tab) {
        tab.document.title = `Opening ${repo}…`
        tab.document.body.style.cssText =
          'margin:0;height:100vh;display:grid;place-items:center;background:#1f1f1f;color:#ccc;font:14px system-ui,sans-serif'
        tab.document.body.textContent = `Preparing ${repo} in Code Server…`
      }
    }

    const tid = `ide-${repo}`
    const step = (title: string, description?: string) => toast.loading(title, { id: tid, description })
    setBusy(ide)
    try {
      let w: coder.Workspace | undefined = workspace
      if (!w) {
        if (!cloneUrl) throw new Error('This repository has no clone URL to check out.')
        step(`Creating your environment for ${repo}`, 'First open only — usually a minute or two.')
        w = await ensureRepoWorkspace({ repo, cloneUrl, owner })
      } else if (w.latest_build.status !== 'running') {
        step(`Starting ${w.name}`, 'A stopped environment keeps its files; this is a boot, not a rebuild.')
        if (!['starting', 'pending'].includes(w.latest_build.status)) {
          await coderClient.startWorkspace(w.id, w.template_active_version_id)
        }
        for (let i = 0; i < 90; i++) {
          await sleep(2_000)
          w = await coderClient.getWorkspace(w.id)
          if (['running', 'failed', 'canceled'].includes(w.latest_build.status)) break
        }
      }
      void qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] })
      if (w.latest_build.status !== 'running') {
        tab?.close()
        toast.error(`${w.name} did not start (${w.latest_build.status})`, {
          id: tid,
          description: 'Its build log is on the Cloud Envs page.',
          action: { label: 'Open Cloud Envs', onClick: () => navigate({ to: '/develop', search: { section: 'environments' } as never }) },
        })
        return
      }

      // Wait for the agent (and, for Code Server, its app) — the clone runs
      // as a start-up script, so "ready" means the folder is there.
      step(`Connecting to ${w.name}`, `Checking out ${folder}`)
      for (let i = 0; i < 45; i++) {
        const a = mainAgent(w)
        const appOk = ide !== 'code-server' || editorOf(w, 'vscode')
        if (a?.ready && appOk) break
        await sleep(2_000)
        w = await coderClient.getWorkspace(w.id)
      }
      const agent = mainAgent(w)
      if (!agent?.connected) throw new Error(`${w.name} is running but its agent has not connected yet. Try again in a moment.`)

      step(`Opening ${def.label}`, ide === 'code-server' ? undefined : `Hand-off to your desktop ${def.label}`)
      const session = await ideSessionUrl({ workspace: w.name, agent: agent.name, ide, folder })
      if (ide === 'code-server') {
        if (tab && !tab.closed) {
          tab.opener = null
          tab.location.replace(session.url)
          toast.success(`Opened ${repo} in Code Server`, { id: tid, duration: 3000 })
        } else {
          // The tab was blocked (or closed); give a link the person can click.
          toast.warning('Your browser blocked the new tab', {
            id: tid,
            description: 'The environment is ready — open it from here.',
            action: { label: 'Open Code Server', onClick: () => globalThis.open(session.url, '_blank', 'noopener,noreferrer') },
          })
        }
        return
      }
      // A desktop deep link: the OS hands it to the app. Nothing tells the page
      // whether an app took it, so say what should happen and how to recover.
      globalThis.location.assign(session.url)
      toast.info(`Opening ${repo} in ${def.label}…`, {
        id: tid,
        duration: 12_000,
        description: `${def.needs} Nothing happened? Install it, then try again.`,
        action: def.help ? { label: def.help.label, onClick: () => globalThis.open(def.help!.href, '_blank', 'noopener') } : undefined,
      })
    } catch (e) {
      tab?.close()
      toast.error(`Could not open ${repo} in ${def.label}`, { id: tid, description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const primary = IDES.find((i) => i.id === pref)!
  const disabled = isLoading || Boolean(busy) || Boolean(blocked)
  const stateText = {
    none: 'Not created yet — the first open sets it up (a minute or two).',
    running: 'Running — opens right away.',
    busy: `${status} — will open when it is ready.`,
    stopped: 'Stopped — opening starts it (files are kept).',
  }[state]
  const stateDot = { none: 'bg-slate-400', running: 'bg-emerald-500', busy: 'bg-amber-500 animate-pulse', stopped: 'bg-slate-400' }[state]

  return (
    <span ref={ref} className={cn('relative inline-flex', className)} onClick={(e) => e.stopPropagation()}>
      <button
        type='button'
        disabled={disabled}
        onClick={() => void launch(pref)}
        title={blocked ?? `Open ${repo} in ${primary.label} (${primary.where.toLowerCase()})`}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-l-md border border-edge-default bg-surface-raised font-medium text-content transition-colors hover:border-brand-400 hover:text-brand-700 disabled:opacity-60 dark:hover:text-brand-300',
          compact ? 'h-7 px-1.5 text-xs' : 'h-8 px-2.5 text-xs',
        )}
      >
        {busy ? <Spinner /> : <primary.Icon />}
        {compact ? null : <span>Open in {primary.short}</span>}
      </button>
      <button
        type='button'
        disabled={isLoading || Boolean(blocked)}
        onClick={() => setMenu((m) => !m)}
        aria-haspopup='menu'
        aria-expanded={menu}
        aria-label='Choose an IDE'
        title={blocked ?? 'Choose an IDE'}
        className={cn(
          '-ml-px inline-flex items-center rounded-r-md border border-edge-default bg-surface-raised text-content-muted transition-colors hover:border-brand-400 hover:text-content disabled:opacity-60',
          compact ? 'h-7 px-1' : 'h-8 px-1.5',
          menu && 'border-brand-400 text-content',
        )}
      >
        <IconChevron />
      </button>

      {menu && pos && typeof document !== 'undefined' ? createPortal(
        <div
          ref={menuRef}
          role='menu'
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', right: pos.right, ...(pos.up ? { bottom: globalThis.innerHeight - pos.top } : { top: pos.top }) }}
          className='z-70 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl ring-1 ring-black/5 dark:ring-white/10'
        >
          <div className='border-b border-edge-subtle px-3 py-2.5'>
            <div className='text-[12px] font-semibold text-content'>Open {repo} in…</div>
            <div className='mt-0.5 flex items-center gap-1.5 text-[11px] text-content-muted'>
              <i className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateDot)} />
              <span className='truncate'>{stateText}</span>
            </div>
            <div className='mt-0.5 truncate font-mono text-[10px] text-content-subtle'>{folder}</div>
          </div>
          <ul className='p-1'>
            {IDES.map((i) => (
              <li key={i.id}>
                <button
                  type='button'
                  role='menuitem'
                  onClick={() => void launch(i.id)}
                  className='group flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-sunken'
                >
                  <span className='mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-content group-hover:bg-surface-raised'>
                    <i.Icon />
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='flex items-center gap-1.5 text-[13px] font-medium text-content'>
                      {i.label}
                      <span className='rounded-full border border-edge-default px-1.5 text-[10px] font-normal text-content-subtle'>{i.where}</span>
                      {i.id === pref ? <span className='text-[10px] font-normal text-brand-700 dark:text-brand-300'>default</span> : null}
                    </span>
                    <span className='mt-0.5 block text-[11px] leading-snug text-content-muted'>{i.needs}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className='flex items-center justify-between border-t border-edge-subtle px-3 py-2 text-[11px]'>
            <a href='vscode:extension/coder.coder-remote' className='font-medium text-content-muted hover:text-content'>VS Code extension</a>
            <button
              type='button'
              onClick={() => {
                setMenu(false)
                navigate({ to: '/develop', search: { section: 'environments' } as never })
              }}
              className='font-medium text-brand-700 hover:underline dark:text-brand-300'
            >
              Manage environment →
            </button>
          </div>
          {note ? <div className='border-t border-edge-subtle px-3 py-2 text-[10px] text-content-subtle'>{note}</div> : null}
        </div>,
        document.body,
      ) : null}
    </span>
  )
}

function Spinner() {
  return <span className='h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent' aria-hidden />
}

function IconChevron() {
  return (
    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.25' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
      <path d='m6 9 6 6 6-6' />
    </svg>
  )
}

function IconVSCode() {
  return (
    <svg width='14' height='14' viewBox='0 0 24 24' aria-hidden>
      <path fill='#0065A9' d='M17.6 2.4 8.2 11 4.4 8.1 2 9.4v5.2l2.4 1.3L8.2 13l9.4 8.6 4.4-2.1V4.5l-4.4-2.1zm0 4.1v11L11 12l6.6-5.5z' />
    </svg>
  )
}

function IconIntelliJ() {
  return (
    <svg width='14' height='14' viewBox='0 0 24 24' aria-hidden>
      <rect x='2' y='2' width='20' height='20' rx='3' fill='#000' className='dark:fill-white' />
      <path d='M5.5 16.5h6v2h-6zM5.5 5.5h5.4v2H9.3v5.4h1.6v2H5.5v-2h1.6V7.5H5.5z' fill='#fff' className='dark:fill-black' />
    </svg>
  )
}

function IconBrowserCode() {
  return (
    <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
      <rect x='2.5' y='4' width='19' height='16' rx='2' />
      <path d='M2.5 8.5h19' />
      <path d='m10 12.5-2 2 2 2M14 12.5l2 2-2 2' />
    </svg>
  )
}
