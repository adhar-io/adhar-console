import { useMemo, useState } from 'react'
import { Button, EmptyState, StatusBadge, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { useGiteaOrg } from '@adhar/shell-ui'
import { type PlatformCatalog, readRepoFile, useRepoFile, useRepoInfo } from '../data/platform.ts'
import { apiUsage, type PEntity, refOf, shortRef } from '../data/platform-model.ts'
import { bumpFor, bumpVersion, describeSource, specSource, tsClientFor } from '../data/api-catalog.ts'
import { diffSpecs, type OpenApiDoc, parseSpec } from '../data/openapi.ts'
import { CatalogSources, EntityChip, KIND_TONE } from './catalog-bits.tsx'
import { PrBadge } from './work-bits.tsx'
import { copyText, downloadText } from './export.ts'

/**
 * API & Schemas ↔ the platform: API entities from the service catalog with
 * their spec source and the components that provide / consume them; the
 * breaking-change diff of a spec against its repository's default branch;
 * and a generated TypeScript client.
 */

export interface SpecLink {
  id: string
  name: string
  entity?: string
}

/** One spec document's import from a catalog API's definition. */
export interface ImportedSpec {
  document: string
  entity: string
  name: string
  source: string
  git?: { repo: string; branch: string; path: string; at: string }
}

export function CatalogApis({
  catalog,
  specs,
  onOpenSpec,
  onImport,
}: {
  catalog: PlatformCatalog
  specs: SpecLink[]
  onOpenSpec(id: string): void
  onImport(spec: ImportedSpec): void
}) {
  const toast = useToast()
  const org = useGiteaOrg()
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const apis = catalog.entities.filter((e) => e.kind === 'API')
  const shown = apis.filter((a) => !q.trim() || `${a.name} ${a.title ?? ''} ${a.description ?? ''}`.toLowerCase().includes(q.toLowerCase()))
  const byEntity = new Map(specs.filter((s) => s.entity).map((s) => [s.entity!, s]))

  const importApi = async (api: PEntity) => {
    const src = specSource(api)
    if (!src) return
    const ref = refOf(api)
    setBusy(ref)
    try {
      let document = ''
      let git: ImportedSpec['git']
      if (src.type === 'inline') document = src.text
      else if (src.type === 'repo') {
        const branch = src.branch ?? 'main'
        const f = await readRepoFile(org, src.repo, branch, src.path)
        if (!f) throw new Error(`${src.repo}/${src.path} does not exist on ${branch}.`)
        document = f.text
        git = { repo: src.repo, branch, path: src.path, at: new Date().toISOString() }
      } else {
        const res = await fetch(src.url, { headers: { accept: 'application/json, application/yaml, text/yaml, */*' } })
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${src.url}`)
        document = await res.text()
      }
      const p = parseSpec(document)
      if (p.error) throw new Error(`The definition does not parse: ${p.error}`)
      onImport({ document, entity: ref, name: api.title ?? api.name, source: describeSource(src), git })
    } catch (e) {
      toast.error('Could not import the definition', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search catalog APIs…"
          aria-label="Search catalog APIs"
          className="h-8 w-56 rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12.5px] text-content placeholder:text-content-subtle"
        />
        <CatalogSources sources={catalog.sources} className="ml-auto" />
      </div>
      {catalog.isLoading
        ? <div className="rounded-xl border border-edge-default p-8 text-center text-[12.5px] text-content-subtle">Reading the service catalog…</div>
        : apis.length === 0
        ? (
          <EmptyState
            compact
            title="No API entities in the catalog"
            description="APIs come from `kind: API` documents in your repositories' catalog-info.yaml (with `spec.definition` pointing at the spec). Components list them under providesApis / consumesApis."
          />
        )
        : (
          <div className="overflow-x-auto rounded-xl border border-edge-default">
            <table className="w-full min-w-[720px] text-left text-[12.5px]">
              <thead className="bg-surface-sunken/70 text-[10.5px] uppercase tracking-wider text-content-subtle">
                <tr>
                  <th className="px-3 py-2 font-semibold">API</th>
                  <th className="px-3 py-2 font-semibold">Provided by</th>
                  <th className="px-3 py-2 font-semibold">Consumed by</th>
                  <th className="px-3 py-2 font-semibold">Spec source</th>
                  <th className="px-3 py-2 text-right font-semibold">Design</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {shown.map((api) => {
                  const ref = refOf(api)
                  const use = apiUsage(catalog.entities, ref)
                  const src = specSource(api)
                  const linked = byEntity.get(ref)
                  return (
                    <tr key={ref} className="align-top">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded px-1 font-mono text-[9.5px] uppercase ${KIND_TONE.API}`}>{api.type ?? 'api'}</span>
                          <span className="font-medium text-content">{api.title ?? api.name}</span>
                        </div>
                        {api.description ? <div className="mt-0.5 line-clamp-2 text-[11.5px] text-content-muted">{api.description}</div> : null}
                        {api.system ? <div className="mt-0.5 text-[11px] text-content-subtle">{shortRef(api.system)}</div> : null}
                      </td>
                      <td className="px-3 py-2"><RefList list={use.providers} /></td>
                      <td className="px-3 py-2"><RefList list={use.consumers} /></td>
                      <td className="px-3 py-2 font-mono text-[11px] text-content-muted">{describeSource(src)}</td>
                      <td className="px-3 py-2 text-right">
                        {linked
                          ? <Button size="xs" onClick={() => onOpenSpec(linked.id)}>Open spec</Button>
                          : <Button size="xs" variant="primary" disabled={!src || busy === ref} loading={busy === ref} onClick={() => void importApi(api)}>Import spec</Button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

function RefList({ list }: { list: PEntity[] }) {
  if (!list.length) return <span className="text-[11.5px] text-content-subtle">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((e) => <EntityChip key={refOf(e)} entityRef={refOf(e)} entity={e} />)}
    </div>
  )
}

/* ───────────────────────── editor: repo & catalog ───────────────────────── */

export function RepoPanel({
  git,
  pr,
  entity,
  catalog,
  current,
  version,
  onReplace,
  onPublish,
  onLinkFile,
}: {
  git?: { repo: string; branch: string; path: string; at: string }
  pr?: { repo: string; number: number; branch: string; base: string; at: string }
  entity?: string
  catalog: PlatformCatalog
  current: OpenApiDoc | null
  version: string
  onReplace(text: string, source: string): void
  onPublish(suggestedVersion?: string): void
  onLinkFile(): void
}) {
  const repo = useRepoInfo(git?.repo)
  const base = repo.data?.default_branch ?? git?.branch
  const file = useRepoFile(git?.repo, base, git?.path)
  const remoteDoc = useMemo(() => (file.data ? parseSpec(file.data.text).doc : null), [file.data])
  const diff = useMemo(() => (remoteDoc && current ? diffSpecs(remoteDoc, current) : null), [remoteDoc, current])
  const bump = diff ? bumpFor(diff) : 'none'
  const usage = entity ? apiUsage(catalog.entities, entity) : null
  const ent = entity ? catalog.entities.find((e) => refOf(e) === entity) : undefined

  return (
    <div className="space-y-5 text-[12.5px]">
      <section className="space-y-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Catalog</div>
        {entity
          ? (
            <>
              <EntityChip entityRef={entity} entity={ent ?? (catalog.settled ? null : undefined)} />
              {usage
                ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] text-content-muted">Provided by</div>
                      <RefList list={usage.providers} />
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] text-content-muted">Consumed by</div>
                      <RefList list={usage.consumers} />
                    </div>
                  </div>
                )
                : null}
              {usage && usage.consumers.length && bump === 'major'
                ? <div className="text-[12px] text-rose-700 dark:text-rose-300">Breaking changes affect {usage.consumers.length} consumer{usage.consumers.length === 1 ? '' : 's'}: {usage.consumers.map((c) => c.title ?? c.name).join(', ')}.</div>
                : null}
            </>
          )
          : <div className="text-content-subtle">Not linked to a catalog API. Import specs from the “Catalog APIs” tab to link them.</div>}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Repository</span>
          <div className="ml-auto flex gap-1">
            {git ? <Button size="xs" onClick={() => file.data && onReplace(file.data.text, `${git.repo}@${base}/${git.path}`)} disabled={!file.data}>Sync from {base ?? 'repo'}</Button> : null}
            <Button size="xs" variant="primary" onClick={() => onPublish(bump !== 'none' ? bumpVersion(version, bump) : undefined)}>Publish as PR…</Button>
          </div>
        </div>
        {!git
          ? (
            <div className="text-content-subtle">
              Not linked to a file in Gitea. <button type="button" onClick={onLinkFile} className="text-brand-700 hover:underline dark:text-brand-300">Pick the spec file…</button> or publish it to create one.
            </div>
          )
          : (
            <div className="space-y-2">
              <div className="font-mono text-[11px] text-content-muted">{git.repo}/{git.path} · compared with <span className="text-content">{base}</span> · last synced {formatRelative(git.at)}</div>
              {pr ? <PrBadge repo={pr.repo} number={pr.number} /> : null}
              {file.isLoading || repo.isLoading
                ? <div className="text-content-subtle">Reading {git.path}…</div>
                : file.error
                ? <div className="text-rose-600 dark:text-rose-400">{file.error.message}</div>
                : file.data === null
                ? <div className="text-content-subtle">{git.path} is not on {base} yet — publishing creates it.</div>
                : !current
                ? <div className="text-rose-600">The current draft does not parse — fix it to compare.</div>
                : diff
                ? <RepoDiff diff={diff} bump={bump} base={base ?? ''} />
                : null}
            </div>
          )}
      </section>
    </div>
  )
}

function RepoDiff({ diff, bump, base }: { diff: ReturnType<typeof diffSpecs>; bump: ReturnType<typeof bumpFor>; base: string }) {
  if (bump === 'none') return <StatusBadge kind="healthy">Matches {base}</StatusBadge>
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind={bump === 'major' ? 'failed' : bump === 'minor' ? 'info' : 'unknown'}>{bump === 'major' ? 'Breaking' : bump === 'minor' ? 'Additive' : 'Compatible'} · {bump} bump</StatusBadge>
        <span className="text-content-muted">
          +{diff.added.length} / −{diff.removed.length} operations · {diff.changed.length} changed · {diff.schemasChanged.length + diff.schemasAdded.length + diff.schemasRemoved.length} schema changes
        </span>
      </div>
      {diff.breaking.length
        ? (
          <ul className="list-disc space-y-0.5 rounded-lg border border-rose-200 bg-rose-50 py-2 pl-7 pr-3 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            {diff.breaking.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        )
        : null}
      {[...diff.added.map((x) => `+ ${x}`), ...diff.removed.map((x) => `− ${x}`), ...diff.changed.flatMap((c) => c.changes.map((x) => `~ ${c.key}: ${x}`))].length
        ? (
          <pre className="max-h-56 overflow-auto rounded-lg border border-edge-default bg-surface-sunken/50 p-2 font-mono text-[11px] text-content-muted">
            {[...diff.added.map((x) => `+ ${x}`), ...diff.removed.map((x) => `− ${x}`), ...diff.changed.flatMap((c) => c.changes.map((x) => `~ ${c.key}: ${x}`))].join('\n')}
          </pre>
        )
        : null}
    </div>
  )
}

/* ───────────────────────── editor: client ───────────────────────── */

export function ClientPanel({ doc, name }: { doc: OpenApiDoc | null; name: string }) {
  const toast = useToast()
  const src = useMemo(() => tsClientFor(doc), [doc])
  if (!src) return <EmptyState compact title="Nothing to generate" description="The document must parse as OpenAPI with at least one HTTP operation." />
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
        A dependency-free TypeScript client (types + one function per operation) built on <code className="font-mono">fetch</code>.
        <div className="ml-auto flex gap-1">
          <Button size="xs" onClick={async () => ((await copyText(src)) ? toast.success('Client copied') : toast.error('Clipboard unavailable'))}>Copy</Button>
          <Button size="xs" onClick={() => downloadText(src, `${name}-client.ts`, 'text/typescript')}>Download .ts</Button>
        </div>
      </div>
      <pre className="max-h-[60vh] overflow-auto rounded-lg bg-code p-3 font-mono text-[11.5px] leading-relaxed text-code-fg">{src}</pre>
    </div>
  )
}
