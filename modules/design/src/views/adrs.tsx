import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Markdown, Modal, StatusBadge, type StatusKind, useOptionalUser, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  KIND,
  type Listed,
  newId,
  useCollection,
  useCreate,
  useRemove,
  useSeedExamples,
  useUpdate,
} from '../data/store.ts'
import { SEED_ADRS } from '../data/seed.ts'
import {
  ADR_TEMPLATES,
  type AdrDoc,
  type AdrEvent,
  adrFileName,
  adrIndexMarkdown,
  adrToMarkdown,
  type AdrTemplateId,
  appendHistory,
  backlinks,
  canSupersede,
  filterAdrs,
  formatAdrNumber,
  markdownToAdr,
  NEXT_STATUS,
  nextAdrNumber,
  STATUS_LABEL,
  STATUSES,
  supersede,
  today,
} from '../data/adr.ts'
import { designLink, useDesignParams, useNewFlag, useSetDesignParams } from '../data/deep-link.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import { CommitToRepoModal, ImportFromRepoModal } from '../components/git-dialogs.tsx'
import { copyText, downloadText, pickTextFile } from '../components/export.ts'
import { useAutosave } from '../components/use-autosave.ts'
import { Icon, Menu, SaveDot, SearchBox, TagInput, useConfirm } from '../components/ui-bits.tsx'
import type { AdrStatus } from '../data/types.ts'

/**
 * Architecture Decision Records — MADR-style decisions with a real lifecycle.
 *
 *   • List: status chips with counts, tag filter, full-text search, sort.
 *   • Document view (`?adr=<id>`): rendered MADR, lifecycle actions, the
 *     supersession chain both ways, related ADRs + backlinks, history.
 *   • Editor (`&mode=edit`): section editor with live markdown preview and
 *     autosave.
 *   • Import MADR / Nygard markdown (paste, file, or a Gitea repo); export
 *     `.md`; commit one or all ADRs (+ README index) to `docs/adr` in Gitea.
 *
 * Persisted in the tenant document store (kind `design.adr`).
 */

const STATUS_KIND: Record<AdrStatus, StatusKind> = {
  proposed: 'info',
  accepted: 'healthy',
  superseded: 'unknown',
  deprecated: 'degraded',
  rejected: 'failed',
}

const STATUS_DOT: Record<AdrStatus, string> = {
  proposed: 'bg-sky-500',
  accepted: 'bg-emerald-500',
  superseded: 'bg-slate-400',
  deprecated: 'bg-amber-500',
  rejected: 'bg-rose-500',
}

type Doc = Listed<AdrDoc>
type SortKey = 'number-desc' | 'number-asc' | 'updated'

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

export function Adrs() {
  const { items: adrs, isLoading, error, refetch } = useCollection<AdrDoc>(KIND.adr)
  const createAdr = useCreate<AdrDoc>(KIND.adr)
  const updateAdr = useUpdate<AdrDoc>(KIND.adr)
  const removeAdr = useRemove(KIND.adr)
  const seed = useSeedExamples<AdrDoc>(KIND.adr)
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const toast = useToast()
  const user = useOptionalUser()
  const me = user?.name ?? 'someone'
  const [ask, confirmDialog] = useConfirm()

  const [status, setStatus] = useState<'all' | AdrStatus>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('number-desc')
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [repoImportOpen, setRepoImportOpen] = useState(false)
  const [commitAllOpen, setCommitAllOpen] = useState(false)
  useNewFlag(() => setCreateOpen(true), !isLoading)

  const byId = useMemo(() => new Map(adrs.map((a) => [a.id, a])), [adrs])
  const lookup = useCallback((id: string) => byId.get(id), [byId])
  const selected = params.adr ? byId.get(params.adr) ?? null : null
  const select = (id: string | undefined, mode?: 'edit') => setParams({ adr: id, mode }, { push: true })

  const allTags = useMemo(() => Array.from(new Set(adrs.flatMap((a) => a.tags ?? []))).sort(), [adrs])
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: adrs.length }
    for (const s of STATUSES) out[s] = adrs.filter((a) => a.status === s).length
    return out
  }, [adrs])

  const filtered = useMemo(() => {
    const out = filterAdrs(adrs, { q: search, status, tag })
    const cmp: Record<SortKey, (a: Doc, b: Doc) => number> = {
      'number-desc': (a, b) => b.number - a.number,
      'number-asc': (a, b) => a.number - b.number,
      updated: (a, b) => (b._updatedAt ?? b.updated_at ?? '').localeCompare(a._updatedAt ?? a.updated_at ?? ''),
    }
    return out.sort(cmp[sort])
  }, [adrs, search, status, tag, sort])

  const lastGit = useMemo(
    () => [...adrs].filter((a) => a.git).sort((a, b) => (b.git!.at).localeCompare(a.git!.at))[0]?.git,
    [adrs],
  )

  const save = useCallback(
    (doc: AdrDoc, event?: Omit<AdrEvent, 'at' | 'by'>) => {
      const at = new Date().toISOString()
      const next = event ? appendHistory({ ...doc, updated_at: at }, { ...event, at, by: me }) : { ...doc, updated_at: at }
      return updateAdr.mutateAsync(next)
    },
    [updateAdr, me],
  )

  const createFrom = (fields: Partial<AdrDoc>, opts: { edit?: boolean; toastTitle?: string } = {}) => {
    const at = new Date().toISOString()
    const taken = new Set(adrs.map((a) => a.number))
    const number = fields.number && !taken.has(fields.number) ? fields.number : nextAdrNumber(adrs)
    const doc: AdrDoc = {
      id: newId('adr'),
      title: 'Untitled decision',
      status: 'proposed',
      authors: user?.name ? [user.name] : [],
      repo: lastGit?.repo ?? '',
      context: '',
      decision: '',
      consequences: '',
      tags: [],
      date: today(),
      ...fields,
      number,
      updated_at: at,
      history: [{ at, by: me, action: 'Created', detail: formatAdrNumber(number) }],
    }
    return createAdr.mutateAsync(doc).then((created) => {
      toast.success(opts.toastTitle ?? `${formatAdrNumber(number)} created`, { description: created.title })
      select(created.id, opts.edit ? 'edit' : undefined)
      return created
    }).catch((e: Error) => {
      toast.error('Could not create ADR', { description: e.message })
      throw e
    })
  }

  const importMarkdown = (md: string, source: string) => {
    const p = markdownToAdr(md)
    if (!p.title && !p.context && !p.decision) {
      toast.error('Nothing to import', { description: 'No ADR title or sections were found in that markdown.' })
      return
    }
    void createFrom(
      {
        title: p.title ?? 'Imported decision',
        number: p.number,
        status: p.status ?? 'proposed',
        date: p.date ?? today(),
        deciders: p.deciders,
        tags: p.tags ?? [],
        context: p.context ?? '',
        drivers: p.drivers,
        options: p.options,
        decision: p.decision ?? '',
        consequences: p.consequences ?? '',
        notes: p.notes,
      },
      { toastTitle: `Imported from ${source}` },
    ).catch(() => {})
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading decisions…" />

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {(['all', ...STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${
              status === s
                ? 'border-brand-300 bg-brand-50 font-semibold text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
                : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content'
            }`}
          >
            {s !== 'all' ? <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} /> : null}
            {s === 'all' ? 'All' : STATUS_LABEL[s]}
            <span className="font-mono text-[10px] tabular-nums opacity-60">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Menu
          label="Import"
          icon={<Icon name="upload" />}
          items={[
            { label: 'Paste markdown…', onSelect: () => setImportOpen(true) },
            {
              label: 'Upload .md file…',
              onSelect: async () => {
                const f = await pickTextFile('.md,.markdown,text/markdown')
                if (f) importMarkdown(f.text, f.name)
              },
            },
            { label: 'From a Gitea repository…', onSelect: () => setRepoImportOpen(true) },
          ]}
        />
        <Menu
          label="Export"
          icon={<Icon name="download" />}
          items={[
            {
              label: 'Commit all to Gitea…',
              onSelect: () => setCommitAllOpen(true),
              disabled: !adrs.length,
            },
            {
              label: 'Download index (README.md)',
              onSelect: () => downloadText(adrIndexMarkdown(adrs), 'README.md', 'text/markdown'),
              disabled: !adrs.length,
            },
          ]}
        />
        <Button size="sm" variant="primary" leading={<Icon name="plus" />} onClick={() => setCreateOpen(true)}>
          New ADR
        </Button>
      </div>
    </div>
  )

  const modals = (
    <>
      <CreateAdrModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        nextNumber={nextAdrNumber(adrs)}
        tagSuggestions={allTags}
        busy={createAdr.isPending}
        onCreate={(fields) =>
          createFrom(fields, { edit: true }).then(() => setCreateOpen(false)).catch(() => {})}
      />
      <PasteImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(md) => {
          importMarkdown(md, 'markdown')
          setImportOpen(false)
        }}
      />
      <ImportFromRepoModal
        open={repoImportOpen}
        onClose={() => setRepoImportOpen(false)}
        title="Import an ADR from Gitea"
        accept={/\.(md|markdown)$/i}
        onImport={(f) => importMarkdown(f.text, `${f.repo}/${f.path}`)}
      />
      <CommitToRepoModal
        open={commitAllOpen}
        onClose={() => setCommitAllOpen(false)}
        title="Commit all ADRs to Gitea"
        description="Writes every ADR as MADR markdown plus a README index, in one commit."
        initial={lastGit ? { repo: lastGit.repo, branch: lastGit.branch, folder: lastGit.path.split('/').slice(0, -1).join('/') } : undefined}
        defaultFolder="docs/adr"
        defaultMessage={`docs(adr): sync ${adrs.length} architecture decision records`}
        buildFiles={() => [
          ...adrs.map((a) => ({ path: adrFileName(a), content: adrToMarkdown(a, lookup) })),
          { path: 'README.md', content: adrIndexMarkdown(adrs) },
        ]}
        onCommitted={(t) => {
          const at = new Date().toISOString()
          for (const a of adrs) {
            const path = `${t.folder.replace(/^\/+|\/+$/g, '')}/${adrFileName(a)}`.replace(/^\//, '')
            void save({ ...a, repo: t.repo, git: { repo: t.repo, branch: t.branch, path, sha: t.sha, at } })
          }
        }}
      />
      {confirmDialog}
    </>
  )

  if (adrs.length === 0) {
    return (
      <div className="space-y-4">
        {toolbar}
        <EmptyState
          title="Record your first architecture decision"
          description="ADRs capture why the platform looks the way it does — the context, the options you weighed, and the consequences you accepted. Use the MADR template, move decisions through proposed → accepted → superseded, and commit them to docs/adr in Gitea."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" variant="primary" leading={<Icon name="plus" />} onClick={() => setCreateOpen(true)}>
                New ADR
              </Button>
              <Button
                size="sm"
                loading={seed.isPending}
                onClick={() =>
                  seed.mutate(SEED_ADRS as AdrDoc[], {
                    onSuccess: () => toast.success('Example ADRs added'),
                    onError: (e) => toast.error('Could not load examples', { description: e.message }),
                  })}
              >
                Load examples
              </Button>
            </div>
          }
        />
        {modals}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {toolbar}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <aside className={`${selected ? 'hidden lg:block' : ''} min-w-0`}>
          <div className="mb-2 flex items-center gap-2">
            <SearchBox value={search} onChange={setSearch} placeholder="Search title, text, #tag…" className="flex-1" />
            <select
              value={tag ?? ''}
              onChange={(e) => setTag(e.target.value || null)}
              aria-label="Filter by tag"
              className="h-8 max-w-28 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content"
            >
              <option value="">All tags</option>
              {allTags.map((t) => <option key={t} value={t}>#{t}</option>)}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort"
              className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content"
            >
              <option value="number-desc">Newest #</option>
              <option value="number-asc">Oldest #</option>
              <option value="updated">Updated</option>
            </select>
          </div>
          {filtered.length === 0
            ? <EmptyState compact title="No matches" description="Try another status, tag or search term." />
            : (
              <ul className="max-h-[calc(100dvh-15rem)] divide-y divide-edge-subtle overflow-auto rounded-xl border border-edge-default bg-surface-raised">
                {filtered.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => select(a.id)}
                      aria-current={selected?.id === a.id}
                      className={`block w-full px-3.5 py-2.5 text-left transition ${
                        selected?.id === a.id ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/60'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10.5px] font-semibold text-content-subtle">{formatAdrNumber(a.number)}</span>
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[a.status]}`} title={STATUS_LABEL[a.status]} />
                        <span className="text-[10.5px] text-content-subtle">{STATUS_LABEL[a.status]}</span>
                        <span className="ml-auto text-[10.5px] text-content-subtle">{formatRelative(a._updatedAt ?? a.updated_at)}</span>
                      </div>
                      <div className={`mt-0.5 line-clamp-2 text-[13px] font-medium ${a.status === 'superseded' || a.status === 'rejected' ? 'text-content-muted line-through decoration-content-subtle/50' : 'text-content'}`}>
                        {a.title}
                      </div>
                      {a.tags?.length
                        ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {a.tags.slice(0, 4).map((t) => (
                              <span key={t} className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted">#{t}</span>
                            ))}
                          </div>
                        )
                        : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </aside>

        <section className="min-w-0">
          {selected
            ? (
              params.mode === 'edit'
                ? (
                  <AdrEditor
                    key={selected.id}
                    adr={selected}
                    all={adrs}
                    lookup={lookup}
                    tagSuggestions={allTags}
                    me={me}
                    onDone={() => setParams({ mode: undefined })}
                  />
                )
                : (
                  <AdrView
                    adr={selected}
                    all={adrs}
                    lookup={lookup}
                    lastGit={lastGit}
                    onBack={() => select(undefined)}
                    onOpen={(id) => select(id)}
                    onEdit={() => setParams({ mode: 'edit' })}
                    onSave={save}
                    onCreateSuperseding={(old) =>
                      createFrom({
                        title: old.title,
                        tags: old.tags,
                        context: old.context,
                        supersedes: [old.id],
                      }, { edit: true, toastTitle: 'Superseding ADR drafted' }).then((created) =>
                        save(supersede(old, created as AdrDoc, me)[0])
                      ).catch(() => {})}
                    onSupersedeWith={(old, newer) => {
                      const [o, n] = supersede(old, newer, me)
                      Promise.all([updateAdr.mutateAsync(o), updateAdr.mutateAsync(n)])
                        .then(() => toast.success(`${formatAdrNumber(old.number)} superseded`, { description: `by ${formatAdrNumber(newer.number)} ${newer.title}` }))
                        .catch((e: Error) => toast.error('Could not supersede', { description: e.message }))
                    }}
                    onDelete={() =>
                      ask({
                        title: `Delete ${formatAdrNumber(selected.number)}?`,
                        description: 'Prefer “Deprecated” or “Superseded” to keep the decision trail. Deleting removes it for everyone.',
                        onConfirm: () =>
                          removeAdr.mutate(selected.id, {
                            onSuccess: () => {
                              toast.success(`${formatAdrNumber(selected.number)} deleted`)
                              select(undefined)
                            },
                            onError: (e) => toast.error('Could not delete', { description: e.message }),
                          }),
                      })}
                  />
                )
            )
            : <Overview adrs={adrs} onOpen={(id) => select(id)} />}
        </section>
      </div>
      {modals}
    </div>
  )
}

/* ─────────── Overview (nothing selected) ─────────── */

function Overview({ adrs, onOpen }: { adrs: Doc[]; onOpen(id: string): void }) {
  const proposed = adrs.filter((a) => a.status === 'proposed').sort((a, b) => b.number - a.number)
  const recent = [...adrs].sort((a, b) => (b._updatedAt ?? '').localeCompare(a._updatedAt ?? '')).slice(0, 5)
  return (
    <div className="hidden space-y-5 rounded-xl border border-dashed border-edge-default p-6 lg:block">
      <div>
        <div className="text-sm font-semibold text-content">Decision log</div>
        <p className="mt-1 text-[12.5px] text-content-muted">
          Select a decision to read it. {proposed.length
            ? `${proposed.length} proposal${proposed.length === 1 ? ' is' : 's are'} waiting for a decision.`
            : 'No proposals are waiting.'}
        </p>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {STATUSES.map((s) => (
          <div key={s} className="rounded-lg bg-surface-sunken/60 p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
              <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} />
              {STATUS_LABEL[s]}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-content">{adrs.filter((a) => a.status === s).length}</div>
          </div>
        ))}
      </div>
      {proposed.length
        ? (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Awaiting decision</div>
            <ul className="space-y-1">
              {proposed.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => onOpen(a.id)} className="text-left text-[13px] text-brand-700 hover:underline dark:text-brand-300">
                    {formatAdrNumber(a.number)} · {a.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
        : null}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Recently updated</div>
        <ul className="space-y-1">
          {recent.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-[13px]">
              <button type="button" onClick={() => onOpen(a.id)} className="truncate text-left text-content hover:underline">
                {formatAdrNumber(a.number)} · {a.title}
              </button>
              <span className="ml-auto shrink-0 text-[11px] text-content-subtle">{formatRelative(a._updatedAt ?? a.updated_at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/* ─────────── Document view ─────────── */

function AdrView({
  adr,
  all,
  lookup,
  lastGit,
  onBack,
  onOpen,
  onEdit,
  onSave,
  onCreateSuperseding,
  onSupersedeWith,
  onDelete,
}: {
  adr: Doc
  all: Doc[]
  lookup(id: string): Doc | undefined
  lastGit?: AdrDoc['git']
  onBack(): void
  onOpen(id: string): void
  onEdit(): void
  onSave(doc: AdrDoc, ev?: Omit<AdrEvent, 'at' | 'by'>): Promise<unknown>
  onCreateSuperseding(old: Doc): void
  onSupersedeWith(old: Doc, newer: Doc): void
  onDelete(): void
}) {
  const toast = useToast()
  const [supersedeOpen, setSupersedeOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const md = useMemo(() => adrToMarkdown(adr, lookup), [adr, lookup])
  const refs = useMemo(() => backlinks(all, adr.id), [all, adr.id])
  const supersededBy = adr.supersededBy ? lookup(adr.supersededBy) : undefined

  const setStatus = (s: AdrStatus) =>
    onSave({ ...adr, status: s, date: s === 'accepted' ? today() : adr.date }, { action: STATUS_LABEL[s], detail: `${STATUS_LABEL[adr.status]} → ${STATUS_LABEL[s]}` })
      .then(() => toast.success(`${formatAdrNumber(adr.number)} ${STATUS_LABEL[s].toLowerCase()}`))
      .catch((e: Error) => toast.error('Could not update status', { description: e.message }))

  const next = NEXT_STATUS[adr.status]
  const body = md.replace(/^---[\s\S]*?---\n+/, '').replace(/^# .*\n+/, '')

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onBack} className="mb-1 inline-flex items-center gap-1 text-[12px] text-content-muted hover:text-content lg:hidden">
            <Icon name="back" size={12} /> All decisions
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content-muted">
              {formatAdrNumber(adr.number)}
            </span>
            <StatusBadge kind={STATUS_KIND[adr.status]}>{STATUS_LABEL[adr.status]}</StatusBadge>
            {adr.date ? <span className="text-[11.5px] text-content-subtle">Decided {adr.date}</span> : null}
          </div>
          <h2 className="mt-1.5 text-xl font-semibold tracking-tight text-content">{adr.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {next.map((s) => (
            <Button key={s} size="sm" variant={s === 'accepted' ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>
              {s === 'accepted' ? 'Accept' : s === 'rejected' ? 'Reject' : s === 'deprecated' ? 'Deprecate' : s === 'proposed' ? 'Re-propose' : STATUS_LABEL[s]}
            </Button>
          ))}
          {canSupersede(adr.status)
            ? <Button size="sm" onClick={() => setSupersedeOpen(true)}>Supersede…</Button>
            : null}
          <Button size="sm" leading={<Icon name="edit" />} onClick={onEdit}>Edit</Button>
          <Menu
            ariaLabel="More actions"
            icon={<Icon name="more" />}
            items={[
              { label: 'Commit to Gitea…', onSelect: () => setCommitOpen(true) },
              { label: 'Download markdown', onSelect: () => downloadText(md, adrFileName(adr), 'text/markdown') },
              {
                label: 'Copy markdown',
                onSelect: async () => ((await copyText(md)) ? toast.success('Markdown copied') : toast.error('Clipboard unavailable')),
              },
              {
                label: 'Copy link',
                onSelect: async () => ((await copyText(designLink({ adr: adr.id, mode: undefined }))) ? toast.success('Link copied') : toast.error('Clipboard unavailable')),
              },
              'separator',
              ...STATUSES.filter((s) => s !== adr.status && s !== 'superseded').map((s) => ({
                label: `Mark ${STATUS_LABEL[s].toLowerCase()}`,
                onSelect: () => setStatus(s),
              })),
              'separator',
              { label: 'Delete ADR', onSelect: onDelete, danger: true },
            ]}
          />
        </div>
      </div>

      {adr.status === 'superseded'
        ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            This decision was superseded{supersededBy ? ' by' : '.'}
            {supersededBy
              ? (
                <button type="button" onClick={() => onOpen(supersededBy.id)} className="font-semibold underline-offset-2 hover:underline">
                  {formatAdrNumber(supersededBy.number)} {supersededBy.title} →
                </button>
              )
              : null}
          </div>
        )
        : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 rounded-xl border border-edge-default bg-surface-raised p-5">
          {body.trim()
            ? <Markdown text={body} className="text-[13.5px] leading-relaxed text-content" />
            : (
              <EmptyState
                compact
                title="This decision is empty"
                description="Add the context, the options you considered, and the outcome."
                action={<Button size="sm" variant="primary" onClick={onEdit}>Write it</Button>}
              />
            )}
        </div>
        <aside className="space-y-4 text-[12.5px]">
          <Meta label="Deciders">
            {(adr.deciders?.length ? adr.deciders : adr.authors)?.join(', ') || <span className="text-content-subtle">—</span>}
          </Meta>
          {adr.tags?.length
            ? (
              <Meta label="Tags">
                <div className="flex flex-wrap gap-1">
                  {adr.tags.map((t) => <span key={t} className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-content-muted">#{t}</span>)}
                </div>
              </Meta>
            )
            : null}
          <LinkList title="Supersedes" ids={adr.supersedes} lookup={lookup} onOpen={onOpen} />
          <LinkList title="Superseded by" ids={adr.supersededBy ? [adr.supersededBy] : []} lookup={lookup} onOpen={onOpen} />
          <LinkList title="Related" ids={adr.related} lookup={lookup} onOpen={onOpen} />
          <LinkList title="Referenced by" ids={refs.filter((r) => r.id !== adr.supersededBy && !(adr.supersedes ?? []).includes(r.id)).map((r) => r.id)} lookup={lookup} onOpen={onOpen} />
          {adr.git
            ? (
              <Meta label="In Gitea">
                <span className="break-all font-mono text-[11px] text-content-muted">
                  {adr.git.repo}@{adr.git.branch}/{adr.git.path}
                </span>
                <div className="text-[11px] text-content-subtle">
                  committed {formatRelative(adr.git.at)}{adr.git.sha ? ` · ${adr.git.sha.slice(0, 7)}` : ''}
                </div>
              </Meta>
            )
            : null}
          <Meta label="History">
            <ol className="relative space-y-2 border-l border-edge-default pl-3">
              {(adr.history ?? []).slice(0, 12).map((h, i) => (
                <li key={`${h.at}-${i}`} className="relative">
                  <span className="absolute -left-[16.5px] top-1.5 h-2 w-2 rounded-full border-2 border-surface-canvas bg-brand-500" />
                  <div className="text-content">
                    <span className="font-medium">{h.action}</span>
                    {h.detail ? <span className="text-content-muted"> · {h.detail}</span> : null}
                  </div>
                  <div className="text-[11px] text-content-subtle">{h.by} · {formatRelative(h.at)}</div>
                </li>
              ))}
              <li className="relative">
                <span className="absolute -left-[16.5px] top-1.5 h-2 w-2 rounded-full border-2 border-surface-canvas bg-content-subtle" />
                <div className="text-content-muted">Last saved</div>
                <div className="text-[11px] text-content-subtle">
                  {adr._updatedBy ? `${adr._updatedBy} · ` : ''}{formatRelative(adr._updatedAt ?? adr.updated_at)}
                </div>
              </li>
            </ol>
          </Meta>
        </aside>
      </div>

      <SupersedeModal
        open={supersedeOpen}
        onClose={() => setSupersedeOpen(false)}
        adr={adr}
        candidates={all.filter((a) => a.id !== adr.id && a.status !== 'superseded' && a.status !== 'rejected')}
        onNew={() => {
          setSupersedeOpen(false)
          onCreateSuperseding(adr)
        }}
        onPick={(n) => {
          setSupersedeOpen(false)
          onSupersedeWith(adr, n)
        }}
      />
      <CommitToRepoModal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        title={`Commit ${formatAdrNumber(adr.number)} to Gitea`}
        description="Writes the decision as MADR markdown and refreshes the folder's README index."
        initial={adr.git
          ? { repo: adr.git.repo, branch: adr.git.branch, folder: adr.git.path.split('/').slice(0, -1).join('/') }
          : lastGit
          ? { repo: lastGit.repo, branch: lastGit.branch, folder: lastGit.path.split('/').slice(0, -1).join('/') }
          : undefined}
        defaultFolder="docs/adr"
        defaultMessage={`docs(adr): ${formatAdrNumber(adr.number).toLowerCase()} ${adr.title} (${adr.status})`}
        buildFiles={() => [
          { path: adrFileName(adr), content: md },
          { path: 'README.md', content: adrIndexMarkdown(all) },
        ]}
        onCommitted={(t) =>
          void onSave(
            { ...adr, repo: t.repo, git: { repo: t.repo, branch: t.branch, path: t.paths[0], sha: t.sha, at: new Date().toISOString() } },
            { action: 'Committed', detail: `${t.repo}@${t.branch}` },
          )}
      />
    </article>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{label}</div>
      <div className="text-content">{children}</div>
    </div>
  )
}

function LinkList({
  title,
  ids,
  lookup,
  onOpen,
}: {
  title: string
  ids?: string[]
  lookup(id: string): Doc | undefined
  onOpen(id: string): void
}) {
  const docs = (ids ?? []).map(lookup).filter(Boolean) as Doc[]
  if (!docs.length) return null
  return (
    <Meta label={title}>
      <ul className="space-y-1">
        {docs.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onOpen(d.id)} className="flex w-full items-start gap-1.5 text-left hover:underline">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[d.status]}`} />
              <span>
                <span className="font-mono text-[11px] text-content-subtle">{formatAdrNumber(d.number)}</span>{' '}
                <span className="text-brand-700 dark:text-brand-300">{d.title}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Meta>
  )
}

function SupersedeModal({
  open,
  onClose,
  adr,
  candidates,
  onNew,
  onPick,
}: {
  open: boolean
  onClose(): void
  adr: Doc
  candidates: Doc[]
  onNew(): void
  onPick(d: Doc): void
}) {
  const [pick, setPick] = useState('')
  useEffect(() => {
    if (open) setPick('')
  }, [open])
  const chosen = candidates.find((c) => c.id === pick)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Supersede ${formatAdrNumber(adr.number)}`}
      description="The current decision is marked superseded and linked forward to its replacement; the replacement links back."
      width="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={onNew}>Draft a new ADR</Button>
          <Button size="sm" variant="primary" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            Supersede with selected
          </Button>
        </>
      }
    >
      <label className="block">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Replacement decision</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)} className={`mt-1.5 ${INPUT}`}>
          <option value="">Choose an existing ADR…</option>
          {[...candidates].sort((a, b) => b.number - a.number).map((c) => (
            <option key={c.id} value={c.id}>{formatAdrNumber(c.number)} · {c.title} ({STATUS_LABEL[c.status]})</option>
          ))}
        </select>
      </label>
      <p className="mt-3 text-[12px] text-content-muted">
        Or draft a new ADR — it starts as <em>proposed</em> with the context copied over.
      </p>
    </Modal>
  )
}

/* ─────────── Editor ─────────── */

const SECTIONS: { key: 'context' | 'drivers' | 'options' | 'decision' | 'consequences' | 'notes'; label: string; hint: string; rows: number }[] = [
  { key: 'context', label: 'Context and problem statement', hint: 'What is the issue? What forces are at play?', rows: 5 },
  { key: 'drivers', label: 'Decision drivers', hint: 'The forces and concerns that shape the choice (bullets).', rows: 3 },
  { key: 'options', label: 'Considered options', hint: 'Each option with its good and bad sides.', rows: 6 },
  { key: 'decision', label: 'Decision outcome', hint: 'Chosen option, and why.', rows: 4 },
  { key: 'consequences', label: 'Consequences', hint: 'What becomes easier or harder.', rows: 4 },
  { key: 'notes', label: 'More information', hint: 'Links, follow-ups, validation.', rows: 3 },
]

function AdrEditor({
  adr,
  all,
  lookup,
  tagSuggestions,
  me,
  onDone,
}: {
  adr: Doc
  all: Doc[]
  lookup(id: string): Doc | undefined
  tagSuggestions: string[]
  me: string
  onDone(): void
}) {
  const update = useUpdate<AdrDoc>(KIND.adr)
  const toast = useToast()
  const [draft, setDraft] = useState<AdrDoc>(() => ({ ...adr }))
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const latest = useRef(adr)
  latest.current = adr

  const save = useCallback(
    (d: AdrDoc) => {
      const at = new Date().toISOString()
      // One "Edited" entry per editing session (10 min window) per person.
      const hist = latest.current.history ?? []
      const head = hist[0]
      const recent = head && head.action === 'Edited' && head.by === me && Date.now() - Date.parse(head.at) < 10 * 60_000
      const history = recent ? [{ ...head, at }, ...hist.slice(1)] : [{ at, by: me, action: 'Edited' }, ...hist].slice(0, 50)
      return update.mutateAsync({
        ...latest.current,
        ...d,
        id: latest.current.id,
        history,
        updated_at: at,
      })
    },
    [update, me],
  )
  const autosave = useAutosave(
    {
      title: draft.title,
      number: draft.number,
      status: draft.status,
      date: draft.date,
      deciders: draft.deciders,
      tags: draft.tags,
      related: draft.related,
      context: draft.context,
      drivers: draft.drivers,
      options: draft.options,
      decision: draft.decision,
      consequences: draft.consequences,
      notes: draft.notes,
    } as AdrDoc,
    save,
    { key: adr.id, delay: 1200, onError: (e) => toast.error('Autosave failed', { description: e.message }) },
  )

  const set = <K extends keyof AdrDoc>(k: K, v: AdrDoc[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const md = useMemo(() => adrToMarkdown(draft, lookup), [draft, lookup])
  const dupNumber = all.some((a) => a.id !== adr.id && a.number === draft.number)
  const relatedOptions = all.filter((a) => a.id !== adr.id && !(draft.related ?? []).includes(a.id))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content-muted">
          Editing {formatAdrNumber(draft.number)}
        </span>
        <SaveDot state={autosave.state} />
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-edge-default p-0.5 xl:hidden">
            {(['write', 'preview'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-[12px] capitalize ${tab === t ? 'bg-surface-sunken font-semibold text-content' : 'text-content-muted'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="primary"
            leading={<Icon name="check" />}
            onClick={() =>
              void autosave.flush().then(() => {
                onDone()
              })}
          >
            Done
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={`space-y-4 ${tab === 'preview' ? 'hidden xl:block' : ''}`}>
          <input
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Short title of the decision"
            aria-label="Title"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-lg font-semibold tracking-tight text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <FieldLabel label="Number">
              <input
                type="number"
                min={1}
                value={draft.number}
                onChange={(e) => set('number', Math.max(1, Number(e.target.value) || 1))}
                className={`${INPUT} ${dupNumber ? 'border-rose-400' : ''}`}
              />
              {dupNumber ? <span className="mt-1 block text-[11px] text-rose-600 dark:text-rose-400">Number already used</span> : null}
            </FieldLabel>
            <FieldLabel label="Status">
              <select value={draft.status} onChange={(e) => set('status', e.target.value as AdrStatus)} className={INPUT}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </FieldLabel>
            <FieldLabel label="Date" className="col-span-2">
              <input type="date" value={draft.date ?? ''} onChange={(e) => set('date', e.target.value)} className={INPUT} />
            </FieldLabel>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FieldLabel label="Deciders">
              <TagInput value={draft.deciders ?? draft.authors ?? []} onChange={(v) => set('deciders', v)} placeholder="Add a person…" prefix="" lowercase={false} />
            </FieldLabel>
            <FieldLabel label="Tags">
              <TagInput value={draft.tags ?? []} onChange={(v) => set('tags', v)} suggestions={tagSuggestions} />
            </FieldLabel>
          </div>
          <FieldLabel label="Related decisions">
            <div className="flex flex-wrap items-center gap-1.5">
              {(draft.related ?? []).map((id) => {
                const r = lookup(id)
                return (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11.5px] text-content">
                    {r ? `${formatAdrNumber(r.number)} ${r.title}` : id}
                    <button type="button" aria-label="Remove" className="text-content-subtle hover:text-content" onClick={() => set('related', (draft.related ?? []).filter((x) => x !== id))}>×</button>
                  </span>
                )
              })}
              {relatedOptions.length
                ? (
                  <select
                    value=""
                    onChange={(e) => e.target.value && set('related', [...(draft.related ?? []), e.target.value])}
                    className="h-7 rounded-lg border border-dashed border-edge-default bg-transparent px-2 text-[12px] text-content-muted"
                    aria-label="Add related ADR"
                  >
                    <option value="">+ Link ADR…</option>
                    {[...relatedOptions].sort((a, b) => b.number - a.number).map((a) => (
                      <option key={a.id} value={a.id}>{formatAdrNumber(a.number)} · {a.title}</option>
                    ))}
                  </select>
                )
                : null}
            </div>
          </FieldLabel>
          {SECTIONS.map((s) => (
            <FieldLabel key={s.key} label={s.label} hint={s.hint}>
              <textarea
                value={(draft[s.key] as string | undefined) ?? ''}
                onChange={(e) => set(s.key, e.target.value)}
                rows={s.rows}
                className={`${INPUT} resize-y font-mono text-[12.5px] leading-relaxed`}
                placeholder="Markdown supported — **bold**, lists, `code`, links, tables."
              />
            </FieldLabel>
          ))}
        </div>
        <div className={`${tab === 'write' ? 'hidden xl:block' : ''}`}>
          <div className="sticky top-4 max-h-[calc(100dvh-8rem)] overflow-auto rounded-xl border border-edge-default bg-surface-raised p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Live preview · {adrFileName(draft)}</span>
              <StatusBadge kind={STATUS_KIND[draft.status]}>{STATUS_LABEL[draft.status]}</StatusBadge>
            </div>
            <Markdown text={md.replace(/^---[\s\S]*?---\n+/, '')} className="text-[13.5px] leading-relaxed text-content" />
          </div>
        </div>
      </div>
    </div>
  )
}

function FieldLabel({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{label}</span>
        {hint ? <span className="truncate text-[11px] text-content-subtle">{hint}</span> : null}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

/* ─────────── Create / import ─────────── */

function CreateAdrModal({
  open,
  onClose,
  nextNumber,
  tagSuggestions,
  busy,
  onCreate,
}: {
  open: boolean
  onClose(): void
  nextNumber: number
  tagSuggestions: string[]
  busy: boolean
  onCreate(fields: Partial<AdrDoc>): void
}) {
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tpl, setTpl] = useState<AdrTemplateId>('madr')
  useEffect(() => {
    if (open) {
      setTitle('')
      setTags([])
      setTpl('madr')
    }
  }, [open])
  const submit = () => {
    if (!title.trim()) return
    const t = ADR_TEMPLATES.find((x) => x.id === tpl)!
    onCreate({ ...t.fields, title: title.trim(), tags })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New decision · ${formatAdrNumber(nextNumber)}`}
      description="It starts as proposed. You'll land in the editor with the template's prompts."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} disabled={!title.trim() || busy} loading={busy}>
            Create & edit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FieldLabel label="Title">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Use Tekton for in-cluster CI"
            className={INPUT}
          />
        </FieldLabel>
        <FieldLabel label="Tags">
          <TagInput value={tags} onChange={setTags} suggestions={tagSuggestions} />
        </FieldLabel>
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Template</span>
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {ADR_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTpl(t.id)}
                className={`rounded-lg border p-3 text-left transition ${
                  tpl === t.id
                    ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10'
                    : 'border-edge-default bg-surface-raised hover:border-edge-strong'
                }`}
              >
                <div className="text-[13px] font-semibold text-content">{t.label}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-content-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

const PASTE_PLACEHOLDER = '# 1. Record architecture decisions\n\n## Status\n\nAccepted\n\n## Context\n…'

function PasteImportModal({ open, onClose, onImport }: { open: boolean; onClose(): void; onImport(md: string): void }) {
  const [md, setMd] = useState('')
  useEffect(() => {
    if (open) setMd('')
  }, [open])
  const parsed = useMemo(() => (md.trim() ? markdownToAdr(md) : null), [md])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import ADR markdown"
      description="MADR (with or without front matter) and Nygard-style ADRs are recognised."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!parsed?.title} onClick={() => onImport(md)}>Import</Button>
        </>
      }
    >
      <textarea
        autoFocus
        value={md}
        onChange={(e) => setMd(e.target.value)}
        rows={14}
        placeholder={PASTE_PLACEHOLDER}
        className={`${INPUT} resize-y font-mono text-[12px]`}
      />
      {parsed
        ? (
          <div className="mt-2 text-[12px] text-content-muted">
            {parsed.title
              ? <>Found <span className="font-semibold text-content">{parsed.title}</span>{parsed.status ? ` · ${parsed.status}` : ''}{parsed.number ? ` · #${parsed.number}` : ''} — sections: {(['context', 'drivers', 'options', 'decision', 'consequences'] as const).filter((k) => parsed[k]).join(', ') || 'none'}</>
              : 'No “# Title” heading found yet.'}
          </div>
        )
        : null}
    </Modal>
  )
}
