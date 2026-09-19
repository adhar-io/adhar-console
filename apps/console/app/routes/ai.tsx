import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AppShell, AssistHost } from '@adhar-console/shell-ui'
import { PENDING_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

/**
 * /ai — Adhar AI as a page.
 *
 * The ⌘K overlay is the fastest way to ask something from wherever you are;
 * this is the place to WORK in a conversation — a full frame, a URL you can
 * bookmark and share, and on a phone the whole screen. Same surface, same
 * store, same thread: a conversation started in the overlay continues here.
 */
export const Route = createFileRoute('/ai')({
  loader: () => getLayoutData(),
  head: () => ({ meta: [{ title: 'Adhar AI · Adhar Console' }] }),
  component: AiPage,
})

function AiPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? PENDING_USER
  const navigate = useNavigate()
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      notifications={notifications}
      contentWidth="bleed"
    >
      <AssistHost variant="page" onClose={() => navigate({ to: '/' })} />
    </AppShell>
  )
}
