import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'

/**
 * Single shared QueryClient. Created at module-init so `main.tsx` can wrap
 * `<QueryClientProvider>` around `<RouterProvider>` — without that provider,
 * every `useQuery` throws "No QueryClient set".
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

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
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: Awaited<ReturnType<typeof getRouter>>
  }
}
