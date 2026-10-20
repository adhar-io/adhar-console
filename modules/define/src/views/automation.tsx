import { EmptyState } from '@adhar/shell-ui'
import { AutomationEditor } from '../components/automation-editor.tsx'

/**
 * Automation — the active project's console-side rules, the Gitea
 * repositories it watches, and what ran recently.
 */
export function Automation({ projectId }: { projectId?: string }) {
  if (!projectId) return <EmptyState title="Pick a project" description="Automation rules belong to a project." />
  return <AutomationEditor projectId={projectId} />
}
