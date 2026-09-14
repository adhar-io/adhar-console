/**
 * Human labels for tool calls.
 *
 * The console's own tools have known argument shapes and get a precise label.
 * adhar-ai's MCP tools arrive as `<domain>_<verb>_<thing>` and are given a
 * readable form derived from the name, with the most identifying argument
 * appended when one is obvious — so "gitops_get_application · payments-api"
 * rather than a bare identifier.
 */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>
  switch (name) {
    case 'k8s_list': return `list ${a.resource ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_get': return `get ${a.resource ?? ''}/${a.name ?? ''}`
    case 'k8s_logs': return `logs ${a.pod ?? ''}`
    case 'k8s_events': return 'events'
    case 'k8s_discovery': return 'discover API'
    case 'k8s_describe': return `describe ${a.resource ?? ''}/${a.name ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_pod_diagnostics': return `pod diagnostics ${a.pod ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_workload_health': return `${a.kind ?? 'workload'} health ${a.name ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_events_scan': return `warning scan · ${a.namespace ?? 'cluster'}`
    case 'argocd_app_status': return `argocd app ${a.name ?? ''}`
    case 'propose_change': return 'propose change'
    case 'update_plan': return 'update plan'
    case 'record_finding': return `finding: ${String(a.title ?? '').slice(0, 40)}`
    case 'render_ui': return `render ${a.component ?? 'ui'}`
    case 'navigate_to': return `open ${a.path ?? ''}`
    case 'open_resource': return `open ${a.kind ?? ''}/${a.name ?? ''}`
    case 'ask_operator': return 'ask the operator'
  }
  // MCP tools: `<domain>_<rest>` → "<rest with spaces>" + identifying arg.
  const m = /^([a-z]+)_(.+)$/.exec(name)
  const verb = m ? m[2].replace(/_/g, ' ') : name
  const id = a.name ?? a.app ?? a.application ?? a.pod ?? a.deployment ?? a.repo ?? a.namespace ?? a.query
  return id ? `${verb} · ${String(id).slice(0, 40)}` : verb
}

/** Which MCP domain a tool belongs to, for grouping in the inspector. */
export function toolDomain(name: string): string {
  if (name.startsWith('k8s_')) return 'cluster'
  const m = /^([a-z]+)_/.exec(name)
  return m ? m[1] : 'console'
}

export function safeArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
