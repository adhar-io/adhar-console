import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { LaunchPage } from './pages/launch-page.tsx'
import { MaintenancePage } from './pages/maintenance-page.tsx'

/**
 * Two public routes, declared in code. The console uses file-based routing
 * with the router plugin because it has dozens of routes; two do not earn
 * a code generator.
 */
const rootRoute = createRootRoute({
  component: () => (
    <>
      <div className='ambient' aria-hidden>
        <div className='ambient-grid' />
      </div>
      <Outlet />
    </>
  ),
  notFoundComponent: () => {
    throw redirect({ to: '/' })
  },
})

const launchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LaunchPage,
})

const maintenanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/maintenance',
  // `until` is optional, so links to this route need no `search` prop.
  validateSearch: (s: Record<string, unknown>): { until?: string } =>
    typeof s.until === 'string' ? { until: s.until } : {},
  component: MaintenancePage,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([launchRoute, maintenanceRoute]),
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
