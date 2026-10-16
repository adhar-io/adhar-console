import { normalizeProject, type BuilderProject } from '@adhar/builder/project'

/**
 * Pure helpers for the Visual Builder's project library (no React, no I/O).
 *
 * Projects live in the console document store under the collection the
 * builder itself saves to (`builder.project`), so opening one is just mounting
 * the builder on its id. Visual projects are told apart from other builder
 * documents (Develop's Code Builder, wireframe drafts) by an id prefix.
 */

export const BUILDER_KIND = 'builder.project'
export const VISUAL_PREFIX = 'visual-'
/** The single scratch project the Visual Builder used before the library existed. */
const LEGACY_ID = 'design.visual-builder'

export interface ProjectSummary {
  id: string
  name: string
  project: BuilderProject
  pages: number
  updatedAt: string
  createdAt: string
}

export function isVisualProjectId(id: string): boolean {
  return id.startsWith(VISUAL_PREFIX) || id === LEGACY_ID
}

export function newProjectId(now = Date.now(), rand = Math.random()): string {
  return `${VISUAL_PREFIX}${now.toString(36)}-${rand.toString(36).slice(2, 7)}`
}

function countPages(p: BuilderProject): number {
  let n = 0
  const walk = (fs: BuilderProject['files']) => {
    for (const f of fs) {
      if (f.type === 'file' && f.nodes !== undefined && !f.symbol) n++
      if (f.children) walk(f.children)
    }
  }
  walk(p.files)
  return n
}

/** The fields of a document-store envelope the library reads. */
export interface ProjectDoc {
  id: string
  data: unknown
  createdAt: string
  updatedAt: string
}

export function summarize(docs: ProjectDoc[]): ProjectSummary[] {
  const out: ProjectSummary[] = []
  for (const d of docs) {
    if (!isVisualProjectId(d.id)) continue
    const project = normalizeProject(d.data, d.id === LEGACY_ID ? 'Visual Builder' : 'Untitled')
    if (!project) continue
    out.push({ id: d.id, name: project.name, project, pages: countPages(project), updatedAt: d.updatedAt, createdAt: d.createdAt })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function filterProjects(list: ProjectSummary[], q: string): ProjectSummary[] {
  const needle = q.trim().toLowerCase()
  return needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list
}

/** "Landing" → "Landing (copy)" → "Landing (copy 2)" … unique within `taken`. */
export function copyName(name: string, taken: string[]): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '')
  const set = new Set(taken)
  let candidate = `${base} (copy)`
  for (let i = 2; set.has(candidate); i++) candidate = `${base} (copy ${i})`
  return candidate
}

