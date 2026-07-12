import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@adhar-console/auth'
import { bootTheme } from '@adhar-console/shell-ui'
import { getRouter, queryClient } from './router.tsx'
import './styles.css'

bootTheme()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing from index.html')

// TanStack Router v1.168 initializes its state inside RouterProvider's
// effect; don't call `router.load()` here — it pokes at internal state
// (latestLocation, resolvedLocation) that isn't populated until mount.
const router = await getRouter()

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </QueryClientProvider>,
)
