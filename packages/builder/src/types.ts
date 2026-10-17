import type { ProjectFile } from './lib/builder-types.ts'

/**
 * Public types of `@adhar/builder`.
 *
 * A project is a small virtual file tree: pages and reusable components hold
 * visual node trees, `data/*.json` files are data sources, and other files hold
 * text (Mermaid diagrams, workflows). See lib/studio.ts for the app model and
 * code/repo-session.ts for how a repository maps onto it.
 */

/** `visual` is the Visual Designer; `workflow` and `theme` open on those panels. */
export type BuilderMode = 'visual' | 'workflow' | 'theme'

export type { ProjectFile }
export type { CanvasNode } from './lib/builder-types.ts'

export interface BuilderSettings {
  /** Code-generation target: react | vue | svelte | angular | solid. */
  framework: string
  /** Design theme preset id (see lib/builder-api.ts `themePresets`). */
  theme: string
  /** Preview the design in its dark variant. Independent of the console's mode. */
  darkMode: boolean
  /** Theme-panel token overrides, keyed `light.<token>` / `dark.<token>` / `radius`. */
  customTokenOverrides: Record<string, string>
}

export interface BuilderProject {
  version: 1
  name: string
  files: ProjectFile[]
  settings: BuilderSettings
  /** Repository-backed projects: where the files came from. */
  source?: { repo: string; branch: string; commit?: string }
}

/** What `onSave` receives. */
export interface BuilderSaveEvent {
  id: string
  kind: 'builder'
  name: string
  mode: BuilderMode
  project: BuilderProject
}

/**
 * Handed to `actions` / `onSaveRequest` so a host page can put project-aware
 * controls in the page header and run its own save flow.
 */
export interface BuilderController {
  /** The project as edited right now. */
  readonly project: BuilderProject | null
  /** Unsaved edits since the last save / load. */
  dirty: boolean
  saving: boolean
  save(): Promise<void>
  /** Replace the open project (e.g. reloaded from a branch). */
  loadProject(project: BuilderProject, opts?: { dirty?: boolean }): void
  /** The host persisted the edits: drop the local draft, clear "dirty". */
  markSaved(): void
}
