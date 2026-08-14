import { useEffect, useRef, useState } from 'react'
import { Button, EmptyState, Modal } from '@adhar-console/shell-ui'
import { KIND, newId, useCollection, useCreate, useRemove, useSeedExamples, useUpdate } from '../data/store.ts'
import { SEED_NOTES } from '../data/seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { NoteConnection, StickyColor, StickyNote, WhiteboardBoard } from '../data/types.ts'

const COLORS: { id: StickyColor; bg: string; text: string; ring: string }[] = [
  { id: 'amber', bg: 'bg-amber-100', text: 'text-amber-900', ring: 'ring-amber-200' },
  { id: 'rose', bg: 'bg-rose-100', text: 'text-rose-900', ring: 'ring-rose-200' },
  { id: 'sky', bg: 'bg-sky-100', text: 'text-sky-900', ring: 'ring-sky-200' },
  { id: 'violet', bg: 'bg-violet-100', text: 'text-violet-900', ring: 'ring-violet-200' },
  { id: 'emerald', bg: 'bg-emerald-100', text: 'text-emerald-900', ring: 'ring-emerald-200' },
  { id: 'slate', bg: 'bg-slate-100', text: 'text-slate-900', ring: 'ring-slate-200' },
]
function colorFor(id: StickyColor) {
  return COLORS.find((c) => c.id === id) ?? COLORS[0]
}

const NOTE_W = 200
const NOTE_H = 140
const BOARD_W = 1800
const BOARD_H = 1200
const GRID_BG =
  'radial-gradient(circle at 1px 1px, rgba(15, 23, 42, 0.07) 1px, transparent 0)'

const TEMPLATES: {
  id: string
  name: string
  description: string
  build(): { notes: StickyNote[]; connections: NoteConnection[] }
}[] = [
  {
    id: 'tpl-blank',
    name: 'Blank',
    description: 'Empty grid — drop ideas freely.',
    build: () => ({ notes: [], connections: [] }),
  },
  {
    id: 'tpl-4ls',
    name: '4 Ls retro',
    description: 'Liked · Learned · Lacked · Longed for.',
    build: () => {
      const cols = ['Liked', 'Learned', 'Lacked', 'Longed for']
      const tones: StickyColor[] = ['emerald', 'sky', 'amber', 'violet']
      return {
        notes: cols.map((c, i) => ({
          id: newId('note'),
          text: c,
          color: tones[i],
          x: 60 + i * 240,
          y: 40,
          author: 'me',
        })),
        connections: [],
      }
    },
  },
  {
    id: 'tpl-moscow',
    name: 'MoSCoW',
    description: 'Must · Should · Could · Won\'t (this round).',
    build: () => {
      const cols = ['Must', 'Should', 'Could', "Won't"]
      const tones: StickyColor[] = ['rose', 'amber', 'sky', 'slate']
      return {
        notes: cols.map((c, i) => ({
          id: newId('note'),
          text: c,
          color: tones[i],
          x: 60 + i * 240,
          y: 40,
          author: 'me',
        })),
        connections: [],
      }
    },
  },
  {
    id: 'tpl-lean',
    name: 'Lean canvas (mini)',
    description: 'Problem · Solution · UVP · Channels · Customer.',
    build: () => {
      const items: { text: string; tone: StickyColor; x: number; y: number }[] = [
        { text: 'Problem', tone: 'rose', x: 40, y: 40 },
        { text: 'Solution', tone: 'sky', x: 280, y: 40 },
        { text: 'Unique value prop', tone: 'violet', x: 520, y: 40 },
        { text: 'Channels', tone: 'amber', x: 280, y: 220 },
        { text: 'Customer segments', tone: 'emerald', x: 760, y: 40 },
      ]
      return {
        notes: items.map((i) => ({
          id: newId('note'),
          text: i.text,
          color: i.tone,
          x: i.x,
          y: i.y,
          author: 'me',
        })),
        connections: [],
      }
    },
  },
  {
    id: 'tpl-affinity',
    name: 'Affinity start',
    description: 'Two parallel columns — themes and observations.',
    build: () => {
      const seeds = ['Theme A', 'Theme B', 'Obs 1', 'Obs 2', 'Obs 3', 'Obs 4']
      return {
        notes: seeds.map((t, i) => ({
          id: newId('note'),
          text: t,
          color: i < 2 ? ('amber' as StickyColor) : ('sky' as StickyColor),
          x: i < 2 ? 60 + i * 240 : 60 + (i - 2) * 240,
          y: i < 2 ? 40 : 220 + (Math.floor((i - 2) / 2) * 180),
          author: 'me',
        })),
        connections: [],
      }
    },
  },
]

function defaultBoards(): WhiteboardBoard[] {
  return [
    {
      id: 'board-default',
      name: 'Brainstorm',
      notes: SEED_NOTES,
      connections: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]
}

export function Whiteboard() {
  const { items: boards, isLoading, error, refetch } = useCollection<WhiteboardBoard>(KIND.board)
  const createBoard = useCreate<WhiteboardBoard>(KIND.board)
  const updateBoard = useUpdate<WhiteboardBoard>(KIND.board)
  const removeBoard_ = useRemove(KIND.board)
  const seed = useSeedExamples<WhiteboardBoard>(KIND.board)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeColor, setActiveColor] = useState<StickyColor>('amber')
  const [tplOpen, setTplOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)

  // Keep a valid active board selected as the list loads / changes.
  useEffect(() => {
    if (boards.length && (activeId == null || !boards.some((b) => b.id === activeId))) {
      setActiveId(boards[0].id)
    }
  }, [boards, activeId])

  const active = boards.find((b) => b.id === activeId) ?? null
  const updateActive = (patch: Partial<WhiteboardBoard>) => {
    if (!active) return
    updateBoard.mutate({ ...active, ...patch, updated_at: new Date().toISOString() })
  }

  const addNote = () => {
    if (!active) return
    const board = boardRef.current
    const x = board ? board.scrollLeft + 40 + Math.random() * 80 : 40
    const y = board ? board.scrollTop + 40 + Math.random() * 80 : 40
    updateActive({
      notes: [
        ...active.notes,
        { id: newId('note'), text: 'New idea…', color: activeColor, x, y, author: 'me' },
      ],
    })
  }

  const updateNote = (id: string, patch: Partial<StickyNote>) => {
    if (!active) return
    updateActive({ notes: active.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })
  }

  const removeNote = (id: string) => {
    if (!active) return
    updateActive({
      notes: active.notes.filter((n) => n.id !== id),
      connections: active.connections.filter((c) => c.from !== id && c.to !== id),
    })
  }

  const onNoteClick = (id: string) => {
    if (!active) return
    if (connectFrom == null) {
      setConnectFrom(id)
      return
    }
    if (connectFrom === id) {
      setConnectFrom(null)
      return
    }
    const exists = active.connections.some(
      (c) =>
        (c.from === connectFrom && c.to === id) ||
        (c.from === id && c.to === connectFrom),
    )
    if (!exists) {
      updateActive({
        connections: [...active.connections, { from: connectFrom, to: id }],
      })
    }
    setConnectFrom(null)
  }

  const removeConnection = (c: NoteConnection) => {
    if (!active) return
    updateActive({
      connections: active.connections.filter((x) => !(x.from === c.from && x.to === c.to)),
    })
  }

  const newBoard = (name: string, build?: () => { notes: StickyNote[]; connections: NoteConnection[] }) => {
    const seeded = build ? build() : { notes: [], connections: [] }
    const board: WhiteboardBoard = {
      id: newId('board'),
      name: name || 'Untitled board',
      notes: seeded.notes,
      connections: seeded.connections,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    createBoard.mutate(board, { onSuccess: (created) => setActiveId(created.id) })
  }

  const removeBoard = (id: string) => {
    if (!confirm('Delete this board? Notes are not recoverable.')) return
    const remaining = boards.filter((b) => b.id !== id)
    removeBoard_.mutate(id)
    if (activeId === id) setActiveId(remaining[0]?.id ?? null)
  }

  if (error) return <ErrorBlock error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock label="Loading boards…" />

  if (boards.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          title="No whiteboards yet"
          description="Create a board to start dropping sticky notes, or load an example brainstorm."
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setTplOpen(true)} leading={<IconPlus />}>
                New board
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => seed.mutate(defaultBoards())}
                disabled={seed.isPending}
              >
                {seed.isPending ? 'Loading…' : 'Load examples'}
              </Button>
            </div>
          }
        />
        <NewBoardModal
          open={tplOpen}
          onClose={() => setTplOpen(false)}
          onCreate={(name, tplId) => {
            const tpl = TEMPLATES.find((t) => t.id === tplId)
            newBoard(name, tpl?.build)
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <BoardTabs
        boards={boards}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={() => setTplOpen(true)}
        onRename={() => setRenameOpen(true)}
        onRemove={() => active && removeBoard(active.id)}
      />
      <Toolbar
        count={active?.notes.length ?? 0}
        connectFrom={connectFrom}
        onCancelConnect={() => setConnectFrom(null)}
        activeColor={activeColor}
        setActiveColor={setActiveColor}
        onAdd={addNote}
        onClear={() => {
          if (!active) return
          if (!confirm('Clear all notes on this board?')) return
          updateActive({ notes: [], connections: [] })
        }}
      />
      {!active || (active.notes.length === 0 && active.connections.length === 0) ? (
        <div
          className="flex h-[60vh] items-center justify-center rounded-xl border border-dashed border-edge-default bg-surface-raised"
          style={{ backgroundImage: GRID_BG, backgroundSize: '20px 20px' }}
        >
          <EmptyState
            compact
            title="Empty board"
            description="Pick a color, then click New note. Or use a template from the boards menu."
          />
        </div>
      ) : (
        <div
          ref={boardRef}
          className="relative h-[70vh] overflow-auto rounded-xl border border-edge-default bg-surface-raised shadow-sm"
          style={{ backgroundImage: GRID_BG, backgroundSize: '20px 20px' }}
        >
          <div className="relative" style={{ width: BOARD_W, height: BOARD_H }}>
            <ConnectionLayer notes={active.notes} connections={active.connections} onRemove={removeConnection} />
            {active.notes.map((n) => (
              <Note
                key={n.id}
                note={n}
                connectMode={connectFrom != null}
                isConnectSource={connectFrom === n.id}
                onUpdate={updateNote}
                onRemove={removeNote}
                onClickInConnectMode={() => onNoteClick(n.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="text-[11px] text-content-subtle">
        Drag by the header. Double-click body to edit. Click <em>Connect</em> in a note's
        toolbar, then click another note to draw a line.
      </div>

      <NewBoardModal
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        onCreate={(name, tplId) => {
          const tpl = TEMPLATES.find((t) => t.id === tplId)
          newBoard(name, tpl?.build)
        }}
      />
      <RenameBoardModal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        initial={active?.name ?? ''}
        onSubmit={(name) => updateActive({ name })}
      />
    </div>
  )
}

function BoardTabs({
  boards,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: {
  boards: WhiteboardBoard[]
  activeId: string | null
  onSelect(id: string): void
  onAdd(): void
  onRename(): void
  onRemove(): void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
        {boards.map((b) => {
          const on = b.id === activeId
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => onSelect(b.id)}
              className={
                on
                  ? 'inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                  : 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
              }
            >
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500/60" />
              {b.name}
              <span className="font-mono text-[10px] tabular-nums opacity-60">{b.notes.length}</span>
            </button>
          )
        })}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onRename}>
          Rename
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Delete board
        </Button>
        <Button size="sm" onClick={onAdd} leading={<IconPlus />}>
          New board
        </Button>
      </div>
    </div>
  )
}

function Toolbar({
  count,
  connectFrom,
  onCancelConnect,
  activeColor,
  setActiveColor,
  onAdd,
  onClear,
}: {
  count: number
  connectFrom: string | null
  onCancelConnect(): void
  activeColor: StickyColor
  setActiveColor(c: StickyColor): void
  onAdd(): void
  onClear(): void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
      <div className="text-[11px] text-content-muted">
        {count} note{count === 1 ? '' : 's'}
      </div>
      <div className="ml-2 flex items-center gap-1 rounded-md bg-surface-sunken p-1">
        {COLORS.map((c) => {
          const on = activeColor === c.id
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveColor(c.id)}
              aria-label={`${c.id} note color`}
              className={`h-6 w-6 rounded-md border ${c.bg} transition ${
                on ? 'scale-110 border-content shadow-sm' : 'border-transparent hover:scale-105'
              }`}
            />
          )
        })}
      </div>
      {connectFrom ? (
        <span className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800">
          Click another note to connect
          <button
            type="button"
            onClick={onCancelConnect}
            className="rounded hover:bg-brand-100/60"
            aria-label="Cancel connect"
          >
            <IconClose />
          </button>
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" onClick={onAdd} leading={<IconPlus />}>
          New note
        </Button>
        {count > 0 ? (
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear board
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function Note({
  note,
  connectMode,
  isConnectSource,
  onUpdate,
  onRemove,
  onClickInConnectMode,
}: {
  note: StickyNote
  connectMode: boolean
  isConnectSource: boolean
  onUpdate(id: string, patch: Partial<StickyNote>): void
  onRemove(id: string): void
  onClickInConnectMode(): void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.text)
  const palette = colorFor(note.color)

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    if (connectMode) {
      e.stopPropagation()
      onClickInConnectMode()
      return
    }
    const startX = e.clientX
    const startY = e.clientY
    const origX = note.x
    const origY = note.y
    let moved = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.hypot(dx, dy) < 3) return
      moved = true
      onUpdate(note.id, { x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const save = () => {
    onUpdate(note.id, { text: draft.trim() || 'New idea…' })
    setEditing(false)
  }

  return (
    <div
      onClick={connectMode ? onClickInConnectMode : undefined}
      className={`absolute select-none rounded-md ${palette.bg} ${palette.text} shadow-md ring-1 ring-inset ${palette.ring} ${
        isConnectSource ? 'ring-2 ring-brand-500' : ''
      } ${connectMode ? 'cursor-crosshair' : ''}`}
      style={{ left: note.x, top: note.y, width: NOTE_W, height: NOTE_H }}
    >
      <div
        onPointerDown={onPointerDown}
        className={`flex items-center justify-between gap-1 rounded-t-md border-b border-current/10 bg-black/[0.03] px-2 py-1 ${
          connectMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
        }`}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
          {note.author}
        </span>
        <div className="flex items-center gap-1" data-no-drag>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClickInConnectMode()
            }}
            aria-label="Connect to another note"
            title="Connect to another note"
            className="rounded px-1 text-[10px] font-semibold uppercase tracking-wider opacity-70 hover:bg-black/10"
          >
            ⤳
          </button>
          <ColorMenu value={note.color} onChange={(c) => onUpdate(note.id, { color: c })} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(note.id)
            }}
            aria-label="Delete note"
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-black/10"
          >
            <IconClose />
          </button>
        </div>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') {
              setDraft(note.text)
              setEditing(false)
            }
          }}
          className="block h-[calc(100%-28px)] w-full resize-none bg-transparent p-2 text-sm leading-snug focus:outline-none"
        />
      ) : (
        <div
          onDoubleClick={() => {
            setDraft(note.text)
            setEditing(true)
          }}
          className="h-[calc(100%-28px)] overflow-y-auto whitespace-pre-wrap p-2 text-sm leading-snug"
        >
          {note.text}
        </div>
      )}
    </div>
  )
}

function ColorMenu({ value, onChange }: { value: StickyColor; onChange(c: StickyColor): void }) {
  return (
    <div className="flex items-center gap-0.5">
      {COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onChange(c.id)
          }}
          aria-label={`Set color ${c.id}`}
          className={`h-3 w-3 rounded-full border ${c.bg} transition ${
            value === c.id ? 'border-content' : 'border-transparent opacity-70 hover:opacity-100'
          }`}
        />
      ))}
    </div>
  )
}

function ConnectionLayer({
  notes,
  connections,
  onRemove,
}: {
  notes: StickyNote[]
  connections: NoteConnection[]
  onRemove(c: NoteConnection): void
}) {
  const map = new Map(notes.map((n) => [n.id, n]))
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={BOARD_W}
      height={BOARD_H}
      viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
    >
      <defs>
        <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--color-brand-500)" />
        </marker>
      </defs>
      {connections.map((c, i) => {
        const a = map.get(c.from)
        const b = map.get(c.to)
        if (!a || !b) return null
        const x1 = a.x + NOTE_W / 2
        const y1 = a.y + NOTE_H / 2
        const x2 = b.x + NOTE_W / 2
        const y2 = b.y + NOTE_H / 2
        const cx = (x1 + x2) / 2
        const cy = (y1 + y2) / 2 - 30
        return (
          <g key={i} className="pointer-events-auto">
            <path
              d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`}
              fill="none"
              stroke="var(--color-brand-500)"
              strokeWidth="2"
              markerEnd="url(#wb-arrow)"
            />
            <circle
              cx={cx}
              cy={cy}
              r={9}
              fill="white"
              stroke="var(--color-brand-500)"
              strokeWidth="1.5"
              className="cursor-pointer"
              onClick={() => onRemove(c)}
            />
            <text
              x={cx}
              y={cy + 3}
              textAnchor="middle"
              fontSize="11"
              fill="var(--color-brand-700)"
              className="pointer-events-none select-none"
            >
              ×
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function NewBoardModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose(): void
  onCreate(name: string, tplId: string): void
}) {
  const [name, setName] = useState('')
  const [tplId, setTplId] = useState(TEMPLATES[0].id)
  const submit = () => {
    onCreate(name.trim() || 'New board', tplId)
    setName('')
    setTplId(TEMPLATES[0].id)
    onClose()
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New whiteboard"
      description="Pick a template to seed the board, or start blank."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit}>
            Create board
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sprint retro"
            className="mt-1.5 block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </label>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Template
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TEMPLATES.map((t) => {
              const on = tplId === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTplId(t.id)}
                  className={
                    on
                      ? 'rounded-lg border border-brand-400 bg-brand-50 p-3 text-left ring-2 ring-brand-400/20'
                      : 'rounded-lg border border-edge-default bg-surface-raised p-3 text-left hover:border-edge-strong'
                  }
                >
                  <div className="text-sm font-semibold text-content">{t.name}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-content-muted">
                    {t.description}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function RenameBoardModal({
  open,
  onClose,
  initial,
  onSubmit,
}: {
  open: boolean
  onClose(): void
  initial: string
  onSubmit(name: string): void
}) {
  const [name, setName] = useState(initial)
  useEffect(() => {
    if (open) setName(initial)
  }, [open, initial])
  const submit = () => {
    if (!name.trim()) return
    onSubmit(name.trim())
    onClose()
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rename board"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
      />
    </Modal>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconClose() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
