import { apiServerFetch } from '../k8s/gateway.ts'
import type { ToolDef } from './provider.ts'

/**
 * Read-only Kubernetes tools exposed to the model. Every tool runs against the
 * apiserver with the SIGNED-IN USER's token, so the AI can never see or do more
 * than the user's own RBAC allows. The only "write" tool, `propose_change`,
 * does NOT touch the cluster — it returns a manifest for the human to review
 * and apply. (Chosen policy: read + diagnose + propose only.)
 */

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'k8s_list',
      description: 'List Kubernetes resources of a kind. Returns names, namespaces and a brief status summary.',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: "API group, '' for core (e.g. 'apps', '')" },
          version: { type: 'string', description: "API version (e.g. 'v1')" },
          resource: { type: 'string', description: "Plural resource name (e.g. 'pods', 'deployments')" },
          namespace: { type: 'string', description: 'Namespace; omit for all/cluster-scoped' },
          labelSelector: { type: 'string' },
          fieldSelector: { type: 'string' },
        },
        required: ['version', 'resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_get',
      description: 'Get a single Kubernetes object (full manifest incl. spec + status).',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          version: { type: 'string' },
          resource: { type: 'string' },
          namespace: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['version', 'resource', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_logs',
      description: 'Read recent logs from a pod container (for diagnosing crashes/errors).',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          pod: { type: 'string' },
          container: { type: 'string' },
          tailLines: { type: 'number', description: 'default 200' },
          previous: { type: 'boolean', description: 'logs from the previous (crashed) container instance' },
        },
        required: ['namespace', 'pod'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_events',
      description: 'List Events, optionally scoped to one object (to explain scheduling/pull/health failures).',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          name: { type: 'string', description: 'involved object name' },
          kind: { type: 'string', description: 'involved object kind' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_discovery',
      description: 'List the API resource kinds available in the cluster (incl. CRDs).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_change',
      description:
        'Propose a change to the cluster as a full manifest for the human to review and apply. Does NOT apply it. Use for fixes/edits you recommend.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'one-line description of the change and why' },
          manifest: { type: 'object', description: 'the complete desired object (apiVersion, kind, metadata, spec)' },
        },
        required: ['summary', 'manifest'],
      },
    },
  },
]

function root(group: string, version: string): string {
  return group ? `/apis/${group}/${version}` : `/api/${version}`
}

export interface ToolResult {
  /** JSON string fed back to the model. */
  content: string
  /** Set for propose_change → surfaced to the client for human approval. */
  proposal?: { summary: string; manifest: unknown }
}

/** Execute a tool call with the user's token. Never throws — returns an error string. */
export async function executeTool(name: string, argsJson: string, token: string): Promise<ToolResult> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson || '{}')
  } catch {
    return { content: JSON.stringify({ error: 'invalid tool arguments (not JSON)' }) }
  }
  try {
    switch (name) {
      case 'k8s_list': {
        const { group = '', version, resource, namespace, labelSelector, fieldSelector } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const q = new URLSearchParams()
        if (labelSelector) q.set('labelSelector', labelSelector)
        if (fieldSelector) q.set('fieldSelector', fieldSelector)
        q.set('limit', '200')
        const res = await apiServerFetch(token, `${root(group, version)}${ns}/${resource}`, { search: `?${q}` })
        const body = await res.json()
        const items = (body.items ?? []).map((o: KObj) => summarize(o))
        return { content: JSON.stringify({ count: items.length, items }) }
      }
      case 'k8s_get': {
        const { group = '', version, resource, namespace, name: n } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const res = await apiServerFetch(token, `${root(group, version)}${ns}/${resource}/${n}`)
        const body = await res.json()
        return { content: JSON.stringify(trim(body)) }
      }
      case 'k8s_logs': {
        const { namespace, pod, container, tailLines = 200, previous } = args as Record<string, unknown>
        const q = new URLSearchParams({ tailLines: String(tailLines), timestamps: 'true' })
        if (container) q.set('container', String(container))
        if (previous) q.set('previous', 'true')
        const res = await apiServerFetch(token, `/api/v1/namespaces/${namespace}/pods/${pod}/log`, { search: `?${q}` })
        const text = await res.text()
        return { content: text.slice(-8000) || '(no logs)' }
      }
      case 'k8s_events': {
        const { namespace, name: n, kind } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const q = new URLSearchParams()
        const sel: string[] = []
        if (n) sel.push(`involvedObject.name=${n}`)
        if (kind) sel.push(`involvedObject.kind=${kind}`)
        if (sel.length) q.set('fieldSelector', sel.join(','))
        const res = await apiServerFetch(token, `/api/v1${ns}/events`, { search: q.toString() ? `?${q}` : '' })
        const body = await res.json()
        const events = (body.items ?? []).map((e: KEvent) => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
          count: e.count,
          lastTimestamp: e.lastTimestamp,
        }))
        return { content: JSON.stringify({ count: events.length, events }) }
      }
      case 'k8s_discovery': {
        const [core, apis] = await Promise.all([
          apiServerFetch(token, '/api/v1').then((r) => r.json()),
          apiServerFetch(token, '/apis').then((r) => r.json()),
        ])
        const kinds = new Set<string>()
        for (const r of core.resources ?? []) if (!r.name.includes('/')) kinds.add(`core/${r.kind} (${r.name})`)
        for (const g of apis.groups ?? []) kinds.add(`${g.name}: ${g.preferredVersion?.groupVersion}`)
        return { content: JSON.stringify({ kinds: [...kinds] }) }
      }
      case 'propose_change': {
        const summary = String((args as Record<string, unknown>).summary ?? 'Proposed change')
        const manifest = (args as Record<string, unknown>).manifest
        return {
          content: JSON.stringify({ status: 'proposed_for_human_review', summary }),
          proposal: { summary, manifest },
        }
      }
      default:
        return { content: JSON.stringify({ error: `unknown tool ${name}` }) }
    }
  } catch (e) {
    return { content: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }
  }
}

interface KObj {
  kind?: string
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> }
  status?: Record<string, unknown>
  spec?: Record<string, unknown>
}
interface KEvent {
  type?: string
  reason?: string
  message?: string
  count?: number
  lastTimestamp?: string
  involvedObject?: { kind?: string; name?: string }
}

function summarize(o: KObj): Record<string, unknown> {
  const s = o.status ?? {}
  return {
    name: o.metadata?.name,
    namespace: o.metadata?.namespace,
    phase: s.phase,
    ready: s.readyReplicas ?? s.numberReady,
    replicas: (o.spec as { replicas?: number })?.replicas,
    conditions: Array.isArray(s.conditions)
      ? (s.conditions as Array<{ type: string; status: string; reason?: string }>).map((c) => `${c.type}=${c.status}${c.reason ? `(${c.reason})` : ''}`)
      : undefined,
    created: o.metadata?.creationTimestamp,
  }
}

/** Drop noisy managedFields before feeding an object to the model. */
function trim(o: KObj): KObj {
  if (o.metadata && 'managedFields' in o.metadata) delete (o.metadata as Record<string, unknown>).managedFields
  return o
}
