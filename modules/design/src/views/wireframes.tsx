import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { KIND, newId, useCollection, useCreate, useRemove, useSeedExamples, useUpdate } from '../data/store.ts'
import { SEED_WIREFRAMES } from '../data/seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { Wireframe, WireframeBlock } from '../data/types.ts'
import { FrameCanvas } from '../components/frame-canvas.tsx'
import { BuilderEmbed } from './builder.tsx'

const FLOW_LABEL: Record<string, string> = {
  onboarding: 'Onboarding flow',
  incident: 'Incident triage flow',
}

/**
 * Wireframes — flow-grouped low-fi screens.
 *
 *   Library mode: cards grouped by flow, with an SVG thumbnail per frame.
 *   Editor mode:  hands the frame to the embedded Visual Builder via
 *                 postMessage. The builder owns the editing experience;
 *                 this module just keeps the index, the create modal, and
 *                 a read-only fallback for when the builder isn't running.
 */
export function Wireframes() {
  const { items: list, isLoading, error, refetch } = useCollection<Wireframe>(KIND.wireframe)
  const createWf = useCreate<Wireframe>(KIND.wireframe)
  const updateWf = useUpdate<Wireframe>(KIND.wireframe)
  const removeWf = useRemove(KIND.wireframe)
  const seed = useSeedExamples<Wireframe>(KIND.wireframe)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const editing = useMemo(
    () => list.find((f) => f.id === editingId) ?? null,
    [list, editingId],
  )

  const flows = useMemo(() => {
    const grouped: Record<string, Wireframe[]> = {}
    for (const f of list) (grouped[f.flow] ??= []).push(f)
    for (const k of Object.keys(grouped)) grouped[k].sort((a, b) => a.order - b.order)
    return grouped
  }, [list])
  const flowKeys = Object.keys(flows).sort()

  if (editing) {
    return (
      <BuilderEmbed
        embedded
        title={editing.name}
        eyebrow={`Wireframe · ${FLOW_LABEL[editing.flow] ?? editing.flow} · step ${editing.order}`}
        doc={editing}
        onBack={() => setEditingId(null)}
        onSave={(saved) => {
          const blocks = (saved.blocks as WireframeBlock[] | undefined) ?? editing.blocks
          updateWf.mutate({ ...editing, name: saved.name || editing.name, blocks })
        }}
      />
    )
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading wireframes…" />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">
          {list.length} screen{list.length === 1 ? '' : 's'} across {flowKeys.length} flow
          {flowKeys.length === 1 ? '' : 's'} · editing handled in the Visual Builder
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
            New frame
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="No wireframes yet"
          description="Sketch a screen — pick a template or start blank. Editing opens in the Visual Builder."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => seed.mutate(SEED_WIREFRAMES)}
              disabled={seed.isPending}
            >
              {seed.isPending ? 'Loading…' : 'Load examples'}
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {flowKeys.map((flowKey) => (
            <FlowSection
              key={flowKey}
              flowKey={flowKey}
              frames={flows[flowKey]}
              onOpen={(id) => setEditingId(id)}
              onMove={(id, delta) => {
                const sameFlow = (flows[flowKey] ?? []).slice().sort((a, b) => a.order - b.order)
                const idx = sameFlow.findIndex((f) => f.id === id)
                const nxt = idx + delta
                if (idx < 0 || nxt < 0 || nxt >= sameFlow.length) return
                const a = sameFlow[idx]
                const b = sameFlow[nxt]
                updateWf.mutate({ ...a, order: b.order })
                updateWf.mutate({ ...b, order: a.order })
              }}
              onDuplicate={(id) => {
                const src = list.find((f) => f.id === id)
                if (!src) return
                const sameFlow = list.filter((f) => f.flow === src.flow)
                const order = Math.max(...sameFlow.map((f) => f.order), 0) + 1
                const clone: Wireframe = {
                  ...src,
                  id: newId('wf'),
                  name: `${src.name} (copy)`,
                  order,
                  blocks: src.blocks.map((b) => ({ ...b })),
                }
                createWf.mutate(clone, { onSuccess: (created) => setEditingId(created.id) })
              }}
              onDelete={(id) => {
                const f = list.find((x) => x.id === id)
                if (!f) return
                if (!confirm(`Delete frame "${f.name}"?`)) return
                removeWf.mutate(id)
              }}
            />
          ))}
        </div>
      )}

      <CreateFrameModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        existingFlows={Array.from(new Set(list.map((f) => f.flow)))}
        onCreate={({ name, flow, notes, templateId }) => {
          const orderInFlow = list.filter((f) => f.flow === flow).length + 1
          const tpl = FRAME_TEMPLATES.find((t) => t.id === templateId) ?? FRAME_TEMPLATES[0]
          const next: Wireframe = {
            id: newId('wf'),
            name,
            flow,
            order: orderInFlow,
            notes: notes || tpl.notes,
            blocks: tpl.build().map((b) => ({ ...b })),
          }
          createWf.mutate(next, { onSuccess: (created) => setEditingId(created.id) })
        }}
      />
    </div>
  )
}

/* ─────────── Library view ─────────── */

function FlowSection({
  flowKey,
  frames,
  onOpen,
  onMove,
  onDuplicate,
  onDelete,
}: {
  flowKey: string
  frames: Wireframe[]
  onOpen(id: string): void
  onMove(id: string, delta: -1 | 1): void
  onDuplicate(id: string): void
  onDelete(id: string): void
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-base font-semibold tracking-tight text-content">
          {FLOW_LABEL[flowKey] ?? flowKey}
        </h2>
        <StatusBadge kind="info">{frames.length} screens</StatusBadge>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex items-stretch gap-4">
          {frames.map((f, i) => (
            <div key={f.id} className="flex items-stretch gap-4">
              <FrameCard
                frame={f}
                onOpen={() => onOpen(f.id)}
                onMoveLeft={i > 0 ? () => onMove(f.id, -1) : undefined}
                onMoveRight={i < frames.length - 1 ? () => onMove(f.id, 1) : undefined}
                onDuplicate={() => onDuplicate(f.id)}
                onDelete={() => onDelete(f.id)}
              />
              {i < frames.length - 1 ? <FlowArrow /> : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function FrameCard({
  frame,
  onOpen,
  onMoveLeft,
  onMoveRight,
  onDuplicate,
  onDelete,
}: {
  frame: Wireframe
  onOpen(): void
  onMoveLeft?(): void
  onMoveRight?(): void
  onDuplicate(): void
  onDelete(): void
}) {
  return (
    <Card className="group relative w-85 shrink-0">
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`Edit ${frame.name}`}>
        <CardHeader className="py-3!">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-content-subtle">
                Step {frame.order}
              </div>
              <div className="text-sm font-semibold text-content">{frame.name}</div>
            </div>
            <StatusBadge kind="unknown">low-fi</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-3!">
          <FrameCanvas blocks={frame.blocks} />
          {frame.notes ? (
            <p className="mt-3 line-clamp-3 text-[11px] leading-relaxed text-content-muted">
              {frame.notes}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1 text-content-muted">
              <IconBuilder /> Open in Builder
            </span>
            <span className="font-mono text-[10px] text-content-subtle">{frame.blocks.length} blocks</span>
          </div>
        </CardBody>
      </button>
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-lg border border-edge-default bg-white/95 p-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100">
        {onMoveLeft ? (
          <ActionBtn onClick={onMoveLeft} label="Move left">
            <IconArrowLeft />
          </ActionBtn>
        ) : null}
        {onMoveRight ? (
          <ActionBtn onClick={onMoveRight} label="Move right">
            <IconArrowRight />
          </ActionBtn>
        ) : null}
        <ActionBtn onClick={onDuplicate} label="Duplicate">
          <IconCopy />
        </ActionBtn>
        <ActionBtn onClick={onDelete} label="Delete" tone="danger">
          <IconTrash />
        </ActionBtn>
      </div>
    </Card>
  )
}

function ActionBtn({
  onClick,
  label,
  tone = 'neutral',
  children,
}: {
  onClick(): void
  label: string
  tone?: 'neutral' | 'danger'
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-content-subtle transition-colors ${
        tone === 'danger' ? 'hover:bg-rose-50 hover:text-rose-700' : 'hover:bg-surface-sunken hover:text-content'
      }`}
    >
      {children}
    </button>
  )
}

function FlowArrow() {
  return (
    <div className="flex shrink-0 items-center" aria-hidden>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-content-subtle)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    </div>
  )
}

/* ─────────── Frame templates ─────────── */

const VIEW_W = 720
const VIEW_H = 440

const FRAME_TEMPLATES: {
  id: string
  label: string
  description: string
  notes?: string
  build(): WireframeBlock[]
}[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'Empty viewport — sketch from scratch.',
    build: () => [],
  },
  {
    id: 'login',
    label: 'Login screen',
    description: 'Logo, two inputs, primary button, link.',
    notes: 'Sign-in flow — collapse SSO under a "More" toggle.',
    build: () => [
      { type: 'logo', x: 240, y: 64, w: 120, h: 36 },
      { type: 'h1', x: 200, y: 120, w: 200, h: 28, label: 'Welcome back' },
      { type: 'text', x: 200, y: 156, w: 200, h: 16 },
      { type: 'input', x: 200, y: 200, w: 200, h: 36, label: 'Email' },
      { type: 'input', x: 200, y: 248, w: 200, h: 36, label: 'Password' },
      { type: 'button', x: 200, y: 304, w: 200, h: 36, label: 'Sign in' },
      { type: 'link', x: 240, y: 352, w: 120, h: 16, label: 'Forgot password?' },
    ],
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Top nav, sidebar, stat row, chart, table.',
    build: () => [
      { type: 'navbar', x: 16, y: 16, w: 568, h: 40 },
      { type: 'sidebar', x: 16, y: 64, w: 144, h: 320 },
      { type: 'h1', x: 176, y: 72, w: 280, h: 28, label: 'Operations' },
      { type: 'stat', x: 176, y: 112, w: 128, h: 72, label: '128|Active' },
      { type: 'stat', x: 312, y: 112, w: 128, h: 72, label: '14|Errors' },
      { type: 'stat', x: 448, y: 112, w: 136, h: 72, label: '99.8|Uptime %' },
      { type: 'chart', x: 176, y: 200, w: 408, h: 120 },
      { type: 'table', x: 176, y: 336, w: 408, h: 88 },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Tabbed settings with form rows.',
    build: () => [
      { type: 'breadcrumb', x: 24, y: 24, w: 240, h: 16, label: 'Home / Settings' },
      { type: 'h1', x: 24, y: 48, w: 280, h: 28, label: 'Account settings' },
      { type: 'tabs', x: 24, y: 88, w: 360, h: 28, label: 'Profile,Security,Billing' },
      { type: 'card', x: 24, y: 132, w: 560, h: 240 },
      { type: 'h2', x: 40, y: 148, w: 200, h: 22, label: 'Profile' },
      { type: 'input', x: 40, y: 188, w: 320, h: 32, label: 'Display name' },
      { type: 'input', x: 40, y: 232, w: 320, h: 32, label: 'Email' },
      { type: 'toggle', x: 40, y: 280, w: 36, h: 20, label: 'on' },
      { type: 'text', x: 88, y: 282, w: 200, h: 16 },
      { type: 'button', x: 40, y: 320, w: 120, h: 32, label: 'Save changes' },
    ],
  },
  {
    id: 'card-grid',
    label: 'Card grid',
    description: 'Search + filter + grid of cards.',
    build: () => [
      { type: 'h1', x: 24, y: 24, w: 280, h: 28, label: 'Browse projects' },
      { type: 'search', x: 24, y: 64, w: 280, h: 32, label: 'Search projects…' },
      { type: 'dropdown', x: 312, y: 64, w: 144, h: 32, label: 'Status: All' },
      { type: 'card', x: 24, y: 112, w: 180, h: 120 },
      { type: 'card', x: 212, y: 112, w: 180, h: 120 },
      { type: 'card', x: 400, y: 112, w: 180, h: 120 },
      { type: 'card', x: 24, y: 240, w: 180, h: 120 },
      { type: 'card', x: 212, y: 240, w: 180, h: 120 },
      { type: 'card', x: 400, y: 240, w: 180, h: 120 },
    ],
  },
  {
    id: 'empty-state',
    label: 'Empty state',
    description: 'Centered icon + headline + CTA.',
    build: () => [
      { type: 'icon', x: 320, y: 120, w: 64, h: 64 },
      { type: 'h1', x: 220, y: 200, w: 264, h: 28, label: 'Nothing here yet' },
      { type: 'text', x: 200, y: 240, w: 304, h: 32 },
      { type: 'button', x: 296, y: 296, w: 112, h: 36, label: 'Get started' },
    ],
  },
  {
    id: 'modal',
    label: 'Modal dialog',
    description: 'Backdrop + dialog with form + actions.',
    build: () => [
      { type: 'card', x: 0, y: 0, w: VIEW_W, h: VIEW_H },
      { type: 'card', x: 152, y: 80, w: 416, h: 280 },
      { type: 'h2', x: 168, y: 96, w: 280, h: 22, label: 'Confirm action' },
      { type: 'text', x: 168, y: 128, w: 384, h: 32 },
      { type: 'input', x: 168, y: 176, w: 384, h: 32, label: 'Reason (optional)' },
      { type: 'button', x: 416, y: 312, w: 80, h: 32, label: 'Confirm' },
      { type: 'button', x: 504, y: 312, w: 56, h: 32, label: 'Cancel' },
    ],
  },
]

/* ─────────── Create modal ─────────── */

function CreateFrameModal({
  open,
  onClose,
  existingFlows,
  onCreate,
}: {
  open: boolean
  onClose(): void
  existingFlows: string[]
  onCreate(input: { name: string; flow: string; notes: string; templateId: string }): void
}) {
  const [name, setName] = useState('')
  const [flow, setFlow] = useState(existingFlows[0] ?? 'onboarding')
  const [notes, setNotes] = useState('')
  const [templateId, setTemplateId] = useState('blank')

  useEffect(() => {
    if (!open) return
    setName('')
    setNotes('')
    setTemplateId('blank')
    setFlow(existingFlows[0] ?? 'onboarding')
  }, [open, existingFlows])

  const submit = () => {
    if (!name.trim()) return
    onCreate({ name: name.trim(), flow: flow.trim(), notes, templateId })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New frame"
      description="Pick a template to seed the canvas, or start blank — opens directly in the Visual Builder."
      branded
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>
            Create & open in Builder
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sign up"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
          <Field label="Flow">
            <input
              value={flow}
              onChange={(e) => setFlow(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              list="flow-options"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
            <datalist id="flow-options">
              {existingFlows.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Template
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FRAME_TEMPLATES.map((t) => {
              const on = templateId === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  className={
                    on
                      ? 'rounded-lg border border-brand-400 bg-brand-50 p-3 text-left ring-2 ring-brand-400/20'
                      : 'rounded-lg border border-edge-default bg-white p-3 text-left hover:border-edge-strong'
                  }
                >
                  <div className="text-sm font-semibold text-content">{t.label}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-content-muted">
                    {t.description}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
        <Field label="Notes (optional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="What does this screen need to communicate?"
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

/* ─────────── icons ─────────── */

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}
function IconArrowRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}
function IconBuilder() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
