import type { plane } from '@adhar/api-clients'
import type { WorkItem } from './insights-math.ts'
import { jql, type JqlParts, useOpenDefine } from './insights-nav.ts'
import { recordRecent } from './my-work.ts'

/**
 * Drill-down navigation shared by the dashboard, My Work and Reports: a
 * number opens Issues with its JQL-like query (scoped to the project when
 * there is exactly one), an item opens Issues on that item (and joins
 * "Recently viewed").
 */
export function useDrill(projects: plane.Project[]) {
  const open = useOpenDefine()
  const single = projects.length === 1 ? projects[0] : undefined
  return {
    issues: (parts: JqlParts) => open('issues', { q: jql({ project: single?.identifier, ...parts }), project: single?.id }),
    item: (i: WorkItem) => {
      recordRecent({ project: i.project, id: i.id, key: i.key, name: i.name })
      open('issues', { project: i.project, issue: i.id, q: i.key ? jql({ key: i.key }) : undefined })
    },
    open,
  }
}

