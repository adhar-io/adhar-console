import { useMemo, useState, type ReactNode } from 'react'
import { DataTable, EmptyState, StatusBadge, useAppConfig, type StatusKind } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { k8s } from '@adhar-console/api-clients'
import { useGeneric } from '../data/hooks.ts'
import { GVRS } from '../data/gvr.ts'
import { age } from '../data/format.ts'
import { DrawerSection, ResourceDrawer, Row } from './resource-drawer.tsx'
import { ListShell, StatusFilterPills, matchesSearch } from './list-shell.tsx'
import { ManifestEditor } from './manifest-editor.tsx'
import type { NetworkPolicyObject } from './networking-list.tsx'

/**
 * Gateway API (gateway.networking.k8s.io) views + the drawers Ingress and
 * NetworkPolicy were missing.
 *
 *   Gateways        — listeners (port / protocol / hostname / TLS / allowed
 *                     routes), addresses, Accepted / Programmed conditions,
 *                     attached-route counts per listener.
 *   Routes          — HTTPRoutes + GRPCRoutes: hostnames, parent gateways,
 *                     rules (matches → backends with weights, filters), and
 *                     per-parent Accepted / ResolvedRefs status. Public URL
 *                     links open the host straight from the row.
 *   Gateway Classes — controller name, Accepted status, gateways per class.
 *
 * All from the live cluster with the user's RBAC; a 404 on the CRDs renders a
 * "Gateway API not installed" guide rather than an empty table.
 */

/* ─────────── raw shapes ─────────── */

interface Condition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}
interface Listener {
  name: string
  port: number
  protocol: string
  hostname?: string
  tls?: { mode?: string; certificateRefs?: Array<{ name: string; namespace?: string; kind?: string }> }
  allowedRoutes?: { namespaces?: { from?: string; selector?: unknown }; kinds?: Array<{ kind: string }> }
}
interface GatewayObject extends k8s.Generic {
  spec?: { gatewayClassName?: string; listeners?: Listener[]; addresses?: Array<{ type?: string; value: string }> }
  status?: {
    addresses?: Array<{ type?: string; value: string }>
    conditions?: Condition[]
    listeners?: Array<{ name: string; attachedRoutes?: number; conditions?: Condition[]; supportedKinds?: Array<{ kind: string }> }>
  }
}
interface ParentRef {
  name: string
  namespace?: string
  sectionName?: string
  port?: number
  kind?: string
  group?: string
}
interface BackendRef {
  name: string
  namespace?: string
  port?: number
  weight?: number
  kind?: string
  group?: string
}
interface HttpMatch {
  path?: { type?: string; value?: string }
  method?: string
  headers?: Array<{ name: string; value: string; type?: string }>
  queryParams?: Array<{ name: string; value: string }>
}
interface GrpcMatch {
  method?: { service?: string; method?: string; type?: string }
  headers?: Array<{ name: string; value: string }>
}
interface RouteRule {
  name?: string
  matches?: Array<HttpMatch & GrpcMatch>
  filters?: Array<{ type: string; [k: string]: unknown }>
  backendRefs?: Array<BackendRef & { filters?: unknown[] }>
  timeouts?: { request?: string; backendRequest?: string }
}
interface RouteObject extends k8s.Generic {
  spec?: { hostnames?: string[]; parentRefs?: ParentRef[]; rules?: RouteRule[] }
  status?: { parents?: Array<{ parentRef: ParentRef; controllerName?: string; conditions?: Condition[] }> }
}
interface GatewayClassObject extends k8s.Generic {
  spec?: { controllerName?: string; description?: string; parametersRef?: { name: string; kind?: string; namespace?: string } }
  status?: { conditions?: Condition[] }
}

/* ─────────── helpers ─────────── */

function cond(list: Condition[] | undefined, type: string): Condition | undefined {
  return list?.find((c) => c.type === type)
}
function condTone(c?: Condition): StatusKind {
  if (!c) return 'unknown'
  return c.status === 'True' ? 'healthy' : c.status === 'False' ? 'failed' : 'progressing'
}
function is404(q: { isError: boolean; error: unknown }): boolean {
  return q.isError && (q.error as { status?: number })?.status === 404
}
function pathLabel(m: HttpMatch): string {
  const t = m.path?.type ?? 'PathPrefix'
  const v = m.path?.value ?? '/'
  return t === 'Exact' ? `= ${v}` : t === 'RegularExpression' ? `~ ${v}` : `${v}*`
}

function NotInstalled({ what }: { what: string }) {
  return (
    <EmptyState
      title="Gateway API not installed"
      description={
        <>
          The <code className="font-mono">gateway.networking.k8s.io</code> {what} CRD isn’t registered on this cluster. Install the{' '}
          <a className="text-brand-700 underline dark:text-brand-300" href="https://gateway-api.sigs.k8s.io/guides/" target="_blank" rel="noreferrer">Gateway API CRDs</a>{' '}
          and a controller (Cilium, Envoy Gateway, Istio, NGINX Gateway Fabric) — the Adhar platform stack ships one by default.
        </>
      }
    />
  )
}

/* ─────────── gateways ─────────── */

export function GatewaysTable({ namespace }: { namespace?: string }) {
  const q = useGeneric(GVRS.gateways, namespace)
  const routes = useGeneric(GVRS.httproutes, namespace)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'ready' | 'problem' | 'all'>('all')
  const [selected, setSelected] = useState<GatewayObject | null>(null)
  const [editing, setEditing] = useState<GatewayObject | null>(null)
  const all = (q.data ?? []) as GatewayObject[]
  const ready = (g: GatewayObject) => cond(g.status?.conditions, 'Programmed')?.status === 'True' && cond(g.status?.conditions, 'Accepted')?.status !== 'False'
  const rows = useMemo(
    () =>
      all
        .filter((g) => status === 'all' || (status === 'ready' ? ready(g) : !ready(g)))
        .filter((g) => matchesSearch(g.metadata.name, search) || matchesSearch(g.metadata.namespace, search) || matchesSearch(g.spec?.gatewayClassName, search) || (g.spec?.listeners ?? []).some((l) => matchesSearch(l.hostname, search))),
    [all, search, status],
  )
  if (is404(q)) return <NotInstalled what="Gateway" />
  return (
    <>
      <ListShell
        title="Gateways"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching}
        onRefresh={() => q.refetch()}
        lastUpdatedAt={q.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search gateways, classes, hostnames…"
        caption={namespace ? `namespace ${namespace}` : 'all namespaces'}
        filters={
          <StatusFilterPills<'ready' | 'problem'>
            value={status}
            onChange={setStatus}
            pills={[
              { value: 'ready', label: 'Programmed', count: all.filter(ready).length, tone: 'emerald' },
              { value: 'problem', label: 'Attention', count: all.filter((g) => !ready(g)).length, tone: 'amber' },
            ]}
          />
        }
      >
        <DataTable<GatewayObject>
          loading={q.isLoading}
          onRowClick={(g) => setSelected(g)}
          columns={[
            { key: 'name', header: 'Name', cell: (g) => <div><div className="font-medium text-content">{g.metadata.name}</div><div className="text-xs text-content-muted">{g.metadata.namespace}</div></div> },
            { key: 'class', header: 'Class', cell: (g) => <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">{g.spec?.gatewayClassName ?? '—'}</code> },
            {
              key: 'listeners',
              header: 'Listeners',
              cell: (g) => (
                <div className="flex flex-wrap gap-1 font-mono text-[11px]">
                  {(g.spec?.listeners ?? []).map((l) => (
                    <span key={l.name} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted" title={l.hostname ?? '*'}>{l.protocol}:{l.port}{l.hostname ? ` ${l.hostname}` : ''}</span>
                  ))}
                </div>
              ),
            },
            { key: 'addresses', header: 'Addresses', cell: (g) => <code className="font-mono text-[11px] text-content-muted">{(g.status?.addresses ?? g.spec?.addresses ?? []).map((a) => a.value).join(', ') || '—'}</code> },
            { key: 'routes', header: 'Routes', numeric: true, cell: (g) => (g.status?.listeners ?? []).reduce((s, l) => s + (l.attachedRoutes ?? 0), 0) },
            {
              key: 'status',
              header: 'Status',
              cell: (g) => {
                const p = cond(g.status?.conditions, 'Programmed')
                const a = cond(g.status?.conditions, 'Accepted')
                return <div className="flex gap-1"><StatusBadge kind={condTone(a)}>{a ? `accepted ${a.status === 'True' ? '' : a.reason ?? ''}`.trim() : 'no status'}</StatusBadge><StatusBadge kind={condTone(p)}>{p ? (p.status === 'True' ? 'programmed' : p.reason ?? 'not programmed') : '—'}</StatusBadge></div>
              },
            },
            { key: 'age', header: 'Age', cell: (g) => age(g.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(g) => `${g.metadata.namespace}/${g.metadata.name}`}
          empty={<EmptyState title="No gateways" description="Create a Gateway from a GatewayClass to expose routes." />}
        />
      </ListShell>
      {selected ? (
        <GatewayDrawer
          gateway={selected}
          routes={(routes.data ?? []) as RouteObject[]}
          onClose={() => setSelected(null)}
          onEdit={() => { setEditing(selected); setSelected(null) }}
        />
      ) : null}
      {editing ? <ManifestEditor gvr={GVRS.gateways} namespace={editing.metadata.namespace} name={editing.metadata.name} onClose={() => { setEditing(null); q.refetch() }} /> : null}
    </>
  )
}

function GatewayDrawer({ gateway, routes, onClose, onEdit }: { gateway: GatewayObject; routes: RouteObject[]; onClose(): void; onEdit(): void }) {
  const listeners = gateway.spec?.listeners ?? []
  const lstatus = gateway.status?.listeners ?? []
  const attached = routes.filter((r) => (r.spec?.parentRefs ?? []).some((p) => p.name === gateway.metadata.name && (p.namespace ?? r.metadata.namespace) === gateway.metadata.namespace))
  const programmed = cond(gateway.status?.conditions, 'Programmed')
  return (
    <ResourceDrawer
      resource={{ ...gateway, apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway' }}
      kindLabel="Gateway"
      statusBadge={<StatusBadge kind={condTone(programmed)}>{programmed?.status === 'True' ? 'programmed' : programmed?.reason ?? 'pending'}</StatusBadge>}
      onClose={onClose}
    >
      <DrawerSection title="Manage">
        <div className="flex flex-wrap gap-2">
          <ActionBtn primary onClick={onEdit}>Edit YAML</ActionBtn>
          <ActionBtn href="/platform?section=explore">Browse in Explore</ActionBtn>
          <ActionBtn href="https://gateway-api.sigs.k8s.io/api-types/gateway/">Gateway docs</ActionBtn>
        </div>
      </DrawerSection>
      <DrawerSection title="Spec">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Gateway class" value={gateway.spec?.gatewayClassName ?? '—'} mono />
          <Row label="Addresses" value={(gateway.status?.addresses ?? gateway.spec?.addresses ?? []).map((a) => `${a.value}${a.type ? ` (${a.type})` : ''}`).join(', ') || '— (pending)'} mono />
          <Row label="Age" value={age(gateway.metadata.creationTimestamp)} />
        </div>
      </DrawerSection>
      <DrawerSection title={`Listeners · ${listeners.length}`}>
        <div className="space-y-2">
          {listeners.map((l) => {
            const st = lstatus.find((x) => x.name === l.name)
            const acc = cond(st?.conditions, 'Accepted')
            const prog = cond(st?.conditions, 'Programmed')
            const resolved = cond(st?.conditions, 'ResolvedRefs')
            return (
              <div key={l.name} className="rounded-xl border border-edge-default bg-surface-raised p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[12px] font-semibold text-content">{l.name}</code>
                  <Chip>{l.protocol}:{l.port}</Chip>
                  <Chip>{l.hostname ?? '*'}</Chip>
                  {l.tls ? <Chip>TLS {l.tls.mode ?? 'Terminate'}{l.tls.certificateRefs?.length ? ` · ${l.tls.certificateRefs.map((c) => c.name).join(', ')}` : ''}</Chip> : null}
                  <span className="ml-auto font-mono text-[11px] text-content-subtle">{st?.attachedRoutes ?? 0} route{st?.attachedRoutes === 1 ? '' : 's'}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <StatusBadge kind={condTone(acc)}>accepted</StatusBadge>
                  <StatusBadge kind={condTone(prog)}>programmed</StatusBadge>
                  <StatusBadge kind={condTone(resolved)}>refs resolved</StatusBadge>
                  {l.allowedRoutes?.namespaces?.from ? <Chip>routes from {l.allowedRoutes.namespaces.from} namespaces</Chip> : null}
                  {l.allowedRoutes?.kinds?.length ? <Chip>{l.allowedRoutes.kinds.map((k) => k.kind).join(', ')}</Chip> : null}
                </div>
                {[acc, prog, resolved].filter((c) => c && c.status !== 'True' && c.message).map((c) => (
                  <p key={c!.type} className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{c!.type}: {c!.message}</p>
                ))}
              </div>
            )
          })}
        </div>
      </DrawerSection>
      <DrawerSection title={`Attached routes · ${attached.length}`}>
        {attached.length === 0 ? (
          <p className="text-[12px] text-content-subtle">No HTTPRoute references this gateway yet.</p>
        ) : (
          <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default">
            {attached.map((r) => (
              <div key={`${r.metadata.namespace}/${r.metadata.name}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0"><div className="truncate font-medium text-content">{r.metadata.name}</div><div className="truncate font-mono text-[11px] text-content-subtle">{(r.spec?.hostnames ?? ['*']).join(', ')}</div></div>
                <span className="font-mono text-[11px] text-content-subtle">{r.metadata.namespace}</span>
              </div>
            ))}
          </div>
        )}
      </DrawerSection>
      <Conditions conditions={gateway.status?.conditions} />
    </ResourceDrawer>
  )
}

/* ─────────── routes ─────────── */

export function RoutesTable({ namespace }: { namespace?: string }) {
  const http = useGeneric(GVRS.httproutes, namespace)
  const grpc = useGeneric(GVRS.grpcroutes, namespace)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'HTTPRoute' | 'GRPCRoute' | 'all'>('all')
  const [selected, setSelected] = useState<(RouteObject & { kind: string }) | null>(null)
  const [editing, setEditing] = useState<(RouteObject & { kind: string }) | null>(null)
  const config = useAppConfig()
  const proto = typeof location !== 'undefined' && location.protocol === 'http:' ? 'http:' : 'https:'

  const all = useMemo(
    () => [
      ...((http.data ?? []) as RouteObject[]).map((r) => ({ ...r, kind: 'HTTPRoute' as const })),
      ...((is404(grpc) ? [] : (grpc.data ?? [])) as RouteObject[]).map((r) => ({ ...r, kind: 'GRPCRoute' as const })),
    ],
    [http.data, grpc.data, grpc.isError, grpc.error],
  )
  const rows = useMemo(
    () =>
      all
        .filter((r) => kind === 'all' || r.kind === kind)
        .filter((r) => matchesSearch(r.metadata.name, search) || matchesSearch(r.metadata.namespace, search) || (r.spec?.hostnames ?? []).some((h) => matchesSearch(h, search)) || (r.spec?.parentRefs ?? []).some((p) => matchesSearch(p.name, search)) || (r.spec?.rules ?? []).some((rule) => (rule.backendRefs ?? []).some((b) => matchesSearch(b.name, search)))),
    [all, kind, search],
  )
  const accepted = (r: RouteObject) => (r.status?.parents ?? []).length > 0 && (r.status?.parents ?? []).every((p) => cond(p.conditions, 'Accepted')?.status === 'True' && cond(p.conditions, 'ResolvedRefs')?.status !== 'False')

  if (is404(http)) return <NotInstalled what="HTTPRoute" />
  return (
    <>
      <ListShell
        title="Routes"
        total={all.length}
        visible={rows.length}
        loading={http.isLoading}
        isFetching={http.isFetching || grpc.isFetching}
        onRefresh={() => { http.refetch(); grpc.refetch() }}
        lastUpdatedAt={http.dataUpdatedAt}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search hostnames, routes, gateways, backends…"
        caption={`${all.filter(accepted).length} accepted · base ${config.data?.publicBaseDomain || 'unknown'}`}
        filters={
          <StatusFilterPills<'HTTPRoute' | 'GRPCRoute'>
            value={kind}
            onChange={setKind}
            pills={[
              { value: 'HTTPRoute', label: 'HTTP', count: all.filter((r) => r.kind === 'HTTPRoute').length, tone: 'sky' },
              { value: 'GRPCRoute', label: 'gRPC', count: all.filter((r) => r.kind === 'GRPCRoute').length, tone: 'violet' },
            ]}
          />
        }
      >
        <DataTable<RouteObject & { kind: 'HTTPRoute' | 'GRPCRoute' }>
          loading={http.isLoading}
          onRowClick={(r) => setSelected(r)}
          columns={[
            { key: 'name', header: 'Name', cell: (r) => <div><div className="font-medium text-content">{r.metadata.name}</div><div className="text-xs text-content-muted">{r.metadata.namespace} · {r.kind}</div></div> },
            {
              key: 'hosts',
              header: 'Hostnames',
              cell: (r) => (
                <div className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {(r.spec?.hostnames ?? []).length === 0 ? <span className="text-content-subtle">* (any)</span> : null}
                  {(r.spec?.hostnames ?? []).map((h) => (
                    h.includes('*') ? <span key={h} className="text-content-muted">{h}</span> : (
                      <a key={h} href={`${proto}//${h}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline dark:text-brand-300">{h} ↗</a>
                    )
                  ))}
                </div>
              ),
            },
            { key: 'parents', header: 'Gateway', cell: (r) => <div className="flex flex-col gap-0.5 font-mono text-[11px] text-content-muted">{(r.spec?.parentRefs ?? []).map((p, i) => <span key={i}>{p.namespace ? `${p.namespace}/` : ''}{p.name}{p.sectionName ? `#${p.sectionName}` : ''}</span>)}</div> },
            {
              key: 'rules',
              header: 'Rules → Backends',
              cell: (r) => {
                const lines = (r.spec?.rules ?? []).flatMap((rule, ri) => {
                  const m = rule.matches?.[0]
                  const match = r.kind === 'GRPCRoute' ? (m?.method ? `${m.method.service ?? '*'}/${m.method.method ?? '*'}` : '*') : m ? `${m.method ? `${m.method} ` : ''}${pathLabel(m)}` : '/*'
                  const backends = (rule.backendRefs ?? []).map((b) => `${b.name}:${b.port ?? ''}${b.weight !== undefined && (rule.backendRefs?.length ?? 0) > 1 ? ` (${b.weight})` : ''}`).join(', ') || 'no backend'
                  return <span key={ri} className="text-content-muted">{match} → {backends}</span>
                })
                return <div className="flex flex-col gap-0.5 font-mono text-[11px]">{lines.slice(0, 3)}{lines.length > 3 ? <span className="text-[10px] text-content-subtle">+{lines.length - 3} more</span> : null}</div>
              },
            },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge kind={(r.status?.parents ?? []).length ? (accepted(r) ? 'healthy' : 'degraded') : 'unknown'}>{(r.status?.parents ?? []).length ? (accepted(r) ? 'accepted' : 'attention') : 'no status'}</StatusBadge> },
            { key: 'age', header: 'Age', cell: (r) => age(r.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(r) => `${r.kind}/${r.metadata.namespace}/${r.metadata.name}`}
          empty={<EmptyState title="No routes" description="Create an HTTPRoute that references a Gateway to expose a Service." />}
        />
      </ListShell>
      {selected ? <RouteDrawer route={selected} proto={proto} onClose={() => setSelected(null)} onEdit={() => { setEditing(selected); setSelected(null) }} /> : null}
      {editing ? <ManifestEditor gvr={editing.kind === 'GRPCRoute' ? GVRS.grpcroutes : GVRS.httproutes} namespace={editing.metadata.namespace} name={editing.metadata.name} onClose={() => { setEditing(null); http.refetch(); grpc.refetch() }} /> : null}
    </>
  )
}

function RouteDrawer({ route, proto, onClose, onEdit }: { route: RouteObject & { kind: string }; proto: string; onClose(): void; onEdit(): void }) {
  const parents = route.status?.parents ?? []
  const ok = parents.length > 0 && parents.every((p) => cond(p.conditions, 'Accepted')?.status === 'True')
  return (
    <ResourceDrawer
      resource={{ ...route, apiVersion: 'gateway.networking.k8s.io/v1' }}
      kindLabel={route.kind}
      statusBadge={<StatusBadge kind={parents.length ? (ok ? 'healthy' : 'degraded') : 'unknown'}>{parents.length ? (ok ? 'accepted' : 'attention') : 'no status'}</StatusBadge>}
      onClose={onClose}
    >
      <DrawerSection title="Manage">
        <div className="flex flex-wrap gap-2">
          <ActionBtn primary onClick={onEdit}>Edit YAML</ActionBtn>
          {(route.spec?.hostnames ?? []).filter((h) => !h.includes('*')).slice(0, 3).map((h) => <ActionBtn key={h} href={`${proto}//${h}`}>Open {h}</ActionBtn>)}
          <ActionBtn href="/platform?section=explore">Browse in Explore</ActionBtn>
          <ActionBtn href={`https://gateway-api.sigs.k8s.io/api-types/${route.kind === 'GRPCRoute' ? 'grpcroute' : 'httproute'}/`}>{route.kind} docs</ActionBtn>
        </div>
      </DrawerSection>
      <DrawerSection title="Hostnames & parents">
        <div className="divide-y divide-edge-subtle text-sm">
          <Row label="Hostnames" value={(route.spec?.hostnames ?? []).join(', ') || '* (any)'} mono />
          {(route.spec?.parentRefs ?? []).map((p, i) => {
            const st = parents.find((x) => x.parentRef.name === p.name && (x.parentRef.namespace ?? route.metadata.namespace) === (p.namespace ?? route.metadata.namespace))
            const acc = cond(st?.conditions, 'Accepted')
            const res = cond(st?.conditions, 'ResolvedRefs')
            return (
              <Row
                key={i}
                label={`Gateway ${i + 1}`}
                value={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono">{p.namespace ? `${p.namespace}/` : ''}{p.name}{p.sectionName ? `#${p.sectionName}` : ''}{p.port ? `:${p.port}` : ''}</span>
                    <StatusBadge kind={condTone(acc)}>{acc ? (acc.status === 'True' ? 'accepted' : acc.reason ?? 'rejected') : 'no status'}</StatusBadge>
                    <StatusBadge kind={condTone(res)}>{res ? (res.status === 'True' ? 'refs ok' : res.reason ?? 'unresolved') : '—'}</StatusBadge>
                    {st?.controllerName ? <span className="font-mono text-[10.5px] text-content-subtle">{st.controllerName}</span> : null}
                  </span>
                }
              />
            )
          })}
        </div>
        {parents.flatMap((p) => (p.conditions ?? []).filter((c) => c.status !== 'True' && c.message)).map((c, i) => (
          <p key={i} className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{c.type}: {c.message}</p>
        ))}
      </DrawerSection>
      <DrawerSection title={`Rules · ${(route.spec?.rules ?? []).length}`}>
        <div className="space-y-2">
          {(route.spec?.rules ?? []).map((rule, ri) => (
            <div key={ri} className="rounded-xl border border-edge-default bg-surface-raised p-3">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Rule {ri + 1}{rule.name ? <code className="font-mono normal-case tracking-normal text-content">{rule.name}</code> : null}{rule.timeouts?.request ? <Chip>timeout {rule.timeouts.request}</Chip> : null}</div>
              <div className="space-y-1 font-mono text-[11.5px]">
                {(rule.matches ?? [{}]).map((m, mi) => (
                  <div key={mi} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-content-subtle">match</span>
                    {route.kind === 'GRPCRoute' ? (
                      <Chip>{m.method ? `${m.method.service ?? '*'}/${m.method.method ?? '*'}` : '*'}</Chip>
                    ) : (
                      <><Chip>{m.method ?? 'ANY'}</Chip><Chip>{pathLabel(m)}</Chip></>
                    )}
                    {(m.headers ?? []).map((h) => <Chip key={h.name}>{h.name}={h.value}</Chip>)}
                    {(m.queryParams ?? []).map((h) => <Chip key={h.name}>?{h.name}={h.value}</Chip>)}
                  </div>
                ))}
                {(rule.filters ?? []).length ? (
                  <div className="flex flex-wrap items-center gap-1.5"><span className="text-content-subtle">filters</span>{(rule.filters ?? []).map((f, fi) => <Chip key={fi}>{f.type}</Chip>)}</div>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-content-subtle">→</span>
                  {(rule.backendRefs ?? []).length === 0 ? <Chip>no backend (filters only)</Chip> : null}
                  {(rule.backendRefs ?? []).map((b, bi) => (
                    <Chip key={bi}>{b.kind && b.kind !== 'Service' ? `${b.kind}/` : ''}{b.namespace ? `${b.namespace}/` : ''}{b.name}{b.port ? `:${b.port}` : ''}{b.weight !== undefined ? ` · w${b.weight}` : ''}</Chip>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </DrawerSection>
    </ResourceDrawer>
  )
}

/* ─────────── gateway classes ─────────── */

export function GatewayClassesTable() {
  const q = useGeneric(GVRS.gatewayclasses)
  const gws = useGeneric(GVRS.gateways)
  const [search, setSearch] = useState('')
  const all = (q.data ?? []) as GatewayClassObject[]
  const gateways = (gws.data ?? []) as GatewayObject[]
  const rows = useMemo(() => all.filter((c) => matchesSearch(c.metadata.name, search) || matchesSearch(c.spec?.controllerName, search)), [all, search])
  if (is404(q)) return <NotInstalled what="GatewayClass" />
  return (
    <ListShell title="Gateway Classes" total={all.length} visible={rows.length} loading={q.isLoading} isFetching={q.isFetching} onRefresh={() => q.refetch()} lastUpdatedAt={q.dataUpdatedAt} search={search} onSearchChange={setSearch} searchPlaceholder="Search classes, controllers…" caption="cluster-scoped · which controller programs each Gateway">
      <DataTable<GatewayClassObject>
        loading={q.isLoading}
        columns={[
          { key: 'name', header: 'Name', cell: (c) => <div><div className="font-medium text-content">{c.metadata.name}</div>{c.spec?.description ? <div className="text-xs text-content-muted">{c.spec.description}</div> : null}</div> },
          { key: 'controller', header: 'Controller', cell: (c) => <code className="font-mono text-[11px] text-content-muted">{c.spec?.controllerName ?? '—'}</code> },
          { key: 'params', header: 'Parameters', cell: (c) => c.spec?.parametersRef ? <code className="font-mono text-[11px] text-content-muted">{c.spec.parametersRef.kind ?? ''}/{c.spec.parametersRef.name}</code> : <span className="text-content-subtle">—</span> },
          { key: 'gateways', header: 'Gateways', numeric: true, cell: (c) => gateways.filter((g) => g.spec?.gatewayClassName === c.metadata.name).length },
          { key: 'status', header: 'Status', cell: (c) => { const a = cond(c.status?.conditions, 'Accepted'); return <StatusBadge kind={condTone(a)}>{a ? (a.status === 'True' ? 'accepted' : a.reason ?? 'not accepted') : 'no status'}</StatusBadge> } },
          { key: 'age', header: 'Age', cell: (c) => age(c.metadata.creationTimestamp) },
        ]}
        rows={rows}
        rowKey={(c) => c.metadata.name}
        empty={<EmptyState title="No gateway classes" description="A Gateway controller registers its GatewayClass on install." />}
      />
    </ListShell>
  )
}

/* ─────────── Ingress drawer ─────────── */

export function IngressDrawer({ ingress, onClose }: { ingress: k8s.Ingress; onClose(): void }) {
  const spec = ingress.spec as { ingressClassName?: string; rules?: Array<{ host?: string; http?: { paths?: Array<{ path?: string; pathType?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }> } }>; tls?: Array<{ hosts?: string[]; secretName?: string }>; defaultBackend?: { service?: { name?: string; port?: { number?: number; name?: string } } } } | undefined
  const status = (ingress as { status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } }).status
  const lb = status?.loadBalancer?.ingress ?? []
  const [editing, setEditing] = useState(false)
  const proto = spec?.tls?.length ? 'https:' : 'http:'
  return (
    <>
      <ResourceDrawer resource={{ ...ingress, apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' } as k8s.Ingress & { apiVersion: string; kind: string }} kindLabel="Ingress" statusBadge={<StatusBadge kind={lb.length ? 'healthy' : 'progressing'}>{lb.length ? 'load balancer assigned' : 'pending address'}</StatusBadge>} onClose={onClose}>
        <DrawerSection title="Manage">
          <div className="flex flex-wrap gap-2">
            <ActionBtn primary onClick={() => setEditing(true)}>Edit YAML</ActionBtn>
            {(spec?.rules ?? []).filter((r) => r.host).slice(0, 3).map((r) => <ActionBtn key={r.host} href={`${proto}//${r.host}`}>Open {r.host}</ActionBtn>)}
            <ActionBtn href="/platform?section=explore">Browse in Explore</ActionBtn>
          </div>
        </DrawerSection>
        <DrawerSection title="Spec">
          <div className="divide-y divide-edge-subtle text-sm">
            <Row label="Class" value={spec?.ingressClassName ?? '— (default)'} mono />
            <Row label="Address" value={lb.map((a) => a.ip ?? a.hostname).filter(Boolean).join(', ') || '—'} mono />
            <Row label="TLS" value={spec?.tls?.length ? spec.tls.map((t) => `${(t.hosts ?? []).join(', ')} → ${t.secretName ?? 'default cert'}`).join(' · ') : 'none'} mono />
            <Row label="Default backend" value={spec?.defaultBackend?.service ? `${spec.defaultBackend.service.name}:${spec.defaultBackend.service.port?.number ?? spec.defaultBackend.service.port?.name ?? ''}` : '—'} mono />
          </div>
        </DrawerSection>
        <DrawerSection title="Rules">
          <div className="overflow-hidden rounded-lg border border-edge-default">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-xs text-content-subtle"><tr><th className="px-3 py-2 text-left font-medium">Host</th><th className="px-3 py-2 text-left font-medium">Path</th><th className="px-3 py-2 text-left font-medium">Type</th><th className="px-3 py-2 text-left font-medium">Backend</th></tr></thead>
              <tbody className="divide-y divide-edge-subtle font-mono text-[12px]">
                {(spec?.rules ?? []).flatMap((r, ri) => (r.http?.paths ?? [{}]).map((p, pi) => (
                  <tr key={`${ri}-${pi}`}><td className="px-3 py-2 text-content">{r.host ?? '*'}</td><td className="px-3 py-2 text-content">{p.path ?? '/'}</td><td className="px-3 py-2 text-content-muted">{p.pathType ?? 'Prefix'}</td><td className="px-3 py-2 text-content-muted">{p.backend?.service ? `${p.backend.service.name}:${p.backend.service.port?.number ?? p.backend.service.port?.name ?? ''}` : 'resource'}</td></tr>
                )))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-content-subtle">Ingress is the legacy API — new exposure on the Adhar platform uses Gateway API HTTPRoutes (see the Routes tab).</p>
        </DrawerSection>
      </ResourceDrawer>
      {editing ? <ManifestEditor gvr={GVRS.ingresses} namespace={ingress.metadata.namespace} name={ingress.metadata.name} onClose={() => setEditing(false)} /> : null}
    </>
  )
}

/* ─────────── NetworkPolicy drawer ─────────── */

interface PeerRule {
  from?: Peer[]
  to?: Peer[]
  ports?: Array<{ port?: number | string; protocol?: string; endPort?: number }>
}
interface Peer {
  podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] }
  namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] }
  ipBlock?: { cidr: string; except?: string[] }
}

function peerLabel(p: Peer): string {
  const parts: string[] = []
  if (p.ipBlock) parts.push(`${p.ipBlock.cidr}${p.ipBlock.except?.length ? ` except ${p.ipBlock.except.join(',')}` : ''}`)
  if (p.namespaceSelector) parts.push(`ns{${Object.entries(p.namespaceSelector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(',') || 'any'}}`)
  if (p.podSelector) parts.push(`pods{${Object.entries(p.podSelector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(',') || 'any'}}`)
  return parts.join(' ∧ ') || 'any'
}

export function NetworkPolicyDrawer({ policy, onClose }: { policy: NetworkPolicyObject; onClose(): void }) {
  const spec = policy.spec as { podSelector?: { matchLabels?: Record<string, string> }; policyTypes?: string[]; ingress?: PeerRule[]; egress?: PeerRule[] } | undefined
  const types = spec?.policyTypes ?? ['Ingress']
  const [editing, setEditing] = useState(false)
  const renderRules = (rules: PeerRule[] | undefined, dir: 'from' | 'to') => {
    if (!rules) return <p className="text-[12px] text-content-subtle">Not restricted by this policy.</p>
    if (rules.length === 0) return <p className="rounded-md bg-rose-50 px-2 py-1.5 text-[12px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">Deny all — no {dir === 'from' ? 'ingress' : 'egress'} allowed.</p>
    return (
      <div className="space-y-1.5">
        {rules.map((r, i) => (
          <div key={i} className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2 font-mono text-[11.5px]">
            <div className="flex flex-wrap gap-1"><span className="text-content-subtle">{dir}</span>{(r[dir] ?? []).length === 0 ? <Chip>anywhere</Chip> : (r[dir] ?? []).map((p, pi) => <Chip key={pi}>{peerLabel(p)}</Chip>)}</div>
            <div className="mt-1 flex flex-wrap gap-1"><span className="text-content-subtle">ports</span>{(r.ports ?? []).length === 0 ? <Chip>all</Chip> : (r.ports ?? []).map((p, pi) => <Chip key={pi}>{p.protocol ?? 'TCP'} {p.port ?? '*'}{p.endPort ? `–${p.endPort}` : ''}</Chip>)}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <>
      <ResourceDrawer resource={{ ...policy, apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' } as NetworkPolicyObject & { apiVersion: string; kind: string }} kindLabel="NetworkPolicy" statusBadge={<StatusBadge kind="info">{types.join(' + ')}</StatusBadge>} onClose={onClose}>
        <DrawerSection title="Manage">
          <div className="flex flex-wrap gap-2">
            <ActionBtn primary onClick={() => setEditing(true)}>Edit YAML</ActionBtn>
            <ActionBtn href="/platform?section=explore">Browse in Explore</ActionBtn>
            <ActionBtn href="https://kubernetes.io/docs/concepts/services-networking/network-policies/">NetworkPolicy docs</ActionBtn>
          </div>
        </DrawerSection>
        <DrawerSection title="Applies to">
          <div className="divide-y divide-edge-subtle text-sm">
            <Row label="Pod selector" value={Object.entries(spec?.podSelector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'all pods in namespace'} mono />
            <Row label="Policy types" value={types.join(', ')} />
            <Row label="Age" value={age(policy.metadata.creationTimestamp)} />
          </div>
        </DrawerSection>
        {types.includes('Ingress') ? <DrawerSection title={`Ingress rules · ${spec?.ingress?.length ?? 0}`}>{renderRules(spec?.ingress, 'from')}</DrawerSection> : null}
        {types.includes('Egress') ? <DrawerSection title={`Egress rules · ${spec?.egress?.length ?? 0}`}>{renderRules(spec?.egress, 'to')}</DrawerSection> : null}
      </ResourceDrawer>
      {editing ? <ManifestEditor gvr={GVRS.networkpolicies} namespace={policy.metadata.namespace} name={policy.metadata.name} onClose={() => setEditing(false)} /> : null}
    </>
  )
}

/* ─────────── bits ─────────── */

function Conditions({ conditions }: { conditions?: Condition[] }) {
  if (!conditions?.length) return null
  return (
    <DrawerSection title="Conditions">
      <div className="divide-y divide-edge-subtle text-sm">
        {conditions.map((c) => (
          <Row key={c.type} label={c.type} value={<span className={c.status === 'True' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>{c.status}{c.reason ? ` · ${c.reason}` : ''}{c.message ? ` — ${c.message}` : ''}</span>} />
        ))}
      </div>
    </DrawerSection>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex max-w-full items-center truncate rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-content-muted">{children}</span>
}

function ActionBtn({ children, href, onClick, primary = false }: { children: ReactNode; href?: string; onClick?(): void; primary?: boolean }) {
  const cls = cn(
    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors',
    primary ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700' : 'border-edge-default bg-surface-raised text-content-muted hover:border-brand-300 hover:text-content',
  )
  if (href) {
    const ext = /^https?:/.test(href)
    return <a href={href} target={ext ? '_blank' : undefined} rel={ext ? 'noreferrer' : undefined} className={cls}>{children}</a>
  }
  return <button type="button" onClick={onClick} className={cls}>{children}</button>
}
