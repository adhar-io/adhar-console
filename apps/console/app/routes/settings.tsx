import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AppShell } from '@adhar-console/shell-ui'
import { RemoteModule } from '@adhar-console/mf-utils'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
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
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  const { section } = Route.useSearch()
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Settings' }]}
      notifications={notifications}
      contentWidth="full"
    >
      <RemoteModule
        loader={() => import('workspace/Home') as Promise<{ default: React.ComponentType }>}
        componentProps={{ section }}
      />
    </AppShell>
  )
}
