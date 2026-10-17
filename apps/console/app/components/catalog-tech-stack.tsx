import { useMemo } from 'react'
import { Button, Skeleton, Spinner, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { Entity } from '~/data/catalog.ts'
import type { EntityDeployment } from '~/data/catalog-deployment.ts'
import { type DocsSource, repoFileUrl, type RepoTechScan } from '~/data/catalog-docs.ts'
import {
  languageComposition,
  type LanguageShare,
  parseTechTag,
  primaryBuildTool,
  primaryFramework,
  primaryLanguage,
  runtimeFor,
  TECH_GROUP_LABEL,
  TECH_GROUP_ORDER,
  TECH_MAP,
  TECH_PILL,
  type TechBadge,
  type TechGroup,
  techFromAnnotations,
  techInitials,
  withLanguageShares,
} from '~/data/catalog-tech-badges.ts'
import { describeSupport, REVIEWED_AT, SUPPORT_TABLE, type SupportStatus, supportStatus, worstSupport } from '~/data/catalog-tech-support.ts'
import { parseImageRef } from '~/data/catalog-techstack.ts'

/**
 * The catalog entity drawer's "Tech stack" tab.
 *
 * Three sources, each shown with where it came from so a wrong number can be
 * traced: the catalog's own record (tags, `adhar.io/tech-stack`), the
 * repository (build files, CI definitions, Dockerfiles, Helm charts, the
 * forge's language statistics and releases — `useRepoTechStack`), and what
 * Argo CD is running. Support status is read from a static, dated table
 * (`catalog-tech-support.ts`), never fetched.
 */

export interface TechScanState {
  source: DocsSource | null
  data?: RepoTechScan
  isLoading: boolean
  isError: boolean
}

interface AppVersion {
  value: string
  /** Human provenance: "project <version> in pom.xml". */
  from: string
  /** Repository path, when it came from a file. */
  file?: string
  href?: string
  others: Array<{ value: string; from: string }>
}

const SUPPORT_TONE: Record<SupportStatus['state'], string> = {
  eol: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
  ending: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  supported: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  unknown: 'bg-surface-sunken text-content-muted ring-edge-subtle',
}
const SUPPORT_WORD: Record<SupportStatus['state'], string> = { eol: 'End of life', ending: 'Ending soon', supported: 'Supported', unknown: 'Unknown' }

function entityAnn(e: Entity): Record<string, string> {
  const meta = e.metadata as Entity['metadata'] & { annotations?: Record<string, string> }
  return meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {}
}

function Section({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-edge-default bg-surface-raised px-4 py-4 sm:px-5', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Mark({ badge, size = 'md' }: { badge: Pick<TechBadge, 'label' | 'tone'>; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-bold ring-1 ring-inset',
        size === 'lg' ? 'h-11 w-11 text-[14px]' : size === 'sm' ? 'h-6 w-6 text-[9px]' : 'h-8 w-8 text-[11px]',
        TECH_PILL[badge.tone],
      )}
    >
      {techInitials(badge.label)}
    </span>
  )
}

export function SupportPill({ status, compact }: { status: SupportStatus; compact?: boolean }) {
  if (status.state === 'unknown') return null
  const title = `${status.product} ${status.cycle ?? ''}${status.lts ? ' (LTS)' : ''}: ${describeSupport(status)}${status.note ? ` — ${status.note}` : ''}. Source: ${status.policy ?? 'support table'}, reviewed ${REVIEWED_AT}.`
  return (
    <span title={title} className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset', SUPPORT_TONE[status.state])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', status.state === 'eol' ? 'bg-rose-500' : status.state === 'ending' ? 'bg-amber-500' : 'bg-emerald-500')} />
      {compact ? SUPPORT_WORD[status.state] : `${SUPPORT_WORD[status.state]}${status.lts ? ' · LTS' : ''}`}
    </span>
  )
}

function CompositionBar({ shares }: { shares: LanguageShare[] }) {
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle" role="img" aria-label={shares.map((s) => `${s.name} ${s.pct}%`).join(', ')}>
        {shares.map((s) => (
          <span key={s.name} title={`${s.name} ${s.pct}%`} style={{ width: `${Math.max(s.pct, 0.6)}%`, backgroundColor: s.color }} className="h-full first:rounded-l-full last:rounded-r-full" />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {shares.map((s) => (
          <li key={s.name} className="inline-flex items-center gap-1.5 text-[12px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="font-medium text-content">{s.name}</span>
            <span className="tabular-nums text-content-subtle">{s.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Turn the tab's facts into a Markdown summary for a PR, a ticket, a review. */
function toMarkdown(args: {
  entity: Entity
  stack: TechBadge[]
  support: Map<string, SupportStatus>
  shares: LanguageShare[]
  appVersion?: AppVersion
  scan?: RepoTechScan
  repoUrl?: string
}): string {
  const { entity, stack, support, shares, appVersion, scan, repoUrl } = args
  const lines: string[] = [`## Tech stack — ${entity.metadata.title ?? entity.metadata.name}`, '']
  if (repoUrl) lines.push(`Repository: ${repoUrl}${scan ? ` @ \`${scan.ref}\`${scan.focus ? ` (folder \`${scan.focus}\`)` : ''}` : ''}`)
  if (appVersion) lines.push(`App version: **${appVersion.value}** (${appVersion.from})`)
  if (shares.length) lines.push(`Languages: ${shares.map((s) => `${s.name} ${s.pct}%`).join(', ')}`)
  lines.push('')
  for (const g of TECH_GROUP_ORDER) {
    const items = stack.filter((b) => b.group === g)
    if (!items.length) continue
    lines.push(`### ${TECH_GROUP_LABEL[g]}`, '', '| Tech | Version | Source | Support |', '| --- | --- | --- | --- |')
    for (const b of items) {
      const st = support.get(b.label)
      const also = b.also?.length ? ` (also ${b.also.map((a) => `${a.version} in ${a.from}`).join(', ')})` : ''
      lines.push(`| ${b.label} | ${b.version ?? '—'}${also} | ${b.file ?? (b.share != null ? 'language stats' : 'catalog')} | ${st && st.state !== 'unknown' ? describeSupport(st) : ''} |`)
    }
    lines.push('')
  }
  lines.push(`_Support data reviewed ${REVIEWED_AT}._`)
  return lines.join('\n')
}

export function TechStackTab({
  stack: baseStack,
  version,
  entity,
  repoUrl,
  scan,
  docsUrl,
  deployment,
  onOpenDocs,
}: {
  /** Catalog stack already folded with the repository detections (`withRepoTech`). */
  stack: TechBadge[]
  /** The entity's declared version (annotation / version-shaped tag). */
  version?: string
  entity: Entity
  repoUrl?: string
  scan?: TechScanState
  docsUrl?: string
  deployment?: EntityDeployment
  onOpenDocs?: () => void
}) {
  const toast = useToast()
  const ann = entityAnn(entity)
  const data = scan?.data
  const loading = Boolean(scan?.isLoading && !data)
  const scanSrc = scan?.source ?? null
  const scanAt = scanSrc && data ? { ...scanSrc, ref: data.ref } : scanSrc
  const hrefFor = (path: string) => (scanAt ? repoFileUrl(scanAt, path) : undefined)

  const shares = useMemo(() => languageComposition(data?.languages), [data?.languages])

  // Argo CD knows the service is delivered by GitOps to Kubernetes even when the repo says nothing.
  const stack = useMemo(() => {
    let out = withLanguageShares(baseStack, shares)
    const apps = deployment?.apps ?? []
    if (apps.length) {
      const add = (key: string, detail: string) => {
        const hit = TECH_MAP[key]
        if (!out.some((b) => b.label === hit.label)) out = [...out, { ...hit, key, detail }]
        else out = out.map((b) => (b.label === hit.label && !b.file && !b.detail ? { ...b, detail } : b))
      }
      add('argocd', `${apps.length} Argo CD application${apps.length === 1 ? '' : 's'}`)
      const ns = [...new Set(apps.map((a) => a.spec.destination.namespace).filter(Boolean))]
      add('kubernetes', ns.length ? `deployed to ${ns.join(', ')}` : 'deployed by Argo CD')
      if (apps.some((a) => a.spec.sources.some((s) => s.chart))) add('helm', 'Argo CD source is a Helm chart')
    }
    return out
  }, [baseStack, shares, deployment?.apps])

  const support = useMemo(() => {
    const m = new Map<string, SupportStatus>()
    for (const b of stack) {
      if (!b.key || !SUPPORT_TABLE[b.key === 'nodejs' ? 'node' : b.key] || !b.version) continue
      m.set(b.label, supportStatus(b.key, b.version))
    }
    return m
  }, [stack])

  const lang = primaryLanguage(stack, shares)
  const runtime = runtimeFor(lang, stack)
  const framework = primaryFramework(stack)
  const build = primaryBuildTool(stack)

  const appVersion = useMemo<AppVersion | undefined>(() => {
    const declared = ann['adhar.io/version']
      ? 'adhar.io/version annotation'
      : ann['backstage.io/version']
        ? 'backstage.io/version annotation'
        : ann['app.kubernetes.io/version']
          ? 'app.kubernetes.io/version label'
          : version
            ? 'version-shaped tag'
            : undefined
    const candidates: AppVersion[] = []
    if (version && declared) candidates.push({ value: version, from: declared, others: [] })
    if (data?.release) {
      candidates.push({ value: data.release.version, from: `latest ${data.release.kind} ${data.release.tag}`, href: data.release.url, others: [] })
    }
    for (const h of data?.appVersions ?? []) candidates.push({ value: h.version, from: `${h.detail} · ${h.source}`, file: h.source, href: hrefFor(h.source), others: [] })
    if (!candidates.length) return undefined
    const [first, ...rest] = candidates
    const seen = new Set([first.value])
    return { ...first, others: rest.filter((c) => !seen.has(c.value) && seen.add(c.value)).map((c) => ({ value: c.value, from: c.from })) }
  }, [version, data, ann, scanSrc])

  const worst = worstSupport([...support.entries()].map(([label, status]) => ({ label, status })))
  const attention = [...support.entries()].filter(([, s]) => s.state === 'eol' || s.state === 'ending')
  const conflicts = stack.filter((b) => b.also?.length)

  const grouped = TECH_GROUP_ORDER.map((g) => ({ group: g, items: stack.filter((b) => b.group === g) })).filter((x) => x.items.length > 0)
  const versioned = stack.filter((b) => b.version).length

  const envImages = (deployment?.environments ?? []).map((e) => ({ env: e.label, app: e.app.metadata.name, images: e.app.status.images }))
  const unscopedImages = (deployment?.unscoped ?? []).map((a) => ({ env: a.metadata.name, app: a.metadata.name, images: a.status.images }))
  const imageRows = [...envImages, ...unscopedImages].filter((e) => e.images.length)

  const fileLink = (path: string, className?: string) => {
    const href = hrefFor(path)
    return href ? (
      <a href={href} target="_blank" rel="noreferrer" className={cn('font-mono text-brand-700 hover:underline dark:text-brand-300', className)} title={`Open ${path} at ${data?.ref ?? scanSrc?.ref ?? ''}`}>{path}</a>
    ) : (
      <span className={cn('font-mono', className)} title={path}>{path}</span>
    )
  }

  // Which file, tag or annotation each badge came from.
  const sourceOf = (b: TechBadge): React.ReactNode => {
    if (b.file) return <>{fileLink(b.file)}{b.detail ? <span className="text-content-subtle"> · {b.detail}</span> : null}</>
    if (b.share != null && b.detail === 'repository language statistics') return 'repository language statistics'
    const tag = (entity.metadata.tags ?? []).find((t) => TECH_MAP[parseTechTag(t).key]?.label === b.label)
    if (tag && (!b.version || parseTechTag(tag).version)) return `catalog tag ${tag}`
    const fromAnn = techFromAnnotations(entity).find((m) => TECH_MAP[m.key]?.label === b.label)
    if (fromAnn) return fromAnn.version ? 'adhar.io/tech-stack annotation' : 'annotation'
    if (b.detail) return b.detail
    return tag ? `catalog tag ${tag}` : 'catalog'
  }
  const sourceText = (b: TechBadge) => (b.file ? `${b.file}${b.detail ? ` · ${b.detail}` : ''}` : b.detail ?? 'catalog')

  const copyMarkdown = () => {
    const md = toMarkdown({ entity, stack, support, shares, appVersion, scan: data, repoUrl })
    navigator.clipboard
      .writeText(md)
      .then(() => toast.success('Tech stack copied as Markdown'))
      .catch(() => toast.error('Could not copy to the clipboard'))
  }

  /* ── header facts ── */
  const facts: Array<{ label: string; value: React.ReactNode; title?: string; sub: React.ReactNode; badge?: TechBadge }> = [
    {
      label: 'Language & runtime',
      badge: lang,
      value: lang ? `${lang.label}${runtime && runtime !== lang ? '' : lang.version ? ` ${lang.version}` : ''}` : '—',
      title: lang ? `${lang.label}${lang.version ? ` ${lang.version}` : ''}${runtime && runtime !== lang ? ` on ${runtime.label}${runtime.version ? ` ${runtime.version}` : ''}` : ''}` : undefined,
      sub: runtime && runtime !== lang ? `on ${runtime.label}${runtime.version ? ` ${runtime.version}` : ''}` : lang?.share != null ? `${lang.share}% of the code` : lang ? sourceText(lang) : loading ? 'reading the repository…' : 'not detected',
    },
    {
      label: 'Framework',
      badge: framework,
      value: framework ? `${framework.label}${framework.version ? ` ${framework.version}` : ''}` : '—',
      sub: framework ? sourceText(framework) : loading ? 'reading the repository…' : 'none detected',
    },
    {
      label: 'Build tool',
      badge: build,
      value: build ? `${build.label}${build.version ? ` ${build.version}` : ''}` : '—',
      sub: build ? sourceText(build) : loading ? 'reading the repository…' : 'none detected',
    },
    {
      label: 'App version',
      value: appVersion?.value ?? '—',
      title: appVersion ? [`${appVersion.value} — ${appVersion.from}`, ...appVersion.others.map((o) => `${o.value} — ${o.from}`)].join('\n') : undefined,
      sub: appVersion ? (
        appVersion.href ? <a href={appVersion.href} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">{appVersion.from}</a> : appVersion.from
      ) : loading ? 'reading the repository…' : 'not published — no annotation, release or build-file version',
    },
  ]

  const ciSummary = data?.ci ?? []
  const containers = data?.containers ?? []
  const argoApps = deployment?.apps ?? []

  return (
    <div className="space-y-5">
      {/* ── summary ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {lang ? <Mark badge={lang} size="lg" /> : loading ? <Skeleton width={44} height={44} rounded="lg" /> : null}
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-content" title={[lang, framework].filter(Boolean).map((b) => `${b!.label}${b!.version ? ` ${b!.version}` : ''}`).join(' · ')}>
              {lang || framework
                ? [lang, framework].filter(Boolean).map((b) => `${b!.label}${b!.version ? ` ${b!.version}` : ''}`).join(' · ')
                : loading ? <Skeleton width={180} height={16} /> : 'Stack not detected'}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content-muted">
              <span>{stack.length} technolog{stack.length === 1 ? 'y' : 'ies'} · {versioned} with a version</span>
              {data ? <span className="font-mono" title={data.refSource === 'default-branch' ? 'The repository\'s default branch' : data.refSource === 'entity' ? 'Branch named by the entity' : 'Fallback branch'}>@ {data.ref}{data.focus ? ` / ${data.focus}` : ''}</span> : null}
              {worst ? <SupportPill status={worst.status} /> : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {repoUrl ? (
            <a href={repoUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md px-3 text-[12px] font-medium text-content-muted ring-1 ring-inset ring-edge-default hover:bg-surface-sunken hover:text-content">
              Repository ↗
            </a>
          ) : null}
          <Button size="sm" onClick={copyMarkdown} disabled={!stack.length}>Copy as Markdown</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{f.label}</div>
            {loading && f.value === '—' ? (
              <div className="mt-2 space-y-1.5"><Skeleton height={16} width="70%" /><Skeleton height={10} width="50%" /></div>
            ) : (
              <>
                <div className="mt-1.5 flex min-w-0 items-center gap-2">
                  <span className="truncate text-[15px] font-semibold leading-tight text-content" title={f.title ?? (typeof f.value === 'string' ? f.value : undefined)}>{f.value}</span>
                  {f.badge && support.get(f.badge.label) ? <SupportPill status={support.get(f.badge.label)!} compact /> : null}
                </div>
                <div className="mt-1 truncate text-[11px] text-content-muted" title={typeof f.sub === 'string' ? f.sub : f.title}>{f.sub}</div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* ── attention: support and conflicts ── */}
      {attention.length || conflicts.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-800 dark:text-amber-300">Needs attention</div>
          <ul className="mt-2 space-y-1.5 text-[12px] text-content">
            {attention.map(([label, s]) => (
              <li key={`s-${label}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <SupportPill status={s} compact />
                <span className="font-medium">{label} {s.cycle}</span>
                <span className="text-content-muted">{describeSupport(s)}{s.note ? ` — ${s.note}` : ''}</span>
              </li>
            ))}
            {conflicts.map((b) => (
              <li key={`c-${b.label}`} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Mismatch</span>
                <span className="font-medium">{b.label}</span>
                <span className="text-content-muted">
                  <span className="font-mono font-semibold text-content">{b.version}</span> in {b.file ? fileLink(b.file) : 'catalog'}
                  {b.also!.map((a) => (
                    <span key={`${a.version}-${a.from}`}>, <span className="font-mono font-semibold text-content">{a.version}</span> in {a.file ? fileLink(a.from) : a.from}</span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── language composition ── */}
      <Section
        title="Language composition"
        aside={shares.length ? <span className="text-[11px] text-content-subtle">bytes of code · from {scanSrc?.kind === 'github' ? 'GitHub' : 'Gitea'} language statistics</span> : undefined}
      >
        {loading ? (
          <div className="space-y-3"><Skeleton height={10} rounded="full" /><div className="flex gap-4"><Skeleton width={80} height={12} /><Skeleton width={70} height={12} /><Skeleton width={60} height={12} /></div></div>
        ) : shares.length ? (
          <CompositionBar shares={shares} />
        ) : (
          <p className="text-[12px] text-content-muted">
            {!scanSrc ? 'No readable repository is linked, so there are no language statistics.' : scan?.isError ? `Couldn't read ${scanSrc.org}/${scanSrc.repo}.` : 'The forge reports no language statistics for this repository yet (it computes them after the first push is indexed).'}
          </p>
        )}
      </Section>

      {/* ── grouped stack ── */}
      {loading && !stack.length ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Section key={i} title={i ? 'Frameworks & libraries' : 'Languages & runtimes'}>
              <div className="space-y-3">{[0, 1, 2].map((j) => <div key={j} className="flex items-center gap-3"><Skeleton width={32} height={32} rounded="lg" /><div className="flex-1 space-y-1.5"><Skeleton height={12} width="40%" /><Skeleton height={9} width="65%" /></div></div>)}</div>
            </Section>
          ))}
        </div>
      ) : stack.length === 0 ? (
        <Section title="Stack">
          <p className="text-[12px] leading-relaxed text-content-muted">
            Nothing recorded for <code className="font-mono text-content">{entity.metadata.name}</code>
            {scanSrc ? (scan?.isError ? `, and ${scanSrc.org}/${scanSrc.repo} could not be read` : ', and no build file in the repository names its stack') : ''}. Commit a build file (<code className="font-mono text-content">pom.xml</code>, <code className="font-mono text-content">build.gradle</code>, <code className="font-mono text-content">package.json</code>, <code className="font-mono text-content">go.mod</code>) or tag it with its stack and versions — for example{' '}
            <code className="font-mono text-content">java-21</code>, <code className="font-mono text-content">spring-boot-3.3</code> — or set{' '}
            <code className="font-mono text-content">adhar.io/tech-stack: "java@21, spring-boot@3.3.2"</code>.
          </p>
        </Section>
      ) : (
        <>
          {/* Sections differ in length: a column flow packs them without the gaps a grid leaves. */}
          <div className="gap-5 lg:columns-2">
            {grouped.filter((g) => g.group !== 'delivery').map(({ group, items }) => (
              <Section
                key={group}
                title={TECH_GROUP_LABEL[group]}
                className="mb-5 break-inside-avoid"
                aside={<span className="text-[11px] text-content-subtle">{items.length} · {items.filter((b) => b.version).length} versioned</span>}
              >
                <TechList items={sortItems(group, items)} support={support} sourceOf={sourceOf} fileLink={fileLink} />
              </Section>
            ))}
          </div>
          <Section
            title={TECH_GROUP_LABEL.delivery}
            aside={<span className="text-[11px] text-content-subtle">CI → container → CD</span>}
          >
            <DeliveryFlow ci={ciSummary} containers={containers} apps={argoApps} fileLink={fileLink} scanning={Boolean(scan?.isLoading)} noRepo={!scanSrc} />
            {grouped.find((g) => g.group === 'delivery') ? (
              <TechList items={sortItems('delivery', grouped.find((g) => g.group === 'delivery')!.items)} support={support} sourceOf={sourceOf} fileLink={fileLink} />
            ) : null}
          </Section>
        </>
      )}

      {/* ── running now ── */}
      {deployment ? (
        <Section title="Running now" aside={<span className="text-[11px] text-content-subtle">container images per environment · from Argo CD</span>}>
          {deployment.isLoading ? (
            <div className="space-y-2"><Skeleton height={12} width="60%" /><Skeleton height={12} width="45%" /></div>
          ) : !imageRows.length ? (
            <p className="text-[12px] text-content-muted">
              {deployment.isError ? 'Argo CD is not reachable.' : deployment.apps.length ? 'Argo CD reports no images for this application.' : 'Not deployed via Argo CD, so there is nothing running to report.'}
            </p>
          ) : (
            <ul className="divide-y divide-edge-subtle">
              {imageRows.flatMap((e) =>
                e.images.map((img, i) => {
                  const ref = parseImageRef(img)
                  const pinned = Boolean(ref.digest)
                  const latest = !pinned && (!ref.tag || ref.tag === 'latest')
                  const matchesRelease = data?.release && ref.tag && ref.tag.replace(/^v/, '') === data.release.version
                  return (
                    <li key={`${e.app}-${img}`} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
                      <span className="w-28 shrink-0 text-[12px] font-medium text-content">{i === 0 ? e.env : ''}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content-muted" title={img}>
                        {ref.registry ? <span className="text-content-subtle">{ref.registry}/</span> : null}
                        {ref.repository}
                      </span>
                      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {ref.tag ? (
                          <span className={cn('max-w-[14rem] truncate rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold', latest ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-surface-sunken text-content')} title={latest ? 'A :latest tag cannot be rolled back to' : ref.tag}>
                            {ref.tag}
                          </span>
                        ) : null}
                        {ref.digest ? (
                          <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted" title={ref.digest}>{ref.digest.slice(0, 19)}…</span>
                        ) : null}
                        {!ref.tag && !ref.digest ? (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" title="No tag means :latest, which cannot be rolled back to">latest (implicit)</span>
                        ) : null}
                        {matchesRelease ? <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300" title={`Matches ${data!.release!.kind} ${data!.release!.tag}`}>= latest release</span> : null}
                      </span>
                    </li>
                  )
                }),
              )}
            </ul>
          )}
        </Section>
      ) : null}

      {/* ── provenance + docs ── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Where this comes from">
          <dl className="-my-1 divide-y divide-edge-subtle">
            {[
              {
                label: 'Repository',
                node: repoUrl ? <a href={repoUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">{repoUrl.replace(/^https?:\/\//, '')}</a> : 'not linked',
              },
              {
                label: 'Branch',
                node: !scanSrc ? '—' : data ? <span className="font-mono">{data.ref}<span className="font-sans text-content-subtle"> · {data.refSource === 'default-branch' ? 'default branch' : data.refSource === 'entity' ? 'named by the entity' : 'fallback'}</span></span> : scan?.isLoading ? 'resolving…' : scanSrc.ref,
              },
              {
                label: 'Folder',
                node: data ? (data.focus ? <span><span className="font-mono">{data.focus}</span>{data.focusReason ? <span className="text-content-subtle"> · {data.focusReason}</span> : null}</span> : data.scannedDirs.length > 1 ? `root + ${data.scannedDirs.filter(Boolean).join(', ')}` : 'repository root') : '—',
              },
              {
                label: 'Build files',
                node: !scanSrc
                  ? 'no readable repository linked'
                  : scan?.isLoading
                    ? <span className="inline-flex items-center gap-1.5 text-content-muted"><Spinner size={11} /> reading…</span>
                    : scan?.isError
                      ? `couldn't read ${scanSrc.org}/${scanSrc.repo}`
                      : data?.files.length
                        ? <span className="break-words">{data.files.map((f, i) => <span key={f}>{i ? ', ' : ''}{fileLink(f)}</span>)}</span>
                        : 'none found',
              },
              { label: 'Listing', node: data ? `${data.pathsSeen.toLocaleString()} files scanned${data.truncated ? ' (forge truncated the tree)' : ''}` : '—' },
              { label: 'Catalog', node: (entity.metadata.tags ?? []).some((t) => TECH_MAP[parseTechTag(t).key]) || techFromAnnotations(entity).length ? `tags${techFromAnnotations(entity).length ? ' and adhar.io/tech-stack' : ''}` : 'no tech tags' },
              { label: 'Support data', node: `static table, reviewed ${REVIEWED_AT}` },
            ].map((r) => (
              <div key={r.label} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <dt className="shrink-0 text-[11px] font-medium text-content-subtle">{r.label}</dt>
                <dd className="min-w-0 break-words text-[12px] text-content sm:text-right">{r.node}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section
          title="Tech docs"
          aside={docsUrl && onOpenDocs ? (
            <button type="button" onClick={onOpenDocs} className="inline-flex min-h-9 items-center text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300 sm:min-h-0">Read here →</button>
          ) : undefined}
        >
          <div className="flex items-center gap-2">
            {docsUrl ? (
              <StatusBadge kind="healthy" className="px-1.5 py-0 text-[10px]">registered</StatusBadge>
            ) : (
              <StatusBadge kind="paused" className="px-1.5 py-0 text-[10px]">not registered</StatusBadge>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-content-muted">
            {docsUrl
              ? 'Markdown kept in the repository renders inside the console, with a table of contents and search.'
              : 'Add a docs link to metadata.links, or the backstage.io/techdocs-ref / adhar.io/docs annotation, to publish documentation for this component.'}
          </p>
        </Section>
      </div>
    </div>
  )
}

/** Versioned and file-backed items first; languages by share. */
function sortItems(group: TechGroup, items: TechBadge[]): TechBadge[] {
  const score = (b: TechBadge) => (b.version ? 0 : 2) + (b.file ? 0 : 1)
  return [...items].sort((a, b) => (group === 'language' ? (b.share ?? -1) - (a.share ?? -1) : 0) || score(a) - score(b))
}

function TechList({
  items,
  support,
  sourceOf,
  fileLink,
}: {
  items: TechBadge[]
  support: Map<string, SupportStatus>
  sourceOf: (b: TechBadge) => React.ReactNode
  fileLink: (path: string, className?: string) => React.ReactNode
}) {
  return (
    <ul className="divide-y divide-edge-subtle">
      {items.map((b) => {
        const st = support.get(b.label)
        return (
          <li key={b.label} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <Mark badge={b} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-[13px] font-medium text-content" title={b.label}>{b.label}</span>
                {b.share != null ? <span className="text-[10px] tabular-nums text-content-subtle">{b.share}% of code</span> : null}
                {st ? <SupportPill status={st} compact /> : null}
              </span>
              <span className="block truncate text-[10px] text-content-subtle" title={b.file ? `${b.file}${b.detail ? ` · ${b.detail}` : ''}` : undefined}>from {sourceOf(b)}</span>
              {st && st.state !== 'unknown' ? (
                <span className="block truncate text-[10px] text-content-muted" title={st.policy}>{st.product} {st.cycle}{st.lts ? ' LTS' : ''} · {describeSupport(st)}</span>
              ) : null}
              {b.also?.length ? (
                <span className="mt-0.5 block text-[10px] text-amber-700 dark:text-amber-300" title="Recorded differently elsewhere — worth reconciling">
                  also{' '}
                  {b.also.map((a, i) => (
                    <span key={`${a.version}-${a.from}`}>
                      {i ? ', ' : ''}
                      <span className="font-mono font-semibold">{a.version}</span> in {a.file ? fileLink(a.from, 'text-amber-700 dark:text-amber-300') : a.from}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            {b.version ? (
              <span className="max-w-[8rem] shrink-0 truncate rounded-md bg-surface-sunken px-2 py-1 font-mono text-[12px] font-semibold text-content ring-1 ring-inset ring-edge-subtle" title={b.version}>{b.version}</span>
            ) : (
              <span className="shrink-0 rounded-md border border-dashed border-edge-default px-2 py-1 text-[10px] italic text-content-subtle" title={b.file ? `${b.file} does not pin a version` : `Add the version to the tag, e.g. ${b.label.toLowerCase().replace(/\s+/g, '-')}-<version>`}>
                no version
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** CI → container → CD, as the repository and Argo CD describe it. */
function DeliveryFlow({
  ci,
  containers,
  apps,
  fileLink,
  scanning,
  noRepo,
}: {
  scanning?: boolean
  noRepo?: boolean
  ci: RepoTechScan['ci']
  containers: RepoTechScan['containers']
  apps: EntityDeployment['apps']
  fileLink: (path: string, className?: string) => React.ReactNode
}) {
  const ciName: Record<string, string> = { tekton: 'Tekton', 'github-actions': 'GitHub Actions', 'gitea-actions': 'Gitea Actions', jenkins: 'Jenkins', 'gitlab-ci': 'GitLab CI' }
  // The plain `Dockerfile` (nearest the root) is the one that ships; variants (Dockerfile.dev) come second.
  const c = [...containers].sort((a, b) => Number(!/^(docker|container)file$/i.test(a.source.split('/').pop() ?? '')) - Number(!/^(docker|container)file$/i.test(b.source.split('/').pop() ?? '')) || a.source.length - b.source.length)[0]
  const steps: Array<{ title: string; body: React.ReactNode; empty: string; ok: boolean }> = [
    {
      title: 'CI',
      ok: ci.length > 0,
      empty: 'No pipeline definition found (.tekton/, .gitea/workflows, .github/workflows, Jenkinsfile).',
      body: (
        <ul className="space-y-1">
          {ci.slice(0, 3).map((x) => (
            <li key={x.source} className="min-w-0">
              <div className="truncate text-[12px] font-medium text-content" title={x.names.join(', ') || x.source}>{ciName[x.key] ?? x.key}{x.names.length ? ` · ${x.names.slice(0, 2).join(', ')}` : ''}</div>
              <div className="truncate text-[10px] text-content-subtle">{fileLink(x.source)}</div>
              {x.steps.length ? <div className="truncate text-[10px] text-content-muted" title={x.steps.join(', ')}>{x.steps.slice(0, 5).join(' → ')}{x.steps.length > 5 ? ' …' : ''}</div> : null}
            </li>
          ))}
        </ul>
      ),
    },
    {
      title: 'Container',
      ok: Boolean(c),
      empty: 'No Dockerfile found — the image may be built by Buildpacks, Jib or kpack.',
      body: c ? (
        <div className="min-w-0 space-y-0.5">
          <div className="truncate font-mono text-[12px] font-medium text-content" title={c.base}>{c.base ?? 'unknown base'}</div>
          <div className="truncate text-[10px] text-content-subtle">{fileLink(c.source)}{c.builders.length ? ` · built with ${c.builders.join(', ')}` : ''}</div>
          <div className="flex flex-wrap gap-x-2 text-[10px] text-content-muted">
            {c.ports.length ? <span>ports {c.ports.join(', ')}</span> : null}
            {c.user && !/^(0|root)(:|$)/.test(c.user) ? <span>runs as {c.user}</span> : <span className="text-amber-700 dark:text-amber-300" title="No USER instruction in the final stage, so the container runs as root">runs as root</span>}
            {c.healthcheck ? <span>healthcheck</span> : null}
          </div>
          {containers.length > 1 ? <div className="text-[10px] text-content-subtle">+{containers.length - 1} more Dockerfile{containers.length > 2 ? 's' : ''}</div> : null}
        </div>
      ) : null,
    },
    {
      title: 'CD',
      ok: apps.length > 0,
      empty: 'Not deployed by Argo CD.',
      body: (
        <ul className="space-y-1">
          {apps.slice(0, 3).map((a) => {
            const src = a.spec.sources[0] ?? a.spec.source
            return (
              <li key={a.metadata.name} className="min-w-0">
                <div className="truncate text-[12px] font-medium text-content" title={a.metadata.name}>Argo CD · {a.metadata.name}</div>
                <div className="truncate text-[10px] text-content-subtle" title={`${src.repoURL} ${src.path ?? src.chart ?? ''}`}>
                  {src.chart ? `Helm chart ${src.chart}${src.targetRevision ? ` ${src.targetRevision}` : ''}` : src.path ? `path ${src.path}` : src.repoURL.replace(/^https?:\/\//, '')} → {a.spec.destination.namespace || 'default'}
                </div>
                <div className="text-[10px] text-content-muted">{a.status.sync.status} · {a.status.health.status}</div>
              </li>
            )
          })}
          {apps.length > 3 ? <li className="text-[10px] text-content-subtle">+{apps.length - 3} more</li> : null}
        </ul>
      ),
    },
  ]
  return (
    <ol className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
      {steps.map((s, i) => (
        <li key={s.title} className="relative min-w-0 rounded-lg border border-edge-subtle bg-surface-sunken/60 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold', s.ok ? 'bg-brand-600 text-white' : 'bg-surface-raised text-content-subtle ring-1 ring-inset ring-edge-default')}>{i + 1}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">{s.title}</span>
          </div>
          {s.ok ? s.body : s.title !== 'CD' && scanning ? (
            <div className="space-y-1.5"><Skeleton height={11} width="70%" /><Skeleton height={9} width="50%" /></div>
          ) : (
            <p className="text-[11px] leading-relaxed text-content-subtle">{s.title !== 'CD' && noRepo ? 'No readable repository linked.' : s.empty}</p>
          )}
        </li>
      ))}
    </ol>
  )
}
