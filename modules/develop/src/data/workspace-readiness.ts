import type { coder } from '@adhar/api-clients'

/**
 * Whether a cloud development environment can actually be used.
 *
 * The page read `latest_build.status` and called anything `running` ready. A
 * Coder build reaching `running` only means the pod started — the agent inside
 * it then has to connect back, and if it cannot, the workspace sits there
 * reporting `running` forever with nothing able to attach to it.
 *
 * That is not hypothetical. A workspace whose owner was dormant built fine,
 * reported `running`, and its agent was refused:
 *
 *   401: User is not active (status = "dormant")
 *
 * The console showed "1 running" and offered VS Code and IntelliJ buttons that
 * could only ever open a dead app. Build state and usability are two different
 * questions, and the page has to answer the second one.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export type Readiness =
  /** The agent is connected and reports itself ready. */
  | 'ready'
  /** Pod is up, agent has not finished connecting. Normal, briefly. */
  | 'starting'
  /** Pod is up and the agent is not coming. Needs a human. */
  | 'unreachable'
  /** A build is in flight. */
  | 'building'
  | 'stopped'
  | 'failed'
  | 'unknown'

export interface WorkspaceState {
  readiness: Readiness
  /** Short label for a badge. */
  label: string
  /** Only true when an IDE could actually open. */
  usable: boolean
  /** Agent name, when there is one. */
  agent?: string
  /** Why it is not usable, in one line. */
  reason?: string
}

const BUILDING = new Set(['pending', 'starting', 'stopping', 'canceling', 'deleting'])
const STOPPED = new Set(['stopped', 'canceled', 'deleted'])

/** Agent states Coder reports that mean it is never going to connect. */
const DEAD_AGENT = new Set(['timeout', 'disconnected'])

export function primaryAgent(w: coder.Workspace): coder.WorkspaceAgent | undefined {
  for (const r of w.latest_build?.resources ?? []) {
    const a = r.agents?.[0]
    if (a) return a
  }
  return undefined
}

export function workspaceState(w: coder.Workspace): WorkspaceState {
  const status = w.latest_build?.status ?? ''

  if (BUILDING.has(status)) return { readiness: 'building', label: 'Building', usable: false }
  if (status === 'failed') return { readiness: 'failed', label: 'Failed', usable: false }
  if (STOPPED.has(status)) {
    return { readiness: 'stopped', label: status === 'stopped' ? 'Stopped' : 'Gone', usable: false }
  }
  if (status !== 'running') return { readiness: 'unknown', label: status || 'Unknown', usable: false }

  const agent = primaryAgent(w)
  if (!agent) {
    // A running build with no agent at all is a template that declares none;
    // there is nothing to open, and saying "Running" would imply there is.
    return {
      readiness: 'unreachable',
      label: 'No agent',
      usable: false,
      reason: 'This workspace has no Coder agent, so no IDE can attach to it.',
    }
  }

  const agentStatus = (agent.status ?? '').toLowerCase()
  if (DEAD_AGENT.has(agentStatus)) {
    return {
      readiness: 'unreachable',
      label: agentStatus === 'timeout' ? 'Agent timed out' : 'Agent lost',
      usable: false,
      agent: agent.name,
      reason: agentStatus === 'timeout'
        ? 'The pod is running but its agent never connected back to Coder, so nothing can attach. Check that the workspace owner’s Coder account is active.'
        : 'The agent was connected and has dropped. The environment is running but cannot be opened until it reconnects.',
    }
  }

  if (agentStatus !== 'connected') {
    return {
      readiness: 'starting',
      label: 'Connecting',
      usable: false,
      agent: agent.name,
      reason: 'The pod is up and the agent is still connecting.',
    }
  }

  // Connected, but the startup script may still be running — Coder reports
  // that separately, and an IDE opened mid-startup lands in a half-built home.
  const life = (agent.lifecycle_state ?? '').toLowerCase()
  if (life === 'start_error') {
    return {
      readiness: 'unreachable',
      label: 'Start failed',
      usable: true,
      agent: agent.name,
      reason: 'The agent connected but the startup script failed. The IDE will open into an incomplete environment.',
    }
  }
  if (life && life !== 'ready' && life !== 'start_timeout') {
    return {
      readiness: 'starting',
      label: 'Preparing',
      usable: false,
      agent: agent.name,
      reason: 'The agent is running the startup script — cloning the repository and installing tools.',
    }
  }

  return { readiness: 'ready', label: 'Ready', usable: true, agent: agent.name }
}

export interface ReadinessTally {
  ready: number
  starting: number
  unreachable: number
  building: number
  stopped: number
  failed: number
}

export function tallyReadiness(list: coder.Workspace[]): ReadinessTally {
  const t: ReadinessTally = { ready: 0, starting: 0, unreachable: 0, building: 0, stopped: 0, failed: 0 }
  for (const w of list) {
    const s = workspaceState(w).readiness
    if (s === 'ready') t.ready++
    else if (s === 'starting') t.starting++
    else if (s === 'unreachable') t.unreachable++
    else if (s === 'building') t.building++
    else if (s === 'failed') t.failed++
    else if (s === 'stopped') t.stopped++
  }
  return t
}
