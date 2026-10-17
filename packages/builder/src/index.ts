/**
 * @adhar/builder — the Adhar Visual Designer: visual editing of the React apps
 * in your repositories (pages, layers, components, data, interactions,
 * clickable prototype), saved back as reviewed git commits / pull requests.
 *
 * Import `BuilderApp` directly; the heavy parts (workbench, Babel parser,
 * Tailwind compiler, Monaco, Mermaid, React Flow) are lazy chunks.
 */
export { BuilderApp, type BuilderAppProps, type CanvasCss } from './builder-app.tsx'
export {
  type BuilderController,
  type BuilderMode,
  type BuilderProject,
  type BuilderSaveEvent,
  type BuilderSettings,
  type CanvasNode,
  type ProjectFile,
} from './types.ts'
export { defaultProjectFor, normalizeProject } from './lib/project.ts'
export type { ThemePreset, ThemeTokens } from './lib/builder-api.ts'
