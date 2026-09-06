import { useMemo, useState } from 'react'
import { Button, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { PodTerminal, type TerminalAction } from './pod-terminal.tsx'

/**
 * Cloud Shell — a multi-session, in-browser terminal into the cluster, running
 * as the signed-in user (per-user RBAC via the exec gateway).
 *
 * Sessions are **tabbed**: open as many as you like, each into a pod/container
 * ("Pod exec") or into the platform tools pod with kubectl + k9s + helm
 * ("Cluster shell"). Tabs keep their live sessions when you switch between them,
 * so long-running commands (a `k9s` view, a `tail -f`) survive navigation within
 * Cloud Shell. Each terminal carries the full toolbar — search, copy/paste,
 * clear, reconnect, font-size, download and fullscreen.
 *
 * Every exec is authorized as *you*; the shell process runs with the target
 * pod's service account.
 */

interface PodLike extends KubeObject {
  spec?: { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> }
  status?: { phase?: string }
}

type Mode = 'pod' | 'cluster'

/** Where the kubectl/k9s tools pod lives, and how it is labeled. */
const TOOLS_NAMESPACE = 'adhar-system'
const TOOLS_LABEL = 'app=cloud-shell'
/** Try bash, fall back to sh — a single argv that works on either image. */
const SHELL_COMMAND = ['/bin/sh', '-c', 'exec /bin/bash 2>/dev/null || exec /bin/sh']

const CLUSTER_ACTIONS: TerminalAction[] = [
  { label: 'Launch k9s', send: 'k9s\n', title: 'Open the k9s terminal UI' },
  { label: 'get pods -A', send: 'kubectl get pods -A\n', title: 'kubectl get pods --all-namespaces' },
  { label: 'get nodes', send: 'kubectl get nodes -o wide\n', title: 'kubectl get nodes -o wide' },
  { label: 'helm ls -A', send: 'helm list -A\n', title: 'helm list --all-namespaces' },
]

interface Session {
  id: string
  kind: Mode
  namespace: string
  pod: string
  container: string
  command?: string[]
  actions?: TerminalAction[]
  label: string
}

let seq = 0
const nextId = () => `s${++seq}-${Date.now().toString(36)}`

export function CloudShell({ namespace: initialNs }: { namespace?: string } = {}) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(true)

  const open = (s: Omit<Session, 'id'>) => {
    const id = nextId()
    setSessions((prev) => [...prev, { ...s, id }])
    setActiveId(id)
    setLaunching(false)
  }

  const close = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      setActiveId((cur) => {
        if (cur !== id) return cur
        return next.length ? next[next.length - 1].id : null
      })
      if (next.length === 0) setLaunching(true)
      return next
    })
  }

  return (
    <div className="space-y-3">
      {/* Tab bar */}
      <div className="flex items-center gap-1.5 overflow-x-auto rounded-xl border border-edge-default bg-surface-raised px-1.5 py-1.5 shadow-sm">
        {sessions.map((s) => (
          <SessionTab
            key={s.id}
            session={s}
            active={s.id === activeId && !launching}
            onSelect={() => {
              setActiveId(s.id)
              setLaunching(false)
            }}
            onClose={() => close(s.id)}
          />
        ))}
        <button
          type="button"
          onClick={() => setLaunching(true)}
          title="New session"
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors',
            launching
              ? 'bg-brand-600 text-white'
              : 'text-content-muted hover:bg-surface-sunken hover:text-content',
          )}
        >
          <IconPlus /> New session
        </button>
        {sessions.length > 0 ? (
          <span className="ml-auto shrink-0 pr-1 text-[11px] text-content-subtle">
            {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {/* Launcher (shown until a session is opened, or when adding a new tab) */}
      {launching ? <SessionLauncher initialNs={initialNs} onLaunch={open} /> : null}

      {/* Terminals — kept mounted so tabs preserve their live sessions. */}
      {sessions.map((s) => (
        <div key={s.id} hidden={launching || s.id !== activeId} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2 text-sm shadow-sm">
            <StatusBadge kind={s.kind === 'cluster' ? 'healthy' : 'info'} dot={false}>
              {s.kind === 'cluster' ? 'cluster shell' : 'pod exec'}
            </StatusBadge>
            <span className="font-mono text-xs text-content-muted">
              {s.namespace} / {s.pod}
              {s.container ? ` · ${s.container}` : ''}
            </span>
            {s.kind === 'cluster' ? (
              <span className="text-xs text-content-subtle">kubectl · k9s · helm on PATH</span>
            ) : null}
          </div>
          <PodTerminal
            namespace={s.namespace}
            pod={s.pod}
            container={s.container}
            command={s.command}
            actions={s.actions}
          />
        </div>
      ))}
    </div>
  )
}

function SessionTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: Session
  active: boolean
  onSelect(): void
  onClose(): void
}) {
  return (
    <div
      className={cn(
        'group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs font-medium transition-colors',
        active
          ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20'
          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
      )}
    >
      <button type="button" onClick={onSelect} className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            session.kind === 'cluster' ? 'bg-emerald-500' : 'bg-sky-500',
          )}
        />
        <span className="max-w-40 truncate">{session.label}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close session"
        aria-label={`Close ${session.label}`}
        className="inline-flex h-4 w-4 items-center justify-center rounded text-content-subtle opacity-60 hover:bg-rose-500/15 hover:text-rose-600 group-hover:opacity-100"
      >
        <IconX />
      </button>
    </div>
  )
}

/* ─────────── Session launcher ─────────── */

function SessionLauncher({
  initialNs,
  onLaunch,
}: {
  initialNs?: string
  onLaunch(s: Omit<Session, 'id'>): void
}) {
  const [mode, setMode] = useState<Mode>('pod')
  return (
    <div className="space-y-4 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-edge-default bg-surface-sunken p-0.5">
          {(
            [
              ['pod', 'Pod exec'],
              ['cluster', 'Cluster shell'],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? 'primary' : 'ghost'}
              onClick={() => setMode(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-content-subtle">
          Opens in a new tab — your identity &amp; Kubernetes RBAC apply.
        </span>
      </div>
      {mode === 'cluster' ? (
        <ClusterLauncher initialNs={initialNs} onLaunch={onLaunch} />
      ) : (
        <PodLauncher initialNs={initialNs} onLaunch={onLaunch} />
      )}
    </div>
  )
}

function ClusterLauncher({
  initialNs,
  onLaunch,
}: {
  initialNs?: string
  onLaunch(s: Omit<Session, 'id'>): void
}) {
  const toolPods = useLiveList<PodLike>(GVRS.pods, {
    namespace: TOOLS_NAMESPACE,
    labelSelector: TOOLS_LABEL,
  })
  const running = useMemo(
    () => toolPods.data.find((p) => p.status?.phase === 'Running'),
    [toolPods.data],
  )
  const container = running?.spec?.containers?.[0]?.name

  if (toolPods.isLoading) {
    return (
      <EmptyState
        compact
        title="Looking for the cluster tools pod…"
        description={`Searching for a Running pod labeled ${TOOLS_LABEL} in ${TOOLS_NAMESPACE}.`}
      />
    )
  }
  if (!running || !container) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
        <StatusBadge kind="paused" dot={false}>
          unavailable
        </StatusBadge>
        <div>
          <p className="font-medium">Cluster shell tools pod not deployed.</p>
          <p className="mt-0.5 text-xs opacity-80">
            A Running pod labeled <code className="font-mono">{TOOLS_LABEL}</code> in{' '}
            <code className="font-mono">{TOOLS_NAMESPACE}</code> (with kubectl/k9s/helm) is required.
            Use <strong>Pod exec</strong> instead until it is deployed.
          </p>
        </div>
      </div>
    )
  }
  const podName = running.metadata?.name ?? ''
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge kind="healthy">tools pod ready</StatusBadge>
      <span className="font-mono text-xs text-content-muted">
        {TOOLS_NAMESPACE} / {podName}
      </span>
      <Button
        size="sm"
        className="ml-auto"
        onClick={() =>
          onLaunch({
            kind: 'cluster',
            namespace: TOOLS_NAMESPACE,
            pod: podName,
            container,
            command: SHELL_COMMAND,
            actions: CLUSTER_ACTIONS,
            label: 'Cluster shell',
          })
        }
      >
        Open cluster shell
      </Button>
    </div>
  )
}

function PodLauncher({
  initialNs,
  onLaunch,
}: {
  initialNs?: string
  onLaunch(s: Omit<Session, 'id'>): void
}) {
  const [namespace, setNamespace] = useState<string | undefined>(initialNs)
  const [pod, setPod] = useState<string | undefined>(undefined)
  const [container, setContainer] = useState<string | undefined>(undefined)

  const pods = useLiveList<PodLike>(GVRS.pods, { namespace })
  const running = useMemo(
    () => pods.data.filter((p) => p.status?.phase === 'Running' || p.status?.phase === undefined),
    [pods.data],
  )
  const selectedPod = useMemo(() => running.find((p) => p.metadata?.name === pod), [running, pod])
  const containers = useMemo(
    () =>
      [
        ...(selectedPod?.spec?.containers ?? []),
        ...(selectedPod?.spec?.initContainers ?? []),
      ].map((c) => c.name),
    [selectedPod],
  )
  const effectiveContainer = container && containers.includes(container) ? container : containers[0]
  const ns = selectedPod?.metadata?.namespace ?? namespace ?? 'default'

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Namespace">
        <NamespacePicker
          value={namespace}
          onChange={(v) => {
            setNamespace(v)
            setPod(undefined)
            setContainer(undefined)
          }}
        />
      </Field>
      <Field label="Pod">
        <select
          value={pod ?? ''}
          onChange={(e) => {
            setPod(e.target.value || undefined)
            setContainer(undefined)
          }}
          className="h-9 min-w-56 rounded-md border border-edge-default bg-surface-raised px-2.5 text-sm text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
        >
          <option value="">
            {pods.isLoading ? 'Loading pods…' : running.length ? 'Select a pod…' : 'No running pods'}
          </option>
          {running.map((p) => (
            <option key={p.metadata?.uid ?? p.metadata?.name} value={p.metadata?.name}>
              {p.metadata?.name}
              {p.metadata?.namespace && !namespace ? ` · ${p.metadata.namespace}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {containers.length > 1 ? (
        <Field label="Container">
          <select
            value={effectiveContainer ?? ''}
            onChange={(e) => setContainer(e.target.value || undefined)}
            className="h-9 min-w-40 rounded-md border border-edge-default bg-surface-raised px-2.5 text-sm text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
          >
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Button
        size="sm"
        className="ml-auto"
        disabled={!selectedPod || !effectiveContainer}
        onClick={() =>
          selectedPod &&
          effectiveContainer &&
          onLaunch({
            kind: 'pod',
            namespace: ns,
            pod: pod!,
            container: effectiveContainer,
            label: `${pod}${containers.length > 1 ? `·${effectiveContainer}` : ''}`,
          })
        }
      >
        Open shell
      </Button>
    </div>
  )
}

/* ─────────── bits ─────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">
        {label}
      </span>
      {children}
    </label>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconX() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export default CloudShell
