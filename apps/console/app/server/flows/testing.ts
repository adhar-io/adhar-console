/**
 * Test-only builders: encode Hubble flows with the same field numbers the
 * decoder reads, so tests exercise the real wire path. Not imported by
 * production code.
 */

import { PbWriter } from './proto-wire.ts'

export interface EpSpec {
  ns?: string
  pod?: string
  labels?: string[]
  identity?: number
  workload?: { name: string; kind: string }
}

export interface FlowSpec {
  timeMs: number
  verdict?: number
  dropReason?: number
  ipSrc?: string
  ipDst?: string
  tcp?: { sport: number; dport: number; syn?: boolean; ack?: boolean }
  udp?: { sport: number; dport: number }
  src?: EpSpec
  dst?: EpSpec
  type?: number
  l7?: {
    type: number
    latencyNs?: number
    http?: { code?: number; method?: string; url?: string; protocol?: string; headers?: Array<[string, string]> }
    dns?: { query: string; rcode?: number }
    kafka?: { errorCode?: number; apiKey?: string; topic?: string }
  }
  dstService?: { name: string; namespace: string }
  isReply?: boolean
}

function ep(w: PbWriter, e: EpSpec) {
  w.uint(2, e.identity ?? 0)
  if (e.ns) w.string(3, e.ns)
  for (const l of e.labels ?? []) w.string(4, l)
  if (e.pod) w.string(5, e.pod)
  if (e.workload) w.message(6, (x) => x.string(1, e.workload!.name).string(2, e.workload!.kind))
}

export function encodeFlow(f: FlowSpec): Uint8Array {
  const w = new PbWriter()
  w.message(1, (t) => t.uint(1, Math.floor(f.timeMs / 1000)).uint(2, (f.timeMs % 1000) * 1e6))
  w.uint(2, f.verdict ?? 1)
  if (f.ipSrc || f.ipDst) w.message(5, (ip) => ip.string(1, f.ipSrc ?? '').string(2, f.ipDst ?? ''))
  if (f.tcp) {
    w.message(6, (l4) =>
      l4.message(1, (t) => {
        t.uint(1, f.tcp!.sport).uint(2, f.tcp!.dport)
        if (f.tcp!.syn || f.tcp!.ack) t.message(3, (fl) => fl.bool(2, !!f.tcp!.syn).bool(5, !!f.tcp!.ack))
      }))
  } else if (f.udp) {
    w.message(6, (l4) => l4.message(2, (u) => u.uint(1, f.udp!.sport).uint(2, f.udp!.dport)))
  }
  if (f.src) w.message(8, (x) => ep(x, f.src!))
  if (f.dst) w.message(9, (x) => ep(x, f.dst!))
  w.uint(10, f.type ?? (f.l7 ? 2 : 1))
  if (f.l7) {
    const l7 = f.l7
    w.message(15, (x) => {
      x.uint(1, l7.type).uint(2, l7.latencyNs ?? 0)
      if (l7.http) {
        x.message(101, (h) => {
          h.uint(1, l7.http!.code ?? 0).string(2, l7.http!.method ?? 'GET').string(3, l7.http!.url ?? '/').string(4, l7.http!.protocol ?? 'HTTP/1.1')
          for (const [k, v] of l7.http!.headers ?? []) h.message(5, (hh) => hh.string(1, k).string(2, v))
        })
      }
      if (l7.dns) x.message(100, (d) => d.string(1, l7.dns!.query).uint(6, l7.dns!.rcode ?? 0))
      if (l7.kafka) x.message(102, (k) => k.uint(1, l7.kafka!.errorCode ?? 0).string(3, l7.kafka!.apiKey ?? '').string(5, l7.kafka!.topic ?? ''))
    })
  }
  if (f.dstService) w.message(21, (s) => s.string(1, f.dstService!.name).string(2, f.dstService!.namespace))
  if (f.dropReason) w.uint(25, f.dropReason)
  if (f.isReply !== undefined) w.message(26, (b) => b.bool(1, f.isReply!))
  return w.finish()
}

/** A GetFlowsResponse wrapping one flow. */
export function encodeResponse(f: FlowSpec): Uint8Array {
  return new PbWriter().bytes(1, encodeFlow(f)).string(1000, 'relay').finish()
}

export const pod = (ns: string, name: string, deployment: string): EpSpec => ({
  ns,
  pod: name,
  identity: 1000,
  labels: [`k8s:app=${deployment}`, `k8s:io.kubernetes.pod.namespace=${ns}`],
  workload: { name: `${deployment}-6b7c9d8f4`, kind: 'ReplicaSet' },
})
