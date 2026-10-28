import {
  condition,
  countBucket,
  createdSince,
  get,
  type KubeObject,
  labelsOf,
  links,
  nameOf,
  nsOf,
  type Signal,
  type SignalContext,
  type Source,
} from './signal-kit.ts'

/**
 * The control plane and the cluster under it, as notifications: self-service
 * resources (the `platform.adhar.io` XRs a team asks for) being created,
 * becoming ready, failing and being deleted; nodes joining and leaving; the
 * node autoscaler's decisions; and the resilience gate's verdict on a
 * promotion.
 */

/* ─────────────────────────── control-plane XRs ─────────────────────────── */

/**
 * Every XR kind the control plane defines (`platform/controlplane/configuration/xrd/`
 * in the platform repo — 40 on 2026-10-28). One watch each: an idle watch on
 * an empty resource costs the apiserver next to nothing, and a kind left out
 * here is a self-service request that is created, fails and is deleted in
 * silence. The platform repo's `TestConsoleWatchedResourcesAreGranted` reads
 * this list and fails when an XRD exists that it does not name, or when the
 * console's ServiceAccount is not granted one it does.
 */
export const XR_KINDS: ReadonlyArray<{ kind: string; plural: string }> = [
  { kind: 'AgentWorkload', plural: 'agentworkloads' },
  { kind: 'Application', plural: 'applications' },
  { kind: 'AuthStack', plural: 'authstacks' },
  { kind: 'BackupPolicy', plural: 'backuppolicies' },
  { kind: 'Bucket', plural: 'buckets' },
  { kind: 'Cache', plural: 'caches' },
  { kind: 'Cluster', plural: 'clusters' },
  { kind: 'CompliancePolicy', plural: 'compliancepolicies' },
  { kind: 'CostTracker', plural: 'costtrackers' },
  { kind: 'Database', plural: 'databases' },
  { kind: 'Environment', plural: 'environments' },
  { kind: 'Function', plural: 'functions' },
  { kind: 'GitOps', plural: 'gitops' },
  { kind: 'GraphDatabase', plural: 'graphdatabases' },
  { kind: 'Health', plural: 'healths' },
  { kind: 'Logging', plural: 'loggings' },
  { kind: 'Messaging', plural: 'messagings' },
  { kind: 'Metrics', plural: 'metrics' },
  { kind: 'Network', plural: 'networks' },
  { kind: 'NoSqlDatabase', plural: 'nosqldatabases' },
  { kind: 'Organisation', plural: 'organisations' },
  { kind: 'Pipeline', plural: 'pipelines' },
  { kind: 'PlatformConfig', plural: 'platformconfigs' },
  { kind: 'Project', plural: 'projects' },
  { kind: 'Queue', plural: 'queues' },
  { kind: 'Release', plural: 'releases' },
  { kind: 'Repository', plural: 'repositories' },
  { kind: 'Restore', plural: 'restores' },
  { kind: 'Scale', plural: 'scales' },
  { kind: 'Search', plural: 'searches' },
  { kind: 'SecretRotation', plural: 'secretrotations' },
  { kind: 'Secret', plural: 'secrets' },
  { kind: 'Service', plural: 'services' },
  { kind: 'Storage', plural: 'storages' },
  { kind: 'Table', plural: 'tables' },
  { kind: 'Team', plural: 'teams' },
  { kind: 'Topic', plural: 'topics' },
  { kind: 'Trace', plural: 'traces' },
  { kind: 'Vector', plural: 'vectors' },
  { kind: 'Webhook', plural: 'webhooks' },
]

export const XR_GROUP = 'platform.adhar.io'

/** The console page that lists a kind. Unlisted kinds open the Platform Catalog. */
const XR_SECTION: Record<string, string> = {
  Database: '/platform?section=databases',
  NoSqlDatabase: '/platform?section=databases',
  GraphDatabase: '/platform?section=databases',
  Vector: '/platform?section=databases',
  Search: '/platform?section=databases',
  Cache: '/platform?section=caches',
  Bucket: '/platform?section=buckets',
  Storage: '/platform?section=buckets',
  Topic: '/platform?section=topics',
  Messaging: '/platform?section=topics',
  Queue: '/platform?section=queues',
  Pipeline: '/platform?section=pipelines',
  Environment: '/platform?section=environments',
  Cluster: '/platform?section=clusters',
  Secret: '/platform?section=secret-stores',
  Release: '/deliver?section=releases',
  Repository: '/develop?section=repos',
  Team: '/settings?section=teams',
  Organisation: '/settings?section=organization',
}

function param(obj: KubeObject, key: string): string | undefined {
  const v = get<unknown>(obj, `spec.parameters.${key}`)
  return typeof v === 'string' && v ? v : undefined
}

/** How a person would name this XR. */
export function xrLabel(kind: string, obj: KubeObject): string {
  const l = labelsOf(obj)
  if (kind === 'Release') {
    const app = param(obj, 'application')
    const env = param(obj, 'environment')
    if (app && env) return `Release of ${app} to ${env}`
  }
  if (kind === 'Application') return `Application ${l['adhar.io/application'] ?? nameOf(obj)}`
  return `${kind} ${nameOf(obj)}`
}

function xrHref(kind: string, obj: KubeObject): string {
  if (kind === 'Application') return links.component(labelsOf(obj)['adhar.io/application'] ?? nameOf(obj))
  if (kind === 'Project') return links.projectEnvironments(nameOf(obj))
  return XR_SECTION[kind] ?? '/platform?section=catalog'
}

/**
 * A transition of one XR:
 *
 *   failed  — Synced=False. Crossplane could not reconcile it (a rejected
 *             composition, a provider error). Ready=False on its own is NOT
 *             a failure: `Creating` is what every XR says while it composes.
 *   ready   — Ready=True.
 *   created — anything else, but only the first time the object is seen and
 *             only if it was created after the watcher started. Once tracked,
 *             an in-progress state is not news (a Ready XR whose composed
 *             resource briefly flips is not "created" again).
 */
export function xrSignal(kind: string, obj: KubeObject, ctx?: SignalContext): Signal | null {
  const synced = condition(obj, 'Synced')
  const ready = condition(obj, 'Ready')
  const label = xrLabel(kind, obj)
  const id = `${nsOf(obj)}/${nameOf(obj)}`
  const base = {
    source: 'platform' as const,
    href: xrHref(kind, obj),
    target: { type: kind.toLowerCase(), id, label },
  }
  const key = (state: string) => `xr:${kind}:${id}:${obj.metadata?.uid ?? ''}:${state}`

  if (synced?.status === 'False') {
    const why = synced.message || synced.reason || 'reconcile error'
    return {
      signature: 'failed',
      doc: {
        ...base,
        kind: 'error',
        severity: 'high',
        title: `${label} failed`,
        description: why,
        key: key('failed'),
        prompt: `The ${kind} ${id} (${XR_GROUP}) is not syncing: ${why}. Find which composed resource or composition step is failing and tell me how to fix it.`,
      },
    }
  }
  if (ready?.status === 'True') {
    return {
      signature: 'ready',
      doc: { ...base, kind: 'success', severity: 'low', title: `${label} is ready`, key: key('ready') },
    }
  }
  if (ctx?.previous !== undefined || !createdSince(obj, ctx)) return null
  return {
    signature: 'created',
    doc: {
      ...base,
      kind: 'info',
      severity: 'low',
      title: `${label} created`,
      description: ready?.message || undefined,
      key: key('created'),
    },
  }
}

export function xrRemoved(kind: string, obj: KubeObject): Signal {
  const label = xrLabel(kind, obj)
  const id = `${nsOf(obj)}/${nameOf(obj)}`
  return {
    signature: 'deleted',
    doc: {
      source: 'platform',
      kind: 'warning',
      severity: 'low',
      title: `${label} deleted`,
      href: XR_SECTION[kind] ?? '/platform?section=catalog',
      key: `xr:${kind}:${id}:${obj.metadata?.uid ?? ''}:deleted`,
      target: { type: kind.toLowerCase(), id, label },
    },
  }
}

const xrSources: Source[] = XR_KINDS.map(({ kind, plural }) => ({
  id: `xr-${plural}`,
  group: XR_GROUP,
  version: 'v1alpha1',
  resource: plural,
  signal: (obj, ctx) => xrSignal(kind, obj, ctx),
  removed: (obj) => xrRemoved(kind, obj),
}))

/* ─────────────────────────── nodes ─────────────────────────── */

const nodes: Source = {
  /**
   * Capacity changing under everyone: a node joined (after the watcher
   * started — the nodes already there at boot are not news) or left. A node
   * going NotReady is the Warning-event source's job.
   */
  id: 'nodes',
  group: '',
  version: 'v1',
  resource: 'nodes',
  signal(obj, ctx) {
    if (!createdSince(obj, ctx)) return null
    const name = nameOf(obj)
    const role = labelsOf(obj)['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane node' : 'node'
    return {
      signature: 'joined',
      doc: {
        source: 'platform',
        kind: 'success',
        severity: 'low',
        title: `Node ${name} joined the cluster`,
        description: `A ${role} was added${labelsOf(obj)['node.kubernetes.io/instance-type'] ? ` (${labelsOf(obj)['node.kubernetes.io/instance-type']})` : ''}.`,
        href: links.nodes(),
        key: `node:${name}:${obj.metadata?.uid ?? ''}:joined`,
        target: { type: 'node', id: name, label: name },
      },
    }
  },
  removed(obj) {
    const name = nameOf(obj)
    return {
      signature: 'removed',
      doc: {
        source: 'platform',
        kind: 'warning',
        severity: 'medium',
        title: `Node ${name} left the cluster`,
        description: 'The node object was deleted — scaled down, retired or replaced.',
        href: links.nodes(),
        key: `node:${name}:${obj.metadata?.uid ?? ''}:removed`,
        target: { type: 'node', id: name, label: name },
      },
    }
  },
}

/* ─────────────────────────── node autoscaler ─────────────────────────── */

/**
 * The reasons `platform/controllers/autoscaler/controller.go` records on the
 * AdharPlatform. `ScaleUpFailed` / `ScaleDownFailed` are
 * `string(decision.Action) + "Failed"`.
 */
const AUTOSCALER_REASONS: Record<string, { kind: 'info' | 'warning' | 'error'; severity: 'low' | 'medium' | 'high'; title: (p: string) => string }> = {
  ScalingUp: { kind: 'info', severity: 'low', title: (p) => `Cluster ${p} is adding a worker` },
  ScalingDown: { kind: 'info', severity: 'low', title: (p) => `Cluster ${p} is removing a worker` },
  ScaleUpFailed: { kind: 'error', severity: 'high', title: (p) => `Cluster ${p} could not add a worker` },
  ScaleDownFailed: { kind: 'error', severity: 'medium', title: (p) => `Cluster ${p} could not remove a worker` },
  ScaleUpMadeNoProgress: { kind: 'warning', severity: 'high', title: (p) => `Cluster ${p} scale-up made no progress` },
}

const autoscaler: Source = {
  /**
   * The node autoscaler's own decisions. The controller re-decides every
   * tick and words each decision differently ("3 pod(s) unschedulable … (8/8)"),
   * so every tick is a new Event; the dedupe key is the reason plus the worker
   * target it names, which turns a scale-up storm into one notification per
   * step rather than one per tick.
   */
  id: 'autoscaler-events',
  group: '',
  version: 'v1',
  resource: 'events',
  search: { fieldSelector: 'involvedObject.kind=AdharPlatform' },
  signal(obj) {
    const reason = get<string>(obj, 'reason') ?? ''
    const spec = AUTOSCALER_REASONS[reason]
    if (!spec) return null
    const platform = get<string>(obj, 'involvedObject.name') ?? 'platform'
    const message = get<string>(obj, 'message') ?? ''
    const count = get<number>(obj, 'count') ?? 1
    const target = message.match(/\((\d+)\/(\d+)\)\s*$/)?.[1]
    const bucket = countBucket(count)
    return {
      signature: `${reason}/${bucket}`,
      doc: {
        source: 'platform',
        kind: spec.kind,
        severity: spec.severity,
        title: spec.title(platform),
        description: message,
        href: links.nodes(),
        key: `autoscaler:${platform}:${reason}:${target ?? message.slice(0, 80)}`,
        target: { type: 'adharplatform', id: platform, label: platform },
        ...(spec.kind === 'info' ? {} : {
          prompt: `The Adhar node autoscaler on ${platform} reported ${reason}: ${message}. Explain why and what I should do (quota, instance size, maxWorkers, or a stuck join).`,
        }),
      },
    }
  },
}

/* ─────────────────────────── resilience gate ─────────────────────────── */

const RESILIENCE_LABEL = 'adhar.io/resilience-gate'

const resilienceGate: Source = {
  /**
   * The resilience gate a promotion waits on: the Kargo verification Job
   * starts a resilience-runner Job in adhar-system labelled with the app, and
   * that runner's outcome is the gate's verdict. The wrapper Job in the
   * project namespace carries the same label and would report the same
   * verdict a second time, so only adhar-system's runner is read.
   */
  id: 'resilience-gate',
  group: 'batch',
  version: 'v1',
  resource: 'jobs',
  search: { labelSelector: RESILIENCE_LABEL },
  signal(obj) {
    if (nsOf(obj) !== 'adhar-system') return null
    const app = labelsOf(obj)[RESILIENCE_LABEL]
    if (!app) return null
    const complete = condition(obj, 'Complete')
    const failed = condition(obj, 'Failed')
    const passed = complete?.status === 'True'
    if (!passed && failed?.status !== 'True') return null
    const env = get<Array<{ name?: string; value?: string }>>(obj, 'spec.template.spec.containers.0.env')
      ?.find((e) => e.name === 'VERIFY_ENVIRONMENT')?.value
    const where = env ? ` for ${env}` : ''
    const base = {
      source: 'platform' as const,
      href: links.readiness(app),
      key: `resilience-gate:${nameOf(obj)}:${passed ? 'passed' : 'failed'}`,
      target: { type: 'application', id: app, label: app },
    }
    if (passed) {
      return { signature: 'passed', doc: { ...base, kind: 'success', severity: 'low', title: `${app} passed the resilience gate${where}` } }
    }
    return {
      signature: 'failed',
      doc: {
        ...base,
        kind: 'error',
        severity: 'high',
        title: `${app} failed the resilience gate${where}`,
        description: failed?.message || failed?.reason || 'The resilience runner reported failure; the promotion is blocked.',
        prompt: `The resilience gate for ${app}${where} failed (Job adhar-system/${nameOf(obj)}). Read the runner's report and tell me which check failed and how to make ${app} pass it.`,
      },
    }
  },
}

export const CONTROL_PLANE_SOURCES: Source[] = [...xrSources, nodes, autoscaler, resilienceGate]
