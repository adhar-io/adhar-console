/**
 * `@adhar/builder/code` — the repository pipeline, React-free: open a branch
 * (framework, pages, JSX import), compute the edits back as file changes
 * (splice, new files, routes), conflicts, diffs. React and Solid pages are
 * JSX; Angular, Vue, Svelte and static HTML pages go through the template
 * engine (`markup.ts`) with each framework's own parser, loaded lazily.
 */
import { scopePlainCss } from './css-theme.ts'

export {
  computeChanges, designerBranch, DESIGNER_META, findConflicts, openRepo, previewFile, pullRequestsBlocked, writesBlocked,
  type ChangeSet, type DesignerMeta, type FileChange, type OpenPage, type RepoApi, type RepoSession,
} from './repo-session.ts'
export {
  detectFramework, familyOf, findAppPackageJson, isEditable, SUPPORTED_FRAMEWORKS, type Framework, type FrameworkFamily, type FrameworkId,
} from './framework.ts'
export { loadMarkupParsers } from './parsers/load.ts'
export type { MarkupParsers } from './parsers/types.ts'
export { diffLines, diffStats, hunks, type DiffLine, type Hunk } from './line-diff.ts'
export type { ParseFn } from './ast.ts'

/** The Babel parser, loaded on first use (its own chunk). */
export async function loadParser(): Promise<import('./ast.ts').ParseFn> {
  const mod = await import('@babel/parser')
  return mod.parse as unknown as import('./ast.ts').ParseFn
}

/** The repo's Tailwind, compiled in the browser for the canvas (its own chunk); `extraCss` = component styles. */
export async function loadCanvasCss(appCss: string | null, extraCss = ''): Promise<{ build(candidates: string[]): string }> {
  const mod = await import('./tailwind-runtime.ts')
  return mod.createRepoCssCompiler(appCss, extraCss)
}

/** A repo without Tailwind: its plain CSS (global + component styles), scoped to the canvas. */
export function plainCanvasCss(css: string): { build(candidates: string[]): string } {
  const scoped = scopePlainCss(css)
  return { build: () => scoped }
}
