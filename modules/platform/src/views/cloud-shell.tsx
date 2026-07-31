import { useMemo, useState } from 'react'
import { EmptyState } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { NamespacePicker } from '../components/namespace-picker.tsx'
import { useLiveList } from '../data/live.ts'
import { GVRS } from '../data/gvr.ts'
import { PodTerminal } from './pod-terminal.tsx'

/**
 * Cloud Shell — an in-browser terminal into any pod in the cluster, running as
 * the signed-in user (per-user RBAC via the exec gateway). Pick a namespace →
 * pod → container and get a live shell (bash/sh) over WebSocket.
 */

interface PodLike extends KubeObject {
  spec?: { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> }
  status?: { phase?: string }
}

export function CloudShell({ namespace: initialNs }: { namespace?: string } = {}) {
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
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-edge-default bg-white p-3 shadow-sm">
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
            className="h-9 min-w-56 rounded-md border border-edge-default bg-white px-2.5 text-sm text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
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
              className="h-9 min-w-40 rounded-md border border-edge-default bg-white px-2.5 text-sm text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</span>
      {children}
    </label>
  )
}

export default CloudShell
