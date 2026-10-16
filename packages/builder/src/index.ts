/**
 * @adhar/builder — the Adhar Visual Designer: a drag-and-drop app builder
 * (pages and routes, reusable components, data-bound tables and lists,
 * interactions, clickable prototype, React + Tailwind export).
 *
 * Import `BuilderApp` directly; the heavy parts (workbench, Monaco, Mermaid,
 * React Flow) are lazy chunks of whichever module renders it.
 */
export { BuilderApp, BUILDER_STORE_KIND, type BuilderAppProps } from './builder-app.tsx'
export {
  BUILDER_MANIFEST,
  type BuilderController,
  type BuilderMode,
  type BuilderProject,
  type BuilderSaveEvent,
  type BuilderSettings,
  type CanvasNode,
  type GeneratedFile,
  type ProjectFile,
} from './types.ts'
export { defaultProjectFor, normalizeProject } from './lib/project.ts'
export { RepoActions } from './repo/repo-actions.tsx'
export { ProjectThumbnail } from './components/project-thumbnail.tsx'
export { STARTERS, type StarterId } from './lib/starter-list.ts'
export type { ThemePreset, ThemeTokens } from './lib/builder-api.ts'

/** A new visual project from a starter. Lazy: the generator is its own chunk. */
export async function createStarterProject(
  opts: { name: string; starter: import('./lib/starter-list.ts').StarterId; theme?: string },
): Promise<import('./types.ts').BuilderProject> {
  const mod = await import('./lib/starters.ts')
  return mod.createStarterProject(opts)
}
