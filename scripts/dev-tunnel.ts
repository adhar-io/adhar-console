#!/usr/bin/env -S deno run -A
/**
 * Port-forward the tools that local dev cannot reach any other way.
 *
 *     npm run dev:env      # writes .env, including the tunnelled URLs
 *     npm run dev:tunnel   # opens the forwards (leave running)
 *     npm run dev          # in another terminal
 *
 * Most tools answer on the public ingress and need nothing. A handful sit
 * behind an oauth2-proxy that redirects to Keycloak — prometheus, argocd and
 * metabase among them — and a server-to-server call cannot complete an
 * interactive SSO flow. For those the in-cluster Service is the only usable
 * address, which is what the console uses in production anyway.
 *
 * Which tools, and which local port each gets, comes from `dev-cluster.ts` so
 * this and `dev:env` cannot drift apart.
 *
 * Forwards die when their pod is replaced. This restarts them, with a backoff,
 * rather than leaving a port silently dead — a dead forward looks exactly like
 * a broken tool from inside the console.
 */
import { containerEnv, SSO_GATED, type Tunnel, tunnelsFromEnv } from './dev-cluster.ts'

const NS = Deno.env.get('ADHAR_NAMESPACE') ?? 'adhar-system'
const DEPLOY = Deno.env.get('ADHAR_CONSOLE_DEPLOY') ?? 'adhar-console'

async function sh(cmd: string[]): Promise<string | null> {
  try {
    const { code, stdout } = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: 'piped',
      stderr: 'null',
    }).output()
    return code === 0 ? new TextDecoder().decode(stdout) : null
  } catch {
    return null
  }
}

const json = await sh(['kubectl', 'get', 'deploy', DEPLOY, '-n', NS, '-o', 'json'])
if (!json) {
  console.error(
    `\x1b[31m✗\x1b[0m Could not read deployment "${DEPLOY}" in "${NS}".\n` +
      `  Set ADHAR_CONSOLE_DEPLOY / ADHAR_NAMESPACE if this install names them differently.`,
  )
  Deno.exit(1)
}

const tunnels = tunnelsFromEnv(containerEnv(json), SSO_GATED)
if (tunnels.length === 0) {
  console.log('Nothing to tunnel — every tool is reachable on the public ingress.')
  Deno.exit(0)
}

console.log(`\x1b[1mTunnelling ${tunnels.length} tools from ${NS}\x1b[0m  (ctrl-c to stop)\n`)
for (const t of tunnels) {
  console.log(
    `  \x1b[36m${String(t.localPort)}\x1b[0m → ${t.service}:${t.remotePort}`.padEnd(46) +
      `\x1b[2m${t.varName}\x1b[0m`,
  )
}
console.log()

const children: Deno.ChildProcess[] = []
let stopping = false

/**
 * One forward, kept alive.
 *
 * Restarting on process EXIT is not enough, and that gap is not theoretical:
 * measured here, `kubectl port-forward` to argo-cd-argocd-server stayed
 * running with its listener open while the tunnel behind it was dead — every
 * request hung for 30s and the supervisor never noticed, because the process
 * was perfectly healthy. A stuck forward is indistinguishable from a slow tool
 * from inside the console.
 *
 * kubectl announces it on stderr ("lost connection to pod", "an error occurred
 * forwarding …"), so that is what we watch. Any error line tears the forward
 * down and respawns it.
 */
async function keepAlive(t: Tunnel) {
  let backoffMs = 500
  while (!stopping) {
    const child = new Deno.Command('kubectl', {
      args: [
        'port-forward',
        '-n',
        t.namespace,
        `svc/${t.service}`,
        `${t.localPort}:${t.remotePort}`,
        '--address=127.0.0.1',
      ],
      stdout: 'null',
      stderr: 'piped',
    }).spawn()
    children.push(child)

    // Watch stderr for the forwarding errors kubectl reports without exiting.
    let killedForError = false
    const watchStderr = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stderr) {
        if (stopping) return
        const text = decoder.decode(chunk)
        if (!/error|lost connection|failed/i.test(text)) continue
        killedForError = true
        console.log(
          `\x1b[33m↻\x1b[0m ${t.varName} (:${t.localPort}) ${
            text.trim().split('\n')[0].slice(0, 70)
          } — reconnecting`,
        )
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        return
      }
    })()

    const status = await child.status
    await watchStderr
    if (stopping) return
    if (!killedForError) {
      // Exited on its own: a pod replacement, usually. Say so and reconnect.
      console.log(
        `\x1b[33m↻\x1b[0m ${t.varName} (:${t.localPort}) dropped${
          status.code ? ` [exit ${status.code}]` : ''
        } — reconnecting`,
      )
    }
    await new Promise((r) => setTimeout(r, backoffMs))
    // A forward that survived a while then failed should come back promptly;
    // one failing immediately is a wrong port or missing RBAC, so back off.
    backoffMs = killedForError ? 500 : Math.min(backoffMs * 2, 15_000)
  }
}

const stop = () => {
  if (stopping) return
  stopping = true
  console.log('\nClosing tunnels…')
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  Deno.exit(0)
}
Deno.addSignalListener('SIGINT', stop)
Deno.addSignalListener('SIGTERM', stop)

await Promise.all(tunnels.map(keepAlive))
