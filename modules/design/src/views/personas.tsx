import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
} from '@adhar-console/shell-ui'
import { newId, store } from '../data/store.ts'
import { SEED_PERSONAS } from '../data/seed.ts'
import type { Persona } from '../data/types.ts'

const AVATAR_OPTIONS = ['👩🏽‍💻', '🧑🏽‍💼', '🎨', '👨🏿‍🔬', '🧑🏼‍🎤', '👩🏻‍🚀', '🧑🏽‍🚒', '👨🏽‍🏫', '🦊', '🐙']

/**
 * Persona cards — the team's shared view of who they're building for.
 * Stored in localStorage; each card opens a detail drawer with goals,
 * frustrations, behaviors, and tech context. New personas are created via a
 * modal with comma-separated list inputs (lightweight, fast to fill).
 */
export function Personas() {
  const [list, setList] = useState<Persona[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    setList(store.get<Persona[]>('personas', SEED_PERSONAS))
  }, [])

  const persist = (next: Persona[]) => {
    setList(next)
    store.set('personas', next)
  }

  const open = list.find((p) => p.id === openId) ?? null
  const editing = list.find((p) => p.id === editingId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">
          {list.length} persona{list.length === 1 ? '' : 's'}
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New persona
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="No personas yet"
          description="Define who you're designing for — goals, frustrations, behaviors."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => (
            <PersonaCard key={p.id} p={p} onOpen={() => setOpenId(p.id)} />
          ))}
        </div>
      )}

      <PersonaEditorModal
        open={createOpen || !!editing}
        onClose={() => {
          setCreateOpen(false)
          setEditingId(null)
        }}
        initial={editing ?? undefined}
        onSubmit={(input) => {
          if (editing) {
            persist(list.map((p) => (p.id === editing.id ? { ...editing, ...input } : p)))
            setEditingId(null)
          } else {
            const next: Persona = { id: newId('persona'), ...input }
            persist([next, ...list])
            setOpenId(next.id)
          }
        }}
      />

      {open ? (
        <PersonaDetail
          persona={open}
          onClose={() => setOpenId(null)}
          onEdit={() => {
            setEditingId(open.id)
            setOpenId(null)
          }}
          onDelete={() => {
            if (!confirm(`Delete persona "${open.name}"?`)) return
            persist(list.filter((p) => p.id !== open.id))
            setOpenId(null)
          }}
        />
      ) : null}
    </div>
  )
}

function PersonaCard({ p, onOpen }: { p: Persona; onOpen(): void }) {
  return (
    <Card interactive>
      <button type="button" onClick={onOpen} className="block w-full p-5 text-left">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br from-brand-50 to-violet-50 text-2xl ring-1 ring-inset ring-edge-subtle">
            {p.avatar}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-content">{p.name}</div>
            <div className="mt-0.5 text-[11px] uppercase tracking-wider text-content-subtle">
              {p.role}
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-content-muted">{p.bio}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {p.tech.slice(0, 4).map((t) => (
            <span
              key={t}
              className="inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted"
            >
              {t}
            </span>
          ))}
          {p.tech.length > 4 ? (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">
              +{p.tech.length - 4}
            </span>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Mini label="Goals" value={p.goals.length} accent="emerald" />
          <Mini label="Pains" value={p.frustrations.length} accent="rose" />
          <Mini label="Behaviors" value={p.behaviors.length} accent="brand" />
        </div>
      </button>
    </Card>
  )
}

function Mini({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent: 'emerald' | 'rose' | 'brand'
}) {
  const tone = {
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
    brand: 'text-brand-700',
  }[accent]
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-1.5">
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function PersonaDetail({
  persona: p,
  onClose,
  onEdit,
  onDelete,
}: {
  persona: Persona
  onClose(): void
  onEdit(): void
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
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-linear-to-br from-brand-50 to-violet-50 text-2xl ring-1 ring-inset ring-edge-subtle">
              {p.avatar}
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                Persona · {p.role}
              </div>
              <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-content">
                {p.name}
              </h2>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onEdit} leading={<IconEdit />}>
              Edit
            </Button>
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
          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Bio
              </div>
            </CardHeader>
            <CardBody>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-content">{p.bio}</p>
            </CardBody>
          </Card>

          <EmpathyMap p={p} />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ListBlock title="Goals" items={p.goals} tone="emerald" />
            <ListBlock title="Frustrations" items={p.frustrations} tone="rose" />
            <ListBlock title="Behaviors" items={p.behaviors} tone="brand" />
            <ListBlock title="Needs" items={p.needs} tone="violet" />
          </div>

          {p.tech.length ? (
            <Card>
              <CardHeader>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                  Tech context
                </div>
              </CardHeader>
              <CardBody>
                <div className="flex flex-wrap gap-1.5">
                  {p.tech.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-content-muted"
                    >
                      {t}
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

function ListBlock({
  title,
  items,
  tone,
}: {
  title: string
  items: string[]
  tone: 'emerald' | 'rose' | 'brand' | 'violet'
}) {
  const dot = {
    emerald: 'bg-emerald-500',
    rose: 'bg-rose-500',
    brand: 'bg-brand-500',
    violet: 'bg-violet-500',
  }[tone]
  return (
    <Card>
      <CardHeader>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
          {title}
        </div>
      </CardHeader>
      <CardBody>
        {items.length === 0 ? (
          <div className="text-xs text-content-subtle">—</div>
        ) : (
          <ul className="space-y-2">
            {items.map((it, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-content">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <span className="leading-relaxed">{it}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

function PersonaEditorModal({
  open,
  onClose,
  initial,
  onSubmit,
}: {
  open: boolean
  onClose(): void
  initial?: Persona
  onSubmit(input: Omit<Persona, 'id'>): void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [avatar, setAvatar] = useState(AVATAR_OPTIONS[0])
  const [bio, setBio] = useState('')
  const [goals, setGoals] = useState('')
  const [frustrations, setFrustrations] = useState('')
  const [behaviors, setBehaviors] = useState('')
  const [needs, setNeeds] = useState('')
  const [tech, setTech] = useState('')

  // Reset form when opening the modal — prefilled from `initial` for edit mode.
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setRole(initial?.role ?? '')
    setAvatar(initial?.avatar ?? AVATAR_OPTIONS[0])
    setBio(initial?.bio ?? '')
    setGoals((initial?.goals ?? []).join('\n'))
    setFrustrations((initial?.frustrations ?? []).join('\n'))
    setBehaviors((initial?.behaviors ?? []).join('\n'))
    setNeeds((initial?.needs ?? []).join('\n'))
    setTech((initial?.tech ?? []).join(', '))
  }, [open, initial])

  const split = (s: string) =>
    s
      .split(/\n|,(?![^()]*\))/)
      .map((x) => x.trim())
      .filter(Boolean)

  const submit = () => {
    if (!name.trim() || !role.trim()) return
    onSubmit({
      name: name.trim(),
      role: role.trim(),
      avatar,
      bio: bio.trim(),
      goals: split(goals),
      frustrations: split(frustrations),
      behaviors: split(behaviors),
      needs: split(needs),
      tech: split(tech),
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Edit persona' : 'New persona'}
      description="Capture the person — what they want, what blocks them, how they work."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim() || !role.trim()}>
            {initial ? 'Save changes' : 'Create persona'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <Field label="Name">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Priya — Platform Engineer"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
          <Field label="Avatar">
            <div className="flex flex-wrap gap-1">
              {AVATAR_OPTIONS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAvatar(a)}
                  className={
                    avatar === a
                      ? 'flex h-9 w-9 items-center justify-center rounded-md border border-brand-400 bg-brand-50 text-lg ring-2 ring-brand-400/20'
                      : 'flex h-9 w-9 items-center justify-center rounded-md border border-edge-default text-lg hover:border-edge-strong'
                  }
                >
                  {a}
                </button>
              ))}
            </div>
          </Field>
        </div>
        <Field label="Role">
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Platform engineer"
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Bio">
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={2}
            placeholder="Owns the dev platform for a 200-person fintech."
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ListField label="Goals" value={goals} onChange={setGoals} />
          <ListField label="Frustrations" value={frustrations} onChange={setFrustrations} />
          <ListField label="Behaviors" value={behaviors} onChange={setBehaviors} />
          <ListField label="Needs" value={needs} onChange={setNeeds} />
        </div>
        <Field label="Tech (comma-separated)">
          <input
            value={tech}
            onChange={(e) => setTech(e.target.value)}
            placeholder="Kubernetes, Terraform, Go"
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
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

function ListField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange(v: string): void
}) {
  return (
    <Field label={`${label} (one per line)`}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
      />
    </Field>
  )
}

function EmpathyMap({ p }: { p: Persona }) {
  return (
    <Card>
      <CardHeader>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
          Empathy map
        </div>
        <div className="text-[11px] text-content-subtle">Says · Thinks · Does · Feels</div>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-edge-subtle">
          <Quadrant label="Says" tone="brand" items={p.behaviors.filter((b) => /say|say|tell|ask/i.test(b)).concat(p.goals.slice(0, 2))} />
          <Quadrant label="Thinks" tone="violet" items={p.needs} fallback={p.goals.slice(0, 2)} />
          <Quadrant label="Does" tone="emerald" items={p.behaviors} />
          <Quadrant label="Feels" tone="rose" items={p.frustrations} />
        </div>
      </CardBody>
    </Card>
  )
}

function Quadrant({
  label,
  items,
  fallback,
  tone,
}: {
  label: string
  items: string[]
  fallback?: string[]
  tone: 'brand' | 'violet' | 'emerald' | 'rose'
}) {
  const list = items.length ? items : fallback ?? []
  const accent = {
    brand: 'text-brand-700',
    violet: 'text-violet-700',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
  }[tone]
  return (
    <div className="bg-white p-3">
      <div className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${accent}`}>
        {label}
      </div>
      {list.length === 0 ? (
        <div className="mt-1 text-xs text-content-subtle">—</div>
      ) : (
        <ul className="mt-1.5 space-y-1 text-xs text-content">
          {list.slice(0, 4).map((it, i) => (
            <li key={i} className="leading-relaxed">
              · {it}
            </li>
          ))}
        </ul>
      )}
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
function IconEdit() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
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
