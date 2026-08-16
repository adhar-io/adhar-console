import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { useLiveList } from './live.ts'
import { GVRS } from './gvr.ts'

/**
 * Helm releases, read straight from the cluster — Helm 3 persists each
 * release revision as a `helm.sh/release.v1` Secret labelled `owner=helm`.
 * The Secret's labels carry `name`, `version` (revision) and `status`
 * without any decompression, so the list works with zero new dependencies.
 *
 * The full payload (`data.release`) is double-encoded: base64 (Secret data)
 * of base64(gzip(JSON)). Browsers can gunzip natively via
 * `DecompressionStream`, so the drawer decodes chart/app-version/notes when
 * the platform supports it and says so honestly when it can't — values are
 * never fabricated.
 */

const HELM_SECRET_TYPE = 'helm.sh/release.v1'

export interface HelmSecret extends KubeObject {
  type?: string
  data?: Record<string, string>
}

export interface HelmRevision {
  revision: number
  status: string
  /** ISO timestamp — Helm's `modifiedAt` label when present, else the Secret's creationTimestamp. */
  updated?: string
  secretName: string
  secret: HelmSecret
}

export interface HelmRelease {
  /** `namespace/name` — stable row key. */
  key: string
  name: string
  namespace: string
  /** Latest revision (highest `version` label). */
  latest: HelmRevision
  /** All revisions, newest first. */
  history: HelmRevision[]
}

function revisionOf(secret: HelmSecret): HelmRevision | null {
  const labels = secret.metadata?.labels ?? {}
  const revision = Number.parseInt(labels.version ?? '', 10)
  if (!labels.name || Number.isNaN(revision)) return null
  const modifiedAt = Number.parseInt(labels.modifiedAt ?? '', 10)
  return {
    revision,
    status: labels.status ?? 'unknown',
    updated: Number.isNaN(modifiedAt)
      ? secret.metadata?.creationTimestamp
      : new Date(modifiedAt * 1000).toISOString(),
    secretName: secret.metadata?.name ?? '',
    secret,
  }
}

/**
 * Live, watch-backed Helm release inventory. Lists `owner=helm` Secrets
 * cluster-wide (or per namespace), groups revisions per release and sorts
 * history newest-first.
 */
export function useHelmReleases(namespace?: string) {
  const live = useLiveList<HelmSecret>(GVRS.secrets, {
    namespace,
    labelSelector: 'owner=helm',
  })

  const releases = useMemo<HelmRelease[]>(() => {
    const byRelease = new Map<string, { name: string; namespace: string; revisions: HelmRevision[] }>()
    for (const secret of live.data) {
      if (secret.type && secret.type !== HELM_SECRET_TYPE) continue
      const rev = revisionOf(secret)
      if (!rev) continue
      const name = secret.metadata?.labels?.name ?? ''
      const ns = secret.metadata?.namespace ?? ''
      const key = `${ns}/${name}`
      const entry = byRelease.get(key)
      if (entry) entry.revisions.push(rev)
      else byRelease.set(key, { name, namespace: ns, revisions: [rev] })
    }
    return [...byRelease.entries()]
      .map(([key, { name, namespace: ns, revisions }]) => {
        const history = [...revisions].sort((a, b) => b.revision - a.revision)
        return { key, name, namespace: ns, latest: history[0], history }
      })
      .sort((a, b) => a.key.localeCompare(b.key))
  }, [live.data])

  return { ...live, releases }
}

/* ─── in-browser payload decode (no dependency — native gunzip) ────────── */

export interface DecodedHelmRelease {
  name?: string
  namespace?: string
  version?: number
  info?: {
    first_deployed?: string
    last_deployed?: string
    deleted?: string
    description?: string
    status?: string
    notes?: string
  }
  chart?: {
    metadata?: {
      name?: string
      version?: string
      appVersion?: string
      description?: string
    }
  }
  config?: Record<string, unknown>
}

/**
 * Decode a Helm release Secret payload. Returns `null` whenever the payload
 * can't be decoded honestly (no `DecompressionStream` support, corrupt data)
 * — callers must render a "can't decode" state, never invented values.
 */
export async function decodeHelmRelease(secret: HelmSecret): Promise<DecodedHelmRelease | null> {
  const payload = secret.data?.release
  if (!payload) return null
  try {
    // Secret data is base64; Helm stores base64(gzip(JSON)) inside it.
    const inner = atob(atob(payload.replace(/\s/g, '')))
    const bytes = Uint8Array.from(inner, (c) => c.charCodeAt(0))
    const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
    if (!gzipped) return JSON.parse(inner) as DecodedHelmRelease
    if (typeof DecompressionStream === 'undefined') return null
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    const json = await new Response(stream).text()
    return JSON.parse(json) as DecodedHelmRelease
  } catch {
    return null
  }
}

/** Cached decode of one revision's payload — keyed by the Secret identity. */
export function useDecodedRelease(secret: HelmSecret | undefined) {
  return useQuery({
    queryKey: [
      'helm',
      'decode',
      secret?.metadata?.namespace ?? '',
      secret?.metadata?.name ?? '',
      secret?.metadata?.resourceVersion ?? '',
    ],
    queryFn: () => decodeHelmRelease(secret!),
    enabled: Boolean(secret),
    staleTime: Infinity,
    retry: false,
  })
}
