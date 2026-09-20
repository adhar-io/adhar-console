/**
 * Incidents derived from Prometheus's `ALERTS` series — the missing half of
 * the Overview's DORA tiles.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DERIVABLE AFTER ALL
 * ---------------------------------------------------------------------------
 * MTTR was shown as "—" with "needs incident source", on the reasoning that
 * Prometheus `/api/v1/alerts` only lists what is firing *now*, so there is
 * nothing to measure a recovery against. That is true of that endpoint, and
 * false of Prometheus: the rule evaluator writes an `ALERTS` time series for
 * every firing alert, and that series is range-queryable like any other. An
 * alert's firing window is the contiguous run of samples, and the gap after
 * the last one is the recovery.
 *
 * Verified against the live cluster with this module's own code: 30 alert
 * series over 7 days became 30 incidents, 14 of them resolved, for a median
 * recovery of 1.2h. So the number exists — it just needed asking for over a
 * range rather than at an instant.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS THAT MAKE THIS WRONG IF IGNORED
 * ---------------------------------------------------------------------------
 * 1. **Alerts that never resolve.** `Watchdog` fires permanently on purpose —
 *    it is the dead-man's switch that proves the alerting pipeline is alive —
 *    and `InfoInhibitor` exists only to suppress other alerts. Counted as
 *    incidents they are unbounded outliers that swallow the mean.
 *
 * 2. **Incidents still open at the end of the window.** On this cluster 16 of
 *    30 runs were still firing. They have no recovery time *yet*; folding them
 *    in as though they had recovered at the query end reports an MTTR lower
 *    than reality, which is the direction that matters — it would say service
 *    is being restored faster than it is.
 *
 * Kept free of React and of the HTTP client so both rules are testable.
 */

/** One `ALERTS` series as Prometheus returns it from `query_range`. */
export interface AlertSeries {
  /** Label set, including `alertname`, `severity`, and usually `namespace`. */
  metric: Record<string, string>
  /** `[unixSeconds, value]` pairs, ascending. */
  values: Array<[number, string]>
}

export interface Incident {
  alertname: string
  severity: string
  namespace: string | null
  /** The workload the alert names, when it names one. */
  workload: string | null
  startMs: number
  endMs: number
  /** Duration in ms. Accurate to the query step — see `incidentsFromSeries`. */
  durationMs: number
  /** False when the alert was still firing at the end of the window. */
  resolved: boolean
}

/**
 * Alerts that fire by design and never recover, so they are not incidents.
 *
 * `Watchdog` is part of every kube-prometheus install and fires forever;
 * `InfoInhibitor` exists only so other alerts can be suppressed against it.
 */
export const NON_INCIDENT_ALERTS = new Set(['Watchdog', 'InfoInhibitor'])

/** Severities that describe service impact. `info`/`none` are notifications. */
export const INCIDENT_SEVERITIES = new Set(['critical', 'warning'])

/**
 * Split each series into contiguous firing runs.
 *
 * A gap larger than 1.5 steps means the alert stopped firing and started
 * again — that is two incidents, not one long one. The 1.5 factor tolerates
 * the jitter between the rule evaluation interval and the query step without
 * merging genuinely separate incidents.
 *
 * Duration is `end - start + step`: the alert was firing at its last sample
 * and not at the next one, so the true duration lies in `[end-start,
 * end-start+step)`. Taking the top of that interval means a one-sample blip
 * is reported as `step` rather than as a zero-minute incident, which is both
 * closer to the truth and not a number anyone has to explain.
 *
 * @param endMs  the end of the queried window; a run reaching it is unresolved
 */
export function incidentsFromSeries(
  series: AlertSeries[],
  stepMs: number,
  endMs: number,
): Incident[] {
  const gap = stepMs * 1.5
  const out: Incident[] = []

  for (const s of series) {
    const alertname = s.metric.alertname ?? ''
    const severity = s.metric.severity ?? ''
    if (NON_INCIDENT_ALERTS.has(alertname)) continue
    if (!INCIDENT_SEVERITIES.has(severity)) continue

    const times = s.values
      .map(([t]) => t * 1000)
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b)
    if (times.length === 0) continue

    let runStart = times[0]
    let prev = times[0]
    const runs: Array<[number, number]> = []
    for (const t of times.slice(1)) {
      if (t - prev > gap) {
        runs.push([runStart, prev])
        runStart = t
      }
      prev = t
    }
    runs.push([runStart, prev])

    for (const [start, end] of runs) {
      // Still firing when the window closed → no recovery time yet.
      const resolved = end < endMs - gap
      out.push({
        alertname,
        severity,
        namespace: s.metric.namespace || null,
        workload: s.metric.deployment || s.metric.statefulset || s.metric.pod || null,
        startMs: start,
        endMs: end,
        durationMs: end - start + stepMs,
        resolved,
      })
    }
  }

  return out.sort((a, b) => a.startMs - b.startMs)
}

export interface MttrSummary {
  /** Median recovery time in hours, or null when nothing has recovered yet. */
  medianHours: number | null
  meanHours: number | null
  /** How many recoveries the figure is based on — shown so it can be judged. */
  resolvedCount: number
  /** Still firing, and therefore deliberately excluded. */
  ongoingCount: number
}

/**
 * MTTR over the resolved incidents.
 *
 * The median leads because recovery times are long-tailed — one incident
 * nobody noticed over a weekend drags a mean far past anything typical — and
 * a headline tile should describe the usual case. The mean is returned too so
 * a caller can show both.
 */
export function mttrSummary(incidents: Incident[]): MttrSummary {
  const resolved = incidents.filter((i) => i.resolved)
  const ongoingCount = incidents.length - resolved.length
  if (resolved.length === 0) {
    return { medianHours: null, meanHours: null, resolvedCount: 0, ongoingCount }
  }
  const hours = resolved.map((i) => i.durationMs / 3_600_000).sort((a, b) => a - b)
  const mid = Math.floor(hours.length / 2)
  const median = hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2
  const mean = hours.reduce((s, h) => s + h, 0) / hours.length
  return { medianHours: median, meanHours: mean, resolvedCount: resolved.length, ongoingCount }
}

/* ─────────────────────── change failure rate ─────────────────────── */

export interface DeployEvent {
  /** Destination namespace of the Argo CD application. */
  namespace: string | null
  atMs: number
  /**
   * Names of the workloads this application owns (Deployment / StatefulSet /
   * DaemonSet), used to attribute an incident to the deploy that caused it.
   *
   * Namespace alone is not enough. On a real Adhar cluster 80 of 81 Argo CD
   * applications deploy into `adhar-system`, so "an incident in the namespace
   * you deployed into" matches essentially every deploy — measured here, it
   * reported a 98.2% change failure rate, which says something about the
   * cluster's background alert noise and nothing about the changes.
   */
  workloads: string[]
}

export interface ChangeFailureSummary {
  /** 0..1, or null when nothing deployed in the window. */
  rate: number | null
  failed: number
  total: number
}

/** How long after a deploy an incident is attributed to it. */
export const CHANGE_FAILURE_WINDOW_MS = 60 * 60_000

/**
 * Whether an incident is about a given workload.
 *
 * Alerts name a workload in one of three labels. `deployment` and
 * `statefulset` are exact. `pod` is not: a Deployment's pods are named
 * `<deployment>-<replicaset-hash>-<pod-hash>`, so a prefix test is what
 * relates `payments-api-7d9f8b6c4-x2k9p` back to `payments-api`. The trailing
 * dash matters — without it `payments` would also claim `payments-web`.
 */
export function incidentTouchesWorkload(incident: Incident, workload: string): boolean {
  if (!incident.workload || !workload) return false
  if (incident.workload === workload) return true
  return incident.workload.startsWith(`${workload}-`)
}

/**
 * Change failure rate: the share of deploys followed by a NEW incident naming
 * one of the workloads that deploy owns.
 *
 * This is the Four Keys definition — "deployments causing degraded service" —
 * and it needs both halves, which is why it could not be computed from Argo CD
 * alone. Argo CD's `status.history` records a revision and a timestamp but no
 * outcome, so the previous tile fell back to the share of *applications* whose
 * single most recent sync operation had failed: a point-in-time snapshot of
 * sync health, not a rate of change failure over a window, and it moved when
 * an app was re-synced rather than when a change broke something.
 *
 * Two rules keep the number meaningful:
 *
 *   • Only incidents that START after the deploy count. An alert already
 *     firing beforehand is pre-existing damage; blaming it on whatever
 *     deployed next makes every deploy into an unhealthy namespace look
 *     causal.
 *   • Attribution is by workload, not by namespace — see `DeployEvent`.
 *
 * A deploy that owns no workloads (a ConfigMap-only application, of which
 * there are many) cannot be attributed either way. It is left out of BOTH
 * halves rather than counted as a success, because scoring un-measurable
 * deploys as passing quietly drives the rate toward zero.
 */
export function changeFailureRate(
  deploys: DeployEvent[],
  incidents: Incident[],
  windowMs: number = CHANGE_FAILURE_WINDOW_MS,
): ChangeFailureSummary {
  const measurable = deploys.filter((d) => d.workloads.length > 0)
  if (measurable.length === 0) return { rate: null, failed: 0, total: 0 }

  // Only incidents that name a workload can be attributed at all.
  const named = incidents.filter((i) => i.workload)

  let failed = 0
  for (const d of measurable) {
    const hit = named.some(
      (i) =>
        i.startMs > d.atMs &&
        i.startMs <= d.atMs + windowMs &&
        (!d.namespace || !i.namespace || i.namespace === d.namespace) &&
        d.workloads.some((w) => incidentTouchesWorkload(i, w)),
    )
    if (hit) failed += 1
  }

  return { rate: failed / measurable.length, failed, total: measurable.length }
}

/** `0.0721` → `7.2%`. */
export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/** Hours → a compact label, shared by the MTTR and lead-time tiles. */
export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}
