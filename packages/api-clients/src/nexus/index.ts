import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Sonatype Nexus Repository (OSS) — the platform's **package** registry.
 *
 * Nexus is deliberately *not* modelled on Harbor. On this platform it holds
 * language packages (maven2 / npm / pypi / nuget) rather than container images,
 * and Nexus OSS has no vulnerability scanner, no signature store and no SBOM
 * endpoint — those are Sonatype Lifecycle (commercial) features. Everything this
 * client exposes is therefore inventory + integrity (checksums), and nothing
 * here should be presented as a security verdict.
 *
 * API surface used (Nexus 3 REST v1):
 *   GET /service/rest/v1/repositories
 *   GET /service/rest/v1/search?format=&repository=&q=&continuationToken=
 *   GET /service/rest/v1/components?repository=&continuationToken=
 *   GET /service/rest/v1/status/check
 */

/** A checksum set — Nexus records whichever algorithms the format produces. */
export interface AssetChecksum {
  md5?: string
  sha1?: string
  sha256?: string
  sha512?: string
}

/** One downloadable file belonging to a component (jar, tgz, whl, nupkg, …). */
export interface NexusAsset {
  id: string
  path: string
  downloadUrl: string
  repository?: string
  format?: string
  contentType?: string
  fileSize?: number
  checksum: AssetChecksum
  lastModified?: string
  lastDownloaded?: string
  uploader?: string
  blobCreated?: string
  blobStoreName?: string
  /**
   * The format-specific attribute block Nexus attaches (`maven2`, `npm`,
   * `pypi`, `docker`, …). The key varies by format, so it is kept raw rather
   * than flattened into fields that would be wrong for most formats.
   */
  formatAttributes?: Record<string, unknown>
}

/** A component = one `group:name:version` coordinate with its assets. */
export interface NexusComponent {
  id: string
  repository: string
  format: string
  group?: string
  name: string
  version?: string
  assets: NexusAsset[]
}

export interface NexusRepository {
  name: string
  format: string
  /** `hosted` | `proxy` | `group`. */
  type: string
  url: string
  /** Upstream URL for a proxy repository — the supply-chain origin of its content. */
  remoteUrl?: string
  /** `ALLOW` | `ALLOW_ONCE` | `DENY` — whether re-deploying a version is possible. */
  versionPolicy?: string
  writePolicy?: string
  online?: boolean
}

/** One entry of Nexus' `status/check` health map. */
export interface NexusHealthCheck {
  name: string
  healthy: boolean
  message?: string
  error?: string
  duration?: number
}

export interface NexusPage<T> {
  items: T[]
  /** Pass back as `continuationToken` for the next page; absent ⇒ last page. */
  continuationToken?: string
}

export interface SearchParams {
  format?: string
  repository?: string
  /** Free-text keyword (Nexus matches group / name / version). */
  q?: string
  continuationToken?: string
}

export interface NexusClient {
  listRepositories(): Promise<NexusRepository[]>
  search(params?: SearchParams): Promise<NexusPage<NexusComponent>>
  listComponents(repository: string, continuationToken?: string): Promise<NexusPage<NexusComponent>>
  /** Health map. Throws when Nexus is unreachable — callers must not treat that as "healthy". */
  statusCheck(): Promise<NexusHealthCheck[]>
}

const FORMAT_KEYS = ['maven2', 'npm', 'pypi', 'nuget', 'docker', 'raw', 'helm', 'go', 'rubygems', 'conda'] as const

interface RawAsset {
  id?: string
  path?: string
  downloadUrl?: string
  repository?: string
  format?: string
  contentType?: string
  fileSize?: number
  checksum?: AssetChecksum
  lastModified?: string
  lastDownloaded?: string
  uploader?: string
  blobCreated?: string
  blobStoreName?: string
  [k: string]: unknown
}

interface RawComponent {
  id?: string
  repository?: string
  format?: string
  group?: string | null
  name?: string
  version?: string
  assets?: RawAsset[] | null
}

function toAsset(a: RawAsset): NexusAsset {
  let formatAttributes: Record<string, unknown> | undefined
  for (const k of FORMAT_KEYS) {
    const v = a[k]
    if (v && typeof v === 'object') {
      formatAttributes = v as Record<string, unknown>
      break
    }
  }
  return {
    id: a.id ?? a.path ?? a.downloadUrl ?? '',
    path: a.path ?? '',
    downloadUrl: a.downloadUrl ?? '',
    repository: a.repository,
    format: a.format,
    contentType: a.contentType,
    fileSize: a.fileSize,
    checksum: a.checksum ?? {},
    lastModified: a.lastModified ?? undefined,
    lastDownloaded: a.lastDownloaded ?? undefined,
    uploader: a.uploader,
    blobCreated: a.blobCreated ?? undefined,
    blobStoreName: a.blobStoreName,
    formatAttributes,
  }
}

function toComponent(c: RawComponent): NexusComponent {
  return {
    id: c.id ?? `${c.repository ?? ''}:${c.group ?? ''}:${c.name ?? ''}:${c.version ?? ''}`,
    repository: c.repository ?? '',
    format: c.format ?? '',
    group: c.group || undefined,
    name: c.name ?? '',
    version: c.version || undefined,
    assets: (c.assets ?? []).map(toAsset),
  }
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v)
  const s = sp.toString()
  return s ? `?${s}` : ''
}

function build(http: HttpClient): NexusClient {
  return {
    listRepositories: async () => {
      const list = await http.get<
        Array<{
          name?: string
          format?: string
          type?: string
          url?: string
          attributes?: { proxy?: { remoteUrl?: string }; maven?: { versionPolicy?: string } }
        }>
      >('/service/rest/v1/repositories')
      return (list ?? []).map((r) => ({
        name: r.name ?? '',
        format: r.format ?? '',
        type: r.type ?? '',
        url: r.url ?? '',
        remoteUrl: r.attributes?.proxy?.remoteUrl,
        versionPolicy: r.attributes?.maven?.versionPolicy,
      }))
    },
    search: async (params = {}) => {
      const page = await http.get<{ items?: RawComponent[] | null; continuationToken?: string | null }>(
        `/service/rest/v1/search${qs({
          format: params.format,
          repository: params.repository,
          q: params.q,
          continuationToken: params.continuationToken,
        })}`,
      )
      return { items: (page?.items ?? []).map(toComponent), continuationToken: page?.continuationToken ?? undefined }
    },
    listComponents: async (repository, continuationToken) => {
      const page = await http.get<{ items?: RawComponent[] | null; continuationToken?: string | null }>(
        `/service/rest/v1/components${qs({ repository, continuationToken })}`,
      )
      return { items: (page?.items ?? []).map(toComponent), continuationToken: page?.continuationToken ?? undefined }
    },
    // Nexus keys this by check name, so the map is flattened into a list the UI
    // can sort. A failing check is reported as-is; there is no "assume healthy".
    statusCheck: async () => {
      const map = await http.get<
        Record<string, { healthy?: boolean; message?: string; error?: string; duration?: number }>
      >('/service/rest/v1/status/check')
      return Object.entries(map ?? {}).map(([name, v]) => ({
        name,
        healthy: v?.healthy === true,
        message: v?.message || undefined,
        error: v?.error || undefined,
        duration: v?.duration,
      }))
    },
  }
}

const STUB_REPOS: NexusRepository[] = [
  { name: 'maven-central', format: 'maven2', type: 'proxy', url: 'http://nexus/repository/maven-central', remoteUrl: 'https://repo1.maven.org/maven2/' },
  { name: 'maven-releases', format: 'maven2', type: 'hosted', url: 'http://nexus/repository/maven-releases', versionPolicy: 'RELEASE' },
  { name: 'npm-proxy', format: 'npm', type: 'proxy', url: 'http://nexus/repository/npm-proxy', remoteUrl: 'https://registry.npmjs.org' },
  { name: 'pypi-proxy', format: 'pypi', type: 'proxy', url: 'http://nexus/repository/pypi-proxy', remoteUrl: 'https://pypi.org/' },
]

const STUB_COMPONENTS: NexusComponent[] = [
  {
    id: 'stub-1',
    repository: 'maven-releases',
    format: 'maven2',
    group: 'io.adhar',
    name: 'platform-core',
    version: '1.4.2',
    assets: [
      {
        id: 'stub-1-a',
        path: 'io/adhar/platform-core/1.4.2/platform-core-1.4.2.jar',
        downloadUrl: 'http://nexus/repository/maven-releases/io/adhar/platform-core/1.4.2/platform-core-1.4.2.jar',
        contentType: 'application/java-archive',
        fileSize: 2_418_331,
        checksum: { sha1: 'a1b2c3d4e5f6', sha256: '9f5453a0d1e2f3a4b5c6d7e8f90112233445566778899aabbccddeeff00112233' },
        lastModified: '2026-04-20T09:12:00Z',
        formatAttributes: { groupId: 'io.adhar', artifactId: 'platform-core', version: '1.4.2', extension: 'jar' },
      },
    ],
  },
  {
    id: 'stub-2',
    repository: 'npm-proxy',
    format: 'npm',
    name: 'react',
    version: '19.2.0',
    assets: [
      {
        id: 'stub-2-a',
        path: 'react/-/react-19.2.0.tgz',
        downloadUrl: 'http://nexus/repository/npm-proxy/react/-/react-19.2.0.tgz',
        contentType: 'application/x-gzip',
        fileSize: 87_221,
        checksum: { sha1: 'ff00aa11bb22', sha512: 'deadbeef' },
        lastModified: '2026-03-02T14:00:00Z',
      },
    ],
  },
]

export const NexusClient = defineClient<NexusClient>(build, () => ({
  listRepositories: () => Promise.resolve(STUB_REPOS),
  search: (params = {}) =>
    Promise.resolve({
      items: STUB_COMPONENTS.filter(
        (c) => (!params.repository || c.repository === params.repository) && (!params.format || c.format === params.format),
      ),
    }),
  listComponents: (repository) =>
    Promise.resolve({ items: STUB_COMPONENTS.filter((c) => c.repository === repository) }),
  statusCheck: () =>
    Promise.resolve([
      { name: 'Available CPUs', healthy: true, message: '4 available processors.' },
      { name: 'Blob Stores', healthy: true },
      { name: 'Default Role', healthy: true },
    ]),
}))
