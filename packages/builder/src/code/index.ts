/**
 * `@adhar/builder/code` — the repository pipeline, React-free: open a branch
 * (framework, pages, JSX import), compute the edits back as file changes
 * (splice, new files, routes), conflicts, diffs.
 */
export {
  computeChanges, designerBranch, DESIGNER_META, findConflicts, openRepo, previewFile, pullRequestsBlocked, writesBlocked,
  type ChangeSet, type DesignerMeta, type FileChange, type OpenPage, type RepoApi, type RepoSession,
} from './repo-session.ts'
export { detectFramework, findAppPackageJson, isEditable, type Framework, type FrameworkId } from './framework.ts'
export { diffLines, diffStats, hunks, type DiffLine, type Hunk } from './line-diff.ts'
export type { ParseFn } from './ast.ts'

/** The Babel parser, loaded on first use (its own chunk). */
export async function loadParser(): Promise<import('./ast.ts').ParseFn> {
  const mod = await import('@babel/parser')
  return mod.parse as unknown as import('./ast.ts').ParseFn
}

/** The repo's Tailwind, compiled in the browser for the canvas (its own chunk). */
export async function loadCanvasCss(appCss: string | null): Promise<{ build(candidates: string[]): string }> {
  const mod = await import('./tailwind-runtime.ts')
  return mod.createRepoCssCompiler(appCss)
}
