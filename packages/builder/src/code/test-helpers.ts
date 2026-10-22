/** Shared helpers for the repo-pipeline tests (not shipped: only imported by *_test.ts). */
import { parse } from '@babel/parser'
import type { ParseFn } from './ast.ts'
import type { RepoApi } from './repo-session.ts'
import { fakeSha } from './fixtures.ts'
import type { CanvasNode } from '../lib/builder-types.ts'

export const P = parse as unknown as ParseFn

export function api(files: Record<string, string>): RepoApi {
  return {
    tree: () => Promise.resolve({ entries: Object.keys(files).map((p) => ({ path: p, sha: fakeSha(files[p]) })), truncated: false }),
    read: (p) => (p in files ? Promise.resolve({ content: files[p], sha: fakeSha(files[p]) }) : Promise.reject(new Error('404'))),
  }
}

export function find(nodes: CanvasNode[], pred: (n: CanvasNode) => boolean): CanvasNode | undefined {
  for (const n of nodes) {
    if (pred(n)) return n
    const hit = find(n.children, pred)
    if (hit) return hit
  }
  return undefined
}

export function all(nodes: CanvasNode[], pred: (n: CanvasNode) => boolean, out: CanvasNode[] = []): CanvasNode[] {
  for (const n of nodes) {
    if (pred(n)) out.push(n)
    all(n.children, pred, out)
  }
  return out
}

/** Apply a change set to a file map (a commit), returning the new map. */
export function commit(files: Record<string, string>, changes: Array<{ path: string; after: string }>): Record<string, string> {
  const next = { ...files }
  for (const c of changes) next[c.path] = c.after
  return next
}
