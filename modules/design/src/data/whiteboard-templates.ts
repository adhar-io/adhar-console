/**
 * Starter layouts for new whiteboards. Each builds a fresh element list
 * (new ids per call) using frames for columns/quadrants, stickies for
 * prompts, and shapes + connectors for the architecture sketch.
 */

import type { BoardEl, ColorId, ShapeEl } from './whiteboard-model.ts'

export interface BoardTemplate {
  id: string
  name: string
  description: string
  build(makeId: (p: string) => string): BoardEl[]
}

function frame(id: string, x: number, y: number, w: number, h: number, text: string, color: ColorId = 'slate'): ShapeEl {
  return { id, kind: 'frame', x, y, w, h, text, color }
}
function sticky(id: string, x: number, y: number, text: string, color: ColorId): ShapeEl {
  return { id, kind: 'sticky', x, y, w: 180, h: 120, text, color }
}

function columns(makeId: (p: string) => string, titles: string[], colors: ColorId[], prompts: string[] = []): BoardEl[] {
  const out: BoardEl[] = []
  titles.forEach((t, i) => {
    const x = i * 260
    out.push(frame(makeId('el'), x, 0, 240, 560, t, colors[i]))
    if (prompts[i]) out.push(sticky(makeId('el'), x + 30, 50, prompts[i], colors[i]))
  })
  return out
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { id: 'blank', name: 'Blank canvas', description: 'An empty infinite canvas.', build: () => [] },
  {
    id: 'retro',
    name: 'Retro — 4 Ls',
    description: 'Liked · Learned · Lacked · Longed for.',
    build: (id) =>
      columns(id, ['Liked', 'Learned', 'Lacked', 'Longed for'], ['emerald', 'sky', 'rose', 'violet'], [
        'What went well?',
        'What did we discover?',
        'What held us back?',
        'What do we wish we had?',
      ]),
  },
  {
    id: 'kanban',
    name: 'Kanban',
    description: 'To do · Doing · Review · Done.',
    build: (id) => columns(id, ['To do', 'Doing', 'Review', 'Done'], ['slate', 'sky', 'amber', 'emerald'], ['Drop work items here']),
  },
  {
    id: 'moscow',
    name: 'MoSCoW prioritisation',
    description: "Must · Should · Could · Won't (this time).",
    build: (id) => columns(id, ['Must have', 'Should have', 'Could have', "Won't have"], ['rose', 'amber', 'sky', 'slate']),
  },
  {
    id: 'swot',
    name: 'SWOT',
    description: 'Strengths, weaknesses, opportunities, threats.',
    build: (id) => [
      frame(id('el'), 0, 0, 420, 300, 'Strengths', 'emerald'),
      frame(id('el'), 440, 0, 420, 300, 'Weaknesses', 'rose'),
      frame(id('el'), 0, 320, 420, 300, 'Opportunities', 'sky'),
      frame(id('el'), 440, 320, 420, 300, 'Threats', 'amber'),
    ],
  },
  {
    id: 'lean',
    name: 'Lean canvas',
    description: 'Problem, solution, UVP, channels, segments, metrics.',
    build: (id) => [
      frame(id('el'), 0, 0, 220, 420, 'Problem', 'rose'),
      frame(id('el'), 230, 0, 220, 200, 'Solution', 'sky'),
      frame(id('el'), 230, 210, 220, 210, 'Key metrics', 'slate'),
      frame(id('el'), 460, 0, 220, 420, 'Unique value proposition', 'violet'),
      frame(id('el'), 690, 0, 220, 200, 'Unfair advantage', 'amber'),
      frame(id('el'), 690, 210, 220, 210, 'Channels', 'sky'),
      frame(id('el'), 920, 0, 220, 420, 'Customer segments', 'emerald'),
    ],
  },
  {
    id: 'architecture',
    name: 'Architecture sketch',
    description: 'Client → gateway → services → data, ready to rearrange.',
    build: (id) => {
      const client: ShapeEl = { id: id('el'), kind: 'ellipse', x: 0, y: 140, w: 150, h: 80, text: 'Client', color: 'sky', filled: true }
      const gw: ShapeEl = { id: id('el'), kind: 'rect', x: 240, y: 140, w: 170, h: 80, text: 'API gateway', color: 'violet', filled: true }
      const svcA: ShapeEl = { id: id('el'), kind: 'rect', x: 500, y: 40, w: 170, h: 80, text: 'Service A', color: 'emerald', filled: true }
      const svcB: ShapeEl = { id: id('el'), kind: 'rect', x: 500, y: 240, w: 170, h: 80, text: 'Service B', color: 'emerald', filled: true }
      const db: ShapeEl = { id: id('el'), kind: 'diamond', x: 760, y: 130, w: 150, h: 100, text: 'Postgres', color: 'amber', filled: true }
      const zone = frame(id('el'), 460, 0, 480, 360, 'Cluster', 'slate')
      const c = (from: string, to: string, label?: string): BoardEl => ({
        id: id('conn'),
        kind: 'connector',
        from: { id: from, x: 0, y: 0 },
        to: { id: to, x: 0, y: 0 },
        color: 'ink',
        route: 'elbow',
        arrow: 'end',
        label,
      })
      return [zone, client, gw, svcA, svcB, db, c(client.id, gw.id, 'HTTPS'), c(gw.id, svcA.id), c(gw.id, svcB.id), c(svcA.id, db.id, 'SQL'), c(svcB.id, db.id)]
    },
  },
  {
    id: 'story-map',
    name: 'User story map',
    description: 'Activities across the top, stories beneath, release slices.',
    build: (id) => {
      const acts = ['Discover', 'Sign up', 'Configure', 'Deploy', 'Observe']
      const out: BoardEl[] = acts.map((a, i) => sticky(id('el'), i * 200, 0, a, 'violet'))
      out.push(frame(id('el'), -20, 160, 1000, 180, 'Release 1 — walking skeleton', 'emerald'))
      out.push(frame(id('el'), -20, 360, 1000, 180, 'Release 2', 'sky'))
      return out
    },
  },
]
