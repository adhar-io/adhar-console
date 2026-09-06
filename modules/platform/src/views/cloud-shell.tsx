import { useMemo, useState } from 'react'
import { Button, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { PodTerminal, type TerminalAction } from './pod-terminal.tsx'

/**
 * Cloud Shell — an in-browser terminal into the cluster, running as the
 * signed-in user (per-user RBAC via the exec gateway). Two modes:
 *
 *  • **Pod exec** — pick a namespace → pod → container and get a live shell
 *    (bash/sh) over WebSocket into that container.
 *  • **Cluster shell** — exec into a platform "tools" pod (labeled
 *    `app=cloud-shell` in `adhar-system`) that ships `kubectl` + `k9s` + `helm`,
 *    so you land in a full cluster shell with one-click k9s and kubectl
 *    snippets. If the tools pod is not deployed, it degrades honestly to
 *    Pod exec.
 *
 * The exec call is authorized as *you* (your identity, your Kubernetes RBAC);
 * the shell process itself runs as the target pod's service account.
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

export function CloudShell({ namespace: initialNs }: { namespace?: string } = {}) {
  const [mode, setMode] = useState<Mode>('pod')

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {mode === 'cluster' ? <ClusterShell initialNs={initialNs} /> : <PodExec initialNs={initialNs} />}
    </div>
  )
}

/* ─────────────────────────── Cluster shell mode ─────────────────────────── */

function ClusterShell({ initialNs }: { initialNs?: string }) {
  const toolPods = useLiveList<PodLike>(GVRS.pods, {
    namespace: TOOLS_NAMESPACE,
    labelSelector: TOOLS_LABEL,
  })

  const running = useMemo(
    () => toolPods.data.find((p) => p.status?.phase === 'Running'),
    [toolPods.data],
  )
  const anyPod = running ?? toolPods.data[0]
  const container = anyPod?.spec?.containers?.[0]?.name

  if (toolPods.isLoading) {
    return (
      <EmptyState
        title="Looking for the cluster tools pod…"
        description={`Searching for a Running pod labeled ${TOOLS_LABEL} in ${TOOLS_NAMESPACE}.`}
      />
    )
  }

  // Honest fallback: no tools pod → say so and drop the user into Pod exec.
  if (!running || !container) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <StatusBadge kind="paused" dot={false}>
            unavailable
          </StatusBadge>
          <div>
            <p className="font-medium">Cluster shell tools pod not deployed — showing pod exec instead.</p>
            <p className="mt-0.5 text-xs opacity-80">
              A Running pod labeled <code className="font-mono">{TOOLS_LABEL}</code> in{' '}
              <code className="font-mono">{TOOLS_NAMESPACE}</code> (with{' '}
              <code className="font-mono">kubectl</code>/<code className="font-mono">k9s</code>/
              <code className="font-mono">helm</code>) is required. It is being added to the platform
              separately. Until then, pick any pod below.
            </p>
          </div>
        </div>
        <PodExec initialNs={initialNs} />
      </div>
    )
  }

  const podName = anyPod!.metadata?.name!

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5 text-sm shadow-sm">
        <StatusBadge kind="healthy">tools pod ready</StatusBadge>
        <span className="font-mono text-xs text-content-muted">
          {TOOLS_NAMESPACE} / {podName}
        </span>
        <span className="text-xs text-content-subtle">
          kubectl · k9s · helm on PATH — you exec as yourself; commands run with the pod's service
          account.
        </span>
      </div>
      <PodTerminal
        key={`cluster/${podName}`}
        namespace={TOOLS_NAMESPACE}
        pod={podName}
        container={container}
        command={SHELL_COMMAND}
        actions={CLUSTER_ACTIONS}
      />
    </div>
  )
}

/* ──────────────────────────── Pod exec mode ─────────────────────────────── */

function PodExec({ initialNs }: { initialNs?: string }) {
  const [namespace, setNamespace] = useState<string | undefined>(initialNs)
  const [pod, setPod] = useState<string | undefined>(undefined)
  const [container, setContainer] = useState<string | undefined>(undefined)

  const pods = useLiveList<PodLike>(GVRS.pods, { namespace })

  const running = useMemo(
    () => pods.data.filter((p) => p.status?.phase === 'Running' || p.status?.phase === undefined),
    [pods.data],
  )
  const selectedPod = useMemo(() => running.find((p) => p.metadata?.name === pod), [running, pod])
  const containers = useMemo(() => {
    const list = [
      ...(selectedPod?.spec?.containers ?? []),
      ...(selectedPod?.spec?.initContainers ?? []),
    ].map((c) => c.name)
    return list
  }, [selectedPod])

  const effectiveContainer = container && containers.includes(container) ? container : containers[0]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
        <Field label="Namespace">
          <NamespacePicker
            value={namespace}
            onChange={(ns) => {
              setNamespace(ns)
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
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-content-subtle">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              pods.status === 'live' ? 'bg-emerald-500' : 'bg-amber-500',
            )}
          />
          {pods.status === 'live' ? 'live' : pods.status}
        </div>
      </div>

      {selectedPod && effectiveContainer ? (
        <PodTerminal
          key={`${namespace}/${pod}/${effectiveContainer}`}
          namespace={selectedPod.metadata?.namespace ?? namespace ?? 'default'}
          pod={pod!}
          container={effectiveContainer}
        />
      ) : (
        <EmptyState
          title="Pick a pod to open a shell"
          description="Select a namespace and a running pod above. The shell runs as you — your Kubernetes RBAC applies."
        />
      )}
    </div>
  )
}

/* ──────────────────────────────── bits ──────────────────────────────────── */

function ModeToggle({ mode, onChange }: { mode: Mode; onChange(m: Mode): void }) {
  return (
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
          onClick={() => onChange(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</span>
      {children}
    </label>
  )
}

export default CloudShell
