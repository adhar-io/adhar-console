import type { BuilderProject } from '../types.ts'
import { normalizeProject } from './project.ts'

/**
 * Named version snapshots of a project, kept in the console document store
 * (`builder.version/<docId>--v<time>`). Pure helpers; I/O is in the UI.
 */

export const VERSION_KIND = 'builder.version'

export interface VersionDoc {
  docId: string
  name: string
  createdAt: string
  project: BuilderProject
}

export interface VersionSummary {
  id: string
  name: string
  createdAt: string
  project: BuilderProject
}

export function versionId(docId: string, now = Date.now()): string {
  // Doc-store ids: [A-Za-z0-9._-], ≤128 chars.
  const safe = docId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)
  return `${safe}--v${now.toString(36)}`
}

export function makeVersion(docId: string, name: string, project: BuilderProject, now = new Date()): VersionDoc {
  return { docId, name: name.trim() || `Version ${now.toISOString().slice(0, 16).replace('T', ' ')}`, createdAt: now.toISOString(), project }
}

/** The versions of one document, newest first; malformed rows are skipped. */
export function versionsOf(docId: string, rows: Array<{ id: string; data: unknown }>): VersionSummary[] {
  const out: VersionSummary[] = []
  for (const r of rows) {
    const d = r.data as Partial<VersionDoc> | null
    if (!d || d.docId !== docId) continue
    const project = normalizeProject(d.project)
    if (!project) continue
    out.push({ id: r.id, name: String(d.name ?? 'Untitled version'), createdAt: String(d.createdAt ?? ''), project })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
