/**
 * `@adhar/builder/project` — the React-free half of the package: the project
 * model and helpers. Data layers (and their tests) import this instead of the
 * root entry so they don't pull the UI graph in.
 */
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
export type { ThemePreset, ThemeTokens } from './lib/builder-api.ts'
