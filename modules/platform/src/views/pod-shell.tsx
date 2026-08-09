import { useState } from 'react'
import { Button } from '@adhar-console/shell-ui'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
import { PodTerminal } from './pod-terminal.tsx'

/**
 * Pod exec panel.
 *
 * Wires the container picker to an interactive xterm.js terminal (see
 * `pod-terminal.tsx`), which streams keystrokes over the `execPod` WebSocket
 * channel and renders the remote TTY.
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
  const canExec = useHasK8sPermission('pods.exec')
  const [container, setContainer] = useState<string>(defaultContainer ?? containers[0] ?? '')
  const [connected, setConnected] = useState(false)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <label className="text-[11px] font-medium text-content-subtle">Container</label>
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          disabled={connected}
          className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs disabled:opacity-60"
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
            onClick={() => {
              if (!container) return
              setConnected(true)
            }}
          >
            Connect
          </Button>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content-muted"
            title="Pod exec requires the Developer or higher role"
          >
            Connect
            <K8sRolePill perm="pods.exec" />
          </span>
        )}
      </div>

      {connected ? (
        <PodTerminal key={`${name}/${container}`} namespace={namespace} pod={name} container={container} />
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
