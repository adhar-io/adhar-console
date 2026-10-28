import { withDeadline } from './http-hardening.ts'

/**
 * The database's line in `/readyz`: reported, never a gate, and never slow.
 *
 * The console serves the SPA, the Kubernetes-backed views and the BFF without
 * Postgres, so a database outage must not take its pod out of the `console`
 * Service. Reporting the ping instead of failing on it was not enough on its
 * own, because the ping had no deadline: postgres.js waits up to its 15s
 * `connect_timeout` for a new connection, and a query on a pooled connection
 * whose peer has gone (the database's node lost, its node-local volume with it)
 * waits on TCP retransmission far longer. The kubelet abandons the probe at 5s,
 * three misses mark the pod NotReady, and with one replica the Gateway answers
 * "no healthy upstream" for a dependency the console does not need to serve.
 *
 * `/readyz` runs this BEFORE the OIDC discovery probe (3s deadline), so the two
 * deadlines together must stay inside the probe's 5s timeout.
 */
export const DB_PING_DEADLINE_MS = 1500

export type DbReadiness = 'ok' | 'down' | 'unconfigured'

export async function dbReadiness(
  configured: boolean,
  ping: () => Promise<boolean>,
  deadlineMs: number = DB_PING_DEADLINE_MS,
): Promise<DbReadiness> {
  if (!configured) return 'unconfigured'
  try {
    return (await withDeadline(ping(), deadlineMs, `database ping timed out after ${deadlineMs}ms`)) ? 'ok' : 'down'
  } catch {
    return 'down'
  }
}
