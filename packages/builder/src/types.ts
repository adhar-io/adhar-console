import type { ProjectFile } from './lib/builder-types.ts'

/**
 * Public types of `@adhar/builder`.
 *
 * A project is a small virtual file tree: pages and reusable components hold
 * visual node trees, `data/*.json` files are data sources, and other files hold
 * text (Mermaid diagrams, workflows). See lib/studio.ts for the app model and
 * lib/react-export.ts for what an export produces.
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
}

/** One file of the generated output — what "Commit to repo" writes. */
export interface GeneratedFile {
  path: string
  content: string
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
 * Handed to `actions` so a host page can put project-aware controls in the
 * page header (e.g. Develop's "Commit to repo").
 */
export interface BuilderController {
  project: BuilderProject | null
  /** Unsaved edits since the last save / load. */
  dirty: boolean
  saving: boolean
  save(): Promise<void>
  /** Replace the open project (e.g. one read back from a repository). */
  loadProject(project: BuilderProject, opts?: { dirty?: boolean }): void
  /** Render the project to files: a runnable React + Tailwind app, diagrams, workflows, manifest. */
  generateFiles(opts?: { basePath?: string }): Promise<GeneratedFile[]>
}

/** Path of the project manifest inside a repository. Reopened by "Open from repo". */
export const BUILDER_MANIFEST = '.adhar/builder.json'
