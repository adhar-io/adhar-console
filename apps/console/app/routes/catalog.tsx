import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { AppShell } from '@adhar-console/shell-ui'
import { getLayoutData } from '~/server/session.ts'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { CatalogBrowse } from './_catalog-browse.tsx'
import { CatalogTemplates } from './_catalog-templates.tsx'

const SearchSchema = z.object({
  section: z.enum(['browse', 'create']).optional(),
  kind: z.string().optional(),
  q: z.string().optional(),
})

export const Route = createFileRoute('/catalog')({
  validateSearch: SearchSchema.parse,
  loader: () => getLayoutData(),
  head: ({ search }) => ({
    meta: [
      {
        title:
          search.section === 'create'
            ? 'Create New · Adhar Console'
            : 'Service Catalog · Adhar Console',
      },
    ],
  }),
  component: CatalogPage,
})

function CatalogPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const isCreate = search.section === 'create'

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[
        { label: 'Home', to: '/' },
        isCreate ? { label: 'Service Catalog', to: '/catalog' } : null,
        { label: isCreate ? 'Create New' : 'Service Catalog' },
      ].filter(Boolean) as Array<{ label: string; to?: string }>}
      notifications={notifications}
      contentWidth="full"
    >
      {isCreate ? (
        <CatalogTemplates
          onCreated={() =>
            void navigate({
              to: '/catalog',
              search: (prev) => ({ ...prev, section: undefined }),
            })
          }
        />
      ) : (
        <CatalogBrowse search={search} />
      )}
    </AppShell>
  )
}
