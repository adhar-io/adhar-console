import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, docStore, Field, Input, Modal, Select, Textarea, useGiteaOrg, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { KIND, useCollection } from '../data/store.ts'
import type { ColorToken, TokenPublishDoc, TokenPublishRecord, TokenSet, TokenSnapshot } from '../data/types.ts'
import { appRepo, encode, giteaClient, scopedApps, useCatalogApps, useDesignerRepos, useRepoBranches } from '../data/designer-repos.ts'
import { cleanDir, publishBranch, publishFiles, publishPrBody, PUBLISH_FILES } from '../data/token-publish.ts'
import { contrastRatio, countTokens, findColor, wcag } from '../data/tokens-lib.ts'
import { extractJson, PALETTE_PROMPT, toPalette } from '../data/ux-ai.ts'
import { askAdharAi } from '../data/ai.ts'
import type { DesignScope } from '../data/design-scope.ts'
import { designHref } from '../data/nav.ts'
import { PrBadge, Spark } from './integrations.tsx'

/* ───────────────────────────── repos in scope ───────────────────────────── */

export interface RepoOption {
  fullName: string
  name: string
  defaultBranch: string
  /** True when a catalog application of the scope deploys it. */
  inScope: boolean
}

/** The org's repositories, the scope's application repos first. */
export function useScopeRepos(scope: DesignScope): { repos: RepoOption[]; loading: boolean; error: Error | null } {
  const org = useGiteaOrg()
  const repos = useDesignerRepos()
  const apps = useCatalogApps()
  return useMemo(() => {
    const inScope = new Set(
      scopedApps(apps.data ?? [], scope.inScope, scope.projects).map((a) => appRepo(a, org)?.toLowerCase()).filter(Boolean) as string[],
    )
    for (const p of scope.projects) {
      if (scope.inScope && !scope.inScope.has(p.slug)) continue
      const primary = (p as { primaryRepo?: string }).primaryRepo
      if (primary) inScope.add((primary.includes('/') ? primary : `${p.giteaOrg || org}/${primary}`).toLowerCase())
    }
    const list = (repos.data ?? []).map((r) => ({
      fullName: r.full_name,
      name: r.name,
      defaultBranch: r.default_branch,
      inScope: inScope.has(r.full_name.toLowerCase()),
    }))
    list.sort((a, b) => Number(b.inScope) - Number(a.inScope) || a.fullName.localeCompare(b.fullName))
    return { repos: list, loading: repos.isLoading, error: (repos.error as Error | null) ?? null }
  }, [repos.data, repos.isLoading, repos.error, apps.data, scope.inScope, scope.projects, org])
}

function RepoSelect({ repos, value, onChange }: { repos: RepoOption[]; value: string; onChange(v: string): void }) {
  const scoped = repos.filter((r) => r.inScope)
  const rest = repos.filter((r) => !r.inScope)
  return (
    <Select aria-label="Repository" value={value} onChange={(e) => onChange(e.target.value)} className="h-9 py-1.5 text-sm">
      <option value="">Choose a repository</option>
      {scoped.length ? (
        <optgroup label="This scope's applications">
          {scoped.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
        </optgroup>
      ) : null}
      <optgroup label={scoped.length ? 'Other repositories' : 'Repositories'}>
        {rest.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
      </optgroup>
    </Select>
  )
}

function BranchSelect({ repo, value, onChange }: { repo: string; value: string; onChange(v: string): void }) {
  const name = repo.split('/').pop()
  const branches = useRepoBranches(repo ? name : undefined)
  return (
    <Select
      aria-label="Branch"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 py-1.5 font-mono text-xs"
      options={branches.data?.length ? branches.data.map((b) => ({ value: b.name, label: b.name })) : [{ value, label: branches.isLoading ? 'Loading…' : value || '—' }]}
    />
  )
}

/* ───────────────────────────── publish ───────────────────────────── */

export function usePublishDoc(scopeId: string) {
  const list = useCollection<TokenPublishDoc & { id: string }>(KIND.tokenPublish)
  return { doc: list.items.find((d) => d.id === scopeId) ?? null, all: list.items, isLoading: list.isLoading }
}

/**
 * Publish the token set to a repository as a pull request: tag a version
 * (History), write the W3C JSON + CSS + Tailwind files on a new branch, open
 * the PR, and remember it so its status shows here and on the dashboard.
 */
export function PublishModal({
  open,
  onClose,
  tokens,
  scope,
  overrides,
  versionCount,
}: {
  open: boolean
  onClose(): void
  tokens: TokenSet
  scope: DesignScope
  overrides: number
  versionCount: number
}) {
  const scopeId = scope.project || 'workspace'
  const { doc } = usePublishDoc(scopeId)
  const { repos, loading, error } = useScopeRepos(scope)
  const org = useGiteaOrg()
  const toast = useToast()
  const qc = useQueryClient()
  const [repo, setRepo] = useState('')
  const [base, setBase] = useState('')
  const [dir, setDir] = useState('src/design-tokens')
  const [version, setVersion] = useState('')

  useEffect(() => {
    if (!open) return
    const first = doc?.repo ?? repos.find((r) => r.inScope)?.fullName ?? ''
    setRepo(first)
    setBase(doc?.base ?? repos.find((r) => r.fullName === first)?.defaultBranch ?? 'main')
    setDir(doc?.dir ?? 'src/design-tokens')
    // Next "vN" after both saved versions and earlier publishes.
    const published = (doc?.history ?? []).map((h) => Number(/^v(\d+)$/.exec(h.versionLabel ?? '')?.[1] ?? 0))
    setVersion(`v${Math.max(versionCount, ...published) + 1}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const files = useMemo(
    () => publishFiles(tokens, dir, { version: version || 'unversioned', scope: scopeId, source: typeof location !== 'undefined' ? `${location.origin}${designHref('tokens', scope.project ? { project: scope.project } : {})}` : undefined }),
    [tokens, dir, version, scopeId, scope.project],
  )

  const publish = useMutation({
    mutationFn: async () => {
      const [owner, name] = repo.includes('/') ? repo.split('/', 2) : [org, repo]
      // 1. Tag a version in History.
      const snap = await docStore.create<Omit<TokenSnapshot, 'id'>>(KIND.tokenSnapshot, {
        label: `${version} · published to ${repo}`,
        created_at: new Date().toISOString(),
        count: countTokens(tokens),
        tokens,
      })
      // 2. One commit with every file, on a new branch from the base.
      const shas = await Promise.all(files.map((f) => giteaClient.getFile(owner, name, base, f.path).then((x) => x.sha, () => undefined)))
      const branch = publishBranch(scopeId)
      await giteaClient.changeFiles(owner, name, base, {
        message: `design: publish ${scopeId} tokens ${version}`,
        new_branch: branch,
        files: files.map((f, i) => ({
          operation: shas[i] ? 'update' as const : 'create' as const,
          path: f.path,
          content: encode(f.content),
          ...(shas[i] ? { sha: shas[i] } : {}),
        })),
      })
      // 3. The pull request.
      const meta = { version, scope: scopeId }
      const pr = await giteaClient.createPullRequest(owner, name, {
        head: branch,
        base,
        title: `Design tokens: ${scopeId} ${version}`,
        body: publishPrBody(files, meta, { count: countTokens(tokens), overrides }),
      })
      // 4. Remember it.
      const rec: TokenPublishRecord = { repo: `${owner}/${name}`, base, dir: cleanDir(dir), branch, number: pr.number, url: pr.html_url, versionId: snap.id, versionLabel: version, at: new Date().toISOString() }
      const next: TokenPublishDoc = { repo: rec.repo, base, dir: rec.dir, history: [rec, ...(doc?.history ?? [])].slice(0, 50) }
      await docStore.put(KIND.tokenPublish, scopeId, next)
      return rec
    },
    onSuccess: (rec) => {
      void qc.invalidateQueries({ queryKey: ['design', KIND.tokenPublish] })
      void qc.invalidateQueries({ queryKey: ['design', KIND.tokenSnapshot] })
      toast.success(`Opened pull request #${rec.number} in ${rec.repo}`, {
        description: `Version ${rec.versionLabel} tagged in History.`,
        action: rec.url ? { label: 'View pull request', onClick: () => globalThis.open(rec.url, '_blank', 'noopener') } : undefined,
      })
      onClose()
    },
    onError: (e: Error) => toast.error('Could not publish tokens', { description: e.message }),
  })

  const ready = !!repo && !!base && !!version.trim() && files.length > 0
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Publish tokens to a repository"
      description={`Opens a pull request with the ${scope.project ? `project “${scope.project}”` : 'workspace'} token set and tags the version in History.`}
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!ready} loading={publish.isPending} onClick={() => publish.mutate()}>
            Open pull request
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not list repositories: {error.message}</p>
      ) : !loading && !repos.length ? (
        <p className="text-sm text-content-muted">No repositories in this organisation yet. Create one in Develop → Repositories.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field label="Repository">
              <RepoSelect repos={repos} value={repo} onChange={(v) => {
                setRepo(v)
                setBase(repos.find((r) => r.fullName === v)?.defaultBranch ?? 'main')
              }} />
            </Field>
            <Field label="Base branch">
              <BranchSelect repo={repo} value={base} onChange={setBase} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field label="Folder">
              <Input value={dir} onChange={(e) => setDir(e.target.value)} className="font-mono text-xs" placeholder="src/design-tokens" />
            </Field>
            <Field label="Version">
              <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1" />
            </Field>
          </div>
          <div className="rounded-lg border border-edge-default bg-surface-sunken/50 px-3 py-2 text-xs">
            <div className="mb-1 font-medium text-content">Files on a new branch</div>
            <ul className="space-y-0.5">
              {files.map((f) => (
                <li key={f.path} className="flex gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-content">{f.path}</code>
                  <span className="shrink-0 text-content-subtle">{PUBLISH_FILES.find((x) => f.path.endsWith(x.name))?.label}</span>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 text-content-muted">
              {countTokens(tokens)} tokens{overrides ? ` · ${overrides} project overrides` : ''} · existing files at these paths are updated.
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Where this scope's tokens were published, with live PR status. */
export function PublishHistory({ scopeId, onPublish }: { scopeId: string; onPublish(): void }) {
  const { doc, isLoading } = usePublishDoc(scopeId)
  if (isLoading) return null
  const list = doc?.history ?? []
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-content">Published to code</h3>
        <span className="text-xs text-content-subtle">{list.length}</span>
        <div className="ml-auto">
          <Button size="sm" onClick={onPublish}>Publish to repository</Button>
        </div>
      </div>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge-strong px-4 py-3 text-xs text-content-muted">
          Not published yet. Publishing opens a pull request with tokens.json, tokens.css and Tailwind theme files in a repository you choose.
        </p>
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {list.map((r) => (
            <li key={`${r.repo}#${r.number ?? r.branch}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
              <span className="font-medium text-content">{r.versionLabel ?? '—'}</span>
              <span className="font-mono text-content-muted">{r.repo}/{r.dir}</span>
              <span className="text-content-subtle" title={new Date(r.at).toLocaleString()}>{formatRelative(r.at)}</span>
              <span className="ml-auto">{r.number ? <PrBadge pr={{ repo: r.repo, number: r.number, url: r.url, createdAt: r.at }} /> : <Badge tone="slate">no PR</Badge>}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The latest publish's PR status, for the page header. */
export function LatestPublishBadge({ scopeId }: { scopeId: string }) {
  const { doc } = usePublishDoc(scopeId)
  const last = doc?.history?.[0]
  if (!last?.number) return null
  return <PrBadge pr={{ repo: last.repo, number: last.number, url: last.url, createdAt: last.at }} />
}

/* ───────────────────────────── import from a repository ───────────────────────────── */

/** Load a tokens file from a repository into the import box. */
export function RepoImportRow({ scope, onText }: { scope: DesignScope; onText(text: string, from: string): void }) {
  const { repos } = useScopeRepos(scope)
  const org = useGiteaOrg()
  const toast = useToast()
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('src/design-tokens/tokens.json')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const [owner, name] = repo.includes('/') ? repo.split('/', 2) : [org, repo]
    setBusy(true)
    try {
      const f = await giteaClient.getFile(owner, name, ref, path.replace(/^\/+/, ''))
      const bin = f.encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))) : f.content
      onText(bin, `${repo}@${ref}:${path}`)
    } catch (e) {
      toast.error('Could not read the file', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-edge-default p-3">
      <div className="text-xs font-medium text-content">From a repository</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <RepoSelect repos={repos} value={repo} onChange={(v) => {
          setRepo(v)
          setRef(repos.find((r) => r.fullName === v)?.defaultBranch ?? 'main')
        }} />
        {repo ? <BranchSelect repo={repo} value={ref} onChange={setRef} /> : <span />}
      </div>
      <div className="flex gap-2">
        <Input aria-label="File path" value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" />
        <Button size="sm" disabled={!repo || !ref || !path.trim()} loading={busy} onClick={load}>Load</Button>
      </div>
    </div>
  )
}

/* ───────────────────────────── AI palette ───────────────────────────── */

interface PaletteCheck {
  token: ColorToken
  light: number | null
  dark: number | null
}

/** Contrast of each text-like colour against the palette's background (light + dark). */
export function paletteChecks(colors: ColorToken[]): PaletteCheck[] {
  const set = { color: colors } as TokenSet
  const bgL = findColor(set, ['background', 'surface', 'bg'], 'light', '#ffffff')
  const bgD = findColor(set, ['background', 'surface', 'bg'], 'dark', '')
  return colors
    .filter((c) => /text|foreground|fg|ink|content/i.test(`${c.name} ${c.role}`))
    .map((c) => ({
      token: c,
      light: bgL ? contrastRatio(c.value, bgL) : null,
      dark: bgD ? contrastRatio(c.dark ?? c.value, bgD) : null,
    }))
}

export function PaletteAiModal({ open, onClose, onApply }: { open: boolean; onClose(): void; onApply(colors: ColorToken[]): void }) {
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [colors, setColors] = useState<ColorToken[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setColors(null)
      setErr(null)
    }
  }, [open])
  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const text = await askAdharAi({ prompt: `${PALETTE_PROMPT}\n\nBrand brief: ${brief.trim()}` })
      const out = toPalette(extractJson(text))
      if (!out.length) throw new Error('The reply had no valid hex colours.')
      setColors(out)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const checks = colors ? paletteChecks(colors) : []
  const failing = checks.filter((c) => (c.light !== null && c.light < 4.5) || (c.dark !== null && c.dark < 4.5)).length
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate a palette with Adhar AI"
      description="Describe the brand. The proposal is checked for WCAG contrast here before anything changes."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          {colors ? (
            <Button size="sm" variant="primary" onClick={() => onApply(colors)}>Add {colors.length} colours</Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!brief.trim()} loading={busy} onClick={run} leading={<Spark />}>Generate</Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Textarea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Calm, trustworthy fintech for small businesses; deep teal brand, warm accent." />
        {colors ? (
          <div className="flex justify-end">
            <Button size="xs" variant="ghost" loading={busy} onClick={run}>Regenerate</Button>
          </div>
        ) : null}
        {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
        {colors ? (
          <>
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {colors.map((c) => (
                <li key={c.name} className="flex items-center gap-2 rounded-lg border border-edge-default px-2 py-1.5">
                  <span className="h-6 w-6 shrink-0 rounded border border-edge-default" style={{ background: c.value }} />
                  {c.dark ? <span className="h-6 w-6 shrink-0 rounded border border-edge-default" style={{ background: c.dark }} title="Dark value" /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[11px] text-content">{c.name}</span>
                    <span className="block truncate text-[10px] text-content-subtle">{c.value}{c.dark ? ` / ${c.dark}` : ''}{c.role ? ` · ${c.role}` : ''}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="rounded-lg border border-edge-default px-3 py-2 text-xs">
              <div className="mb-1 font-medium text-content">
                Contrast on background {failing ? <span className="text-rose-600 dark:text-rose-400">· {failing} below AA</span> : checks.length ? <span className="text-emerald-700 dark:text-emerald-300">· all pass AA</span> : null}
              </div>
              {checks.length === 0 ? (
                <p className="text-content-muted">No text colours to check (none is named text / foreground).</p>
              ) : (
                <ul className="space-y-0.5">
                  {checks.map((c) => (
                    <li key={c.token.name} className="flex gap-3 font-mono text-[11px]">
                      <span className="min-w-0 flex-1 truncate text-content">{c.token.name}</span>
                      <Ratio label="light" r={c.light} />
                      <Ratio label="dark" r={c.dark} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

function Ratio({ label, r }: { label: string; r: number | null }) {
  if (r === null) return <span className="w-28 text-right text-content-subtle">{label} —</span>
  const w = wcag(r)
  return (
    <span className={cn('w-28 text-right', r >= 4.5 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400')}>
      {label} {r.toFixed(2)} {w.level}
    </span>
  )
}
