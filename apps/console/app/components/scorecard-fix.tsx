import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  toPublicUrl,
  usePublicBaseDomain,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useOptionalSession } from '@adhar/auth'
import { type Entity, type Lifecycle, parseRef, useCatalog, useRegisterEntity } from '../data/catalog.ts'
import { rerunMessage, type Scorecard } from '../data/scorecard.ts'
import {
  DEFAULT_PARAMS,
  editDescriptor,
  entitySource,
  type EntitySource,
  FIELD_LABEL,
  FIELD_LINK_ICON,
  type FileChange,
  fixBranchName,
  type FixAction,
  MANIFEST_LABEL,
  type ManifestParams,
  type ManifestPlan,
  type ManifestTarget,
  type MetadataField,
  type MetadataPatch,
  ownerValue,
  patchEntity,
  pendingFor,
  pendingLabel,
  type PendingFix,
  planManifestFix,
  prunePending,
  scoreDelta,
  type ScoreSnapshot,
  snapshotOf,
  suggestResources,
} from '../data/scorecard-fix.ts'
import {
  applyFix,
  type Descriptor,
  descriptorKey,
  type DescriptorTarget,
  type LocatedBase,
  locateManifestBase,
  observedUsage,
  pendingStore,
  prStateQuery,
  rerunFor,
  useDeploySources,
  useDescriptor,
  useOwnerOptions,
  usePendingFixes,
} from '../data/scorecard-fix-io.ts'
import { diffHunks, diffLines } from '../data/scorecard-yaml-edit.ts'
// Pure and dependency-free: the browser mirrors the server's gate so a button
// that would be refused is disabled with the reason, never a dead click.
import { canApplyFix, canClaimOwnership, type FixGate } from '../server/scorecard-fix-model.ts'

/**
 * Scorecard fixes in the drawer: a "Fix" on each failing check that acts on
 * the check's real source of truth, a per-service "Re-evaluate", and the
 * pending-fix bookkeeping that keeps both honest (a fix is pending until the
 * evaluator says the check passes — never before).
 */

/* ─────────── context ─────────── */

export interface FixContext {
  card: Scorecard
  entity: Entity
  source: EntitySource
  target: DescriptorTarget | null
  descriptor?: Descriptor
  descriptorLoading: boolean
  /** Why the descriptor could not be read (not a 404 — a missing file is `exists: false`). */
  descriptorError?: string
  gate: FixGate
  /**
   * The gate for the metadata editor: the same as `gate`, except that an
   * entity with NO owner can be claimed by a developer for their own team (the
   * server checks the team they pick).
   */
  metaGate: FixGate
  pending: PendingFix[]
  /** Who is acting, for toasts. */
  actor?: string
}

export function useFixContext(card: Scorecard): FixContext {
  const session = useOptionalSession()
  const user = session?.user
  const { target, descriptor, isLoading, error } = useDescriptor(card.platformOnly ? undefined : card.entity)
  const source = entitySource(card.entity, !!target)
  const allPending = usePendingFixes()
  const pending = useMemo(() => allPending.filter((p) => p.entityRef === card.entityRef), [allPending, card.entityRef])
  // The owner the server will check against: the repository's own declaration
  // when it has one. The catalog's view stands in otherwise.
  const gate = useMemo<FixGate>(() => {
    if (source === 'registered') return { ok: true }
    return canApplyFix(user as { roles?: string[]; groups?: string[] } | undefined, card.entity.spec.owner)
  }, [source, user, card.entity.spec.owner])
  const metaGate = useMemo<FixGate>(
    () => (gate.ok || card.entity.spec.owner ? gate : canClaimOwnership(user as { roles?: string[]; groups?: string[] } | undefined)),
    [gate, user, card.entity.spec.owner],
  )
  return {
    card,
    entity: card.entity,
    source,
    target,
    descriptor,
    descriptorLoading: isLoading,
    ...(error ? { descriptorError: error instanceof Error ? error.message : String(error) } : {}),
    gate,
    metaGate,
    pending,
    actor: user?.name ?? user?.email,
  }
}

function usePublicGitea() {
  const toolUrl = useToolPublicUrl('gitea')
  const baseDomain = usePublicBaseDomain()
  return useCallback(
    (raw: string | undefined) => (raw ? toPublicUrl(raw, { tool: 'gitea', toolUrl, baseDomain }) : undefined),
    [toolUrl, baseDomain],
  )
}

/* ─────────── per-check control ─────────── */

export function CheckFix({
  action,
  target,
  ctx,
  onMetadata,
  onManifest,
}: {
  action: FixAction | null
  /** `check:<id>` or `signal:<name>`. */
  target: string
  ctx: FixContext
  onMetadata(field: MetadataField): void
  onManifest(target: ManifestTarget): void
}) {
  const pub = usePublicGitea()
  const pending = pendingFor(ctx.pending, ctx.card.entityRef, target)
  if (pending) {
    const url = pub(pending.pr?.url)
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30">
          {pendingLabel(pending)}
        </span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline dark:text-brand-300">
            View PR
          </a>
        ) : null}
      </div>
    )
  }
  if (!action) return null
  if (action.kind === 'explain') {
    return <p className="mt-1.5 rounded-md bg-surface-sunken px-2 py-1 text-[11px] leading-relaxed text-content-muted">{action.explain}</p>
  }
  if (action.kind === 'link') {
    return (
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]">
        <a href={action.href} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
          {action.label} →
        </a>
        <span className="text-content-muted">{action.explain}</span>
      </div>
    )
  }
  if (action.kind === 'metadata') {
    const g = ctx.metaGate
    return (
      <div className="mt-1.5">
        <Button size="xs" variant="primary" disabled={!g.ok} title={g.ok ? undefined : g.reason} onClick={() => onMetadata(action.field)}>
          Fix
        </Button>
      </div>
    )
  }
  const disabled = !ctx.gate.ok
  const title = ctx.gate.ok ? undefined : ctx.gate.reason
  return (
    <div className="mt-1.5">
      <Button size="xs" variant="primary" disabled={disabled} title={title} onClick={() => onManifest(action.target)}>
        Open PR with fix
      </Button>
    </div>
  )
}

/* ─────────── diff preview ─────────── */

export function DiffPreview({ path, before, after, note }: { path: string; before: string | null; after: string; note?: string }) {
  const rows = useMemo(() => diffHunks(diffLines(before ?? '', after), 3), [before, after])
  const added = rows.filter((r) => r?.kind === 'add').length
  const removed = rows.filter((r) => r?.kind === 'del').length
  return (
    <div className="overflow-hidden rounded-lg border border-edge-default">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge-subtle bg-surface-sunken px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-content">{path}</span>
        <span className="font-mono text-[10px] text-content-muted">
          {before === null ? 'new file · ' : ''}
          <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>{' '}
          <span className="text-rose-700 dark:text-rose-300">−{removed}</span>
        </span>
      </div>
      {note ? <p className="border-b border-edge-subtle bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{note}</p> : null}
      <pre className="max-h-72 overflow-auto bg-surface-raised py-1 font-mono text-[11px] leading-[1.55]">
        {rows.map((r, i) =>
          r === null ? (
            <div key={i} className="px-3 text-content-subtle">⋯</div>
          ) : (
            <div
              key={i}
              className={cn(
                'whitespace-pre px-3',
                r.kind === 'add' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
                r.kind === 'del' && 'bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
                r.kind === 'ctx' && 'text-content-muted',
              )}
            >
              {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  '}
              {r.text}
            </div>
          ),
        )}
      </pre>
    </div>
  )
}

function ModeToggle({ mode, onChange }: { mode: 'pr' | 'commit'; onChange(m: 'pr' | 'commit'): void }) {
  const opt = (m: 'pr' | 'commit', label: string, sub: string) => (
    <button
      type="button"
      onClick={() => onChange(m)}
      aria-pressed={mode === m}
      className={cn(
        'flex min-w-0 flex-1 flex-col items-start rounded-md px-2.5 py-1.5 text-left ring-1 ring-inset transition-colors',
        mode === m ? 'bg-brand-50 ring-brand-400 dark:bg-brand-500/10 dark:ring-brand-500/60' : 'ring-edge-default hover:bg-surface-sunken',
      )}
    >
      <span className="text-[12px] font-medium text-content">{label}</span>
      <span className="text-[10px] text-content-muted">{sub}</span>
    </button>
  )
  return (
    <div className="flex flex-col gap-2 sm:flex-row" role="group" aria-label="How to commit">
      {opt('pr', 'Open a pull request', 'New branch, reviewed before it lands (recommended)')}
      {opt('commit', 'Commit directly', 'Straight to the base branch')}
    </div>
  )
}

/* ─────────── metadata editor (inline, in the drawer) ─────────── */

const LIFECYCLES: Lifecycle[] = ['experimental', 'staging', 'production', 'deprecated']
const LINK_FIELDS: MetadataField[] = ['docs', 'runbook', 'dashboard', 'repo']

/** Which metadata fields the editor shows: every failing one, plus the one clicked. */
function fieldsFor(card: Scorecard, focus: MetadataField): MetadataField[] {
  const failing = new Set<MetadataField>()
  const map: Record<string, MetadataField> = {
    'has-owner': 'owner',
    'has-description': 'description',
    'lifecycle-production': 'lifecycle',
    'has-docs': 'docs',
    'has-runbook': 'runbook',
    'has-dashboard': 'dashboard',
    'has-repo': 'repo',
  }
  for (const c of card.checks) if (!c.pass && map[c.id]) failing.add(map[c.id])
  failing.add(focus)
  return (['owner', 'description', 'lifecycle', 'docs', 'runbook', 'dashboard', 'repo'] as MetadataField[]).filter((f) => failing.has(f))
}

export function MetadataFixPanel({
  ctx,
  focus,
  onClose,
  onLanded,
}: {
  ctx: FixContext
  focus: MetadataField
  onClose(): void
  /** A change landed on the source (direct commit / registered save): re-evaluate now. */
  onLanded(): void
}) {
  const toast = useToast()
  const pub = usePublicGitea()
  const register = useRegisterEntity()
  const catalog = useCatalog()
  const groups = useMemo(() => catalog.data.filter((e) => e.kind === 'Group').map((e) => e.metadata.name), [catalog.data])
  const owners = useOwnerOptions(groups)
  const e = ctx.entity
  const fields = useMemo(() => fieldsFor(ctx.card, focus), [ctx.card, focus])

  const [owner, setOwner] = useState(e.spec.owner ? parseRef(e.spec.owner).name : '')
  const [description, setDescription] = useState(e.metadata.description ?? '')
  const [lifecycle, setLifecycle] = useState<Lifecycle>('production')
  const [links, setLinks] = useState<Partial<Record<MetadataField, string>>>({})
  const [mode, setMode] = useState<'pr' | 'commit'>('pr')
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState(false)

  const patch = useMemo<MetadataPatch>(() => {
    const p: MetadataPatch = {}
    if (fields.includes('owner') && owner.trim()) p.owner = owner.trim()
    if (fields.includes('description') && description.trim() && description.trim() !== (e.metadata.description ?? '')) p.description = description.trim()
    if (fields.includes('lifecycle') && lifecycle !== e.spec.lifecycle) p.lifecycle = lifecycle
    const ls = LINK_FIELDS.filter((f) => fields.includes(f) && /^https?:\/\/\S+$/i.test((links[f] ?? '').trim())).map((f) => ({
      url: (links[f] ?? '').trim(),
      title: FIELD_LABEL[f].replace(/ link$/, ''),
      icon: FIELD_LINK_ICON[f]!,
    }))
    if (ls.length) p.links = ls
    return p
  }, [fields, owner, description, lifecycle, links, e])
  const empty = Object.keys(patch).length === 0
  const badLink = LINK_FIELDS.some((f) => fields.includes(f) && (links[f] ?? '').trim() && !/^https?:\/\/\S+$/i.test((links[f] ?? '').trim()))

  const edit = useMemo(() => {
    if (ctx.source !== 'gitea' || step !== 'review' || !ctx.descriptor) return null
    try {
      return { ok: true as const, ...editDescriptor(ctx.descriptor.exists ? ctx.descriptor.text : null, e, patch) }
    } catch (err) {
      return { ok: false as const, detail: err instanceof Error ? err.message : String(err) }
    }
  }, [ctx.source, ctx.descriptor, step, e, patch])

  const targets = useMemo(() => {
    const ids: Record<MetadataField, string> = {
      owner: 'has-owner', description: 'has-description', lifecycle: 'lifecycle-production',
      docs: 'has-docs', runbook: 'has-runbook', dashboard: 'has-dashboard', repo: 'has-repo',
    }
    const out: string[] = []
    if (patch.owner) out.push(`check:${ids.owner}`)
    if (patch.description) out.push(`check:${ids.description}`)
    if (patch.lifecycle === 'production') out.push(`check:${ids.lifecycle}`)
    for (const l of patch.links ?? []) {
      const f = LINK_FIELDS.find((x) => FIELD_LINK_ICON[x] === l.icon)
      if (f) out.push(`check:${ids[f]}`)
    }
    return out
  }, [patch])

  const saveRegistered = async () => {
    setBusy(true)
    try {
      await register.mutateAsync(patchEntity(e, patch))
      toast.success('Catalog entry updated', { description: `${e.metadata.name} — re-evaluating its scorecard.` })
      onClose()
      onLanded()
    } catch (err) {
      toast.error('Could not update the catalog entry', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!edit?.ok || !ctx.target) return
    setBusy(true)
    const what = Object.keys(patch).map((k) => (k === 'links' ? 'links' : k)).join(', ')
    const branch = fixBranchName(e.metadata.name, targets)
    const res = await applyFix({
      entityRef: ctx.card.entityRef,
      // When the entity has no owner yet, the owner being set is the team the
      // server checks the user against (it re-reads the repo's own declaration).
      owner: e.spec.owner ?? (patch.owner ? `group:${ownerValue(patch.owner)}` : undefined),
      org: ctx.target.org,
      repo: ctx.target.repo,
      ...(ctx.target.ref ? { branch: ctx.target.ref } : {}),
      mode,
      ...(mode === 'pr' ? { newBranch: branch } : {}),
      title: `catalog: ${edit.created ? 'add' : 'update'} ${what} for ${e.metadata.name}`,
      description: `Scorecard fix for ${ctx.card.entityRef}: ${targets.map((t) => t.replace(/^check:/, '')).join(', ')}.`,
      descriptorPath: ctx.target.path,
      files: [{ path: ctx.target.path, content: edit.content, baseSha: ctx.descriptor?.exists ? ctx.descriptor.sha : null }],
    })
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error === 'forbidden' ? 'Not allowed' : res.error === 'stale' ? 'The file changed' : 'Could not commit the fix', { description: res.detail })
      return
    }
    const id = `${ctx.card.entityRef}:${res.branch}:${Date.now()}`
    pendingStore.add({
      id,
      entityRef: ctx.card.entityRef,
      ...(ctx.card.platform ? { service: ctx.card.platform.name } : {}),
      targets,
      org: ctx.target.org,
      repo: ctx.target.repo,
      branch: res.branch,
      mode: res.mode,
      ...(res.pr ? { pr: res.pr } : {}),
      state: res.mode === 'pr' ? 'open' : 'committed',
      createdAt: new Date().toISOString(),
      ...(res.mode === 'commit' ? { landedAt: new Date().toISOString() } : {}),
    })
    const url = pub(res.pr?.url)
    if (res.pr) {
      toast.success(`Pull request #${res.pr.number} opened`, {
        description: `${ctx.target.org}/${ctx.target.repo} — the checks stay pending until it merges and the scorecard is re-evaluated.`,
        ...(url ? { action: { label: 'View PR', onClick: () => globalThis.open(url, '_blank', 'noopener') } } : {}),
      })
    } else {
      toast.success('Fix committed', { description: `${ctx.target.path} on ${res.base} — re-evaluating.` })
      onLanded()
    }
    onClose()
  }

  const where = ctx.source === 'registered'
    ? 'Saved to this entity’s catalog registration.'
    : ctx.target
    ? `${ctx.target.org}/${ctx.target.repo} · ${ctx.target.path}${ctx.descriptor && !ctx.descriptor.exists ? ' (does not exist yet — the fix creates it)' : ''}`
    : ''

  return (
    <section aria-label="Fix catalog metadata" className="rounded-xl border border-brand-200 bg-surface-raised p-4 shadow-sm dark:border-brand-500/30">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-content">Fix catalog metadata</h3>
          <p className="mt-0.5 break-all font-mono text-[11px] text-content-muted">{where}</p>
        </div>
        <Button size="xs" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>

      {ctx.source === 'gitea' && ctx.descriptorLoading ? (
        <p className="text-[12px] text-content-muted">Reading catalog-info.yaml…</p>
      ) : ctx.source === 'gitea' && !ctx.descriptor ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-300">
          Could not read {ctx.target?.path ?? 'catalog-info.yaml'} from Gitea{ctx.descriptorError ? `: ${ctx.descriptorError}` : '.'}
        </p>
      ) : step === 'edit' ? (
        <div className="space-y-3">
          {fields.includes('owner') ? (
            <Field label="Owner" hint={owners.length ? 'A team of this organisation' : 'No teams found — type the team name'}>
              {owners.length ? (
                <Select value={owner} onChange={(ev) => setOwner(ev.target.value)}>
                  <option value="">Choose a team…</option>
                  {owners.map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
              ) : (
                <Input value={owner} onChange={(ev) => setOwner(ev.target.value)} placeholder="payments" />
              )}
            </Field>
          ) : null}
          {fields.includes('description') ? (
            <Field label="Description">
              <Textarea rows={2} value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="What this service does, in a sentence." />
            </Field>
          ) : null}
          {fields.includes('lifecycle') ? (
            <Field label="Lifecycle" hint='The check passes on "production" — set it once the service is GA.'>
              <Select value={lifecycle} onChange={(ev) => setLifecycle(ev.target.value as Lifecycle)}>
                {LIFECYCLES.map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
            </Field>
          ) : null}
          {LINK_FIELDS.filter((f) => fields.includes(f)).map((f) => (
            <Field key={f} label={FIELD_LABEL[f]}>
              <Input
                type="url"
                inputMode="url"
                value={links[f] ?? ''}
                onChange={(ev) => setLinks((cur) => ({ ...cur, [f]: ev.target.value }))}
                placeholder="https://…"
              />
            </Field>
          ))}
          <div className="flex flex-wrap justify-end gap-2">
            {ctx.source === 'registered' ? (
              <Button variant="primary" size="sm" loading={busy} disabled={empty || badLink} onClick={() => void saveRegistered()}>
                Save
              </Button>
            ) : (
              <Button variant="primary" size="sm" disabled={empty || badLink || !ctx.descriptor} onClick={() => setStep('review')}>
                Review change
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {edit && !edit.ok ? (
            <p className="text-[12px] text-rose-700 dark:text-rose-300">{edit.detail}</p>
          ) : edit ? (
            <DiffPreview
              path={ctx.target?.path ?? 'catalog-info.yaml'}
              before={ctx.descriptor?.exists ? ctx.descriptor.text : null}
              after={edit.content}
              note={edit.reserialised
                ? 'This document could not be edited line by line, so it is written out cleanly — comments inside it are not kept. Check the diff.'
                : undefined}
            />
          ) : null}
          <ModeToggle mode={mode} onChange={setMode} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={() => setStep('edit')} disabled={busy}>Back</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={!edit?.ok} onClick={() => void commit()}>
              {mode === 'pr' ? 'Open pull request' : 'Commit'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

/* ─────────── manifest fix (dialog) ─────────── */

export function ManifestFixDialog({
  ctx,
  initial,
  onClose,
  onLanded,
}: {
  ctx: FixContext
  initial: ManifestTarget
  onClose(): void
  onLanded(): void
}) {
  const toast = useToast()
  const pub = usePublicGitea()
  const name = ctx.card.platform?.name ?? ctx.entity.metadata.name
  const { sources, isLoading, argoNamespace } = useDeploySources(ctx.entity, true)
  const [targets, setTargets] = useState<ManifestTarget[]>([initial])
  const [params, setParams] = useState<ManifestParams>(DEFAULT_PARAMS)
  const [usageNote, setUsageNote] = useState<string | null>(null)
  const [base, setBase] = useState<LocatedBase | null>(null)
  const [locating, setLocating] = useState(true)
  const [locateError, setLocateError] = useState<string | null>(null)
  const [mode, setMode] = useState<'pr' | 'commit'>('pr')
  const [busy, setBusy] = useState(false)

  // Find the base once the deploy sources are known. Keyed on the sources'
  // content, not their identity: the card is rebuilt on every background
  // refresh, and re-locating would throw away what the user is editing.
  const fallbackRepo = ctx.target ? `${ctx.target.org}/${ctx.target.repo}` : ''
  const sourcesKey = JSON.stringify(sources)
  const workloadName = ctx.entity.metadata.name
  useEffect(() => {
    if (isLoading) return
    let alive = true
    ;(async () => {
      setLocating(true)
      setLocateError(null)
      const parsed = JSON.parse(sourcesKey) as typeof sources
      const [fOrg, fRepo] = fallbackRepo.split('/')
      const candidates = parsed.length ? parsed : fallbackRepo ? [{ org: fOrg, repo: fRepo, path: 'deploy' }] : []
      if (!candidates.length) {
        setLocateError('No Argo CD application or Application resource names a repository path for this service, and it has no Gitea repository to look in.')
        setLocating(false)
        return
      }
      for (const s of candidates) {
        try {
          const found = await locateManifestBase(s, workloadName)
          if (!alive) return
          if (found) {
            setBase(found)
            setLocating(false)
            return
          }
        } catch (err) {
          if (!alive) return
          setLocateError(err instanceof Error ? err.message : String(err))
        }
      }
      if (alive) {
        setLocateError((cur) => cur ?? `No Deployment or StatefulSet named ${workloadName} in ${candidates.map((c) => `${c.org}/${c.repo}/${c.path}`).join(', ')}.`)
        setLocating(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [isLoading, sourcesKey, workloadName, fallbackRepo])

  // Requests/limits from observed usage, when Prometheus has it.
  const ns = ctx.card.platform?.namespace || argoNamespace
  useEffect(() => {
    if (!targets.includes('resources') || !ns || !base) return
    let alive = true
    void observedUsage(ns, base.workload.name).then((u) => {
      if (!alive) return
      const s = suggestResources(u ?? {})
      setParams((p) => ({ ...p, resources: s.spec }))
      setUsageNote(s.fromUsage
        ? `Sized from the last day's peak usage in ${ns} (requests 1.2× peak; limits 4× CPU, 2× memory).`
        : 'No usage data in Prometheus — conservative defaults. Adjust to what the service needs.')
    })
    return () => {
      alive = false
    }
  }, [targets, ns, base])

  const plan = useMemo<ManifestPlan | null>(() => (base ? planManifestFix(base, targets, params) : null), [base, targets, params])
  // The same stamps on the entity's catalog-info.yaml when it lives in the same
  // repository — that is what the catalog-derived checks read for a repo-backed
  // service, so without it a merged fix could never show up there.
  const descriptorChange = useMemo<FileChange | null>(() => {
    if (!plan || !base || !Object.keys(plan.stamps).length) return null
    const t = ctx.target
    const d = ctx.descriptor
    if (!t || !d?.exists || !d.text || !d.sha || t.org !== base.org || t.repo !== base.repo) return null
    if (plan.changes.some((c) => c.path === t.path)) return null
    try {
      const edit = editDescriptor(d.text, ctx.entity, { annotations: plan.stamps })
      return edit.content === d.text ? null : { path: t.path, before: d.text, after: edit.content, baseSha: d.sha }
    } catch {
      return null
    }
  }, [plan, base, ctx.target, ctx.descriptor, ctx.entity])
  const changes = useMemo(() => [...(plan?.changes ?? []), ...(descriptorChange ? [descriptorChange] : [])], [plan, descriptorChange])

  const toggle = (t: ManifestTarget) => setTargets((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
  const setRes = (w: 'requests' | 'limits', q: 'cpu' | 'memory', v: string) =>
    setParams((p) => ({ ...p, resources: { ...p.resources, [w]: { ...p.resources[w], [q]: v } } }))
  const qtyOk = (v: string) => /^\d+(\.\d+)?(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/.test(v.trim())
  const resValid = !targets.includes('resources') ||
    [params.resources.requests.cpu, params.resources.requests.memory, params.resources.limits.cpu, params.resources.limits.memory].every(qtyOk)
  const hpaValid = !targets.includes('hpa') ||
    (params.hpa.minReplicas >= 1 && params.hpa.maxReplicas >= params.hpa.minReplicas && params.hpa.cpuUtilization > 0 && params.hpa.cpuUtilization <= 100)

  const submit = async () => {
    if (!base || !plan || !changes.length) return
    setBusy(true)
    const what = targets.map((t) => MANIFEST_LABEL[t]).join(', ')
    const signalFor: Record<ManifestTarget, string[]> = {
      resources: ['check:resource-limits', 'signal:resources'],
      hpa: ['check:has-hpa', 'signal:autoscaling'],
      pdb: ['check:has-pdb', 'signal:pod_disruption_budget'],
    }
    const covered = targets.filter((t) => !plan.skipped.some((s) => s.target === t))
    const pendingTargets = covered.flatMap((t) => signalFor[t]).filter((id) =>
      id.startsWith('check:') ? ctx.card.checks.some((c) => `check:${c.id}` === id && !c.pass) : (ctx.card.platform?.signals ?? []).some((s) => `signal:${s.name}` === id && s.applicable && s.score < 1)
    )
    const branch = fixBranchName(ctx.entity.metadata.name, covered.length === 1 ? [covered[0]] : covered)
    const res = await applyFix({
      entityRef: ctx.card.entityRef,
      owner: ctx.entity.spec.owner,
      org: base.org,
      repo: base.repo,
      branch: base.ref,
      mode,
      ...(mode === 'pr' ? { newBranch: branch } : {}),
      title: `deploy: add ${what} to ${base.workload.name}`,
      description: [`Scorecard fix for ${ctx.card.entityRef}.`, ...plan.notes].join('\n'),
      ...(ctx.target && ctx.target.org === base.org && ctx.target.repo === base.repo ? { descriptorPath: ctx.target.path } : {}),
      files: changes.map((c: FileChange) => ({ path: c.path, content: c.after, baseSha: c.baseSha })),
    })
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error === 'forbidden' ? 'Not allowed' : res.error === 'stale' ? 'The manifests changed' : 'Could not open the fix', { description: res.detail })
      return
    }
    pendingStore.add({
      id: `${ctx.card.entityRef}:${res.branch}:${Date.now()}`,
      entityRef: ctx.card.entityRef,
      ...(ctx.card.platform ? { service: ctx.card.platform.name } : {}),
      targets: pendingTargets.length ? pendingTargets : covered.flatMap((t) => signalFor[t]),
      org: base.org,
      repo: base.repo,
      branch: res.branch,
      mode: res.mode,
      ...(res.pr ? { pr: res.pr } : {}),
      state: res.mode === 'pr' ? 'open' : 'committed',
      createdAt: new Date().toISOString(),
      ...(res.mode === 'commit' ? { landedAt: new Date().toISOString() } : {}),
    })
    const url = pub(res.pr?.url)
    if (res.pr) {
      toast.success(`Pull request #${res.pr.number} opened`, {
        description: `${base.org}/${base.repo} — pending until it merges, Argo CD syncs, and the scorer re-grades ${name}.`,
        ...(url ? { action: { label: 'View PR', onClick: () => globalThis.open(url, '_blank', 'noopener') } } : {}),
      })
    } else {
      toast.success('Fix committed', { description: `${base.org}/${base.repo}@${res.base} — re-evaluating once Argo CD has synced.` })
      onLanded()
    }
    onClose()
  }

  const footer = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        disabled={!changes.length || !resValid || !hpaValid || !ctx.gate.ok}
        title={ctx.gate.ok ? undefined : ctx.gate.reason}
        onClick={() => void submit()}
      >
        {mode === 'pr' ? 'Open pull request' : 'Commit'}
      </Button>
    </div>
  )

  return (
    <Modal open onClose={onClose} width="xl" title="Fix deploy manifests" description={`${ctx.entity.metadata.name} — generated into its Kustomize base, reviewed as a diff.`} footer={footer}>
      <div className="space-y-4">
        <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
          <legend className="sr-only">What to add</legend>
          {(['resources', 'hpa', 'pdb'] as ManifestTarget[]).map((t) => (
            <Checkbox key={t} label={MANIFEST_LABEL[t]} checked={targets.includes(t)} onChange={() => toggle(t)} />
          ))}
        </fieldset>

        {targets.includes('resources') ? (
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['requests', 'limits'] as const).flatMap((w) => (['cpu', 'memory'] as const).map((q) => (
                <Field key={`${w}.${q}`} label={`${w} · ${q}`}>
                  <Input value={params.resources[w][q]} invalid={!qtyOk(params.resources[w][q])} onChange={(ev) => setRes(w, q, ev.target.value)} />
                </Field>
              )))}
            </div>
            {usageNote ? <p className="text-[11px] text-content-muted">{usageNote}</p> : null}
          </div>
        ) : null}

        {targets.includes('hpa') ? (
          <div className="grid grid-cols-3 gap-2">
            <Field label="Min replicas">
              <Input type="number" min={1} value={params.hpa.minReplicas} onChange={(ev) => setParams((p) => ({ ...p, hpa: { ...p.hpa, minReplicas: Number(ev.target.value) } }))} />
            </Field>
            <Field label="Max replicas">
              <Input type="number" min={1} value={params.hpa.maxReplicas} onChange={(ev) => setParams((p) => ({ ...p, hpa: { ...p.hpa, maxReplicas: Number(ev.target.value) } }))} />
            </Field>
            <Field label="CPU target %">
              <Input type="number" min={1} max={100} value={params.hpa.cpuUtilization} onChange={(ev) => setParams((p) => ({ ...p, hpa: { ...p.hpa, cpuUtilization: Number(ev.target.value) } }))} />
            </Field>
          </div>
        ) : null}

        {targets.includes('pdb') ? (
          <div className="grid grid-cols-3 gap-2">
            <Field label="Min available">
              <Input type="number" min={1} value={params.pdb.minAvailable} onChange={(ev) => setParams((p) => ({ ...p, pdb: { minAvailable: Math.max(1, Number(ev.target.value)) } }))} />
            </Field>
          </div>
        ) : null}

        {locating ? (
          <p className="text-[12px] text-content-muted">Finding the manifests Argo CD deploys…</p>
        ) : !base ? (
          <p className="rounded-md bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed text-content-muted">
            {locateError ?? 'The deploy manifests could not be found.'} Add the change by hand where the workload is declared.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-[11px] text-content-muted">
              <span className="font-mono text-content">{`${base.org}/${base.repo}`}</span>
              <span className="px-1">· base</span>
              <span className="font-mono text-content">{base.dir || '/'}</span>
              {base.renderedPath !== base.dir ? <span>{` · rendered via ${base.renderedPath}`}</span> : null}
              <span>{` · branch ${base.ref}`}</span>
            </p>
            {plan?.skipped.map((s) => (
              <p key={s.target} className="rounded-md bg-surface-sunken px-3 py-1.5 text-[11px] text-content-muted">
                <span className="font-medium text-content">{MANIFEST_LABEL[s.target]}:</span> {s.reason}
              </p>
            ))}
            {plan?.notes.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-content-muted">
                {plan.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            ) : null}
            {changes.map((c) => <DiffPreview key={c.path} path={c.path} before={c.before} after={c.after} />)}
            {plan && !changes.length ? <p className="text-[12px] text-content-muted">Nothing to change.</p> : null}
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
        )}
        {!ctx.gate.ok ? <p className="text-[12px] text-content-muted">{ctx.gate.reason}</p> : null}
      </div>
    </Modal>
  )
}

/* ─────────── re-evaluation ─────────── */

export type EvalPhase = 'idle' | 'catalog' | 'scoring'

/**
 * Re-evaluate one service: the catalog-derived checks are recomputed from a
 * fresh read of its source (descriptor, registration, live objects); when the
 * platform scorer grades it, a scorer run is started too and the result is
 * awaited (polled, like the page's Re-evaluate). The toast reports the delta the
 * evaluator produced — nothing is claimed before it lands.
 */
export function useReEvaluate(card: Scorecard, target: DescriptorTarget | null, platformLastRun: string | undefined) {
  const qc = useQueryClient()
  const toast = useToast()
  const [phase, setPhase] = useState<EvalPhase>('idle')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const cardRef = useRef(card)
  cardRef.current = card
  const lastRunRef = useRef(platformLastRun)
  lastRunRef.current = platformLastRun
  const before = useRef<ScoreSnapshot | null>(null)
  const timers = useRef<number[]>([])
  const clear = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }
  useEffect(() => clear, [])

  const name = card.entity.metadata.title ?? card.entity.metadata.name
  const report = useCallback((after: Scorecard) => {
    if (!before.current) return
    const d = scoreDelta(before.current, snapshotOf(after))
    const kind = d.delta > 0 || d.passingDelta > 0 ? 'success' : d.delta < 0 ? 'warning' : 'info'
    toast[kind](`${name} re-evaluated`, { description: d.message })
    before.current = null
  }, [toast, name])

  const run = useCallback(async () => {
    if (phaseRef.current !== 'idle') return
    phaseRef.current = 'catalog'
    const c = cardRef.current
    before.current = snapshotOf(c, lastRunRef.current)
    setPhase('catalog')
    await Promise.allSettled([
      ...(target ? [qc.invalidateQueries({ queryKey: descriptorKey(target) })] : []),
      qc.invalidateQueries({ queryKey: ['catalog', 'registered'] }),
      qc.invalidateQueries({ queryKey: ['catalog', 'live'] }),
    ])
    if (!c.platform) {
      // Let the refreshed queries reach the render before reading the card.
      await new Promise((r) => setTimeout(r, 150))
      report(cardRef.current)
      setPhase('idle')
      return
    }
    const r = await rerunFor(c.platform.name)
    if (!r.started && r.error !== 'already_running') {
      toast.warning('Catalog checks refreshed; the scorer did not start', { description: rerunMessage(r) })
      await new Promise((res) => setTimeout(res, 150))
      report(cardRef.current)
      setPhase('idle')
      return
    }
    setPhase('scoring')
    // The scorer grades every service in one pass (~a minute); poll for its new run.
    for (let i = 1; i <= 16; i++) {
      timers.current.push(setTimeout(() => void qc.invalidateQueries({ queryKey: ['platform-scorecards'] }), i * 15_000) as unknown as number)
    }
    timers.current.push(setTimeout(() => {
      if (phaseRef.current !== 'scoring') return
      toast.info(`Still waiting for the scorer to grade ${name}`, { description: 'Its new result will show here when the run finishes.' })
      before.current = null
      setPhase('idle')
    }, 16 * 15_000 + 5_000) as unknown as number)
  }, [target, qc, toast, report, name])

  // The scorer published a newer run → that is the evaluator's answer.
  useEffect(() => {
    if (phase !== 'scoring' || !before.current) return
    if (platformLastRun && platformLastRun !== before.current.lastRun) {
      clear()
      report(card)
      setPhase('idle')
    }
  }, [phase, platformLastRun, card, report])

  return { phase, run }
}

/* ─────────── pending-fix watcher ─────────── */

/**
 * Follow pending fixes' pull requests. In the drawer it polls the open PRs of
 * that entity; on the page it checks every pending PR once per visit. A merged
 * PR marks the fix "merged" and asks for a re-evaluation; a closed one drops
 * the fix (nothing landed). Confirmed fixes — every target now passing per the
 * evaluator — are pruned.
 */
export function usePendingWatcher({
  pending,
  poll,
  cards,
  onMerged,
}: {
  pending: PendingFix[]
  poll: number | false
  cards: Scorecard[]
  onMerged(fixes: PendingFix[]): void
}) {
  const toast = useToast()
  const open = useMemo(() => pending.filter((p) => p.mode === 'pr' && p.pr && p.state === 'open'), [pending])
  const results = useQueries({ queries: open.map((p) => prStateQuery(p, poll)) })
  const states = results.map((r) => r.data?.state ?? '').join('|')
  const onMergedRef = useRef(onMerged)
  onMergedRef.current = onMerged

  useEffect(() => {
    const merged: PendingFix[] = []
    open.forEach((p, i) => {
      const s = results[i]?.data?.state
      if (s === 'merged') {
        const landedAt = new Date().toISOString()
        pendingStore.update(p.id, { state: 'merged', landedAt })
        merged.push({ ...p, state: 'merged', landedAt })
      } else if (s === 'closed') {
        pendingStore.remove(p.id)
        toast.info(`PR #${p.pr?.number} was closed without merging`, { description: `${p.org}/${p.repo} — the fix did not land.` })
      }
    })
    if (merged.length) {
      toast.success(merged.length === 1 ? `PR #${merged[0].pr?.number} merged` : `${merged.length} fix PRs merged`, {
        description: 'Re-evaluating — the checks stay pending until the evaluator confirms them.',
      })
      onMergedRef.current(merged)
    }
  }, [states])

  // Drop fixes the evaluator now confirms, and stale ones.
  const passedSig = cards.map((c) => `${c.entityRef}:${snapshotOf(c).passed.join(',')}`).join(';')
  useEffect(() => {
    const passed = new Map(cards.map((c) => [c.entityRef as string, new Set(snapshotOf(c).passed)]))
    const all = pendingStore.list()
    const relevant = all.filter((p) => passed.has(p.entityRef) || !cards.length)
    if (!relevant.length) return
    const kept = prunePending(relevant, passed, Date.now())
    const keptIds = new Set(kept.map((p) => p.id))
    const dropped = relevant.filter((p) => !keptIds.has(p.id))
    if (dropped.length) pendingStore.replace(all.filter((p) => !dropped.some((d) => d.id === p.id)))
  }, [passedSig])
}
