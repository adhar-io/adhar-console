import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, EmptyState, StatusBadge, useActiveCluster, useOptionalUser } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { K8sRolePill } from '../components/role-gate.tsx'
import { K8S_ROLE_LABEL, useHasK8sPermission, useK8sCurrentRoles } from '../data/access.ts'
import { clusterParam } from '../data/client.ts'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import {
  BUILTIN_SNIPPETS,
  clearRecents,
  deleteUserSnippet,
  loadOpenSessions,
  loadRecents,
  loadShellPrefs,
  loadUserSnippets,
  pushRecent,
  resolveSnippet,
  saveOpenSessions,
  saveShellPrefs,
  saveUserSnippet,
  shellCommand,
  shellLabel,
  type RecentTarget,
  type RestorableSession,
  type ShellPrefs,
  type Snippet,
} from '../data/shell-snippets.ts'
import { PodTerminal, type PodTerminalHandle, type TerminalAction, type TerminalStatus } from './pod-terminal.tsx'

/**
 * Cloud Shell — an in-browser terminal workbench for the cluster, running as
 * the signed-in user (per-user RBAC via the exec gateway; every session is
 * audited).
 *
 * Layout   — identity / cluster / tools-pod header, a collapsible sidebar
 *            (Launch · Snippets · Recent) and a tabbed terminal workbench with
 *            optional side-by-side **split** panes, a **broadcast** bar that
 *            sends one command to every connected session, and a status bar
 *            (state, target, shell, cols×rows, uptime).
 * Sessions — Cluster shell (kubectl/k9s/helm tools pod) or Pod exec into any
 *            running container; tabs keep live sessions mounted, can be
 *            renamed, duplicated, split, closed (with confirm), and the set
 *            that was open is offered for one-click **restore** on return.
 * Snippets — grouped kubectl / helm / Argo CD / in-container command library
 *            with `{{namespace}}`/`{{pod}}`/`{{container}}` placeholders that
 *            resolve from the active session; paste or run; user snippets are
 *            stored per browser.
 * Keys     — Alt+1…9 switch tabs, Alt+T new, Alt+W close, Alt+B broadcast.
 */

interface PodLike extends KubeObject {
  spec?: { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }>; nodeName?: string }
  status?: { phase?: string; containerStatuses?: Array<{ name: string; ready?: boolean; restartCount?: number }> }
}

type Mode = 'pod' | 'cluster'

/** Where the kubectl/k9s tools pod lives, and how it is labeled. */
const TOOLS_NAMESPACE = 'adhar-system'
const TOOLS_LABEL = 'app=cloud-shell'

const CLUSTER_ACTIONS: TerminalAction[] = [
  { label: 'k9s', send: 'k9s\n', title: 'Open the k9s terminal UI' },
  { label: 'pods -A', send: 'kubectl get pods -A\n', title: 'kubectl get pods --all-namespaces' },
  { label: 'nodes', send: 'kubectl get nodes -o wide\n', title: 'kubectl get nodes -o wide' },
]

interface Session {
  id: string
  kind: Mode
  cluster?: string
  namespace: string
  pod: string
  container: string
  command: string[]
  shell: string
  label: string
  status: TerminalStatus
  startedAt: number
}

const STATUS_DOT: Record<TerminalStatus, string> = {
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-emerald-500',
  disconnected: 'bg-slate-400',
  error: 'bg-rose-500',
}

let seq = 0
const nextId = () => `s${++seq}-${Date.now().toString(36)}`

type SidebarTab = 'launch' | 'snippets' | 'recent'

export function CloudShell({ namespace: initialNs }: { namespace?: string } = {}) {
  const canExec = useHasK8sPermission('pods.exec')
  const user = useOptionalUser()
  const roles = useK8sCurrentRoles()
  const { cluster: activeCluster } = useActiveCluster()
  const clusterName = clusterParam(activeCluster)

  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [splitId, setSplitId] = useState<string | null>(null)
  const [prefs, setPrefsState] = useState<ShellPrefs>(() => loadShellPrefs())
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('launch')
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [restorable, setRestorable] = useState<RestorableSession[]>(() => loadOpenSessions())
  const [recents, setRecents] = useState<RecentTarget[]>(() => loadRecents())
  const [now, setNow] = useState(() => Date.now())
  const handles = useRef(new Map<string, PodTerminalHandle>())

  const setPrefs = useCallback((patch: Partial<ShellPrefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch }
      saveShellPrefs(next)
      return next
    })
  }, [])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const split = splitId && splitId !== activeId ? sessions.find((s) => s.id === splitId) ?? null : null
  const connected = sessions.filter((s) => s.status === 'connected').length

  /* ── open / close ── */
  const open = useCallback(
    (s: Omit<Session, 'id' | 'status' | 'startedAt'>, opts: { split?: boolean } = {}) => {
      const id = nextId()
      setSessions((prev) => [...prev, { ...s, id, status: 'connecting', startedAt: Date.now() }])
      if (opts.split && activeId) setSplitId(id)
      else setActiveId(id)
      setRecents(
        pushRecent({ kind: s.kind, cluster: s.cluster, namespace: s.namespace, pod: s.pod, container: s.container, shell: s.shell }),
      )
      setRestorable([])
      if (s.kind === 'pod') setSidebarTab('snippets')
    },
    [activeId],
  )

  const close = useCallback(
    (id: string, force = false) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) return
      if (!force && prefs.confirmClose && s.status === 'connected' && !globalThis.confirm(`Close "${s.label}"? The shell process will end.`)) return
      handles.current.delete(id)
      setSessions((prev) => {
        const next = prev.filter((x) => x.id !== id)
        setActiveId((cur) => (cur !== id ? cur : next.length ? next[next.length - 1].id : null))
        setSplitId((cur) => (cur === id ? null : cur))
        return next
      })
    },
    [sessions, prefs.confirmClose],
  )

  const closeOthers = (id: string) => sessions.filter((s) => s.id !== id).forEach((s) => close(s.id, true))
  const closeAll = () => {
    if (prefs.confirmClose && connected > 0 && !globalThis.confirm(`Close all ${sessions.length} sessions?`)) return
    sessions.forEach((s) => close(s.id, true))
  }
  const duplicate = (s: Session) => open({ ...s, label: `${s.label} (2)` })
  const rename = (id: string, label: string) => setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, label: label.trim() || s.label } : s)))
  const setStatus = useCallback((id: string, status: TerminalStatus) => {
    setSessions((prev) => prev.map((s) => (s.id === id && s.status !== status ? { ...s, status } : s)))
  }, [])

  const restore = () => {
    for (const r of restorable) {
      open({
        kind: r.kind,
        cluster: r.cluster,
        namespace: r.namespace,
        pod: r.pod,
        container: r.container,
        shell: r.shell,
        command: r.kind === 'cluster' ? shellCommand('auto', '') : shellCommand(prefs.shell, prefs.customShell),
        label: r.label,
      })
    }
    setRestorable([])
  }

  /* ── persist the open set for restore-on-return ── */
  useEffect(() => {
    saveOpenSessions(
      sessions.map((s) => ({ kind: s.kind, cluster: s.cluster, namespace: s.namespace, pod: s.pod, container: s.container, shell: s.shell, label: s.label })),
    )
  }, [sessions])

  /* ── uptime ticker ── */
  useEffect(() => {
    if (!sessions.length) return
    const id = globalThis.setInterval(() => setNow(Date.now()), 1000)
    return () => globalThis.clearInterval(id)
  }, [sessions.length])

  /* ── keyboard shortcuts ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return
      if (/^[1-9]$/.test(e.key)) {
        const s = sessions[Number(e.key) - 1]
        if (s) {
          e.preventDefault()
          setActiveId(s.id)
          requestAnimationFrame(() => handles.current.get(s.id)?.focus())
        }
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault()
        setSidebarTab('launch')
        setPrefs({ sidebar: true })
      } else if (e.key.toLowerCase() === 'w' && activeId) {
        e.preventDefault()
        close(activeId)
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setBroadcastOpen((o) => !o)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [sessions, activeId, close, setPrefs])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [fullscreen])

  /* ── snippet + broadcast plumbing ── */
  const pasteToActive = (text: string, run: boolean) => {
    if (!active) return
    const h = handles.current.get(active.id)
    h?.write(run ? `${text}\n` : text)
    h?.focus()
  }
  const broadcast = (text: string) => {
    let n = 0
    for (const s of sessions) {
      if (s.status !== 'connected') continue
      handles.current.get(s.id)?.write(`${text}\n`)
      n++
    }
    return n
  }

  const toolPods = useLiveList<PodLike>(GVRS.pods, { namespace: TOOLS_NAMESPACE, labelSelector: TOOLS_LABEL })
  const toolsPod = useMemo(() => toolPods.data.find((p) => p.status?.phase === 'Running'), [toolPods.data])

  /** Launch the cluster (kubectl/k9s/helm) shell without going via the sidebar. */
  const launchCluster = useCallback(
    (split?: boolean) => {
      const container = toolsPod?.spec?.containers?.[0]?.name
      if (!toolsPod || !container) return
      open(
        {
          kind: 'cluster',
          cluster: clusterName,
          namespace: TOOLS_NAMESPACE,
          pod: toolsPod.metadata?.name ?? '',
          container,
          command: shellCommand('auto', ''),
          shell: 'bash → sh',
          label: `cluster${clusterName ? `:${clusterName}` : ''}`,
        },
        { split },
      )
    },
    [toolsPod, clusterName, open],
  )

  if (!canExec) {
    return (
      <div className="rounded-2xl border border-edge-default bg-surface-raised p-8 shadow-sm">
        <EmptyState
          title="Cloud Shell needs exec permission"
          description={
            <>
              Opening a shell in a container requires the Developer role or higher. Your current role
              {roles.length ? ` (${roles.map((r) => K8S_ROLE_LABEL[r]).join(', ')})` : ''} can browse but not exec.
            </>
          }
          action={<K8sRolePill perm="pods.exec" />}
        />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-3', fullscreen && 'fixed inset-0 z-40 overflow-hidden bg-surface-app p-3')}>
      {/* ═══════════ status band ═══════════
          The page title lives in the module PageHeader, so this band carries
          the state an operator needs before they type a command: who they are
          acting as, which cluster, whether the tools pod is actually up, and
          what is already running. */}
      {!fullscreen ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <ShellStat
            label="Sessions"
            value={String(sessions.length)}
            hint={sessions.length ? `${connected} connected` : 'none open'}
            tone={sessions.length ? undefined : 'muted'}
          />
          <ShellStat
            label="Acting as"
            value={user?.name || user?.email || 'you'}
            hint={roles.length ? K8S_ROLE_LABEL[roles[0]] : 'every exec is audited'}
          />
          <ShellStat label="Cluster" value={clusterName ?? 'local'} hint="change it in the top bar" mono />
          <ShellStat
            label="Tools pod"
            value={toolPods.isLoading ? 'checking…' : toolsPod ? 'ready' : 'missing'}
            hint={toolsPod ? `${TOOLS_NAMESPACE}/${toolsPod.metadata?.name}` : `no Running pod labeled ${TOOLS_LABEL}`}
            tone={toolPods.isLoading ? 'warn' : toolsPod ? 'ok' : 'bad'}
          />
          <ShellStat
            label="Active shell"
            value={active ? active.shell : '—'}
            hint={active ? `${active.namespace}/${active.pod}` : 'no active session'}
            mono
          />
          <ShellStat
            label="Uptime"
            value={active ? fmtUptime(now - active.startedAt) : '—'}
            hint={active ? active.status : 'start a session to begin'}
            tone={active?.status === 'error' ? 'bad' : active?.status === 'connected' ? 'ok' : undefined}
          />
        </div>
      ) : null}

      {/* ═══════════ actions — left: launch, right: workbench controls ═══════════ */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="primary"
          disabled={!toolsPod}
          title={toolsPod ? 'Open a kubectl / k9s / helm shell on the cluster' : `No Running pod labeled ${TOOLS_LABEL} in ${TOOLS_NAMESPACE}`}
          onClick={() => launchCluster()}
        >
          <IconPrompt /> Cluster shell
        </Button>
        <Button
          size="sm"
          variant="secondary"
          title="Pick a pod and container to exec into"
          onClick={() => { setSidebarTab('launch'); setPrefs({ sidebar: true }) }}
        >
          <IconPlus /> Pod shell
        </Button>
        {active ? (
          <Button size="sm" variant="ghost" title="Open the active session beside itself" onClick={() => setSplitId((cur) => (cur === activeId ? null : activeId))}>
            Split
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <IconBtn label="Broadcast a command to every session (Alt+B)" active={broadcastOpen} onClick={() => setBroadcastOpen((o) => !o)} disabled={sessions.length === 0}>
            <IconBroadcast />
          </IconBtn>
          <IconBtn label={prefs.sidebar ? 'Hide sidebar' : 'Show sidebar'} active={prefs.sidebar} onClick={() => setPrefs({ sidebar: !prefs.sidebar })}>
            <IconSidebar />
          </IconBtn>
          <SettingsMenu prefs={prefs} onChange={setPrefs} />
          <ShortcutsMenu />
          <IconBtn label={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen workbench'} active={fullscreen} onClick={() => setFullscreen((f) => !f)}>
            {fullscreen ? <IconCollapse /> : <IconExpand />}
          </IconBtn>
        </div>
      </div>

      {restorable.length && sessions.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-[12px] text-brand-900 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-100">
          <IconHistory />
          <span>
            You had <strong>{restorable.length}</strong> session{restorable.length === 1 ? '' : 's'} open last time:{' '}
            <span className="font-mono">{restorable.map((r) => r.label).join(', ')}</span>
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Button size="xs" variant="primary" onClick={restore}>Reconnect all</Button>
            <Button size="xs" variant="ghost" onClick={() => { setRestorable([]); saveOpenSessions([]) }}>Dismiss</Button>
          </span>
        </div>
      ) : null}

      {/* ═══════════ body ═══════════ */}
      <div
        className={cn('grid min-h-0 gap-3', prefs.sidebar && 'lg:grid-cols-[300px_minmax(0,1fr)]', fullscreen ? 'flex-1' : 'h-[calc(100vh-17rem)] min-h-[560px]')}
      >
        {prefs.sidebar ? (
          <Sidebar
            tab={sidebarTab}
            onTab={setSidebarTab}
            initialNs={initialNs}
            prefs={prefs}
            clusterName={clusterName}
            toolsPod={toolsPod}
            toolsLoading={toolPods.isLoading}
            canSplit={!!active}
            active={active}
            recents={recents}
            onOpen={open}
            onPaste={pasteToActive}
            onClearRecents={() => setRecents(clearRecents())}
          />
        ) : null}

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
          {/* tab strip */}
          <div className="flex items-center gap-1 border-b border-edge-default bg-surface-sunken px-1.5 py-1">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {sessions.map((s, i) => (
                <SessionTab
                  key={s.id}
                  session={s}
                  index={i}
                  active={s.id === activeId}
                  isSplit={s.id === splitId}
                  onSelect={() => {
                    setActiveId(s.id)
                    requestAnimationFrame(() => handles.current.get(s.id)?.focus())
                  }}
                  onClose={() => close(s.id)}
                  onRename={(l) => rename(s.id, l)}
                  onDuplicate={() => duplicate(s)}
                  onSplit={() => setSplitId((cur) => (cur === s.id ? null : s.id))}
                  onCloseOthers={() => closeOthers(s.id)}
                  onCloseAll={closeAll}
                  onReconnect={() => handles.current.get(s.id)?.reconnect()}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  setSidebarTab('launch')
                  setPrefs({ sidebar: true })
                }}
                title="New session (Alt+T)"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-content-muted hover:bg-surface-raised hover:text-content"
              >
                <IconPlus /> New
              </button>
            </div>
            {split ? (
              <button type="button" onClick={() => setSplitId(null)} className="shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-content-subtle hover:bg-surface-raised hover:text-content" title="Close split pane">
                unsplit
              </button>
            ) : null}
          </div>

          {broadcastOpen && sessions.length ? <BroadcastBar count={connected} onSend={broadcast} onClose={() => setBroadcastOpen(false)} /> : null}

          {/* panes — every session stays mounted so tabs keep their live shells */}
          <div className={cn('relative grid min-h-0 flex-1 gap-2 p-2', split ? 'grid-cols-2' : 'grid-cols-1')}>
            {sessions.length === 0 ? (
              <WorkbenchEmpty
                onLaunch={() => { setSidebarTab('launch'); setPrefs({ sidebar: true }) }}
                onCluster={() => launchCluster()}
                sidebarHidden={!prefs.sidebar}
                toolsReady={!!toolsPod}
              />
            ) : null}
            {sessions.map((s) => {
              const visible = s.id === activeId || s.id === split?.id
              return (
                <div key={s.id} hidden={!visible} className={cn('min-h-0', visible && 'flex flex-col')}>
                  {split ? (
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] text-content-subtle">
                      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[s.status])} />
                      <span className="truncate font-medium text-content-muted">{s.label}</span>
                      {s.id === activeId ? <span className="rounded bg-brand-50 px-1 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">active</span> : null}
                    </div>
                  ) : null}
                  <PodTerminal
                    ref={(h) => {
                      if (h) handles.current.set(s.id, h)
                      else handles.current.delete(s.id)
                    }}
                    fill
                    cluster={s.cluster}
                    namespace={s.namespace}
                    pod={s.pod}
                    container={s.container}
                    command={s.command}
                    actions={s.kind === 'cluster' ? CLUSTER_ACTIONS : undefined}
                    defaultFontSize={prefs.fontSize}
                    onStatus={(st) => setStatus(s.id, st)}
                  />
                </div>
              )
            })}
          </div>

          {/* status bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge-default bg-surface-sunken px-3 py-1 font-mono text-[10.5px] text-content-subtle">
            {active ? (
              <>
                <span className="inline-flex items-center gap-1.5"><span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[active.status])} />{active.status}</span>
                <span className="truncate">{active.cluster ?? 'local'} · {active.namespace}/{active.pod}{active.container ? ` · ${active.container}` : ''}</span>
                <span>shell {active.shell}</span>
                <Geometry id={active.id} handles={handles} tick={now} />
                <span>up {fmtUptime(now - active.startedAt)}</span>
              </>
            ) : (
              <span>no active session</span>
            )}
            <span className="ml-auto hidden items-center gap-1 sm:inline-flex"><IconShield /> exec runs as {user?.email ?? 'you'} · audited</span>
          </div>
        </section>
      </div>
    </div>
  )
}

/* ─────────── sidebar ─────────── */

function Sidebar({
  tab,
  onTab,
  initialNs,
  prefs,
  clusterName,
  toolsPod,
  toolsLoading,
  canSplit,
  active,
  recents,
  onOpen,
  onPaste,
  onClearRecents,
}: {
  tab: SidebarTab
  onTab(t: SidebarTab): void
  initialNs?: string
  prefs: ShellPrefs
  clusterName?: string
  toolsPod?: PodLike
  toolsLoading: boolean
  canSplit: boolean
  active: Session | null
  recents: RecentTarget[]
  onOpen(s: Omit<Session, 'id' | 'status' | 'startedAt'>, opts?: { split?: boolean }): void
  onPaste(text: string, run: boolean): void
  onClearRecents(): void
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex items-center gap-0.5 border-b border-edge-default bg-surface-sunken p-1">
        {(
          [
            ['launch', 'Launch', <IconPlus key="l" />],
            ['snippets', 'Snippets', <IconCode key="s" />],
            ['recent', 'Recent', <IconHistory key="r" />],
          ] as Array<[SidebarTab, string, ReactNode]>
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => onTab(id)}
            className={cn(
              'inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors',
              tab === id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'launch' ? (
          <Launcher initialNs={initialNs} prefs={prefs} clusterName={clusterName} toolsPod={toolsPod} toolsLoading={toolsLoading} canSplit={canSplit} onOpen={onOpen} />
        ) : tab === 'snippets' ? (
          <Snippets active={active} onPaste={onPaste} />
        ) : (
          <Recents recents={recents} prefs={prefs} onOpen={onOpen} onClear={onClearRecents} />
        )}
      </div>
    </aside>
  )
}

/* ─────────── launcher ─────────── */

function Launcher({
  initialNs,
  prefs,
  clusterName,
  toolsPod,
  toolsLoading,
  canSplit,
  onOpen,
}: {
  initialNs?: string
  prefs: ShellPrefs
  clusterName?: string
  toolsPod?: PodLike
  toolsLoading: boolean
  canSplit: boolean
  onOpen(s: Omit<Session, 'id' | 'status' | 'startedAt'>, opts?: { split?: boolean }): void
}) {
  const [mode, setMode] = useState<Mode>(toolsPod ? 'cluster' : 'pod')
  const [namespace, setNamespace] = useState<string | undefined>(initialNs)
  const [podFilter, setPodFilter] = useState('')
  const [pod, setPod] = useState<string | undefined>()
  const [container, setContainer] = useState<string | undefined>()
  const [shell, setShell] = useState<ShellPrefs['shell']>(prefs.shell)
  const [customShell, setCustomShell] = useState(prefs.customShell)

  const pods = useLiveList<PodLike>(GVRS.pods, { namespace, enabled: mode === 'pod' })
  const running = useMemo(
    () =>
      pods.data
        .filter((p) => p.status?.phase === 'Running')
        .filter((p) => !podFilter || (p.metadata?.name ?? '').includes(podFilter) || (p.metadata?.namespace ?? '').includes(podFilter))
        .sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? '')),
    [pods.data, podFilter],
  )
  const selectedPod = useMemo(() => running.find((p) => p.metadata?.name === pod), [running, pod])
  const containers = useMemo(() => [...(selectedPod?.spec?.containers ?? []), ...(selectedPod?.spec?.initContainers ?? [])].map((c) => c.name), [selectedPod])
  const effectiveContainer = container && containers.includes(container) ? container : containers[0]

  const toolsContainer = toolsPod?.spec?.containers?.[0]?.name
  const openCluster = (split?: boolean) =>
    toolsPod &&
    toolsContainer &&
    onOpen(
      {
        kind: 'cluster',
        cluster: clusterName,
        namespace: TOOLS_NAMESPACE,
        pod: toolsPod.metadata?.name ?? '',
        container: toolsContainer,
        command: shellCommand('auto', ''),
        shell: 'bash → sh',
        label: `cluster${clusterName ? `:${clusterName}` : ''}`,
      },
      { split },
    )
  const openPod = (split?: boolean) =>
    selectedPod &&
    effectiveContainer &&
    onOpen(
      {
        kind: 'pod',
        cluster: clusterName,
        namespace: selectedPod.metadata?.namespace ?? namespace ?? 'default',
        pod: pod!,
        container: effectiveContainer,
        command: shellCommand(shell, customShell),
        shell: shellLabel(shell, customShell),
        label: `${pod}${containers.length > 1 ? `·${effectiveContainer}` : ''}`,
      },
      { split },
    )

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-edge-default bg-surface-sunken p-0.5">
        {(
          [
            ['cluster', 'Cluster shell', 'kubectl · k9s · helm'],
            ['pod', 'Pod exec', 'shell into a container'],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={cn('rounded-md px-2 py-1.5 text-left transition-colors', mode === value ? 'bg-surface-raised shadow-sm ring-1 ring-edge-default' : 'hover:bg-surface-raised/60')}
          >
            <div className={cn('text-[12px] font-semibold', mode === value ? 'text-content' : 'text-content-muted')}>{label}</div>
            <div className="text-[10px] text-content-subtle">{hint}</div>
          </button>
        ))}
      </div>

      {mode === 'cluster' ? (
        toolsLoading ? (
          <p className="text-[11px] text-content-subtle">Looking for the tools pod ({TOOLS_LABEL} in {TOOLS_NAMESPACE})…</p>
        ) : !toolsPod || !toolsContainer ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
            <p className="font-medium">Cluster tools pod not deployed.</p>
            <p className="mt-0.5 opacity-80">
              A Running pod labeled <code className="font-mono">{TOOLS_LABEL}</code> in <code className="font-mono">{TOOLS_NAMESPACE}</code> with kubectl/k9s/helm is required. Use <strong>Pod exec</strong> meanwhile.
            </p>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-edge-default p-3">
            <div className="flex items-center gap-2">
              <StatusBadge kind="healthy">ready</StatusBadge>
              <span className="truncate font-mono text-[11px] text-content-muted">{TOOLS_NAMESPACE}/{toolsPod.metadata?.name}</span>
            </div>
            <p className="text-[11px] text-content-subtle">A shell with kubectl, k9s and helm on PATH, authorised as you.</p>
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" className="flex-1" onClick={() => openCluster(false)}>Open cluster shell</Button>
              {canSplit ? <Button size="sm" variant="secondary" title="Open beside the active session" onClick={() => openCluster(true)}><IconSplit /></Button> : null}
            </div>
          </div>
        )
      ) : (
        <div className="space-y-2.5">
          <Field label="Namespace">
            <NamespacePicker value={namespace} onChange={(v) => { setNamespace(v); setPod(undefined); setContainer(undefined) }} />
          </Field>
          <Field label={`Pod${running.length ? ` · ${running.length} running` : ''}`}>
            <input
              value={podFilter}
              onChange={(e) => setPodFilter(e.target.value)}
              placeholder="Filter pods…"
              className="mb-1 h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
            <div className="max-h-56 overflow-y-auto rounded-md border border-edge-default">
              {pods.isLoading ? (
                <p className="px-2 py-3 text-[11px] text-content-subtle">Loading pods…</p>
              ) : running.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-content-subtle">No running pods{podFilter ? ' match' : ''}{namespace ? ` in ${namespace}` : ''}.</p>
              ) : (
                <ul className="divide-y divide-edge-subtle">
                  {running.map((p) => {
                    const name = p.metadata?.name ?? ''
                    const on = name === pod
                    const cs = p.status?.containerStatuses ?? []
                    const ready = cs.filter((c) => c.ready).length
                    const restarts = cs.reduce((s, c) => s + (c.restartCount ?? 0), 0)
                    return (
                      <li key={p.metadata?.uid ?? name}>
                        <button
                          type="button"
                          onClick={() => { setPod(name); setContainer(undefined) }}
                          className={cn('flex w-full flex-col gap-0.5 px-2 py-1.5 text-left transition-colors', on ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-surface-sunken')}
                        >
                          <span className={cn('truncate font-mono text-[11px]', on ? 'text-brand-700 dark:text-brand-300' : 'text-content')}>{name}</span>
                          <span className="flex items-center gap-2 text-[10px] text-content-subtle">
                            {!namespace && p.metadata?.namespace ? <span className="truncate">{p.metadata.namespace}</span> : null}
                            <span>{ready}/{cs.length || (p.spec?.containers?.length ?? 1)} ready</span>
                            {restarts ? <span className={cn(restarts > 3 && 'text-amber-600 dark:text-amber-300')}>{restarts} restarts</span> : null}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </Field>
          {containers.length > 1 ? (
            <Field label="Container">
              <SelectBox value={effectiveContainer ?? ''} onChange={(v) => setContainer(v || undefined)} options={containers.map((c) => [c, c])} />
            </Field>
          ) : null}
          <Field label="Shell">
            <SelectBox
              value={shell}
              onChange={(v) => setShell(v as ShellPrefs['shell'])}
              options={[
                ['auto', 'bash, else sh'],
                ['bash', '/bin/bash'],
                ['sh', '/bin/sh'],
                ['custom', 'Custom command…'],
              ]}
            />
            {shell === 'custom' ? (
              <input
                value={customShell}
                onChange={(e) => setCustomShell(e.target.value)}
                placeholder="/bin/bash -l"
                className="mt-1 h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 font-mono text-[11px] text-content focus:border-brand-400 focus:outline-none"
              />
            ) : null}
          </Field>
          <div className="flex gap-1.5 pt-1">
            <Button size="sm" variant="primary" className="flex-1" disabled={!selectedPod || !effectiveContainer} onClick={() => openPod(false)}>Open shell</Button>
            {canSplit ? <Button size="sm" variant="secondary" disabled={!selectedPod || !effectiveContainer} title="Open beside the active session" onClick={() => openPod(true)}><IconSplit /></Button> : null}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────── snippets ─────────── */

function Snippets({ active, onPaste }: { active: Session | null; onPaste(text: string, run: boolean): void }) {
  const [user, setUser] = useState<Snippet[]>(() => loadUserSnippets())
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState({ label: '', group: 'My snippets', command: '', scope: 'any' as Snippet['scope'] })

  const ctx = { namespace: active?.namespace, pod: active?.kind === 'pod' ? active.pod : undefined, container: active?.kind === 'pod' ? active.container : undefined }
  const scope = active?.kind
  const all = useMemo(() => [...user, ...BUILTIN_SNIPPETS], [user])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((s) => {
      if (scope && s.scope !== 'any' && s.scope !== scope) return false
      if (!needle) return true
      return s.label.toLowerCase().includes(needle) || s.command.toLowerCase().includes(needle) || s.group.toLowerCase().includes(needle)
    })
  }, [all, q, scope])
  const groups = useMemo(() => {
    const m = new Map<string, Snippet[]>()
    for (const s of shown) m.set(s.group, [...(m.get(s.group) ?? []), s])
    return [...m.entries()]
  }, [shown])

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1.5 border-b border-edge-subtle p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search commands…"
          className="h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <div className="flex items-center justify-between text-[10px] text-content-subtle">
          <span>
            {active ? (
              <>for <span className="font-mono text-content-muted">{active.kind === 'cluster' ? 'cluster shell' : `${active.namespace}/${active.pod}`}</span></>
            ) : (
              'open a session to paste'
            )}
          </span>
          <button type="button" onClick={() => setAdding((a) => !a)} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{adding ? 'cancel' : '+ add'}</button>
        </div>
        {adding ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!draft.label.trim() || !draft.command.trim()) return
              setUser(saveUserSnippet({ label: draft.label, group: draft.group || 'My snippets', command: draft.command, scope: draft.scope }))
              setDraft({ label: '', group: 'My snippets', command: '', scope: 'any' })
              setAdding(false)
            }}
            className="space-y-1.5 rounded-md border border-edge-default bg-surface-sunken p-2"
          >
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Label" className="h-7 w-full rounded border border-edge-default bg-surface-app px-2 text-[11px] text-content" />
            <input value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} placeholder="Group" className="h-7 w-full rounded border border-edge-default bg-surface-app px-2 text-[11px] text-content" />
            <textarea value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="Command — use {{namespace}}, {{pod}}, {{container}}" rows={2} className="w-full rounded border border-edge-default bg-surface-app px-2 py-1 font-mono text-[11px] text-content" />
            <div className="flex items-center gap-1.5">
              <SelectBox value={draft.scope} onChange={(v) => setDraft({ ...draft, scope: v as Snippet['scope'] })} options={[['any', 'Any session'], ['cluster', 'Cluster shell'], ['pod', 'Pod exec']]} />
              <Button size="xs" variant="primary" type="submit">Save</Button>
            </div>
          </form>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-content-subtle">No snippets match.</p>
        ) : (
          groups.map(([group, items]) => {
            const isCollapsed = collapsed.has(group)
            return (
              <div key={group} className="border-b border-edge-subtle last:border-b-0">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(group)) n.delete(group); else n.add(group); return n })}
                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle hover:bg-surface-sunken/60"
                >
                  <span className={cn('transition-transform', isCollapsed && '-rotate-90')}><IconChevron /></span>
                  {group}
                  <span className="ml-auto font-mono text-[10px] font-normal normal-case">{items.length}</span>
                </button>
                {!isCollapsed ? (
                  <ul className="pb-1">
                    {items.map((s) => {
                      const cmd = resolveSnippet(s.command, ctx)
                      const needsEdit = /<[a-z-]+>/.test(cmd)
                      return (
                        <li key={s.id} className="group px-1.5">
                          <div className="flex items-start gap-1 rounded-md px-1 py-1 hover:bg-surface-sunken/70">
                            <button type="button" disabled={!active} onClick={() => onPaste(cmd, false)} title={active ? 'Paste into the active terminal' : 'Open a session first'} className="min-w-0 flex-1 text-left disabled:opacity-50">
                              <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-content">
                                {s.label}
                                {s.custom ? <span className="rounded bg-violet-50 px-1 text-[9px] uppercase text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">mine</span> : null}
                              </div>
                              <div className="truncate font-mono text-[10.5px] text-content-subtle" title={cmd}>{cmd}</div>
                            </button>
                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              <MiniBtn title={needsEdit ? 'Contains placeholders — paste and edit' : 'Run now'} disabled={!active || needsEdit} onClick={() => onPaste(cmd, true)}><IconPlay /></MiniBtn>
                              <MiniBtn title="Copy" onClick={() => void navigator.clipboard?.writeText(cmd)}><IconCopy /></MiniBtn>
                              {s.custom ? <MiniBtn title="Delete" onClick={() => setUser(deleteUserSnippet(s.id))}><IconTrash /></MiniBtn> : null}
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ─────────── recents ─────────── */

function Recents({
  recents,
  prefs,
  onOpen,
  onClear,
}: {
  recents: RecentTarget[]
  prefs: ShellPrefs
  onOpen(s: Omit<Session, 'id' | 'status' | 'startedAt'>, opts?: { split?: boolean }): void
  onClear(): void
}) {
  if (!recents.length) {
    return <p className="px-3 py-6 text-center text-[11px] text-content-subtle">Targets you open show up here for one-click reconnects.</p>
  }
  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        <span>Recent targets</span>
        <button type="button" onClick={onClear} className="font-medium normal-case tracking-normal hover:text-rose-600">clear</button>
      </div>
      <ul className="divide-y divide-edge-subtle border-t border-edge-subtle">
        {recents.map((r) => (
          <li key={`${r.kind}-${r.cluster ?? ''}-${r.namespace}-${r.pod}-${r.container}`} className="group flex items-center gap-2 px-3 py-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', r.kind === 'cluster' ? 'bg-emerald-500' : 'bg-sky-500')} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-content">{r.kind === 'cluster' ? 'cluster shell' : `${r.namespace}/${r.pod}`}</div>
              <div className="truncate text-[10px] text-content-subtle">{r.kind === 'pod' ? `${r.container} · ${r.shell} · ` : ''}{fmtAgo(r.lastOpened)}</div>
            </div>
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                onOpen({
                  kind: r.kind,
                  cluster: r.cluster,
                  namespace: r.namespace,
                  pod: r.pod,
                  container: r.container,
                  command: r.kind === 'cluster' ? shellCommand('auto', '') : shellCommand(prefs.shell, prefs.customShell),
                  shell: r.shell,
                  label: r.kind === 'cluster' ? 'cluster' : r.pod,
                })
              }
            >
              Open
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ─────────── tabs ─────────── */

function SessionTab({
  session,
  index,
  active,
  isSplit,
  onSelect,
  onClose,
  onRename,
  onDuplicate,
  onSplit,
  onCloseOthers,
  onCloseAll,
  onReconnect,
}: {
  session: Session
  index: number
  active: boolean
  isSplit: boolean
  onSelect(): void
  onClose(): void
  onRename(label: string): void
  onDuplicate(): void
  onSplit(): void
  onCloseOthers(): void
  onCloseAll(): void
  onReconnect(): void
}) {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [label, setLabel] = useState(session.label)
  const dead = session.status === 'disconnected' || session.status === 'error'
  return (
    <div
      className={cn(
        'group relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[11px] font-medium transition-colors',
        active ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:bg-surface-raised/70 hover:text-content',
        isSplit && !active && 'ring-1 ring-dashed ring-brand-300 dark:ring-brand-500/40',
      )}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[session.status])} title={session.status} />
      {editing ? (
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => { onRename(label); setEditing(false) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onRename(label); setEditing(false) }
            if (e.key === 'Escape') { setLabel(session.label); setEditing(false) }
          }}
          className="h-5 w-32 rounded border border-brand-300 bg-surface-app px-1 text-[11px] text-content focus:outline-none"
        />
      ) : (
        <button type="button" onClick={onSelect} onDoubleClick={() => { setLabel(session.label); setEditing(true) }} title={`${session.namespace}/${session.pod} · double-click to rename · Alt+${index + 1}`} className="inline-flex items-center gap-1.5">
          <span className={cn('text-[9px]', session.kind === 'cluster' ? 'text-emerald-600 dark:text-emerald-300' : 'text-sky-600 dark:text-sky-300')}>{session.kind === 'cluster' ? '⌘' : '▣'}</span>
          <span className="max-w-40 truncate">{session.label}</span>
          {index < 9 ? <kbd className="hidden rounded bg-surface-sunken px-1 font-mono text-[9px] text-content-subtle group-hover:inline">⌥{index + 1}</kbd> : null}
        </button>
      )}
      <button type="button" onClick={() => setMenu((m) => !m)} title="Session actions" aria-label="Session actions" className="inline-flex h-4 w-4 items-center justify-center rounded text-content-subtle opacity-0 hover:bg-surface-sunken group-hover:opacity-100">
        <IconDots />
      </button>
      <button type="button" onClick={onClose} title="Close session (Alt+W)" aria-label={`Close ${session.label}`} className="inline-flex h-4 w-4 items-center justify-center rounded text-content-subtle opacity-60 hover:bg-rose-500/15 hover:text-rose-600 group-hover:opacity-100">
        <IconX />
      </button>
      {menu ? (
        <>
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setMenu(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-44 rounded-lg border border-edge-default bg-surface-raised p-1 text-[11.5px] shadow-xl ring-1 ring-black/5 dark:ring-white/10">
            {(
              [
                ['Rename', () => { setLabel(session.label); setEditing(true) }],
                ['Duplicate', onDuplicate],
                [isSplit ? 'Remove from split' : 'Split beside active', onSplit],
                dead ? ['Reconnect', onReconnect] : null,
                ['Close others', onCloseOthers],
                ['Close all', onCloseAll],
              ].filter(Boolean) as Array<[string, () => void]>
            ).map(([l, fn]) => (
              <button key={l} type="button" onClick={() => { setMenu(false); fn() }} className="block w-full rounded-md px-2 py-1.5 text-left text-content-muted hover:bg-surface-sunken hover:text-content">{l}</button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

/* ─────────── broadcast ─────────── */

function BroadcastBar({ count, onSend, onClose }: { count: number; onSend(text: string): number; onClose(): void }) {
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!text.trim()) return
        const n = onSend(text)
        setSent(`sent to ${n} session${n === 1 ? '' : 's'}`)
        setText('')
        globalThis.setTimeout(() => setSent(null), 2000)
      }}
      className="flex items-center gap-2 border-b border-amber-300/60 bg-amber-50/70 px-2 py-1.5 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-200"><IconBroadcast /> Broadcast</span>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Command to run in all ${count} connected session${count === 1 ? '' : 's'}…`}
        className="h-7 min-w-0 flex-1 rounded-md border border-edge-default bg-surface-app px-2 font-mono text-[11.5px] text-content placeholder:text-content-subtle focus:border-amber-400 focus:outline-none"
      />
      {sent ? <span className="text-[10px] text-emerald-700 dark:text-emerald-300">{sent}</span> : null}
      <Button size="xs" variant="primary" type="submit" disabled={!text.trim() || count === 0}>Send all</Button>
      <button type="button" onClick={onClose} aria-label="Close broadcast" className="rounded p-1 text-content-subtle hover:bg-surface-raised hover:text-content"><IconX /></button>
    </form>
  )
}

/* ─────────── menus ─────────── */

function SettingsMenu({ prefs, onChange }: { prefs: ShellPrefs; onChange(p: Partial<ShellPrefs>): void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <IconBtn label="Terminal preferences" active={open} onClick={() => setOpen((o) => !o)}><IconGear /></IconBtn>
      {open ? (
        <Popover onClose={() => setOpen(false)} className="right-0 w-72">
          <div className="space-y-3 p-2 text-[12px]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Preferences</div>
            <label className="flex items-center justify-between gap-3">
              <span className="text-content-muted">Default font size</span>
              <span className="inline-flex items-center overflow-hidden rounded-md border border-edge-default">
                <button type="button" onClick={() => onChange({ fontSize: Math.max(10, prefs.fontSize - 1) })} className="px-2 text-content-muted hover:bg-surface-sunken">−</button>
                <span className="min-w-7 text-center font-mono text-[11px]">{prefs.fontSize}</span>
                <button type="button" onClick={() => onChange({ fontSize: Math.min(22, prefs.fontSize + 1) })} className="px-2 text-content-muted hover:bg-surface-sunken">+</button>
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-content-muted">Default shell for pod sessions</span>
              <SelectBox value={prefs.shell} onChange={(v) => onChange({ shell: v as ShellPrefs['shell'] })} options={[['auto', 'bash, else sh'], ['bash', '/bin/bash'], ['sh', '/bin/sh'], ['custom', 'Custom command']]} />
              {prefs.shell === 'custom' ? (
                <input value={prefs.customShell} onChange={(e) => onChange({ customShell: e.target.value })} className="mt-1 h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 font-mono text-[11px] text-content" />
              ) : null}
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-content-muted">Confirm before closing a live session</span>
              <input type="checkbox" checked={prefs.confirmClose} onChange={(e) => onChange({ confirmClose: e.target.checked })} className="h-4 w-4 accent-brand-600" />
            </label>
            <p className="text-[10.5px] text-content-subtle">Preferences are stored in this browser. New sessions pick them up; open ones keep their toolbar settings.</p>
          </div>
        </Popover>
      ) : null}
    </div>
  )
}

function ShortcutsMenu() {
  const [open, setOpen] = useState(false)
  const rows: Array<[string, string]> = [
    ['Alt + 1…9', 'Switch to session N'],
    ['Alt + T', 'New session (opens the launcher)'],
    ['Alt + W', 'Close the active session'],
    ['Alt + B', 'Toggle broadcast bar'],
    ['Esc', 'Exit fullscreen'],
    ['Double-click tab', 'Rename session'],
    ['Right-click tab', 'Session actions'],
  ]
  return (
    <div className="relative">
      <IconBtn label="Keyboard shortcuts" active={open} onClick={() => setOpen((o) => !o)}><IconKeyboard /></IconBtn>
      {open ? (
        <Popover onClose={() => setOpen(false)} className="right-0 w-72">
          <div className="p-2">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Shortcuts</div>
            <table className="w-full text-[11.5px]">
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k}>
                    <td className="py-1 pr-2"><kbd className="rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content">{k}</kbd></td>
                    <td className="py-1 text-content-muted">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Popover>
      ) : null}
    </div>
  )
}

/* ─────────── bits ─────────── */

function WorkbenchEmpty({
  onLaunch,
  onCluster,
  sidebarHidden,
  toolsReady,
}: {
  onLaunch(): void
  onCluster(): void
  sidebarHidden: boolean
  toolsReady: boolean
}) {
  return (
    <div className="flex min-h-0 items-center justify-center p-6">
      <div className="w-full max-w-lg text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-emerald-300 shadow-sm ring-1 ring-black/10 dark:bg-slate-800">
          <IconPrompt />
        </span>
        <h3 className="mt-3 text-sm font-semibold text-content">A terminal into the cluster, as you</h3>
        <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-content-muted">
          Sessions run through the exec gateway with your own Kubernetes RBAC — you can only reach what
          you could reach with kubectl, and every session is audited.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={onCluster}
            disabled={!toolsReady}
            className="rounded-xl border border-edge-default bg-surface-app p-3 text-left transition-colors hover:border-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="text-[12.5px] font-medium text-content">Cluster shell</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">
              {toolsReady ? 'kubectl, k9s and helm already on PATH.' : 'The tools pod is not running in this cluster.'}
            </div>
          </button>
          <button
            type="button"
            onClick={onLaunch}
            className="rounded-xl border border-edge-default bg-surface-app p-3 text-left transition-colors hover:border-brand-300"
          >
            <div className="text-[12.5px] font-medium text-content">Pod shell</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">
              Exec into any running container to debug it in place.
            </div>
          </button>
        </div>
        <p className="mt-3 text-[11px] text-content-subtle">
          {sidebarHidden ? 'The launcher lives in the sidebar — ' : ''}
          <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">Alt</kbd>+
          <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">T</kbd> new ·{' '}
          <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">Alt</kbd>+
          <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">1…9</kbd> switch ·{' '}
          <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">Alt</kbd>+
          <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">B</kbd> broadcast
        </p>
      </div>
    </div>
  )
}

/** One tile in the status band. */
function ShellStat({
  label,
  value,
  hint,
  tone,
  mono = false,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'bad' | 'muted'
  mono?: boolean
}) {
  const color =
    tone === 'bad'
      ? 'text-rose-600 dark:text-rose-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'ok'
          ? 'text-emerald-600 dark:text-emerald-400'
          : tone === 'muted'
            ? 'text-content-muted'
            : 'text-content'
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-edge-default bg-surface-raised px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <span className={cn('truncate text-[15px] font-semibold leading-tight tracking-tight', mono && 'font-mono text-[13px]', color)} title={value}>
        {value}
      </span>
      <span className="truncate text-[10.5px] text-content-subtle" title={hint}>{hint ?? ' '}</span>
    </div>
  )
}

function Geometry({ id, handles, tick }: { id: string; handles: React.MutableRefObject<Map<string, PodTerminalHandle>>; tick: number }) {
  const g = useMemo(() => handles.current.get(id)?.geometry() ?? null, [id, handles, tick])
  return g ? <span>{g.cols}×{g.rows}</span> : null
}


function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      {children}
    </div>
  )
}

function SelectBox({ value, onChange, options }: { value: string; onChange(v: string): void; options: Array<[string, string]> }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20">
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  )
}

function Popover({ children, onClose, className }: { children: ReactNode; onClose(): void; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-30" aria-hidden onClick={onClose} />
      <div className={cn('absolute top-full z-40 mt-1.5 rounded-xl border border-edge-default bg-surface-raised shadow-xl ring-1 ring-black/5 dark:ring-white/10', className)}>{children}</div>
    </>
  )
}

function IconBtn({ label, onClick, active = false, disabled = false, children }: { label: string; onClick(): void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function MiniBtn({ title, onClick, disabled = false, children }: { title: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick} className="flex h-6 w-6 items-center justify-center rounded text-content-subtle hover:bg-surface-raised hover:text-brand-700 disabled:opacity-40 dark:hover:text-brand-300">
      {children}
    </button>
  )
}

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ─────────── icons ─────────── */

const I = ({ children, size = 14, sw = 2 }: { children: ReactNode; size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
    {children}
  </svg>
)
const IconPrompt = () => <I size={18} sw={2.25}><path d="m5 7 6 5-6 5" /><path d="M13 17h6" /></I>
const IconBroadcast = () => <I><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4" /><path d="M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2" /></I>
const IconSidebar = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></I>
const IconGear = () => <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>
const IconKeyboard = () => <I><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></I>
const IconExpand = () => <I><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></I>
const IconCollapse = () => <I><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></I>
const IconHistory = () => <I><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></I>
const IconPlus = () => <I size={12} sw={2.5}><path d="M12 5v14M5 12h14" /></I>
const IconX = () => <I size={11} sw={2.5}><path d="M18 6 6 18M6 6l12 12" /></I>
const IconDots = () => <I size={11} sw={2.5}><path d="M5 12h.01M12 12h.01M19 12h.01" /></I>
const IconCode = () => <I size={12}><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></I>
const IconChevron = () => <I size={11}><path d="m6 9 6 6 6-6" /></I>
const IconPlay = () => <I size={11} sw={2.5}><path d="m6 4 14 8-14 8z" /></I>
const IconCopy = () => <I size={11}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>
const IconTrash = () => <I size={11}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></I>
const IconSplit = () => <I size={13}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></I>
const IconShield = () => <I size={11}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></I>

export default CloudShell
