import { normalizePkg, TECH_PACKAGES } from './catalog-lockfiles.ts'
import { type ImageRef, parseImageRef, sameVersion } from './catalog-techstack.ts'

/**
 * What is actually running: exact runtime and framework versions read from
 * the trivy-operator reports (`aquasecurity.github.io/v1alpha1`) of the
 * images Argo CD deploys, and the application's version from the image tag
 * or its OCI `org.opencontainers.image.version` label.
 *
 * Pure: the fetching lives in catalog-running-query.ts. The reports are
 * matched to images by repository plus digest (or tag) — never by workload
 * name alone, since one image can back many workloads and a workload's
 * ReplicaSet name changes on every rollout.
 */

/** The subset of a trivy-operator SbomReport / VulnerabilityReport we read. */
export interface TrivyReport {
  kind?: string
  metadata: { name: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> }
  report?: {
    updateTimestamp?: string
    registry?: { server?: string }
    artifact?: { repository?: string; tag?: string; digest?: string }
    os?: { family?: string; name?: string }
    /** SbomReport: a CycloneDX document. */
    components?: {
      metadata?: { component?: SbomComponent }
      components?: SbomComponent[]
    }
    /** VulnerabilityReport: only vulnerable packages, but with installed versions. */
    vulnerabilities?: Array<{ resource?: string; installedVersion?: string; pkgPath?: string; pkgIdentifier?: { purl?: string } }>
  }
}

export interface SbomComponent {
  type?: string
  name?: string
  group?: string
  version?: string
  purl?: string
}

export interface RunningVersion {
  /** Catalog tech key (`java`, `spring-boot`, `node`). */
  key: string
  version: string
  /** The package the version came from (`org.springframework.boot:spring-boot`, `openjdk-17-jre-headless`, `stdlib`). */
  component: string
  source: 'sbom' | 'vulnerability-report'
}

export interface RunningImage {
  image: string
  ref: ImageRef
  /** The report the versions came from, when one matched. */
  report?: { kind: 'sbom' | 'vulnerability-report'; name: string; scannedAt?: string }
  versions: RunningVersion[]
  /** Base OS as the scanner saw it (`debian 12.5`). */
  os?: string
  /** The application's own version for this image. */
  appVersion?: { version: string; source: 'oci-label' | 'image-tag'; revision?: string }
}

export type RunningState = 'ok' | 'no-report' | 'absent' | 'forbidden' | 'error' | 'loading'

export interface RunningEnv {
  env: string
  app: string
  namespace: string
  state: RunningState
  images: RunningImage[]
}

/* ─────────── component → tech ─────────── */

/** Inverse of TECH_PACKAGES: package coordinate → tech key. */
const PACKAGE_TECH: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [key, pkgs] of Object.entries(TECH_PACKAGES)) for (const p of pkgs) if (!m.has(normalizePkg(p))) m.set(normalizePkg(p), key)
  return m
})()

/** OS / binary packages that ARE a runtime. Matched against the bare package name. */
const RUNTIME_PACKAGES: Array<{ re: RegExp; key: string }> = [
  { re: /^(openjdk-\d+-(jre|jdk)(-headless)?|openjdk\d+(-jre|-jdk)?(-headless)?|java-\d+-openjdk(-headless|-devel)?|temurin-\d+-(jdk|jre)|msopenjdk-\d+|zulu\d+(-[\w-]+)?|java|openjdk|jdk|jre)$/i, key: 'java' },
  { re: /^(nodejs|node)$/i, key: 'node' },
  { re: /^(python3?(\.\d+)?(-minimal)?|libpython3\.\d+|python)$/i, key: 'python' },
  { re: /^(stdlib|golang-\d+\.\d+(-go)?|golang|go)$/i, key: 'go' },
  { re: /^(dotnet-runtime-\d+\.\d+|aspnetcore-runtime-\d+\.\d+|dotnet-runtime|aspnetcore-runtime)$/i, key: 'dotnet' },
  { re: /^(ruby\d?(\.\d+)?)$/i, key: 'ruby' },
  { re: /^(php\d?(\.\d+)?(-cli|-fpm)?)$/i, key: 'php' },
]

/**
 * A distro package version as a person reads it: `1:17.0.11+9-1~deb12u1` →
 * `17.0.11`, `17.0.11_p9-r0` → `17.0.11`, `v1.22.5` → `1.22.5`.
 */
export function cleanPkgVersion(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim().replace(/^\d+:/, '').replace(/^v(?=\d)/, '')
  const m = /^(\d+(?:\.\d+){0,2})/.exec(s)
  return m ? m[1] : undefined
}

/** `pkg:maven/org.springframework/spring-core@6.1.2` → ecosystem + coordinate + version. */
export function parsePurl(purl: string): { type: string; coord: string; version?: string } | undefined {
  const m = /^pkg:([\w.+-]+)\/([^@?#]+)(?:@([^?#]+))?/.exec(purl)
  if (!m) return undefined
  const type = m[1].toLowerCase()
  const path = m[2].split('/').map((p) => decodeURIComponent(p))
  const version = m[3] ? decodeURIComponent(m[3]) : undefined
  const name = path[path.length - 1]
  const ns = path.slice(0, -1).join('/')
  let coord = name
  if (type === 'maven') coord = ns ? `${ns}:${name}` : name
  else if (type === 'npm' || type === 'golang' || type === 'composer') coord = ns ? `${ns}/${name}` : name
  return { type, coord, version }
}

const OS_TYPES = new Set(['deb', 'rpm', 'apk', 'alpm', 'generic'])

/** Which tech a scanned package is, and its readable version. */
export function techForPackage(name: string, version: string | undefined, type?: string): { key: string; version: string } | undefined {
  const lib = PACKAGE_TECH.get(normalizePkg(name))
  if (lib && (!type || !OS_TYPES.has(type) || type === 'generic')) {
    const v = version?.replace(/^v(?=\d)/, '')
    return v && /^\d/.test(v) ? { key: lib, version: v } : undefined
  }
  const bare = name.split(/[/:]/).pop() ?? name
  const rt = RUNTIME_PACKAGES.find((r) => r.re.test(bare))
  // A library package named like a runtime (`npm:node`) is not the runtime.
  if (rt && (!type || OS_TYPES.has(type) || (type === 'golang' && bare === 'stdlib'))) {
    // The JDK's major is in the package name when the version omits it (`openjdk-17-jre` 17.0.11).
    const v = cleanPkgVersion(version)
    return v ? { key: rt.key, version: v } : undefined
  }
  return undefined
}

/** Keep the highest version per tech (a jar can appear twice, shaded and not). */
function dedupe(list: RunningVersion[]): RunningVersion[] {
  const by = new Map<string, RunningVersion>()
  const num = (v: string) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const gt = (a: string, b: string) => {
    const x = num(a)
    const y = num(b)
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
    return false
  }
  for (const v of list) {
    const cur = by.get(v.key)
    if (!cur || gt(v.version, cur.version)) by.set(v.key, v)
  }
  return [...by.values()]
}

/** Exact versions (and the base OS) in one trivy-operator report. */
export function extractRunningVersions(r: TrivyReport): { versions: RunningVersion[]; os?: string; kind: 'sbom' | 'vulnerability-report' } {
  const rep = r.report ?? {}
  const out: RunningVersion[] = []
  let os = rep.os?.family ? `${rep.os.family}${rep.os.name ? ` ${rep.os.name}` : ''}` : undefined
  if (rep.components) {
    for (const c of rep.components.components ?? []) {
      if (c.type === 'operating-system') {
        os = `${c.name ?? 'os'}${c.version ? ` ${c.version}` : ''}`
        continue
      }
      const p = c.purl ? parsePurl(c.purl) : undefined
      const name = p?.coord ?? (c.group ? `${c.group}:${c.name}` : c.name ?? '')
      const hit = techForPackage(name, c.version ?? p?.version, p?.type)
      if (hit) out.push({ key: hit.key, version: hit.version, component: name, source: 'sbom' })
    }
    return { versions: dedupe(out), os, kind: 'sbom' }
  }
  for (const v of rep.vulnerabilities ?? []) {
    const p = v.pkgIdentifier?.purl ? parsePurl(v.pkgIdentifier.purl) : undefined
    const name = p?.coord ?? v.resource ?? ''
    const hit = techForPackage(name, v.installedVersion ?? p?.version, p?.type)
    if (hit) out.push({ key: hit.key, version: hit.version, component: name, source: 'vulnerability-report' })
  }
  return { versions: dedupe(out), os, kind: 'vulnerability-report' }
}

/* ─────────── matching reports to images ─────────── */

const normRepo = (repo: string) => repo.replace(/^library\//, '')
const normRegistry = (r?: string) => (!r || /^(index\.)?docker\.io$|^registry-1\.docker\.io$/.test(r) ? 'docker.io' : r.toLowerCase())

/**
 * The report for `image`, best first: same repository and digest, then same
 * repository and tag, then (when the image names neither) same repository.
 * Newest report wins ties.
 */
export function matchReport(image: string, reports: TrivyReport[]): TrivyReport | undefined {
  const ref = parseImageRef(image)
  const sameRepo = reports.filter((r) => {
    const a = r.report?.artifact
    if (!a?.repository || normRepo(a.repository) !== normRepo(ref.repository)) return false
    return !ref.registry || !r.report?.registry?.server || normRegistry(r.report.registry.server) === normRegistry(ref.registry)
  })
  const newest = (list: TrivyReport[]) => [...list].sort((a, b) => (b.report?.updateTimestamp ?? '').localeCompare(a.report?.updateTimestamp ?? ''))[0]
  if (ref.digest) {
    const d = sameRepo.filter((r) => r.report?.artifact?.digest === ref.digest)
    if (d.length) return newest(d)
  }
  const tag = ref.tag ?? (ref.digest ? undefined : 'latest')
  if (tag) {
    const t = sameRepo.filter((r) => (r.report?.artifact?.tag ?? 'latest') === tag)
    if (t.length) return newest(t)
  }
  return ref.digest || ref.tag ? undefined : newest(sameRepo)
}

/** The app version an image reference carries in its tag (`1.4.2`, `v2.0.0-rc.1`), not `latest` or a SHA. */
export function versionFromTag(tag: string | undefined): string | undefined {
  if (!tag) return undefined
  const m = /^(?:[\w-]+-)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)$/.exec(tag)
  return m ? m[1] : undefined
}

/** Resolve every environment's images against the reports of its namespace. */
export function runningForEnvironments(
  envs: Array<{ env: string; app: string; namespace: string; images: string[] }>,
  byNamespace: Map<string, { state: RunningState; reports: TrivyReport[] }>,
  labels?: Map<string, Record<string, string>>,
): RunningEnv[] {
  return envs.map((e) => {
    const ns = byNamespace.get(e.namespace) ?? { state: 'loading' as RunningState, reports: [] }
    const images: RunningImage[] = e.images.map((image) => {
      const ref = parseImageRef(image)
      const report = ns.state === 'ok' ? matchReport(image, ns.reports) : undefined
      const ex = report ? extractRunningVersions(report) : undefined
      const l = labels?.get(image)
      const ociVersion = l?.['org.opencontainers.image.version']
      const tagVersion = versionFromTag(ref.tag)
      return {
        image,
        ref,
        report: report && ex ? { kind: ex.kind, name: report.metadata.name, scannedAt: report.report?.updateTimestamp ?? report.metadata.creationTimestamp } : undefined,
        versions: ex?.versions ?? [],
        os: ex?.os,
        appVersion: ociVersion
          ? { version: ociVersion.replace(/^v(?=\d)/, ''), source: 'oci-label', revision: l?.['org.opencontainers.image.revision'] }
          : tagVersion
            ? { version: tagVersion, source: 'image-tag' }
            : undefined,
      }
    })
    const anyReport = images.some((i) => i.report)
    return { ...e, state: ns.state === 'ok' && !anyReport && e.images.length ? 'no-report' : ns.state, images }
  })
}

/** Running version of `key` per environment (first image that reports it). */
export function runningByEnv(envs: RunningEnv[], key: string): Array<{ env: string; version: string; component: string; image: string }> {
  const out: Array<{ env: string; version: string; component: string; image: string }> = []
  for (const e of envs) {
    for (const img of e.images) {
      const v = img.versions.find((x) => x.key === key)
      if (v) {
        out.push({ env: e.env, version: v.version, component: v.component, image: img.image })
        break
      }
    }
  }
  return out
}

/* ─────────── drift ─────────── */

export type Drift = 'match' | 'drift' | 'unknown'

/**
 * Does what runs agree with what the repository says? `repo` may be a
 * range-ish value the tab shows (`20+`, `6.1.x`, `3.3`) or exact. Precision
 * differences are a match (`3.3` / `3.3.4`); a running version below a `N+`
 * floor, or on another line, is drift.
 */
export function driftOf(repo: string | undefined, running: string | undefined): Drift {
  if (!repo || !running) return 'unknown'
  const r = repo.trim()
  if (r.endsWith('+')) {
    const base = r.slice(0, -1).split('.').map(Number)
    const run = running.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
    for (let i = 0; i < base.length; i++) {
      if ((run[i] ?? 0) > base[i]) return 'match'
      if ((run[i] ?? 0) < base[i]) return 'drift'
    }
    return 'match'
  }
  if (r.endsWith('.x')) return running === r.slice(0, -2) || running.startsWith(`${r.slice(0, -2)}.`) ? 'match' : 'drift'
  return sameVersion(r, running) ? 'match' : 'drift'
}

/**
 * The most accurate version known for a tech, for support checks and the
 * headline: running (production first) › lockfile-resolved › declared.
 */
export function effectiveVersion(
  declared: string | undefined,
  resolved: string | undefined,
  running: Array<{ env: string; version: string }>,
): { version?: string; basis: 'running' | 'resolved' | 'declared' | 'none'; env?: string } {
  if (running.length) return { version: running[0].version, basis: 'running', env: running[0].env }
  if (resolved) return { version: resolved, basis: 'resolved' }
  if (declared) return { version: declared, basis: 'declared' }
  return { basis: 'none' }
}
