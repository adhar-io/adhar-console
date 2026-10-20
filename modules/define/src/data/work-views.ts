import { useMemo } from 'react'
import { type StoredDoc, useOptionalUser } from '@adhar/shell-ui'
import { KINDS, type SavedView, useDocs, type ViewDefault } from './work-store.ts'
import type { SavedIssueQuery } from './view-query.ts'

/**
 * Saved views (console-side, `define.view`). Plane's public API has no views
 * endpoint. "Personal" views are listed only for their author in the console
 * — they live in the tenant's shared store, so this is a listing preference,
 * not access control.
 */

export type ViewDoc = StoredDoc<SavedView>

export function useSavedViews(projectId?: string) {
  const q = useDocs<SavedView>(KINDS.view)
  const defaults = useDocs<ViewDefault>(KINDS.viewDefault)
  const user = useOptionalUser()
  const me = user?.email?.toLowerCase() ?? ''
  const views = useMemo(() => {
    const all = q.data ?? []
    return all
      .filter((v) => v.data.visibility === 'shared' || v.data.owner?.toLowerCase() === me)
      .filter((v) => !projectId || v.data.projectId === null || v.data.projectId === projectId)
      .sort((a, b) => {
        const sa = a.data.starredBy?.includes(me) ? 0 : 1
        const sb = b.data.starredBy?.includes(me) ? 0 : 1
        return sa - sb || a.data.name.localeCompare(b.data.name)
      })
  }, [q.data, me, projectId])
  const defaultId = projectId ? defaults.data?.find((d) => d.id === projectId)?.data.viewId : undefined
  return { ...q, views, me, meName: user?.name, defaultId, defaultsLoaded: !defaults.isLoading }
}

/** Old Issues "Saved Views" (`query_data`) → WQL, using ids the WQL resolver accepts. */
export function legacyQueryToWql(q: SavedIssueQuery | undefined): { jql: string; groupBy?: string } {
  if (!q) return { jql: '' }
  const parts: string[] = []
  if (q.priority) parts.push(`priority = ${q.priority}`)
  if (q.state) parts.push(`status = ${q.state}`)
  if (q.label) parts.push(`label = ${q.label}`)
  if (q.assignee) parts.push(`assignee = ${q.assignee}`)
  const sort = q.sort_by === 'created' ? 'created DESC' : q.sort_by === 'priority' ? 'priority' : q.sort_by === 'target' ? 'due' : q.sort_by === 'estimate' ? 'estimate DESC' : ''
  const groupBy = q.group_by === 'cycle' ? 'sprint' : q.group_by === 'module' ? 'epic' : q.group_by
  return { jql: `${parts.join(' AND ')}${sort ? `${parts.length ? ' ' : ''}ORDER BY ${sort}` : ''}`, groupBy }
}
