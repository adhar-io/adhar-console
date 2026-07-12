import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { newId, store } from '../data/store.ts'
import { SEED_ADRS } from '../data/seed.ts'
import type { Adr, AdrStatus } from '../data/types.ts'

const STATUS_KIND: Record<AdrStatus, StatusKind> = {
  proposed: 'info',
  accepted: 'healthy',
  superseded: 'unknown',
  deprecated: 'degraded',
  rejected: 'failed',
}

const STATUS_ORDER: AdrStatus[] = ['proposed', 'accepted', 'superseded', 'deprecated', 'rejected']

export function Adrs() {
  const [adrs, setAdrs] = useState<Adr[]>([])
  const [filter, setFilter] = useState<'all' | AdrStatus>('all')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    setAdrs(store.get<Adr[]>('adrs', SEED_ADRS))
  }, [])

  const persist = (next: Adr[]) => {
    setAdrs(next)
    store.set('adrs', next)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return adrs
      .filter((a) => filter === 'all' || a.status === filter)
      .filter(
        (a) =>
          !q ||
          a.title.toLowerCase().includes(q) ||
          a.tags.some((t) => t.toLowerCase().includes(q)) ||
          a.authors.some((au) => au.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.number - a.number)
  }, [adrs, filter, search])

  const counts: Record<'all' | AdrStatus, number> = useMemo(() => {
    const out: Record<string, number> = { all: adrs.length }
    for (const s of STATUS_ORDER) out[s] = adrs.filter((a) => a.status === s).length
    return out as Record<'all' | AdrStatus, number>
  }, [adrs])

  const open = adrs.find((a) => a.id === openId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterTabs filter={filter} setFilter={setFilter} counts={counts} />
        <div className="ml-auto flex items-center gap-2">
          <SearchInput value={search} onChange={setSearch} />
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New ADR
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={adrs.length === 0 ? 'No ADRs yet' : 'No matches'}
          description={
            adrs.length === 0
              ? 'Capture the first decision — context, alternatives, consequences.'
              : 'Try a different status or search term.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {filtered.map((a) => (
            <AdrCard key={a.id} adr={a} onOpen={() => setOpenId(a.id)} />
          ))}
        </div>
      )}

      <CreateAdrModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => {
          const next: Adr = {
            id: newId('adr'),
            number: (adrs.reduce((m, a) => Math.max(m, a.number), 0) ?? 0) + 1,
            updated_at: new Date().toISOString(),
            repo: 'acme/docs',
            ...input,
          }
          persist([next, ...adrs])
          setOpenId(next.id)
        }}
      />

      {open ? (
        <AdrDetail
          adr={open}
          onClose={() => setOpenId(null)}
          onChangeStatus={(status) => {
            const next = adrs.map((a) =>
              a.id === open.id ? { ...a, status, updated_at: new Date().toISOString() } : a,
            )
            persist(next)
          }}
          onDelete={() => {
            if (!confirm(`Delete ADR-${String(open.number).padStart(4, '0')}?`)) return
            persist(adrs.filter((a) => a.id !== open.id))
            setOpenId(null)
          }}
        />
      ) : null}
    </div>
  )
}

function FilterTabs({
  filter,
  setFilter,
  counts,
}: {
  filter: 'all' | AdrStatus
  setFilter(f: 'all' | AdrStatus): void
  counts: Record<'all' | AdrStatus, number>
}) {
  const tabs: { id: 'all' | AdrStatus; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'proposed', label: 'Proposed' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'superseded', label: 'Superseded' },
    { id: 'deprecated', label: 'Deprecated' },
    { id: 'rejected', label: 'Rejected' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
      {tabs.map((t) => {
        const on = filter === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setFilter(t.id)}
            className={
              on
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {t.label}
            <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-60">
              {counts[t.id] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function AdrCard({ adr, onOpen }: { adr: Adr; onOpen(): void }) {
  return (
    <Card interactive className="group">
      <button type="button" onClick={onOpen} className="block w-full p-5 text-left">
        <CardHeader className="!p-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                <span className="rounded-md bg-surface-sunken px-1.5 py-0.5">
                  ADR-{String(adr.number).padStart(4, '0')}
                </span>
                <span>{adr.repo}</span>
              </div>
              <h3 className="mt-1 truncate text-sm font-semibold text-content">{adr.title}</h3>
            </div>
            <StatusBadge kind={STATUS_KIND[adr.status]}>{adr.status}</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="!px-0 !pt-3">
          <p className="line-clamp-2 text-xs leading-relaxed text-content-muted">{adr.context}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
            <span className="font-medium text-content">{adr.authors.join(', ')}</span>
            <span className="text-content-subtle">·</span>
            <span>{formatRelative(adr.updated_at)}</span>
            {adr.tags.map((t) => (
              <span
                key={t}
                className="ml-auto inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted last:ml-0"
              >
                #{t}
              </span>
            ))}
          </div>
        </CardBody>
      </button>
    </Card>
  )
}

function AdrDetail({
  adr,
  onClose,
  onChangeStatus,
  onDelete,
}: {
  adr: Adr
  onClose(): void
  onChangeStatus(s: AdrStatus): void
  onDelete(): void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              <span className="rounded-md bg-surface-sunken px-1.5 py-0.5">
                ADR-{String(adr.number).padStart(4, '0')}
              </span>
              <StatusBadge kind={STATUS_KIND[adr.status]}>{adr.status}</StatusBadge>
            </div>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-content">
              {adr.title}
            </h2>
            <div className="mt-1 text-[11px] text-content-muted">
              by {adr.authors.join(', ')} · {formatRelative(adr.updated_at)} · {adr.repo}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              value={adr.status}
              onChange={(e) => onChangeStatus(e.target.value as AdrStatus)}
              className="rounded-md border border-edge-default bg-white px-2 py-1 text-xs"
              aria-label="Change status"
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Section title="Context" body={adr.context} />
          <Section title="Decision" body={adr.decision} />
          <Section title="Consequences" body={adr.consequences} />
          {adr.tags.length ? (
            <Card>
              <CardBody>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  Tags
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {adr.tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-content-muted"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
          {title}
        </div>
      </CardHeader>
      <CardBody>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-content">{body}</p>
      </CardBody>
    </Card>
  )
}

function CreateAdrModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose(): void
  onCreate(adr: Omit<Adr, 'id' | 'number' | 'updated_at' | 'repo'>): void
}) {
  const [title, setTitle] = useState('')
  const [authors, setAuthors] = useState('')
  const [tags, setTags] = useState('')
  const [context, setContext] = useState('')
  const [decision, setDecision] = useState('')
  const [consequences, setConsequences] = useState('')
  const [status, setStatus] = useState<AdrStatus>('proposed')

  const submit = () => {
    const t = title.trim()
    if (!t) return
    onCreate({
      title: t,
      status,
      authors: authors
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      tags: tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      context: context || '—',
      decision: decision || '—',
      consequences: consequences || '—',
    })
    setTitle('')
    setAuthors('')
    setTags('')
    setContext('')
    setDecision('')
    setConsequences('')
    setStatus('proposed')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New ADR"
      description="Capture the decision — context, what we chose, what it costs."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!title.trim()}>
            Create ADR
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Adopt XYZ for A and B"
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AdrStatus)}
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Authors (comma-sep)">
            <input
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
              placeholder="tapas, maya"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
          <Field label="Tags (comma-sep)">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="api, plane"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
        </div>
        <Field label="Context">
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={3}
            placeholder="What problem are we solving?"
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Decision">
          <textarea
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            rows={3}
            placeholder="What did we choose, and why?"
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Consequences">
          <textarea
            value={consequences}
            onChange={(e) => setConsequences(e.target.value)}
            rows={3}
            placeholder="What does this make easier? Harder?"
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

function SearchInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
        <IconSearch />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search ADRs…"
        className="block h-9 w-44 rounded-lg border border-edge-default bg-white pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
      />
    </div>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
