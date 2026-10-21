import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Modal, StatusBadge, Textarea, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { defaultProjectFor, extractFence, htmlToNodes, PAGE_INSTRUCTIONS } from '@adhar/builder'
import { KIND, type Listed, newId, useCollection, useCreate, useRemove, useRestoreDocs, useUpdate } from '../data/store.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { ComponentLink, Wireframe, WireframeBlock } from '../data/types.ts'
import { FrameCanvas } from '../components/frame-canvas.tsx'
import { BuilderEmbed } from './builder.tsx'
import { useUrlParam } from '../data/builder-nav.ts'
import { useDesignScope } from '../data/design-scope.ts'
import { appRepo, scopedApps, useCatalogApps } from '../data/designer-repos.ts'
import { projectToBlocks, projectWithNodes } from '../data/wireframe-builder.ts'
import { askAdharAi } from '../data/ai.ts'
import { useGiteaOrg } from '@adhar/shell-ui'
import { AskAiButton, ComponentSelect, type PickableApp, PrBadge, ReviewBadge, Spark } from '../components/integrations.tsx'
import { FrameDetails } from '../components/wireframe-integrations.tsx'
import { SharedChip } from '../components/scope-picker.tsx'

const FLOW_LABEL: Record<string, string> = {
  onboarding: 'Onboarding flow',
  incident: 'Incident triage flow',
}

/**
 * Wireframes — flow-grouped low-fi screens, scoped to the active project.
 *
 *   Library:  cards grouped by flow with an SVG thumbnail, review state, the
 *             catalog component, Plane state and Visual Designer PRs.
 *   Details:  `?wireframe=<id>` — link a component and Plane work items, run a
 *             design review, "Implement in repo" (repo-first Visual Designer
 *             with the frame as a new page; its PR shows here).
 *   Editor:   `?doc=<id>` — the frame in the Visual Designer; saving stores
 *             the builder project and re-derives the thumbnail blocks.
 */
export function Wireframes() {
  const scope = useDesignScope()
  const org = useGiteaOrg()
  const all = useCollection<Wireframe>(KIND.wireframe)
  const { isLoading, error, refetch } = all
  const list = useMemo(() => all.items.filter((w) => scope.matches(w)), [all.items, scope])
  const createWf = useCreate<Wireframe>(KIND.wireframe)
  const updateWf = useUpdate<Wireframe>(KIND.wireframe)
  const removeWf = useRemove(KIND.wireframe)
  const restore = useRestoreDocs<Wireframe>(KIND.wireframe)
  const toast = useToast()
  const catalog = useCatalogApps()
  const apps = useMemo<PickableApp[]>(
    () => scopedApps(catalog.data ?? [], scope.inScope, scope.projects).map((a) => ({ name: a.name, repo: appRepo(a, org), project: a.project })),
    [catalog.data, scope.inScope, scope.projects, org],
  )

  // `?doc=<id>` deep-links an open frame, so refresh / shared links land in the editor.
  const [docParam, setDocParam] = useUrlParam('doc')
  const [detailParam, setDetailParam] = useUrlParam('wireframe')
  const editingId = docParam ?? null
  const setEditingId = (id: string | null) => setDocParam(id ?? undefined, { replace: id === null })
  const [createOpen, setCreateOpen] = useState(false)
  const [aiCreate, setAiCreate] = useState(false)
  // `?new=1` (from the Design dashboard's "New" menu) opens the create flow once.
  const [newParam, setNewParam] = useUrlParam('new')
  useEffect(() => {
    if (newParam !== '1') return
    setCreateOpen(true)
    setNewParam(undefined, { replace: true })
  }, [newParam, setNewParam])

  const editing = useMemo(() => all.items.find((f) => f.id === editingId) ?? null, [all.items, editingId])
  const details = useMemo(() => all.items.find((f) => f.id === detailParam) ?? null, [all.items, detailParam])

  const flows = useMemo(() => {
    const grouped: Record<string, Listed<Wireframe>[]> = {}
    for (const f of list) (grouped[f.flow] ??= []).push(f)
    for (const k of Object.keys(grouped)) grouped[k].sort((a, b) => a.order - b.order)
    return grouped
  }, [list])
  const flowKeys = Object.keys(flows).sort()
  const inReview = list.filter((f) => f.review?.state === 'in-review').length

  if (editing) {
    return (
      <BuilderEmbed
        title={`${editing.name} · ${FLOW_LABEL[editing.flow] ?? editing.flow} · step ${editing.order}`}
        doc={editing}
        onBack={() => setEditingId(null)}
        onSave={(next) => updateWf.mutateAsync(next)}
      />
    )
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading wireframes…" />

  const del = (f: Listed<Wireframe>) => {
    const { _createdAt: _a, _updatedAt: _b, _updatedBy: _c, ...plain } = f
    removeWf.mutate(f.id, {
      onSuccess: () => {
        if (detailParam === f.id) setDetailParam(undefined)
        toast.success(`Deleted “${f.name}”`, {
          action: { label: 'Undo', onClick: () => restore.mutate([plain as Wireframe], { onError: (e) => toast.error('Could not restore', { description: e.message }) }) },
        })
      },
      onError: (e) => toast.error('Could not delete frame', { description: e.message }),
    })
  }

  const createFrame = (next: Wireframe) =>
    createWf.mutate({ ...scope.tag(), ...next }, {
      onSuccess: (created) => setEditingId(created.id),
      onError: (e) => toast.error('Could not create frame', { description: e.message }),
    })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">
          {list.length} screen{list.length === 1 ? '' : 's'} across {flowKeys.length} flow{flowKeys.length === 1 ? '' : 's'}
          {inReview ? ` · ${inReview} in review` : ''}
          {all.items.length > list.length ? ` · ${all.items.length - list.length} outside ${scope.label}` : ''}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <AskAiButton onClick={() => { setAiCreate(true); setCreateOpen(true) }}>Describe a screen</AskAiButton>
          <Button size="sm" variant="primary" onClick={() => { setAiCreate(false); setCreateOpen(true) }} leading={<IconPlus />}>
            New frame
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title={all.items.length ? `No wireframes in ${scope.label}` : 'No wireframes yet'}
          description="Sketch a screen — pick a template, describe it to Adhar AI, or start blank. Editing opens in the Visual Designer."
          action={
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>New frame</Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {flowKeys.map((flowKey) => (
            <FlowSection
              key={flowKey}
              flowKey={flowKey}
              frames={flows[flowKey]}
              sharedLabel={!!scope.project}
              onOpen={(id) => setDetailParam(id)}
              onEdit={(id) => setEditingId(id)}
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
                const { _createdAt: _a, _updatedAt: _b, _updatedBy: _c, planeLinks: _p, prs: _r, review: _v, ...plain } = src
                createFrame({ ...plain, id: newId('wf'), name: `${src.name} (copy)`, order, blocks: src.blocks.map((b) => ({ ...b })) })
              }}
              onDelete={(id) => {
                const f = list.find((x) => x.id === id)
                if (f) del(f)
              }}
            />
          ))}
        </div>
      )}

      <CreateFrameModal
        open={createOpen}
        ai={aiCreate}
        onClose={() => setCreateOpen(false)}
        apps={apps}
        existingFlows={Array.from(new Set(list.map((f) => f.flow)))}
        onCreate={({ name, flow, notes, templateId, component, builder, blocks }) => {
          const orderInFlow = list.filter((f) => f.flow === flow).length + 1
          const tpl = FRAME_TEMPLATES.find((t) => t.id === templateId) ?? FRAME_TEMPLATES[0]
          createFrame({
            id: newId('wf'),
            name,
            flow,
            order: orderInFlow,
            notes: notes || tpl.notes,
            blocks: blocks ?? tpl.build().map((b) => ({ ...b })),
            ...(builder ? { builder } : {}),
            ...(component ? { component } : {}),
          })
        }}
      />

      {details ? (
        <FrameDetails
          key={details.id}
          frame={details}
          scope={scope}
          apps={apps}
          onClose={() => setDetailParam(undefined)}
          onEdit={() => {
            setDetailParam(undefined)
            setEditingId(details.id)
          }}
          onSave={(next) => updateWf.mutateAsync(next)}
        />
      ) : null}
    </div>
  )
}

/* ─────────── Library view ─────────── */

function FlowSection({
  flowKey,
  frames,
  sharedLabel,
  onOpen,
  onEdit,
  onMove,
  onDuplicate,
  onDelete,
}: {
  flowKey: string
  frames: Listed<Wireframe>[]
  sharedLabel: boolean
  onOpen(id: string): void
  onEdit(id: string): void
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
                shared={sharedLabel && !f.project}
                onOpen={() => onOpen(f.id)}
                onEdit={() => onEdit(f.id)}
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
  shared,
  onOpen,
  onEdit,
  onMoveLeft,
  onMoveRight,
  onDuplicate,
  onDelete,
}: {
  frame: Listed<Wireframe>
  shared: boolean
  onOpen(): void
  onEdit(): void
  onMoveLeft?(): void
  onMoveRight?(): void
  onDuplicate(): void
  onDelete(): void
}) {
  const items = (frame.planeLinks ?? []).length
  const lastPr = frame.prs?.[0]
  return (
    <Card className="group relative w-[min(21rem,calc(100vw-3rem))] shrink-0">
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`Open ${frame.name}`}>
        <CardHeader className="py-3!">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-content-subtle">
                Step {frame.order}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-content">{frame.name}</span>
                {shared ? <SharedChip /> : null}
              </div>
            </div>
            <ReviewBadge review={frame.review} />
          </div>
        </CardHeader>
        <CardBody className="p-3!">
          <FrameCanvas blocks={frame.blocks} />
          {frame.notes ? (
            <p className="mt-3 line-clamp-2 text-[11px] leading-relaxed text-content-muted">{frame.notes}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-content-muted">
            {frame.component ? (
              <span className="inline-flex items-center rounded bg-teal-50 px-1.5 py-0.5 text-[10px] text-teal-800 dark:bg-teal-500/10 dark:text-teal-200">{frame.component.name}</span>
            ) : (
              <span className="text-content-subtle">No component</span>
            )}
            {items ? <span>{items} work item{items === 1 ? '' : 's'}</span> : null}
            <span className="ml-auto font-mono text-[10px] text-content-subtle">{frame.blocks.length} blocks</span>
          </div>
        </CardBody>
      </button>
      {lastPr ? (
        <div className="flex items-center gap-1.5 border-t border-edge-subtle px-3 py-1.5 text-[11px] text-content-subtle">
          Pull request <PrBadge pr={lastPr} />
        </div>
      ) : null}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised/95 p-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <ActionBtn onClick={onEdit} label="Edit design">
          <IconBuilder />
        </ActionBtn>
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
  children: ReactNode
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
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-content-subtle transition-colors',
        tone === 'danger' ? 'hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10 dark:hover:text-rose-300' : 'hover:bg-surface-sunken hover:text-content',
      )}
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

interface CreateInput {
  name: string
  flow: string
  notes: string
  templateId: string
  component?: ComponentLink
  /** Adhar AI draft: a builder project and its thumbnail blocks. */
  builder?: unknown
  blocks?: WireframeBlock[]
}

function CreateFrameModal({
  open,
  ai,
  onClose,
  apps,
  existingFlows,
  onCreate,
}: {
  open: boolean
  ai: boolean
  onClose(): void
  apps: PickableApp[]
  existingFlows: string[]
  onCreate(input: CreateInput): void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [flow, setFlow] = useState(existingFlows[0] ?? 'onboarding')
  const [notes, setNotes] = useState('')
  const [templateId, setTemplateId] = useState('blank')
  const [component, setComponent] = useState<ComponentLink | undefined>()
  const [mode, setMode] = useState<'template' | 'ai'>('template')
  const [describe, setDescribe] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
    setNotes('')
    setDescribe('')
    setTemplateId('blank')
    setComponent(undefined)
    setMode(ai ? 'ai' : 'template')
    setFlow(existingFlows[0] ?? 'onboarding')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ai])

  const submit = async () => {
    if (!name.trim()) return
    const base = { name: name.trim(), flow: flow.trim() || 'flow', notes, templateId, component }
    if (mode === 'template') {
      onCreate(base)
      onClose()
      return
    }
    // The Visual Designer's own AI path: Adhar AI drafts the page as HTML,
    // which becomes canvas nodes; the frame opens in the designer to refine.
    setBusy(true)
    try {
      const reply = await askAdharAi({
        prompt: `${PAGE_INSTRUCTIONS}\n\nScreen: ${name.trim()}.\n${describe.trim()}`,
        context: component ? [{ description: 'Application', value: component.name }] : [],
      })
      const html = extractFence(reply, ['html']) ?? reply
      const nodes = htmlToNodes(html)
      if (!nodes.length) throw new Error('The draft had no usable markup — try describing the screen differently.')
      const project = projectWithNodes(defaultProjectFor('visual', base.name), base.name, nodes)
      onCreate({ ...base, notes: notes || describe.trim(), builder: project, blocks: projectToBlocks(project) })
      onClose()
    } catch (e) {
      toast.error('Adhar AI could not draft the screen', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New frame"
      description="Start from a template or describe the screen to Adhar AI — it opens in the Visual Designer."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} disabled={!name.trim() || (mode === 'ai' && !describe.trim())} loading={busy} leading={mode === 'ai' ? <Spark /> : undefined}>
            {mode === 'ai' ? 'Draft & open' : 'Create & open'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sign up" />
          </Field>
          <Field label="Flow">
            <Input value={flow} onChange={(e) => setFlow(e.target.value.toLowerCase().replace(/\s+/g, '-'))} list="flow-options" />
            <datalist id="flow-options">
              {existingFlows.map((f) => <option key={f} value={f} />)}
            </datalist>
          </Field>
        </div>
        <Field label="Catalog component" hint="The application this screen is for — enables “Implement in repo”.">
          <ComponentSelect apps={apps} value={component} onChange={setComponent} />
        </Field>
        <div className="inline-flex rounded-lg border border-edge-default p-0.5 text-xs">
          {(['template', 'ai'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setMode(k)} aria-pressed={mode === k}
              className={cn('rounded-md px-2.5 py-1 font-medium', mode === k ? 'bg-surface-sunken text-content' : 'text-content-muted hover:text-content')}>
              {k === 'template' ? 'From a template' : 'Describe with Adhar AI'}
            </button>
          ))}
        </div>
        {mode === 'ai' ? (
          <Field label="Describe the screen">
            <Textarea rows={4} value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder="A settings page with a profile form, a notifications section with three toggles, and a danger zone to delete the account." />
          </Field>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FRAME_TEMPLATES.map((t) => {
              const on = templateId === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  aria-pressed={on}
                  className={cn(
                    'rounded-lg border p-3 text-left',
                    on ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong',
                  )}
                >
                  <div className="text-sm font-semibold text-content">{t.label}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-content-muted">{t.description}</div>
                </button>
              )
            })}
          </div>
        )}
        <Field label="Notes (optional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What does this screen need to communicate?" />
        </Field>
      </div>
    </Modal>
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
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
