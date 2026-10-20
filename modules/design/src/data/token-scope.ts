import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { docStore } from '@adhar/shell-ui'
import { KIND, TOKEN_SET_ID, tokenSetId, useDoc } from './store.ts'
import { mergeDefaults } from './tokens-lib.ts'
import { applyOverrides, overrideCount } from './token-publish.ts'
import type { TokenOverrides, TokenSet } from './types.ts'

/**
 * The token set in effect for a scope: the workspace set, or — for a project
 * — the workspace set with the project's overrides applied (project wins by
 * token name). The Visual Designer, the Tokens page and the dashboard all read
 * this, so a project's theme is the same everywhere.
 */
export interface EffectiveTokens {
  /** Workspace set (defaults merged). */
  workspace: TokenSet
  /** True when the workspace document exists (vs. built-in defaults). */
  workspaceStored: boolean
  /** The project's overrides (null for the workspace scope or none stored). */
  overrides: TokenOverrides | null
  overrideCount: number
  /** What applies in this scope. */
  effective: TokenSet
  isLoading: boolean
  error: Error | null
}

export function useEffectiveTokens(project?: string): EffectiveTokens {
  const ws = useDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  // For the workspace scope this reads the same document twice (one cache entry).
  const ov = useDoc<TokenOverrides>(KIND.tokenSet, tokenSetId(project))
  return useMemo(() => {
    const workspace = mergeDefaults(ws.data)
    const overrides = project ? ov.data : null
    return {
      workspace,
      workspaceStored: !!ws.data,
      overrides,
      overrideCount: overrideCount(overrides),
      effective: applyOverrides(workspace, overrides),
      isLoading: ws.isLoading || (!!project && ov.isLoading),
      error: ws.error ?? (project ? ov.error : null),
    }
  }, [ws.data, ws.isLoading, ws.error, ov.data, ov.isLoading, ov.error, project])
}

/**
 * Save a token document by id (the workspace set or `project:<slug>`
 * overrides). The id travels with the data, so a save flushed while the
 * scope is switching still lands on the document it was edited in.
 */
export function useSaveTokenDoc() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { id: string; data: TokenSet | TokenOverrides }>({
    mutationFn: async ({ id, data }) => (await docStore.put(KIND.tokenSet, id, data)).data,
    onSuccess: (data, v) => {
      qc.setQueryData(['design', KIND.tokenSet, v.id], data)
      void qc.invalidateQueries({ queryKey: ['design', KIND.tokenSet], exact: true })
    },
  })
}
