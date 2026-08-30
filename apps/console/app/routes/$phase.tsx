import { createFileRoute, notFound, Outlet } from '@tanstack/react-router'
import { z } from 'zod'
import { AppShell, PlatformSelectionControls } from '@adhar-console/shell-ui'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { getLayoutData } from '~/server/session.ts'

const PhaseSchema = z.enum([
  'define',
  'design',
  'develop',
  'deliver',
  'discover',
  'decide',
  'platform',
])

const PHASE_LABEL: Record<z.infer<typeof PhaseSchema>, string> = {
  define: 'Define',
  design: 'Design',
  develop: 'Develop',
  deliver: 'Deliver',
  discover: 'Discover',
  decide: 'Decide',
  platform: 'Platform',
}

/**
 * Per-phase content-width preference. Pages with full Kanban boards or wide
 * dashboards opt out of the default `max-w-7xl` so they can breathe.
 */
const PHASE_WIDTH: Record<z.infer<typeof PhaseSchema>, 'standard' | 'wide' | 'full'> = {
  define: 'full',
  design: 'full',
  develop: 'full',
  deliver: 'full',
  discover: 'full',
  decide: 'full',
  platform: 'full',
}

const PhaseSearchSchema = z.object({
  section: z.string().optional(),
})

export const Route = createFileRoute('/$phase')({
  parseParams: ({ phase }) => {
    const parsed = PhaseSchema.safeParse(phase)
    if (!parsed.success) throw notFound()
    return { phase: parsed.data }
  },
  validateSearch: PhaseSearchSchema.parse,
  loader: async () => await getLayoutData(),
  head: ({ params }) => ({
    meta: [{ title: `${PHASE_LABEL[params.phase as keyof typeof PHASE_LABEL]} · Adhar Console` }],
  }),
  component: PhaseLayout,
})

function PhaseLayout() {
  const { phase } = Route.useParams()
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[
        { label: 'Home', to: '/' },
        { label: PHASE_LABEL[phase as keyof typeof PHASE_LABEL] },
      ]}
      notifications={notifications}
      contentWidth={PHASE_WIDTH[phase as keyof typeof PHASE_WIDTH]}
      headerControls={phase === 'platform' ? <PlatformSelectionControls /> : undefined}
    >
      <Outlet />
    </AppShell>
  )
}
