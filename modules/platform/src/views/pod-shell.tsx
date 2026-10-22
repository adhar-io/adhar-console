import { useState } from 'react'
import { Button, canResource, useAccessReview } from '@adhar/shell-ui'
import { clusterParam, useActiveCluster } from '../data/client.ts'
import { GVRS } from '../data/gvr.ts'
import { AccessDenied } from '../components/role-gate.tsx'
import { PodTerminal } from './pod-terminal.tsx'

/**
 * Pod exec panel.
 *
 * Wires the container picker to an interactive xterm.js terminal (see
 * `pod-terminal.tsx`), which streams keystrokes over the `execPod` WebSocket
 * channel and renders the remote TTY.
 *
 * Connecting is `create pods/exec` in the pod's namespace (Kubernetes RBAC, as
 * the signed-in user): the Connect button exists only once that is allowed, and
 * a definite "no" replaces the panel with a notice naming the rule.
 */

export function PodShell({
  namespace,
  name,
  containers,
  defaultContainer,
}: {
  namespace: string
  name: string
  containers: string[]
  defaultContainer?: string
}) {
  const execCheck = canResource(GVRS.pods, 'create', { namespace, name, subresource: 'exec' })
  const exec = useAccessReview(execCheck)
  const canExec = exec.allowed
  const { cluster } = useActiveCluster()
  const [container, setContainer] = useState<string>(defaultContainer ?? containers[0] ?? '')
  const [connected, setConnected] = useState(false)

  if (exec.results[0] === false) {
    return <AccessDenied what="a shell in this pod" check={execCheck} />
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <label htmlFor={`pod-shell-container-${name}`} className="text-[11px] font-medium text-content-subtle">
          Container
        </label>
        <select
          id={`pod-shell-container-${name}`}
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          disabled={connected}
          className="h-8 min-w-0 max-w-[16rem] truncate rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 disabled:opacity-60"
        >
          {containers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-content-subtle">
          {connected ? 'session active' : 'disconnected'}
        </span>
        {connected ? (
          <Button size="sm" variant="secondary" onClick={() => setConnected(false)}>
            Disconnect
          </Button>
        ) : canExec ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              if (!container) return
              setConnected(true)
            }}
          >
            Connect
          </Button>
        ) : null}
      </div>

      {connected && canExec ? (
        <PodTerminal key={`${name}/${container}`} namespace={namespace} pod={name} container={container} cluster={clusterParam(cluster)} />
      ) : (
        <div className="rounded-xl border border-dashed border-edge-default bg-surface-sunken p-10 text-center">
          <div className="text-sm font-medium text-content">Exec into this pod</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-content-muted">
            Opens an interactive terminal against container{' '}
            <code className="font-mono">{container || '—'}</code> over a WebSocket exec channel.
            Your keystrokes stream straight into the container's shell.
          </p>
        </div>
      )}
    </div>
  )
}
