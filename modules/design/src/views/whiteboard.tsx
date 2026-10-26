import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Modal, useOptionalUser, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { KIND, type Listed, newId, useCollection, useCreate, useRemove, useUpdate } from '../data/store.ts'
import {
  type ArrowStyle,
  type BoardDoc,
  type BoardEl,
  type Box,
  boundsOf,
  type Camera,
  cloneElements,
  type ColorId,
  connectorEnds,
  connectorMid,
  connectorPath,
  elementBox,
  type Endpoint,
  fitCamera,
  frameChildren,
  type Handle,
  type History,
  intersects,
  isConnector,
  isShape,
  migrateBoard,
  normalizeBox,
  PALETTE,
  penFromPoints,
  penPath,
  type Pt,
  pushHistory,
  redo as redoHistory,
  removeElements,
  reorder,
  resizeBox,
  type Route,
  type ShapeEl,
  type ShapeKind,
  snap,
  STICKY_H,
  STICKY_W,
  toLegacy,
  translate,
  undo as undoHistory,
  wrapText,
  zoomAt,
  EMBED_W,
  embedHeight,
  entityFacts,
  gridAround,
  stickiesForWork,
} from '../data/whiteboard-model.ts'
import { BOARD_TEMPLATES, type BoardTemplate } from '../data/whiteboard-templates.ts'
import { designLink, useDesignParams, useNewFlag, useSetDesignParams } from '../data/deep-link.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import { copyText, downloadBlob, downloadText, pickTextFile, svgToPng } from '../components/export.ts'
import { useAutosave } from '../components/use-autosave.ts'
import { Icon, Menu, SaveDot, useConfirm } from '../components/ui-bits.tsx'
import { type DesignScope, useDesignScope, usePlatformCatalog, useWorkspaceMembers } from '../data/platform.ts'
import { refOf } from '../data/platform-model.ts'
import { scopeFilter, type Scoped } from '../data/scope.ts'
import { ideaLines } from '../data/ai.ts'
import type { Diagram } from '../data/types.ts'
import { renderToSvg } from '../components/mermaid-render.tsx'
import { ScopeChip, ScopeModal } from '../components/scope-bits.tsx'
import { EntityPickerModal } from '../components/catalog-bits.tsx'
import { CreateWorkItemsModal } from '../components/work-bits.tsx'
import { AskAiModal, SparkIcon } from '../components/ai-draft.tsx'

/**
 * Whiteboard — a freeform infinite canvas persisted in the document store
 * (kind `design.board`).
 *
 * Tools: select, hand, sticky, rectangle, ellipse, diamond, text, connector
 * (attaches to shapes and follows them), pen, frame. Select / multi-select /
 * marquee, move (frames carry their contents), resize, inline text editing,
 * pan & zoom (wheel, pinch, space-drag), undo / redo, copy / paste via the
 * system clipboard, z-order, lock, duplicate, keyboard shortcuts, templates,
 * export PNG / SVG / JSON and JSON import. Edits autosave.
 */

const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const GRID = 8
const CLIP_MARK = 'adhar-whiteboard:'

type Tool = 'select' | 'hand' | ShapeKind | 'connector' | 'pen'

const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: <path d="m4 4 7 17 2.5-7.5L21 11Z" /> },
  { id: 'hand', label: 'Hand (pan)', key: 'H', icon: <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0" /> },
  { id: 'sticky', label: 'Sticky note', key: 'N', icon: <path d="M15 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10ZM15 21v-6h6" /> },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <rect x="3" y="5" width="18" height="14" rx="2" /> },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: <ellipse cx="12" cy="12" rx="9" ry="7" /> },
  { id: 'diamond', label: 'Diamond', key: 'D', icon: <path d="M12 3 21 12 12 21 3 12Z" /> },
  { id: 'text', label: 'Text', key: 'T', icon: <path d="M4 7V4h16v3M9 20h6M12 4v16" /> },
  { id: 'connector', label: 'Connector', key: 'A', icon: <path d="M5 19 19 5M19 5h-7M19 5v7" /> },
  { id: 'pen', label: 'Pen', key: 'P', icon: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /> },
  { id: 'frame', label: 'Frame', key: 'F', icon: <path d="M3 8h18M3 16h18M8 3v18M16 3v18" /> },
]

const COLORS: ColorId[] = ['amber', 'rose', 'sky', 'violet', 'emerald', 'slate', 'ink']
const FONT_SIZES: { id: number; label: string }[] = [
  { id: 13, label: 'S' },
  { id: 15, label: 'M' },
  { id: 20, label: 'L' },
  { id: 28, label: 'XL' },
]

/* ───────── text measuring (canvas) ───────── */

let measureCtx: CanvasRenderingContext2D | null = null
function measurer(size: number, weight = 400): (s: string) => number {
  if (typeof document === 'undefined') return (s) => s.length * size * 0.55
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const ctx = measureCtx
  return (s: string) => {
    if (!ctx) return s.length * size * 0.55
    ctx.font = `${weight} ${size}px ${FONT}`
    return ctx.measureText(s).width
  }
}

function defaultFont(el: ShapeEl): number {
  if (el.fontSize) return el.fontSize
  if (el.kind === 'frame') return 14
  if (el.kind === 'text') return 18
  return 15
}

/* ───────── page ───────── */

export function Whiteboard() {
  const { items: boards, isLoading, error, refetch } = useCollection<BoardDoc>(KIND.board)
  const createBoard = useCreate<BoardDoc>(KIND.board)
  const removeBoard = useRemove(KIND.board)
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const toast = useToast()
  const user = useOptionalUser()
  const [newOpen, setNewOpen] = useState(false)
  // With no boards the template grid is already on screen.
  useNewFlag(() => boards.length && setNewOpen(true), !isLoading)
  const [ask, confirmDialog] = useConfirm()
  const scope = useDesignScope()

  const sorted = useMemo(
    () => scopeFilter(boards, scope.lens).shown.sort((a, b) => (b._updatedAt ?? b.updated_at ?? '').localeCompare(a._updatedAt ?? a.updated_at ?? '')),
    [boards, scope.lens],
  )
  // A deep link opens its board even when the team lens would hide it.
  const active = (params.board ? boards.find((b) => b.id === params.board) : undefined) ?? sorted[0]

  const create = (name: string, elements: BoardEl[]) => {
    const now = new Date().toISOString()
    const board: BoardDoc = {
      id: newId('board'),
      name: name || 'Untitled board',
      elements,
      ...toLegacy(elements),
      created_at: now,
      updated_at: now,
      ...scope.initial,
    }
    createBoard.mutate(board, {
      onSuccess: (created) => {
        toast.success('Board created', { description: created.name })
        setParams({ board: created.id }, { push: true })
      },
      onError: (e) => toast.error('Could not create board', { description: e.message }),
    })
  }

  const fromTemplate = (name: string, t: BoardTemplate) => create(name || t.name, t.build((p) => newId(p)))

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading boards…" />

  if (!active) {
    return (
      <div className="space-y-5">
        <EmptyState
          icon={<Icon name="board" size={22} />}
          title="Think on an infinite canvas"
          description="No boards yet. Sticky notes, shapes, connectors, frames and freehand ink — for retros, story maps and architecture sketches. Start blank or from a template:"
        />
        <TemplateGrid onPick={(t) => fromTemplate('', t)} />
      </div>
    )
  }

  return (
    <>
      <BoardCanvas
        key={active.id}
        board={active}
        boards={sorted}
        me={user?.name ?? ''}
        meId={user?.id}
        scope={scope}
        onSwitch={(id) => setParams({ board: id }, { push: true })}
        onNew={() => setNewOpen(true)}
        onDuplicate={(b, elements) => create(`${b.name} (copy)`, cloneElements(elements, new Set(elements.map((e) => e.id)), (p) => newId(p), 0, 0))}
        onImport={(name, elements) => create(name, elements)}
        onDelete={(b) =>
          ask({
            title: `Delete “${b.name}”?`,
            description: 'Everything on this board is removed for everyone.',
            onConfirm: () =>
              removeBoard.mutate(b.id, {
                onSuccess: () => {
                  toast.success('Board deleted')
                  setParams({ board: undefined })
                },
                onError: (e) => toast.error('Could not delete board', { description: e.message }),
              }),
          })}
      />
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New board"
        description="Start blank or from a facilitation template."
        branded
        width="xl"
      >
        <TemplateGrid
          onPick={(t) => {
            setNewOpen(false)
            fromTemplate('', t)
          }}
        />
      </Modal>
      {confirmDialog}
    </>
  )
}

function TemplateGrid({ onPick }: { onPick(t: BoardTemplate): void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {BOARD_TEMPLATES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="group rounded-xl border border-edge-default bg-surface-raised p-3 text-left transition hover:border-brand-300 hover:shadow-md"
        >
          <TemplateThumb t={t} />
          <div className="mt-2 text-[13px] font-semibold text-content">{t.name}</div>
          <div className="text-[11.5px] text-content-muted">{t.description}</div>
        </button>
      ))}
    </div>
  )
}

function TemplateThumb({ t }: { t: BoardTemplate }) {
  const els = useMemo(() => {
    let n = 0
    return t.build((p) => `${p}-${n++}`)
  }, [t])
  const byId = useMemo(() => new Map(els.map((e) => [e.id, e])), [els])
  const b = boundsOf(els.map((e) => elementBox(e, byId))) ?? { x: 0, y: 0, w: 400, h: 240 }
  const pad = 20
  return (
    <svg
      viewBox={`${b.x - pad} ${b.y - pad} ${Math.max(b.w, 200) + pad * 2} ${Math.max(b.h, 120) + pad * 2}`}
      className="h-24 w-full rounded-lg bg-surface-sunken/60 text-content"
      aria-hidden
    >
      {els.map((e) =>
        e.kind === 'connector'
          ? null
          : e.kind === 'pen'
          ? null
          : (
            <rect
              key={e.id}
              x={e.x}
              y={e.y}
              width={e.w}
              height={e.h}
              rx={e.kind === 'ellipse' ? e.h / 2 : 8}
              fill={PALETTE[e.color].fill === 'none' ? 'transparent' : PALETTE[e.color].fill}
              fillOpacity={e.kind === 'frame' ? 0.5 : 1}
              stroke={PALETTE[e.color].stroke}
              strokeWidth={4}
            />
          )
      )}
      {/* Blank: a centred "+" on a dashed sheet, not a stray caption in the corner. */}
      {els.length === 0
        ? (
          <g stroke="currentColor" fill="none" opacity={0.35} strokeLinecap="round">
            <rect x={b.x + 40} y={b.y + 30} width={b.w - 80} height={b.h - 60} rx={16} strokeWidth={4} strokeDasharray="14 12" />
            <path d={`M${b.x + b.w / 2 - 28} ${b.y + b.h / 2}h56M${b.x + b.w / 2} ${b.y + b.h / 2 - 28}v56`} strokeWidth={8} />
          </g>
        )
        : null}
    </svg>
  )
}

/* ───────── canvas ───────── */

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cam: Camera }
  | { mode: 'marquee'; start: Pt; base: Set<string> }
  | { mode: 'move'; start: Pt; ids: Set<string>; origin: BoardEl[]; moved: boolean }
  | { mode: 'resize'; start: Pt; id: string; handle: Handle; box: Box; origin: BoardEl[] }
  | { mode: 'create'; start: Pt; kind: ShapeKind }
  | { mode: 'connect'; from: Endpoint; start: Pt }
  | { mode: 'endpoint'; id: string; end: 'from' | 'to'; origin: BoardEl[] }
  | { mode: 'pen'; points: Pt[] }

function BoardCanvas({
  board,
  boards,
  me,
  meId,
  scope,
  onSwitch,
  onNew,
  onDuplicate,
  onImport,
  onDelete,
}: {
  board: Listed<BoardDoc>
  boards: Listed<BoardDoc>[]
  me: string
  meId?: string
  scope: DesignScope
  onSwitch(id: string): void
  onNew(): void
  onDuplicate(b: BoardDoc, elements: BoardEl[]): void
  onImport(name: string, elements: BoardEl[]): void
  onDelete(b: BoardDoc): void
}) {
  const update = useUpdate<BoardDoc>(KIND.board)
  const toast = useToast()
  const [elements, setElements] = useState<BoardEl[]>(() => migrateBoard(board))
  const [name, setName] = useState(board.name)
  const [history, setHistory] = useState<History>({ past: [], future: [] })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tool, setTool] = useState<Tool>('select')
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 1 })
  const [editing, setEditing] = useState<string | null>(null)
  const [color, setColor] = useState<ColorId>('amber')
  const [snapOn, setSnapOn] = useState(true)
  const [helpOpen, setHelpOpen] = useState(false)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [preview, setPreview] = useState<{ kind: ShapeKind; box: Box } | null>(null)
  const [connectPreview, setConnectPreview] = useState<{ a: Pt; b: Pt; target?: string } | null>(null)
  const [penPoints, setPenPoints] = useState<Pt[] | null>(null)
  const [scopeV, setScopeV] = useState<Scoped>({ project: board.project, team: board.team })
  const [scopeOpen, setScopeOpen] = useState(false)
  const [entityOpen, setEntityOpen] = useState(false)
  const [diagramOpen, setDiagramOpen] = useState(false)
  const [workOpen, setWorkOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const hasEntityEmbeds = (board.elements ?? []).some((e) => isShape(e) && e.embed?.type === 'entity')
  const catalog = usePlatformCatalog(entityOpen || refreshing || hasEntityEmbeds)
  const { items: diagramDocs } = useCollection<Diagram>(KIND.diagram)
  const members = useWorkspaceMembers()
  // Last save this tab made — tells our own autosaves from someone else's edits.
  const ownSave = useRef<string | undefined>(board._updatedAt)
  const loadedAt = useRef(board._updatedAt)

  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const contentRef = useRef<SVGGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const spaceRef = useRef(false)
  const elsRef = useRef(elements)
  elsRef.current = elements
  const camRef = useRef(cam)
  camRef.current = cam
  const selRef = useRef(selected)
  selRef.current = selected

  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements])

  /* persistence */
  const latestBoard = useRef(board)
  latestBoard.current = board
  const save = useCallback(
    (v: { name: string; elements: BoardEl[]; scope: Scoped }) =>
      update.mutateAsync({
        ...latestBoard.current,
        name: v.name.trim() || 'Untitled board',
        elements: v.elements,
        ...toLegacy(v.elements),
        project: v.scope.project,
        team: v.scope.team,
        updated_at: new Date().toISOString(),
        updated_by: me || undefined,
        updated_by_id: meId,
      } as BoardDoc).then((saved) => {
        ownSave.current = (saved as Listed<BoardDoc>)._updatedAt
        return saved
      }),
    [update, me, meId],
  )
  const autosave = useAutosave({ name, elements, scope: scopeV }, save, {
    key: board.id,
    delay: 800,
    onError: (e) => toast.error('Autosave failed', { description: e.message }),
  })

  /* history-aware edits */
  const commit = useCallback((next: BoardEl[] | ((prev: BoardEl[]) => BoardEl[])) => {
    const prev = elsRef.current
    const value = typeof next === 'function' ? next(prev) : next
    if (value === prev) return
    setHistory((h) => pushHistory(h, prev))
    setElements(value)
  }, [])

  const doUndo = useCallback(() => {
    setHistory((h) => {
      const r = undoHistory(h, elsRef.current)
      if (!r) return h
      setElements(r.elements)
      setSelected((s) => new Set([...s].filter((id) => r.elements.some((e) => e.id === id))))
      return r.history
    })
  }, [])
  const doRedo = useCallback(() => {
    setHistory((h) => {
      const r = redoHistory(h, elsRef.current)
      if (!r) return h
      setElements(r.elements)
      return r.history
    })
  }, [])

  /* camera */
  const viewport = () => {
    const r = hostRef.current?.getBoundingClientRect()
    return { w: r?.width ?? 1000, h: r?.height ?? 600, left: r?.left ?? 0, top: r?.top ?? 0 }
  }
  const fit = useCallback((only?: BoardEl[]) => {
    const v = viewport()
    const list = only ?? elsRef.current
    const map = new Map(elsRef.current.map((e) => [e.id, e]))
    setCam(fitCamera(boundsOf(list.map((e) => elementBox(e, map))), v.w, v.h, 60, 1.25))
  }, [])
  useLayoutEffect(() => {
    fit()
    hostRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toWorld = useCallback((clientX: number, clientY: number): Pt => {
    const v = viewport()
    const c = camRef.current
    return { x: (clientX - v.left - c.x) / c.k, y: (clientY - v.top - c.y) / c.k }
  }, [])
  const snapPt = (p: Pt): Pt => (snapOn ? { x: snap(p.x, GRID), y: snap(p.y, GRID) } : p)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewport()
      if (e.ctrlKey || e.metaKey) {
        setCam((c) => zoomAt(c, Math.exp(-e.deltaY * 0.01), e.clientX - v.left, e.clientY - v.top))
      } else {
        setCam((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }))
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = (f: number) => {
    const v = viewport()
    setCam((c) => zoomAt(c, f, v.w / 2, v.h / 2))
  }

  /* element creation */
  const addShape = (kind: ShapeKind, box: Box, edit = true) => {
    const el: ShapeEl = {
      id: newId('el'),
      kind,
      ...box,
      text: kind === 'frame' ? 'Frame' : '',
      color: kind === 'text' ? 'ink' : kind === 'frame' ? 'slate' : color,
      filled: kind === 'rect' || kind === 'ellipse' || kind === 'diamond' ? true : undefined,
      author: kind === 'sticky' ? me || undefined : undefined,
    }
    commit((prev) => (kind === 'frame' ? [el, ...prev] : [...prev, el]))
    setSelected(new Set([el.id]))
    setTool('select')
    if (edit && kind !== 'frame') setEditing(el.id)
    return el
  }

  const defaultBox = (kind: ShapeKind, at: Pt): Box => {
    const size: Record<ShapeKind, [number, number]> = {
      sticky: [STICKY_W, STICKY_H],
      rect: [160, 90],
      ellipse: [150, 100],
      diamond: [150, 110],
      text: [240, 30],
      frame: [480, 320],
    }
    const [w, h] = size[kind]
    return kind === 'text' ? { x: at.x, y: at.y - 14, w, h } : { x: at.x - w / 2, y: at.y - h / 2, w, h }
  }

  /* pointer handling */
  const targetAt = (clientX: number, clientY: number, exclude?: string): string | undefined => {
    const hit = (document.elementFromPoint(clientX, clientY) as Element | null)?.closest('[data-el-id]')
    const id = hit?.getAttribute('data-el-id') ?? undefined
    if (!id || id === exclude) return undefined
    const el = elsRef.current.find((e) => e.id === id)
    return el && el.kind !== 'connector' ? id : undefined
  }

  const startDrag = (d: Drag, pointerId: number) => {
    dragRef.current = d
    svgRef.current?.setPointerCapture(pointerId)
  }

  const onBackgroundDown = (e: React.PointerEvent) => {
    hostRef.current?.focus({ preventScroll: true })
    if (editing) {
      setEditing(null)
      return
    }
    const p = toWorld(e.clientX, e.clientY)
    if (e.button === 1 || tool === 'hand' || spaceRef.current) {
      startDrag({ mode: 'pan', sx: e.clientX, sy: e.clientY, cam: camRef.current }, e.pointerId)
      return
    }
    if (e.button !== 0) return
    switch (tool) {
      case 'select':
        if (!e.shiftKey) setSelected(new Set())
        startDrag({ mode: 'marquee', start: p, base: e.shiftKey ? new Set(selRef.current) : new Set() }, e.pointerId)
        return
      case 'connector':
        startDrag({ mode: 'connect', from: { ...snapPt(p) }, start: p }, e.pointerId)
        return
      case 'pen':
        startDrag({ mode: 'pen', points: [p] }, e.pointerId)
        setPenPoints([p])
        return
      case 'text':
        addShape('text', defaultBox('text', snapPt(p)))
        return
      default:
        startDrag({ mode: 'create', start: snapPt(p), kind: tool as ShapeKind }, e.pointerId)
    }
  }

  const onElementDown = (e: React.PointerEvent, el: BoardEl) => {
    if (e.button === 1 || tool === 'hand' || spaceRef.current) return // bubbles to pan
    if (tool === 'connector' && el.kind !== 'connector') {
      e.stopPropagation()
      hostRef.current?.focus({ preventScroll: true })
      startDrag({ mode: 'connect', from: { id: el.id, x: 0, y: 0 }, start: toWorld(e.clientX, e.clientY) }, e.pointerId)
      return
    }
    if (tool !== 'select') return
    e.stopPropagation()
    hostRef.current?.focus({ preventScroll: true })
    if (editing && editing !== el.id) setEditing(null)
    let sel = selRef.current
    if (e.shiftKey) {
      sel = new Set(sel)
      if (sel.has(el.id)) sel.delete(el.id)
      else sel.add(el.id)
    } else if (!sel.has(el.id)) sel = new Set([el.id])
    setSelected(sel)
    if (!sel.has(el.id)) return
    const ids = new Set(sel)
    for (const id of frameChildren(elsRef.current, sel)) ids.add(id)
    startDrag({ mode: 'move', start: toWorld(e.clientX, e.clientY), ids, origin: elsRef.current, moved: false }, e.pointerId)
  }

  const downRef = useRef(onElementDown)
  downRef.current = onElementDown
  const stableDown = useCallback((e: React.PointerEvent, el: BoardEl) => downRef.current(e, el), [])

  const onHandleDown = (e: React.PointerEvent, el: BoardEl, handle: Handle) => {
    e.stopPropagation()
    if (el.kind === 'connector') return
    startDrag({ mode: 'resize', start: toWorld(e.clientX, e.clientY), id: el.id, handle, box: { x: el.x, y: el.y, w: el.w, h: el.h }, origin: elsRef.current }, e.pointerId)
  }

  const onEndpointDown = (e: React.PointerEvent, id: string, end: 'from' | 'to') => {
    e.stopPropagation()
    startDrag({ mode: 'endpoint', id, end, origin: elsRef.current }, e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const p = toWorld(e.clientX, e.clientY)
    switch (d.mode) {
      case 'pan':
        setCam({ ...d.cam, x: d.cam.x + e.clientX - d.sx, y: d.cam.y + e.clientY - d.sy })
        return
      case 'marquee': {
        const box = normalizeBox(d.start, p)
        setMarquee(box)
        const map = new Map(elsRef.current.map((x) => [x.id, x]))
        const hits = elsRef.current.filter((x) => intersects(box, elementBox(x, map)) && !(x.kind === 'frame' && !containsBox(box, x)))
        setSelected(new Set([...d.base, ...hits.map((x) => x.id)]))
        return
      }
      case 'move': {
        let dx = p.x - d.start.x
        let dy = p.y - d.start.y
        if (!d.moved && Math.hypot(dx * camRef.current.k, dy * camRef.current.k) < 3) return
        d.moved = true
        if (snapOn) {
          dx = snap(dx, GRID)
          dy = snap(dy, GRID)
        }
        setElements(translate(d.origin, d.ids, dx, dy))
        return
      }
      case 'resize': {
        const dx = p.x - d.start.x
        const dy = p.y - d.start.y
        const el = d.origin.find((x) => x.id === d.id)
        const box = resizeBox(d.box, d.handle, dx, dy, e.shiftKey || el?.kind === 'pen', 12)
        const b = snapOn ? { x: snap(box.x, GRID), y: snap(box.y, GRID), w: snap(box.w, GRID) || GRID, h: snap(box.h, GRID) || GRID } : box
        setElements(d.origin.map((x) => (x.id === d.id && x.kind !== 'connector' ? { ...x, ...b } : x)))
        return
      }
      case 'create':
        setPreview({ kind: d.kind, box: normalizeBox(d.start, snapPt(p)) })
        return
      case 'connect': {
        const target = targetAt(e.clientX, e.clientY, d.from.id)
        const map = new Map(elsRef.current.map((x) => [x.id, x]))
        const tmp = { id: 'tmp', kind: 'connector' as const, from: d.from, to: target ? { id: target, x: 0, y: 0 } : { x: p.x, y: p.y }, color: color, route: 'straight' as Route, arrow: 'end' as ArrowStyle }
        const [a, b] = connectorEnds(tmp, map)
        setConnectPreview({ a, b, target })
        return
      }
      case 'endpoint': {
        const target = targetAt(e.clientX, e.clientY)
        setElements(d.origin.map((x) =>
          x.id === d.id && x.kind === 'connector'
            ? { ...x, [d.end]: target && target !== (d.end === 'from' ? x.to.id : x.from.id) ? { id: target, x: 0, y: 0 } : { x: p.x, y: p.y } }
            : x
        ))
        setConnectPreview(target ? { a: p, b: p, target } : null)
        return
      }
      case 'pen':
        d.points.push(p)
        setPenPoints([...d.points])
        return
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId)
    if (!d) return
    const p = toWorld(e.clientX, e.clientY)
    switch (d.mode) {
      case 'marquee':
        setMarquee(null)
        return
      case 'move':
      case 'resize':
      case 'endpoint':
        setConnectPreview(null)
        if (elsRef.current !== d.origin) setHistory((h) => pushHistory(h, d.origin))
        return
      case 'create': {
        setPreview(null)
        const box = normalizeBox(d.start, snapPt(p))
        const tiny = box.w * camRef.current.k < 8 && box.h * camRef.current.k < 8
        addShape(d.kind, tiny ? defaultBox(d.kind, d.start) : { ...box, w: Math.max(box.w, 24), h: Math.max(box.h, 24) })
        return
      }
      case 'connect': {
        setConnectPreview(null)
        const target = targetAt(e.clientX, e.clientY, d.from.id)
        const moved = Math.hypot(p.x - d.start.x, p.y - d.start.y) * camRef.current.k > 6
        if (!target && !moved) return
        const conn: BoardEl = {
          id: newId('conn'),
          kind: 'connector',
          from: d.from,
          to: target ? { id: target, x: 0, y: 0 } : { ...snapPt(p) },
          color: 'ink',
          route: 'curve',
          arrow: 'end',
        }
        commit((prev) => [...prev, conn])
        setSelected(new Set([conn.id]))
        setTool('select')
        return
      }
      case 'pen': {
        setPenPoints(null)
        const pen = penFromPoints(newId('el'), d.points, color, 2.5)
        if (pen) commit((prev) => [...prev, pen])
        return
      }
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = (e.target as Element).closest('[data-el-id]')?.getAttribute('data-el-id')
    if (id) {
      const el = elsRef.current.find((x) => x.id === id)
      if (el && isShape(el) && el.embed) {
        setSelected(new Set([id]))
        return
      }
      if (el && el.kind !== 'pen' && !el.locked) {
        setSelected(new Set([id]))
        setEditing(id)
      }
      return
    }
    if (tool === 'select') addShape('sticky', defaultBox('sticky', snapPt(toWorld(e.clientX, e.clientY))))
  }

  /* selection operations */
  const selectedEls = elements.filter((e) => selected.has(e.id))
  const patchSelected = (patch: Partial<ShapeEl> & Partial<{ route: Route; arrow: ArrowStyle; dashed: boolean; width: number }>) =>
    commit((prev) =>
      prev.map((e) => {
        if (!selected.has(e.id)) return e
        if (e.kind === 'connector') {
          const { route, arrow, dashed, color, locked } = patch
          return { ...e, ...(route ? { route } : {}), ...(arrow ? { arrow } : {}), ...(dashed !== undefined ? { dashed } : {}), ...(color ? { color } : {}), ...(locked !== undefined ? { locked } : {}) }
        }
        if (e.kind === 'pen') {
          const { color, locked, width } = patch
          return { ...e, ...(color ? { color } : {}), ...(locked !== undefined ? { locked } : {}), ...(width ? { width } : {}) }
        }
        const { route: _r, arrow: _a, dashed: _d, width: _w, ...shapePatch } = patch
        return { ...e, ...shapePatch }
      })
    )
  const deleteSelected = () => {
    if (!selected.size) return
    const ids = new Set([...selected].filter((id) => !byId.get(id)?.locked))
    commit((prev) => removeElements(prev, ids))
    setSelected(new Set())
  }
  const duplicateSelected = () => {
    if (!selected.size) return
    const copies = cloneElements(elements, selected, (p) => newId(p))
    commit((prev) => [...prev, ...copies])
    setSelected(new Set(copies.map((c) => c.id)))
  }

  /* clipboard */
  const onCopy = (e: React.ClipboardEvent, cut = false) => {
    if (isTyping(e.target) || !selected.size) return
    e.preventDefault()
    const ids = new Set(selected)
    // Include attached connectors whose both ends are copied.
    for (const c of elements.filter(isConnector)) {
      if (c.from.id && c.to.id && ids.has(c.from.id) && ids.has(c.to.id)) ids.add(c.id)
    }
    e.clipboardData.setData('text/plain', CLIP_MARK + JSON.stringify(elements.filter((x) => ids.has(x.id))))
    if (cut) deleteSelected()
  }
  const onPaste = (e: React.ClipboardEvent) => {
    if (isTyping(e.target)) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    if (text.startsWith(CLIP_MARK)) {
      try {
        const els = JSON.parse(text.slice(CLIP_MARK.length)) as BoardEl[]
        const copies = cloneElements(els, new Set(els.map((x) => x.id)), (p) => newId(p))
        commit((prev) => [...prev, ...copies])
        setSelected(new Set(copies.map((c) => c.id)))
      } catch {
        toast.error('Could not paste', { description: 'The clipboard content is not a whiteboard selection.' })
      }
      return
    }
    const v = viewport()
    const at = toWorld(v.left + v.w / 2, v.top + v.h / 2)
    const el: ShapeEl = { id: newId('el'), kind: 'sticky', ...defaultBox('sticky', at), text: text.slice(0, 2000), color, author: me || undefined }
    commit((prev) => [...prev, el])
    setSelected(new Set([el.id]))
  }

  /* keyboard */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTyping(e.target)) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key
    if (k === ' ') {
      spaceRef.current = true
      e.preventDefault()
      return
    }
    if (mod && k.toLowerCase() === 'z') {
      e.preventDefault()
      e.shiftKey ? doRedo() : doUndo()
      return
    }
    if (mod && k.toLowerCase() === 'y') {
      e.preventDefault()
      doRedo()
      return
    }
    if (mod && k.toLowerCase() === 'd') {
      e.preventDefault()
      duplicateSelected()
      return
    }
    if (mod && k.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(elements.map((x) => x.id)))
      return
    }
    if (mod && (k === '=' || k === '+')) {
      e.preventDefault()
      zoomBy(1.2)
      return
    }
    if (mod && k === '-') {
      e.preventDefault()
      zoomBy(1 / 1.2)
      return
    }
    if (mod && k === '0') {
      e.preventDefault()
      const v = viewport()
      setCam((c) => zoomAt(c, 1 / c.k, v.w / 2, v.h / 2))
      return
    }
    if (mod) return
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault()
      deleteSelected()
      return
    }
    if (k === 'Escape') {
      setSelected(new Set())
      setTool('select')
      setHelpOpen(false)
      return
    }
    if (k === 'Enter' && selected.size === 1) {
      const el = selectedEls[0]
      if (el && el.kind !== 'pen') {
        e.preventDefault()
        setEditing(el.id)
      }
      return
    }
    if (k.startsWith('Arrow') && selected.size) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0
      const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0
      commit((prev) => translate(prev, selected, dx, dy))
      return
    }
    if (k === '!' || (e.shiftKey && k === '1')) {
      fit()
      return
    }
    if (k === '@' || (e.shiftKey && k === '2')) {
      if (selectedEls.length) fit(selectedEls)
      return
    }
    if (k === ']') {
      commit((prev) => reorder(prev, selected, 'front'))
      return
    }
    if (k === '[') {
      commit((prev) => reorder(prev, selected, 'back'))
      return
    }
    if (k === '?') {
      setHelpOpen((o) => !o)
      return
    }
    if (k.toLowerCase() === 'g') {
      setSnapOn((s) => !s)
      return
    }
    const t = TOOLS.find((x) => x.key.toLowerCase() === k.toLowerCase())
    if (t) setTool(t.id)
  }
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') spaceRef.current = false
  }

  /* text editing commit */
  const commitText = (id: string, text: string) => {
    setEditing(null)
    const el = elsRef.current.find((x) => x.id === id)
    if (!el) return
    if (el.kind === 'connector') {
      if ((el.label ?? '') !== text) commit((prev) => prev.map((x) => (x.id === id ? { ...x, label: text.trim() || undefined } : x)))
      return
    }
    if (el.kind === 'pen') return
    if (el.kind === 'text' && !text.trim()) {
      commit((prev) => removeElements(prev, new Set([id])))
      setSelected(new Set())
      return
    }
    if (el.text === text && el.kind !== 'text') return
    commit((prev) =>
      prev.map((x) => {
        if (x.id !== id || x.kind === 'connector' || x.kind === 'pen') return x
        if (x.kind === 'text') {
          const size = defaultFont(x)
          const lines = wrapText(text, x.w - 4, measurer(size))
          return { ...x, text, h: Math.max(size * 1.35, lines.length * size * 1.35 + 6) }
        }
        return { ...x, text }
      })
    )
  }

  /* platform: embeds, work items, AI */
  const centre = () => {
    const v = viewport()
    return toWorld(v.left + v.w / 2, v.top + v.h / 2)
  }
  const embedEntities = (refs: string[]) => {
    const at = new Date().toISOString()
    const picked = catalog.entities.filter((e) => refs.includes(refOf(e)))
    if (!picked.length) return
    const c = centre()
    const pos = gridAround(c, picked.length, EMBED_W, 200, 24)
    const els: ShapeEl[] = picked.map((e, i) => {
      const f = entityFacts(e)
      return {
        id: newId('el'),
        kind: 'rect',
        x: pos[i].x,
        y: pos[i].y,
        w: EMBED_W,
        h: embedHeight(f.lines.length),
        text: '',
        color: 'slate',
        embed: { type: 'entity', ref: refOf(e), title: f.title, subtitle: f.subtitle, lines: f.lines, at },
      }
    })
    commit((prev) => [...prev, ...els])
    setSelected(new Set(els.map((e) => e.id)))
    toast.success(`Embedded ${els.length} catalog entit${els.length === 1 ? 'y' : 'ies'}`, { description: 'Read-only snapshots — refresh them from the board menu.' })
  }
  const svgDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const embedDiagram = async (d: Diagram) => {
    try {
      const svg = await renderToSvg(d.source)
      const c = centre()
      const el: ShapeEl = {
        id: newId('el'),
        kind: 'rect',
        x: c.x - 200,
        y: c.y - 150,
        w: 400,
        h: 300,
        text: '',
        color: 'slate',
        embed: { type: 'diagram', ref: d.id, title: d.title, subtitle: 'Diagram', image: svgDataUri(svg), at: new Date().toISOString() },
      }
      commit((prev) => [...prev, el])
      setSelected(new Set([el.id]))
    } catch (err) {
      toast.error('Could not render the diagram', { description: (err as Error).message })
    }
  }
  const refreshEmbeds = () => {
    const targets = elsRef.current.filter((e): e is ShapeEl => isShape(e) && !!e.embed && (!selected.size || selected.has(e.id)))
    if (!targets.length) return toast.info('No embeds to refresh')
    setRefreshing(true)
  }
  // Runs once the catalog is enabled and loaded for a refresh.
  useEffect(() => {
    if (!refreshing || catalog.isLoading) return
    let alive = true
    ;(async () => {
      const at = new Date().toISOString()
      const sel = selRef.current
      const updates = new Map<string, ShapeEl['embed']>()
      for (const e of elsRef.current) {
        if (!isShape(e) || !e.embed || (sel.size && !sel.has(e.id))) continue
        if (e.embed.type === 'entity') {
          const ent = catalog.entities.find((x) => refOf(x) === e.embed!.ref)
          if (!ent) updates.set(e.id, { ...e.embed, missing: true, at })
          else {
            const f = entityFacts(ent)
            updates.set(e.id, { ...e.embed, title: f.title, subtitle: f.subtitle, lines: f.lines, missing: false, at })
          }
        } else {
          const d = diagramDocs.find((x) => x.id === e.embed!.ref)
          if (!d) updates.set(e.id, { ...e.embed, missing: true, at })
          else {
            try {
              updates.set(e.id, { ...e.embed, title: d.title, image: svgDataUri(await renderToSvg(d.source)), missing: false, at })
            } catch {
              updates.set(e.id, { ...e.embed, at })
            }
          }
        }
      }
      if (!alive) return
      setRefreshing(false)
      commit((prev) =>
        prev.map((x) => {
          const emb = updates.get(x.id)
          if (!emb || !isShape(x)) return x
          return { ...x, embed: emb, h: emb.type === 'entity' ? Math.max(x.h, embedHeight(emb.lines?.length ?? 0)) : x.h }
        })
      )
      const missing = [...updates.values()].filter((u) => u?.missing).length
      toast.success(`Refreshed ${updates.size} snapshot${updates.size === 1 ? '' : 's'}`, { description: missing ? `${missing} source${missing === 1 ? ' is' : 's are'} gone — marked missing.` : undefined })
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshing, catalog.isLoading])

  const workStickies = stickiesForWork(elements, selected)
  const addIdeas = (ideas: string[]) => {
    if (!ideas.length) return toast.info('No ideas in the reply')
    const pos = gridAround(centre(), ideas.length)
    const els: ShapeEl[] = ideas.map((t, i) => ({ id: newId('el'), kind: 'sticky', x: pos[i].x, y: pos[i].y, w: STICKY_W, h: STICKY_H, text: t, color, author: 'Adhar AI' }))
    commit((prev) => [...prev, ...els])
    setSelected(new Set(els.map((e) => e.id)))
    toast.success(`Added ${els.length} sticky notes`)
  }
  const lastEditor = board.updated_by ?? (board._updatedBy ? members.data?.find((m) => m.userId === board._updatedBy)?.name : undefined)
  const changedElsewhere = !!board._updatedAt && board._updatedAt !== ownSave.current && board._updatedAt !== loadedAt.current &&
    (!board.updated_by_id || board.updated_by_id !== meId)

  /* export */
  const exportSvg = (): string | null => {
    const g = contentRef.current
    if (!g || !elements.length) return null
    const b = boundsOf(elements.map((e) => elementBox(e, byId)))!
    const pad = 40
    const x = b.x - pad
    const y = b.y - pad
    const w = b.w + pad * 2
    const h = b.h + pad * 2
    const defs = svgRef.current?.querySelector('defs')?.outerHTML ?? ''
    const clone = g.cloneNode(true) as SVGGElement
    clone.querySelectorAll('[data-export-ignore]').forEach((n) => n.remove())
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}" style="color:#0f172a" font-family='${FONT}'><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>${defs}${clone.outerHTML}</svg>`
  }
  const fileBase = name.trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'whiteboard'
  const doExportPng = async () => {
    const svg = exportSvg()
    if (!svg) return toast.info('Nothing to export', { description: 'The board is empty.' })
    try {
      downloadBlob(await svgToPng(svg, { scale: 2 }), `${fileBase}.png`)
    } catch (err) {
      toast.error('PNG export failed', { description: (err as Error).message })
    }
  }

  const editingEl = editing ? byId.get(editing) : undefined
  const single = selectedEls.length === 1 ? selectedEls[0] : undefined
  const k = cam.k

  return (
    <div className="space-y-2">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Menu
          label={<span className="max-w-48 truncate">{boards.length} board{boards.length === 1 ? '' : 's'}</span>}
          align="left"
          items={[
            ...boards.map((b) => ({
              label: `${b.id === board.id ? '● ' : ''}${b.name}`,
              hint: formatRelative(b._updatedAt ?? b.updated_at),
              onSelect: () => onSwitch(b.id),
            })),
            'separator' as const,
            { label: 'New board…', onSelect: onNew },
          ]}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Board name"
          className="min-w-40 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold tracking-tight text-content hover:border-edge-default focus:border-edge-default focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        <SaveDot state={autosave.state} />
        <ScopeChip item={scopeV} scope={scope} />
        <span className="text-[11px] text-content-subtle" title={board._updatedAt}>
          Edited {formatRelative(board._updatedAt ?? board.updated_at)}{lastEditor ? ` by ${lastEditor}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center">
            <IconBtn label="Undo (⌘Z)" onClick={doUndo} disabled={!history.past.length}><Icon name="undo" /></IconBtn>
            <IconBtn label="Redo (⇧⌘Z)" onClick={doRedo} disabled={!history.future.length}><Icon name="redo" /></IconBtn>
          </div>
          <Menu
            label="Export"
            icon={<Icon name="download" />}
            items={[
              { label: 'PNG image (2×)', onSelect: doExportPng },
              {
                label: 'SVG image',
                onSelect: () => {
                  const svg = exportSvg()
                  svg ? downloadText(svg, `${fileBase}.svg`, 'image/svg+xml') : toast.info('Nothing to export')
                },
              },
              { label: 'Board JSON', onSelect: () => downloadText(JSON.stringify({ name, elements }, null, 2), `${fileBase}.board.json`, 'application/json') },
              'separator',
              {
                label: 'Copy link',
                onSelect: async () => ((await copyText(designLink({ board: board.id }))) ? toast.success('Link copied') : toast.error('Clipboard unavailable')),
              },
            ]}
          />
          <Menu
            ariaLabel="Board actions"
            icon={<Icon name="more" />}
            items={[
              { label: 'Project & owner…', onSelect: () => setScopeOpen(true) },
              { label: 'Embed catalog entity…', onSelect: () => setEntityOpen(true) },
              { label: 'Embed diagram…', onSelect: () => setDiagramOpen(true) },
              { label: selected.size ? 'Refresh selected snapshots' : 'Refresh all snapshots', onSelect: refreshEmbeds },
              {
                label: `Create Plane work items from ${workStickies.length || 'selected'} stick${workStickies.length === 1 ? 'y' : 'ies'}…`,
                onSelect: () => setWorkOpen(true),
                disabled: !workStickies.length,
              },
              'separator',
              { label: 'Duplicate board', onSelect: () => onDuplicate({ ...board, name }, elements) },
              {
                label: 'Import board JSON…',
                onSelect: async () => {
                  const f = await pickTextFile('.json,application/json')
                  if (!f) return
                  try {
                    const parsed = JSON.parse(f.text) as { name?: string; elements?: BoardEl[] }
                    if (!Array.isArray(parsed.elements)) throw new Error('No "elements" array found.')
                    onImport(parsed.name ?? f.name.replace(/\.board\.json$|\.json$/, ''), parsed.elements)
                  } catch (err) {
                    toast.error('Import failed', { description: (err as Error).message })
                  }
                },
              },
              {
                label: snapOn ? 'Disable snap to grid' : 'Enable snap to grid',
                hint: 'G',
                onSelect: () => setSnapOn((s) => !s),
              },
              'separator',
              { label: 'Clear board', onSelect: () => elements.length && commit([]), disabled: !elements.length },
              { label: 'Delete board', onSelect: () => onDelete(board), danger: true },
            ]}
          />
          <Button size="sm" leading={<SparkIcon />} onClick={() => setAiOpen(true)}>Ask Adhar AI</Button>
          <Button size="sm" variant="primary" leading={<Icon name="plus" />} onClick={onNew}>New board</Button>
        </div>
      </div>
      {changedElsewhere
        ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {lastEditor ?? 'Someone else'} saved this board {formatRelative(board._updatedAt ?? board.updated_at)} while you had it open. Your next edit overwrites theirs.
            <button type="button" onClick={() => location.reload()} className="font-semibold underline-offset-2 hover:underline">Reload their version</button>
          </div>
        )
        : null}

      {/* canvas */}
      <div
        ref={hostRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        onBlur={() => (spaceRef.current = false)}
        onScroll={(e) => {
          // Focusing the inline editor must never scroll the clipped canvas.
          e.currentTarget.scrollTop = 0
          e.currentTarget.scrollLeft = 0
        }}
        aria-label="Whiteboard canvas"
        className="relative h-[calc(100dvh-12.5rem)] min-h-[520px] overflow-hidden rounded-xl border border-edge-default bg-surface-raised text-content outline-none focus-visible:ring-2 focus-visible:ring-brand-400/30"
      >
        <svg
          ref={svgRef}
          className={`absolute inset-0 h-full w-full touch-none select-none ${
            tool === 'hand' ? 'cursor-grab' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair'
          }`}
          onPointerDown={onBackgroundDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        >
          <defs>
            <pattern id="wb-dots" width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${cam.x} ${cam.y}) scale(${k})`}>
              <circle cx={1} cy={1} r={1 / Math.max(k, 0.5)} fill="currentColor" opacity={0.18} />
            </pattern>
            {COLORS.map((c) => (
              <marker key={c} id={`wb-arrow-${c}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                <path d="M0,0 L10,5 L0,10 Z" fill={PALETTE[c].stroke} />
              </marker>
            ))}
          </defs>
          <rect width="100%" height="100%" fill="url(#wb-dots)" />
          <g transform={`translate(${cam.x} ${cam.y}) scale(${k})`}>
            <g ref={contentRef}>
              {elements.filter((e) => e.kind === 'frame').map((e) => (
                <ElementView key={e.id} el={e} byId={byId} editing={editing === e.id} onDown={stableDown} />
              ))}
              {elements.filter((e) => e.kind !== 'frame' && e.kind !== 'connector').map((e) => (
                <ElementView key={e.id} el={e} byId={byId} editing={editing === e.id} onDown={stableDown} />
              ))}
              {elements.filter(isConnector).map((e) => (
                <ElementView key={e.id} el={e} byId={byId} editing={editing === e.id} onDown={stableDown} />
              ))}
            </g>

            {/* overlays */}
            {connectPreview?.target
              ? (() => {
                const t = byId.get(connectPreview.target)
                return t && t.kind !== 'connector'
                  ? <rect x={t.x - 6} y={t.y - 6} width={t.w + 12} height={t.h + 12} rx={10} fill="none" stroke="var(--color-brand-500, #6366f1)" strokeWidth={2 / k} strokeDasharray={`${6 / k} ${4 / k}`} pointerEvents="none" />
                  : null
              })()
              : null}
            {connectPreview && dragRef.current?.mode === 'connect'
              ? <path d={connectorPath(connectPreview.a, connectPreview.b, 'straight')} stroke="var(--color-brand-500, #6366f1)" strokeWidth={2 / k} fill="none" markerEnd="url(#wb-arrow-violet)" pointerEvents="none" />
              : null}
            {selectedEls.map((e) => {
              if (e.kind === 'connector') return null
              return <rect key={`sel-${e.id}`} x={e.x - 3 / k} y={e.y - 3 / k} width={e.w + 6 / k} height={e.h + 6 / k} fill="none" stroke="var(--color-brand-500, #6366f1)" strokeWidth={1.5 / k} pointerEvents="none" rx={4 / k} />
            })}
            {single && single.kind !== 'connector' && !single.locked && !editing
              ? (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Handle[]).map((h) => {
                const hx = h.includes('w') ? single.x : h.includes('e') ? single.x + single.w : single.x + single.w / 2
                const hy = h.includes('n') ? single.y : h.includes('s') ? single.y + single.h : single.y + single.h / 2
                const s = 9 / k
                return (
                  <rect
                    key={h}
                    x={hx - s / 2}
                    y={hy - s / 2}
                    width={s}
                    height={s}
                    rx={2 / k}
                    fill="var(--color-surface-raised, #fff)"
                    stroke="var(--color-brand-500, #6366f1)"
                    strokeWidth={1.5 / k}
                    style={{ cursor: `${h}-resize` }}
                    onPointerDown={(ev) => onHandleDown(ev, single, h)}
                  />
                )
              })
              : null}
            {single && single.kind === 'connector'
              ? (() => {
                const [a, b] = connectorEnds(single, byId)
                return ([['from', a], ['to', b]] as const).map(([end, pt]) => (
                  <circle
                    key={end}
                    cx={pt.x}
                    cy={pt.y}
                    r={6 / k}
                    fill="var(--color-surface-raised, #fff)"
                    stroke="var(--color-brand-500, #6366f1)"
                    strokeWidth={2 / k}
                    style={{ cursor: 'move' }}
                    onPointerDown={(ev) => onEndpointDown(ev, single.id, end)}
                  />
                ))
              })()
              : null}
            {marquee
              ? <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(99,102,241,0.08)" stroke="var(--color-brand-500, #6366f1)" strokeWidth={1 / k} strokeDasharray={`${4 / k} ${3 / k}`} pointerEvents="none" />
              : null}
            {preview
              ? <rect x={preview.box.x} y={preview.box.y} width={preview.box.w} height={preview.box.h} rx={preview.kind === 'ellipse' ? Math.min(preview.box.w, preview.box.h) / 2 : 8} fill="rgba(99,102,241,0.06)" stroke="var(--color-brand-500, #6366f1)" strokeWidth={1.5 / k} strokeDasharray={`${5 / k} ${4 / k}`} pointerEvents="none" />
              : null}
            {penPoints
              ? <path d={penPath(penPoints.map((p) => [p.x, p.y]))} fill="none" stroke={PALETTE[color].stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
              : null}
          </g>
        </svg>

        {/* inline text editor */}
        {editingEl ? <TextEditor el={editingEl} byId={byId} cam={cam} onCommit={(t) => commitText(editingEl.id, t)} onCancel={() => setEditing(null)} /> : null}

        {/* tool palette */}
        <div className="absolute left-3 top-1/2 flex -translate-y-1/2 flex-col gap-0.5 rounded-xl border border-edge-default bg-surface-raised/95 p-1 shadow-lg backdrop-blur">
          {TOOLS.map((t, i) => (
            <div key={t.id}>
              {i === 2 || i === 7 ? <div className="mx-1.5 my-0.5 border-t border-edge-subtle" /> : null}
              <button
                type="button"
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                onClick={() => {
                  setTool(t.id)
                  hostRef.current?.focus({ preventScroll: true })
                }}
                className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
                  tool === t.id
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-content-muted hover:bg-surface-sunken hover:text-content'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{t.icon}</svg>
              </button>
            </div>
          ))}
        </div>

        {/* properties */}
        {selectedEls.length && !editing
          ? (
            <PropertiesBar
              els={selectedEls}
              onColor={(c) => {
                setColor(c)
                patchSelected({ color: c })
              }}
              onPatch={patchSelected}
              onFront={() => commit((prev) => reorder(prev, selected, 'front'))}
              onBack={() => commit((prev) => reorder(prev, selected, 'back'))}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
              extra={
                <>
                  {workStickies.length
                    ? <button type="button" className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10" onClick={() => setWorkOpen(true)}>To Plane ({workStickies.length})</button>
                    : null}
                  {selectedEls.some((e) => isShape(e) && e.embed)
                    ? <button type="button" className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content" onClick={refreshEmbeds} disabled={refreshing} aria-busy={refreshing}>Refresh snapshot</button>
                    : null}
                </>
              }
            />
          )
          : (tool === 'sticky' || tool === 'rect' || tool === 'ellipse' || tool === 'diamond' || tool === 'pen')
          ? (
            <div className="absolute left-1/2 top-3 flex w-max -translate-x-1/2 items-center gap-1 rounded-xl border border-edge-default bg-surface-raised/95 px-2 py-1.5 shadow-lg backdrop-blur">
              <span className="mr-1 text-[11px] text-content-subtle">Colour</span>
              {COLORS.filter((c) => tool === 'pen' || c !== 'ink').map((c) => <Swatch key={c} c={c} on={color === c} onClick={() => setColor(c)} />)}
            </div>
          )
          : null}

        {/* empty hint */}
        {elements.length === 0
          ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="rounded-xl bg-surface-raised/80 px-5 py-4 text-center backdrop-blur">
                <div className="text-sm font-semibold text-content">An empty canvas</div>
                <div className="mt-1 text-[12.5px] text-content-muted">
                  Double-click to drop a sticky, or pick a tool on the left. Press <kbd className="rounded border border-edge-default px-1 font-mono text-[11px]">?</kbd> for shortcuts.
                </div>
              </div>
            </div>
          )
          : null}

        {/* footer controls */}
        <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[11px] text-content-subtle">
          <button
            type="button"
            onClick={() => setHelpOpen((o) => !o)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-edge-default bg-surface-raised/95 font-semibold text-content-muted shadow-sm hover:text-content"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
          <span className="rounded-md bg-surface-raised/80 px-1.5 py-0.5 backdrop-blur">
            {elements.length} element{elements.length === 1 ? '' : 's'}{selected.size ? ` · ${selected.size} selected` : ''}{snapOn ? ' · snap' : ''}
          </span>
        </div>
        <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised/95 p-0.5 shadow-sm backdrop-blur">
          <IconBtn label="Zoom out (⌘−)" onClick={() => zoomBy(1 / 1.2)}>−</IconBtn>
          <button
            type="button"
            onClick={() => {
              const v = viewport()
              setCam((c) => zoomAt(c, 1 / c.k, v.w / 2, v.h / 2))
            }}
            className="min-w-12 rounded-md px-1.5 py-1 font-mono text-[11px] tabular-nums text-content-muted hover:bg-surface-sunken"
            title="Reset to 100% (⌘0)"
          >
            {Math.round(k * 100)}%
          </button>
          <IconBtn label="Zoom in (⌘+)" onClick={() => zoomBy(1.2)}>+</IconBtn>
          <IconBtn label="Fit to content (⇧1)" onClick={() => fit()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </IconBtn>
        </div>

        {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}
      </div>
      <ScopeModal open={scopeOpen} onClose={() => setScopeOpen(false)} value={scopeV} scope={scope} onSave={(v) => {
        setScopeOpen(false)
        setScopeV(v)
      }} />
      <EntityPickerModal
        open={entityOpen}
        onClose={() => setEntityOpen(false)}
        entities={catalog.entities}
        sources={catalog.sources}
        selected={[]}
        title="Embed catalog entities"
        onSave={(refs) => {
          setEntityOpen(false)
          embedEntities(refs)
        }}
      />
      <DiagramPickerModal open={diagramOpen} onClose={() => setDiagramOpen(false)} diagrams={diagramDocs} onPick={(d) => {
        setDiagramOpen(false)
        void embedDiagram(d)
      }} />
      <CreateWorkItemsModal
        open={workOpen}
        onClose={() => setWorkOpen(false)}
        title={`Create ${workStickies.length} Plane work item${workStickies.length === 1 ? '' : 's'}`}
        description="One work item per selected sticky note, each linking back to this board. Review the titles first."
        items={workStickies.map((s) => ({ source: `board:${board.id}:sticky:${s.id}`, name: s.text.split('\n')[0].slice(0, 200), description: `${s.text}\n\nFrom whiteboard “${name}”${s.author ? ` · note by ${s.author}` : ''}.`, context: 'Sticky note' }))}
        scope={scopeV.project ? { slug: scopeV.project, name: scope.projectName(scopeV.project) } : undefined}
        backLink={designLink({ board: board.id })}
        onCreated={(links) => {
          const at = new Date().toISOString()
          const bySticky = new Map(links.map((l) => [l.source.split(':sticky:')[1], l]))
          commit((prev) =>
            prev.map((x) => {
              const l = bySticky.get(x.id)
              if (!l || !isShape(x)) return x
              return { ...x, work: { projectId: l.projectId, issueId: l.issueId, key: l.key, at } }
            })
          )
        }}
      />
      <AskAiModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        kind="stickies"
        title="Brainstorm with Adhar AI"
        description="Adhar AI suggests ideas; each line becomes a sticky note in the middle of the board."
        placeholder="Risks of moving the checkout service to event-driven ordering"
        context={[{ description: 'Notes on this board', value: elements.filter(isShape).map((e) => e.text).filter(Boolean).slice(0, 60).join('\n') || 'empty board' }]}
        fence={['text', 'markdown']}
        applyLabel="Add sticky notes"
        onApply={(text) => addIdeas(ideaLines('```text\n' + text + '```'))}
      />
    </div>
  )
}

function DiagramPickerModal({ open, onClose, diagrams, onPick }: { open: boolean; onClose(): void; diagrams: Diagram[]; onPick(d: Diagram): void }) {
  const [q, setQ] = useState('')
  const shown = diagrams.filter((d) => !q.trim() || d.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  return (
    <Modal open={open} onClose={onClose} title="Embed a diagram" description="Places a rendered snapshot on the board; refresh it after the diagram changes." width="md">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search diagrams…" aria-label="Search diagrams" className="mb-2 h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2.5 text-[12.5px] text-content" />
      <ul className="max-h-[50vh] divide-y divide-edge-subtle overflow-auto rounded-lg border border-edge-default">
        {shown.length === 0
          ? <li className="p-4 text-center text-[12px] text-content-subtle">{diagrams.length ? 'No diagrams match.' : 'No diagrams yet — create one in Design → Diagrams.'}</li>
          : shown.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] text-content hover:bg-surface-sunken/60">
                <span className="truncate">{d.title}</span>
                <span className="shrink-0 text-[11px] text-content-subtle">{formatRelative(d.updated_at)}</span>
              </button>
            </li>
          ))}
      </ul>
    </Modal>
  )
}

function containsBox(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/* ───────── element rendering ───────── */

const ElementView = memo(function ElementView({
  el,
  byId,
  editing,
  onDown,
}: {
  el: BoardEl
  byId: Map<string, BoardEl>
  editing: boolean
  onDown(e: React.PointerEvent, el: BoardEl): void
}) {
  const pal = PALETTE[el.color]
  const down = (e: React.PointerEvent) => onDown(e, el)

  if (el.kind === 'connector') {
    const [a, b] = connectorEnds(el, byId)
    const d = connectorPath(a, b, el.route)
    const mid = connectorMid(a, b)
    const label = el.label && !editing ? el.label : ''
    const lw = label ? measurer(12)(label) + 12 : 0
    return (
      <g data-el-id={el.id} onPointerDown={down} style={{ cursor: 'pointer' }}>
        <path d={d} stroke="transparent" strokeWidth={14} fill="none" data-export-ignore="" />
        <path
          d={d}
          fill="none"
          stroke={pal.stroke}
          strokeWidth={2}
          strokeDasharray={el.dashed ? '6 5' : undefined}
          strokeLinecap="round"
          markerEnd={el.arrow !== 'none' ? `url(#wb-arrow-${el.color})` : undefined}
          markerStart={el.arrow === 'both' ? `url(#wb-arrow-${el.color})` : undefined}
        />
        {label
          ? (
            <g>
              <rect x={mid.x - lw / 2} y={mid.y - 10} width={lw} height={20} rx={6} fill="var(--color-surface-raised, #fff)" stroke={pal.stroke} strokeOpacity={0.35} />
              <text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={12} fill={pal.text === 'currentColor' ? 'currentColor' : pal.text} fontFamily={FONT}>{label}</text>
            </g>
          )
          : null}
      </g>
    )
  }

  if (el.kind === 'pen') {
    return (
      <g data-el-id={el.id} onPointerDown={down} transform={`translate(${el.x} ${el.y}) scale(${el.w / el.vw} ${el.h / el.vh})`} style={{ cursor: 'move' }}>
        <rect x={0} y={0} width={el.vw} height={el.vh} fill="transparent" data-export-ignore="" />
        <path d={penPath(el.points)} fill="none" stroke={pal.stroke} strokeWidth={el.width} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </g>
    )
  }

  return <ShapeView el={el} editing={editing} onDown={onDown} />
})

const ShapeView = memo(function ShapeView({ el, editing, onDown }: { el: ShapeEl; editing: boolean; onDown(e: React.PointerEvent, el: BoardEl): void }) {
  if (el.embed) return <EmbedView el={el} onDown={onDown} />
  return <PlainShapeView el={el} editing={editing} onDown={onDown} />
})

/** A read-only snapshot card: a catalog entity's facts or a rendered diagram. */
function EmbedView({ el, onDown }: { el: ShapeEl; onDown(e: React.PointerEvent, el: BoardEl): void }) {
  const em = el.embed!
  const tone = em.type === 'entity' ? '#0ea5e9' : '#8b5cf6'
  const fit = (t: string, size: number, maxW: number) => {
    const m = measurer(size)
    if (m(t) <= maxW) return t
    let s = t
    while (s.length > 1 && m(`${s}…`) > maxW) s = s.slice(0, -1)
    return `${s}…`
  }
  const lines = (em.lines ?? []).slice(0, Math.max(0, Math.floor((el.h - 64) / 18)))
  return (
    <g data-el-id={el.id} onPointerDown={(e) => onDown(e, el)} style={{ cursor: el.locked ? 'default' : 'move' }}>
      <rect x={el.x + 2} y={el.y + 4} width={el.w} height={el.h} rx={12} fill="#0f172a" opacity={0.08} />
      <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={12} fill="var(--color-surface-raised, #ffffff)" stroke={tone} strokeOpacity={0.55} strokeWidth={1.5} />
      <rect x={el.x} y={el.y} width={5} height={el.h} rx={2.5} fill={tone} />
      <text x={el.x + 16} y={el.y + 24} fontSize={14} fontWeight={600} fill="currentColor" fontFamily={FONT}>{fit(em.title, 14, el.w - 32)}</text>
      <text x={el.x + 16} y={el.y + 41} fontSize={11} fill={tone} fontFamily={FONT}>{fit(`${em.subtitle ?? ''}${em.missing ? ' · source missing' : ''}`, 11, el.w - 32)}</text>
      {em.type === 'diagram' && em.image
        ? <image href={em.image} x={el.x + 10} y={el.y + 50} width={el.w - 20} height={Math.max(10, el.h - 72)} preserveAspectRatio="xMidYMid meet" />
        : lines.map((l, i) => (
          <text key={i} x={el.x + 16} y={el.y + 64 + i * 18} fontSize={12} fill="currentColor" opacity={0.8} fontFamily={FONT}>{fit(l, 12, el.w - 32)}</text>
        ))}
      <text x={el.x + el.w - 10} y={el.y + el.h - 8} textAnchor="end" fontSize={9.5} fill="currentColor" opacity={0.45} fontFamily={FONT}>
        snapshot {new Date(em.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </text>
    </g>
  )
}

const PlainShapeView = memo(function PlainShapeView({ el, editing, onDown }: { el: ShapeEl; editing: boolean; onDown(e: React.PointerEvent, el: BoardEl): void }) {
  const pal = PALETTE[el.color]
  const size = defaultFont(el)
  const weight = el.kind === 'frame' ? 600 : 400
  const lh = size * 1.35
  const pad = el.kind === 'sticky' ? 12 : el.kind === 'text' ? 2 : 10
  const innerW = el.kind === 'diamond' ? el.w * 0.6 : el.kind === 'ellipse' ? el.w * 0.75 : el.w - pad * 2
  const lines = useMemo(
    () => (el.text && !editing ? wrapText(el.text, Math.max(10, innerW), measurer(size, weight)) : []),
    [el.text, editing, innerW, size, weight],
  )
  const filled = el.filled !== false
  const fill = el.kind === 'sticky'
    ? pal.fill === 'none' ? '#f8fafc' : pal.fill
    : el.kind === 'frame'
    ? pal.fill === 'none' ? 'transparent' : pal.fill
    : filled && pal.fill !== 'none'
    ? pal.fill
    : 'transparent'
  const textFill = el.kind === 'sticky' ? (pal.text === 'currentColor' ? '#0f172a' : pal.text) : (filled && el.kind !== 'text' && pal.fill !== 'none') ? pal.text : el.kind === 'text' ? pal.text : 'currentColor'

  // Text layout
  let tx = el.x + pad
  let anchor: 'start' | 'middle' = 'start'
  let shown = lines
  let ty0: number
  if (el.kind === 'frame') {
    ty0 = el.y - 8
    shown = lines.slice(0, 1)
  } else if (el.kind === 'sticky' || el.kind === 'text') {
    const max = Math.max(1, Math.floor((el.h - pad * 2) / lh))
    if (el.kind === 'sticky' && lines.length > max) shown = [...lines.slice(0, max - 1), `${lines[max - 1]}…`]
    ty0 = el.y + pad + size * 0.95
  } else {
    anchor = 'middle'
    tx = el.x + el.w / 2
    const max = Math.max(1, Math.floor((el.h - 8) / lh))
    if (lines.length > max) shown = [...lines.slice(0, max - 1), `${lines[max - 1]}…`]
    ty0 = el.y + el.h / 2 - ((shown.length - 1) * lh) / 2 + size * 0.35
  }

  return (
    <g data-el-id={el.id} onPointerDown={(e) => onDown(e, el)} style={{ cursor: el.locked ? 'default' : 'move' }}>
      {el.kind === 'sticky'
        ? (
          <>
            <rect x={el.x + 2} y={el.y + 4} width={el.w} height={el.h} rx={4} fill="#0f172a" opacity={0.1} />
            <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={4} fill={fill} stroke={pal.stroke === 'currentColor' ? '#cbd5e1' : pal.stroke} strokeOpacity={0.35} />
          </>
        )
        : el.kind === 'rect'
        ? <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={10} fill={fill} stroke={pal.stroke} strokeWidth={2} />
        : el.kind === 'ellipse'
        ? <ellipse cx={el.x + el.w / 2} cy={el.y + el.h / 2} rx={el.w / 2} ry={el.h / 2} fill={fill} stroke={pal.stroke} strokeWidth={2} />
        : el.kind === 'diamond'
        ? <polygon points={`${el.x + el.w / 2},${el.y} ${el.x + el.w},${el.y + el.h / 2} ${el.x + el.w / 2},${el.y + el.h} ${el.x},${el.y + el.h / 2}`} fill={fill} stroke={pal.stroke} strokeWidth={2} strokeLinejoin="round" />
        : el.kind === 'frame'
        ? <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={14} fill={fill} fillOpacity={0.35} stroke={pal.stroke} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="8 6" />
        : <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="transparent" data-export-ignore="" />}
      {shown.length
        ? (
          <text x={tx} y={ty0} textAnchor={anchor} fontSize={size} fontWeight={weight} fill={el.kind === 'frame' ? 'currentColor' : textFill} fontFamily={FONT}>
            {shown.map((l, i) => <tspan key={i} x={tx} dy={i === 0 ? 0 : lh}>{l || ' '}</tspan>)}
          </text>
        )
        : null}
      {el.kind === 'sticky' && el.author
        ? <text x={el.x + el.w - 8} y={el.y + el.h - 8} textAnchor="end" fontSize={10} fill={textFill} opacity={0.55} fontFamily={FONT}>{el.author}</text>
        : null}
      {el.kind === 'sticky' && el.work
        ? (
          <g>
            <rect x={el.x + 8} y={el.y + el.h - 22} width={Math.max(46, measurer(10, 600)(el.work.key ?? 'Plane') + 22)} height={15} rx={7.5} fill="#4f46e5" opacity={0.9} />
            <text x={el.x + 15} y={el.y + el.h - 11.5} fontSize={10} fontWeight={600} fill="#ffffff" fontFamily={FONT}>↗ {el.work.key ?? 'Plane'}</text>
          </g>
        )
        : null}
      {el.locked
        ? <text x={el.x + el.w - 6} y={el.y + 14} textAnchor="end" fontSize={11} fill="currentColor" opacity={0.5} data-export-ignore="">🔒</text>
        : null}
    </g>
  )
})

/* ───────── inline text editor ───────── */

function TextEditor({
  el,
  byId,
  cam,
  onCommit,
  onCancel,
}: {
  el: BoardEl
  byId: Map<string, BoardEl>
  cam: Camera
  onCommit(text: string): void
  onCancel(): void
}) {
  const initial = el.kind === 'connector' ? el.label ?? '' : el.kind === 'pen' ? '' : el.text
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    ref.current?.select()
  }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    save ? onCommit(text) : onCancel()
  }

  let box: Box
  let size = 15
  let align: 'left' | 'center' = 'left'
  let color = 'inherit'
  if (el.kind === 'connector') {
    const [a, b] = connectorEnds(el, byId)
    const m = connectorMid(a, b)
    box = { x: m.x - 80, y: m.y - 14, w: 160, h: 28 }
    size = 12
    align = 'center'
  } else if (el.kind === 'pen') {
    return null
  } else {
    size = defaultFont(el)
    box = el.kind === 'frame' ? { x: el.x, y: el.y - 30, w: Math.max(160, el.w), h: 26 } : { x: el.x, y: el.y, w: el.w, h: Math.max(el.h, size * 1.6) }
    align = el.kind === 'sticky' || el.kind === 'text' || el.kind === 'frame' ? 'left' : 'center'
    const pal = PALETTE[el.color]
    if (el.kind === 'sticky') color = pal.text === 'currentColor' ? '#0f172a' : pal.text
    else if (el.kind !== 'frame' && el.kind !== 'text' && el.filled !== false && pal.fill !== 'none') color = pal.text
  }
  const pad = el.kind === 'sticky' ? 12 : el.kind === 'text' ? 2 : 10
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || el.kind === 'connector' || el.kind === 'frame')) {
          e.preventDefault()
          finish(true)
        }
      }}
      aria-label="Edit text"
      className="absolute z-10 resize-none overflow-hidden rounded-md border-0 bg-transparent leading-[1.35] outline-none ring-2 ring-brand-500/60"
      style={{
        left: box.x * cam.k + cam.x,
        top: box.y * cam.k + cam.y,
        width: box.w * cam.k,
        height: box.h * cam.k,
        fontSize: size * cam.k,
        padding: pad * cam.k,
        paddingTop: el.kind === 'frame' || el.kind === 'connector' ? 2 * cam.k : pad * cam.k,
        fontFamily: FONT,
        fontWeight: el.kind === 'frame' ? 600 : 400,
        textAlign: align,
        color,
        background: el.kind === 'connector' || el.kind === 'frame' ? 'var(--color-surface-raised, #fff)' : 'transparent',
      }}
    />
  )
}

/* ───────── toolbars ───────── */

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md text-sm text-content-muted hover:bg-surface-sunken hover:text-content disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  )
}

function Swatch({ c, on, onClick }: { c: ColorId; on: boolean; onClick(): void }) {
  const pal = PALETTE[c]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={pal.label}
      title={pal.label}
      aria-pressed={on}
      className={`h-5 w-5 rounded-full border-2 transition ${on ? 'scale-110 border-brand-500' : 'border-transparent hover:scale-105'}`}
      style={{ background: c === 'ink' ? 'currentColor' : pal.fill, boxShadow: `inset 0 0 0 1.5px ${c === 'ink' ? 'transparent' : pal.stroke}` }}
    />
  )
}

function PropertiesBar({
  els,
  onColor,
  onPatch,
  onFront,
  onBack,
  onDuplicate,
  onDelete,
  extra,
}: {
  els: BoardEl[]
  extra?: React.ReactNode
  onColor(c: ColorId): void
  onPatch(p: Partial<ShapeEl> & Partial<{ route: Route; arrow: ArrowStyle; dashed: boolean; width: number }>): void
  onFront(): void
  onBack(): void
  onDuplicate(): void
  onDelete(): void
}) {
  const shapes = els.filter(isShape)
  const connectors = els.filter(isConnector)
  const hasFillable = shapes.some((s) => s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'diamond')
  const hasText = shapes.length > 0
  const first = els[0]
  const allLocked = els.every((e) => e.locked)
  const sep = <span className="mx-1 h-5 w-px bg-edge-default" />
  const chip = (on: boolean) =>
    `rounded-md px-1.5 py-0.5 text-[11px] font-medium ${on ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300' : 'text-content-muted hover:bg-surface-sunken hover:text-content'}`
  return (
    <div
      className="absolute left-1/2 top-3 flex w-max max-w-[calc(100%-6rem)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl border border-edge-default bg-surface-raised/95 px-2 py-1.5 shadow-lg backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {COLORS.map((c) => <Swatch key={c} c={c} on={els.every((e) => e.color === c)} onClick={() => onColor(c)} />)}
      {hasFillable
        ? (
          <>
            {sep}
            <button type="button" className={chip(shapes.every((s) => s.filled !== false))} onClick={() => onPatch({ filled: true })}>Fill</button>
            <button type="button" className={chip(shapes.every((s) => s.filled === false))} onClick={() => onPatch({ filled: false })}>Outline</button>
          </>
        )
        : null}
      {hasText
        ? (
          <>
            {sep}
            {FONT_SIZES.map((f) => (
              <button key={f.id} type="button" className={chip(shapes.every((s) => defaultFont(s) === f.id))} onClick={() => onPatch({ fontSize: f.id })} title={`${f.id}px`}>
                {f.label}
              </button>
            ))}
          </>
        )
        : null}
      {connectors.length
        ? (
          <>
            {sep}
            {(['straight', 'elbow', 'curve'] as Route[]).map((r) => (
              <button key={r} type="button" className={chip(connectors.every((c) => c.route === r))} onClick={() => onPatch({ route: r })}>{r}</button>
            ))}
            {sep}
            {([['end', '→'], ['both', '↔'], ['none', '—']] as [ArrowStyle, string][]).map(([a, l]) => (
              <button key={a} type="button" className={chip(connectors.every((c) => c.arrow === a))} onClick={() => onPatch({ arrow: a })} title={`Arrow: ${a}`}>{l}</button>
            ))}
            <button type="button" className={chip(connectors.every((c) => c.dashed))} onClick={() => onPatch({ dashed: !connectors.every((c) => c.dashed) })}>dashed</button>
          </>
        )
        : null}
      {sep}
      <button type="button" className={chip(false)} onClick={onFront} title="Bring to front (])">Front</button>
      <button type="button" className={chip(false)} onClick={onBack} title="Send to back ([)">Back</button>
      <button type="button" className={chip(allLocked)} onClick={() => onPatch({ locked: !allLocked })} title="Lock position">{allLocked ? 'Unlock' : 'Lock'}</button>
      <button type="button" className={chip(false)} onClick={onDuplicate} title="Duplicate (⌘D)">Duplicate</button>
      <button
        type="button"
        onClick={onDelete}
        title="Delete (⌫)"
        aria-label="Delete selection"
        className="rounded-md px-1.5 py-0.5 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
      >
        <Icon name="trash" size={13} />
      </button>
      {extra}
      {els.length === 1 && first.kind === 'sticky' && (first as ShapeEl).author
        ? <span className="ml-1 text-[10.5px] text-content-subtle">by {(first as ShapeEl).author}</span>
        : null}
      {els.length === 1 && first.kind === 'sticky' && (first as ShapeEl).work
        ? <span className="ml-1 text-[10.5px] text-content-subtle">· in Plane {(first as ShapeEl).work!.key ?? ''}</span>
        : null}
    </div>
  )
}

function ShortcutHelp({ onClose }: { onClose(): void }) {
  const rows: [string, string][] = [
    ['V / H', 'Select / hand'],
    ['N R O D T', 'Sticky, rect, ellipse, diamond, text'],
    ['A / P / F', 'Connector / pen / frame'],
    ['Double-click', 'Add sticky · edit text'],
    ['Enter', 'Edit selected text'],
    ['⌘Z / ⇧⌘Z', 'Undo / redo'],
    ['⌘C ⌘X ⌘V', 'Copy, cut, paste (text → sticky)'],
    ['⌘D / ⌫', 'Duplicate / delete'],
    ['⌘A', 'Select all'],
    ['Arrows', 'Nudge (⇧ = 10px)'],
    ['] / [', 'Bring to front / send to back'],
    ['Space + drag', 'Pan'],
    ['⌘ + wheel', 'Zoom (or pinch)'],
    ['⇧1 / ⇧2', 'Fit all / fit selection'],
    ['⌘0', 'Zoom to 100%'],
    ['G', 'Toggle snap to grid'],
    ['⇧ + resize', 'Keep aspect ratio'],
  ]
  return (
    <div className="absolute bottom-12 left-3 z-20 w-80 rounded-xl border border-edge-default bg-surface-raised p-3 shadow-xl" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-content">Keyboard shortcuts</span>
        <button type="button" onClick={onClose} className="text-content-subtle hover:text-content" aria-label="Close">×</button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-content">{k}</dt>
            <dd className="text-content-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
