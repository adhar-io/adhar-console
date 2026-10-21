import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AppShell } from '@adhar/shell-ui'
import { RemoteModule } from '@adhar/mf-utils'
import { PENDING_USER, useOptionalSession } from '@adhar/auth'
import { getLayoutData } from '~/server/session.ts'

const SettingsSearchSchema = z.object({
  section: z.string().optional(),
})

export const Route = createFileRoute('/settings')({
  loader: () => getLayoutData(),
  validateSearch: SettingsSearchSchema.parse,
  head: () => ({ meta: [{ title: 'Settings · Adhar Console' }] }),
  component: SettingsPage,
})

function SettingsPage() {
  const { tenants, activeTenant } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  const { section } = Route.useSearch()
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Settings' }]}
      contentWidth="full"
    >
      <RemoteModule loader={loadWorkspace} componentProps={{ section }} />
    </AppShell>
  )
}

/**
 * Module-level so its identity is stable: `RemoteModule` memoises `React.lazy`
 * on the loader, and an inline arrow remounted the whole Settings remote on
 * every `?section=` change.
 */
function loadWorkspace(): Promise<{ default: React.ComponentType }> {
  return import('workspace/Home') as Promise<{ default: React.ComponentType }>
}
