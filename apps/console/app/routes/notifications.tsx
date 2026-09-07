import { createFileRoute } from '@tanstack/react-router'
import { AppShell, NotificationCenter } from '@adhar-console/shell-ui'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

export const Route = createFileRoute('/notifications')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Notifications · Adhar Console' }] }),
  component: NotificationsPage,
})

function NotificationsPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Notifications' }]}
      notifications={notifications}
    >
      <NotificationCenter />
    </AppShell>
  )
}
