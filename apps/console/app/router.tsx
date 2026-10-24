import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen.ts'
import { RouteError, RouteNotFound } from './components/route-fallbacks.tsx'
import { createQueryClient } from './query-policy.ts'

/**
 * Single shared QueryClient. Created at module-init so `main.tsx` can wrap
 * `<QueryClientProvider>` around `<RouterProvider>` — without that provider,
 * every `useQuery` throws "No QueryClient set". The fetch policy (poll floor,
 * no focus refetch, no 4xx retries) lives in `query-policy.ts`.
 */
export const queryClient = createQueryClient()

/**
 * Named `getRouter` so the auto-generated `routeTree.gen.ts` (produced by
 * `@tanstack/router-plugin` in TanStack Start mode) can resolve its type
 * declaration `router: Awaited<ReturnType<typeof getRouter>>`.
 *
 * Returns a Promise because newer TanStack Start versions expect async router
 * setup (deferred route loading, optional SSR hydration state).
 */
export async function getRouter() {
  return createRouter({
    routeTree,
    context: { queryClient, session: null, tenant: null },
    defaultPreload: 'intent',
    // Hover-intent preloads reuse anything fetched in the last 30s instead of
    // re-running the route's loaders on every pointer pass.
    defaultPreloadStaleTime: 30_000,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: Awaited<ReturnType<typeof getRouter>>
  }
}
