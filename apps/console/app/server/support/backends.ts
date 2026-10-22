import { env } from '@adhar/utils'
import { apiServerFetch } from '../k8s/gateway.ts'
import { getK8sServiceToken, getTool, type ToolDef } from '../tool-registry.ts'
import { consolePublicUrl, toolPublicUrl } from '../domain.ts'
import type { Backends, LinkBases, LokiStream, PromSample, TempoTrace } from './evidence.ts'

/**
 * The real evidence backends: the apiserver as the console's own
 * ServiceAccount (the `read-all` ClusterRole covers objects, events and
 * pods/log), and Loki / Prometheus / Tempo through the same tool registry
 * entries the console's UI proxies use (`LOKI_URL`, `PROMETHEUS_URL`,
 * `TEMPO_URL`, tenant headers included). Every call carries its own timeout.
 */

const qs = (search?: Record<string, string>) => (search && Object.keys(search).length ? `?${new URLSearchParams(search)}` : '')

function toolHeaders(t: ToolDef): Record<string, string> {
  return {
    accept: 'application/json',
    ...(t.headers ?? {}),
    ...(t.authMode === 'service' && t.serviceToken ? { authorization: `Bearer ${t.serviceToken}` } : {}),
  }
}

async function toolGet(name: string, path: string, params: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const t = getTool(name)
  if (!t?.baseUrl) throw new Error(`${name} is not configured (${name.toUpperCase()}_URL)`)
  const res = await fetch(`${t.baseUrl}${path}${qs(params)}`, { headers: toolHeaders(t), signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`${name} HTTP ${res.status}${body ? `: ${body}` : ''}`)
  }
  return res.json()
}

export function clusterBackends(timeoutMs: number): Backends {
  const token = getK8sServiceToken()
  const k8s = async (path: string, search?: Record<string, string>) => {
    if (!token) throw new Error('no ServiceAccount token (K8S_SA_TOKEN) — Kubernetes evidence is unavailable')
    const res = await apiServerFetch(token, path, { search: qs(search), signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`apiserver HTTP ${res.status} on ${path}`)
    }
    return res
  }
  return {
    k8s: async (path, search) => (await k8s(path, search)).json(),
    k8sText: async (path, search) => (await k8s(path, search)).text(),
    loki: async (query, startMs, endMs, limit, direction = 'backward') => {
      const body = await toolGet('loki', '/loki/api/v1/query_range', {
        query,
        start: `${startMs}000000`,
        end: `${endMs}000000`,
        limit: String(limit),
        direction,
      }, timeoutMs) as { data?: { result?: LokiStream[] } }
      return body.data?.result ?? []
    },
    prom: async (expr) => {
      const body = await toolGet('prometheus', '/api/v1/query', { query: expr }, timeoutMs) as { data?: { result?: PromSample[] } }
      return body.data?.result ?? []
    },
    tempo: async (q, startMs, endMs, limit) => {
      const body = await toolGet('tempo', '/api/search', {
        q,
        start: String(Math.floor(startMs / 1000)),
        end: String(Math.ceil(endMs / 1000)),
        limit: String(limit),
      }, timeoutMs) as { traces?: TempoTrace[] }
      return body.traces ?? []
    },
  }
}

/** Public URLs for deep links. Grafana datasource uids default to the platform's provisioned ones. */
export function linkBases(): LinkBases {
  const safe = (f: () => string) => {
    try {
      return f()
    } catch {
      return ''
    }
  }
  return {
    console: safe(consolePublicUrl),
    grafana: safe(() => toolPublicUrl('grafana', 'GRAFANA_URL')),
    argocd: safe(() => toolPublicUrl('argocd', 'ARGOCD_URL', 'ARGO_CD_URL')),
    kargo: safe(() => toolPublicUrl('kargo', 'KARGO_URL')),
    ds: {
      prometheus: env('GRAFANA_DS_PROMETHEUS') ?? 'prometheus',
      loki: env('GRAFANA_DS_LOKI') ?? 'loki',
      tempo: env('GRAFANA_DS_TEMPO') ?? 'tempo',
    },
  }
}
