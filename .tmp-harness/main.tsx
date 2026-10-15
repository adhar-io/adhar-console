import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams, useSearch } from '@tanstack/react-router'
import { ToastProvider } from '@adhar/shell-ui'
import DevelopHome from '/Users/tapas-pc/Documents/Work/Anication/AdharWS/adhar-console/modules/develop/src/home.tsx'
import DeliverHome from '/Users/tapas-pc/Documents/Work/Anication/AdharWS/adhar-console/modules/deliver/src/home.tsx'
const qs = new URLSearchParams(location.search)
if (qs.get('theme') === 'dark') document.documentElement.classList.add('dark')
const realFetch = globalThis.fetch
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.pathname.startsWith('/api/config')) return json({ gitea: { org: 'adhar' } })
  if (url.pathname.startsWith('/api/coder/identity')) return json({ owner: 'tapas', matched: true, created: false })
  if (url.pathname.startsWith('/api/')) return json({ items: [], metadata: {} })
  return realFetch(input, init)
}
const root = createRootRoute({ component: Outlet })
const phase = createRoute({ getParentRoute: () => root, path: '/$phase', validateSearch: (s: Record<string, unknown>) => s, component: () => {
  const { phase } = useParams({ strict: false }) as { phase: string }
  const s = useSearch({ strict: false }) as { section?: string }
  const H = phase === 'deliver' ? DeliverHome : DevelopHome
  return <div className="mx-auto max-w-[1400px] p-6"><H section={s.section} /></div>
} })
const router = createRouter({ routeTree: root.addChildren([phase]), history: createMemoryHistory({ initialEntries: [qs.get('p') || '/develop?section=repos'] }) })
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>)
