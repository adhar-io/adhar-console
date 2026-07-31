import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@adhar-console/auth'
import { AiProvider, bootTheme } from '@adhar-console/shell-ui'
import { kube } from '@adhar-console/api-clients/k8s'
import { getRouter, queryClient } from './router.tsx'
import './styles.css'

bootTheme()

/**
 * Human-approved apply for AI-proposed cluster changes. The AI only ever
 * *proposes* a manifest; this runs when the operator clicks "Apply" on the
 * proposal card, using their own RBAC via the gateway.
 */
async function applyAiProposal(manifest: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    await kube.apply(manifest as Parameters<typeof kube.apply>[0], { force: true })
    return { ok: true, message: 'Applied to the cluster.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing from index.html')

// TanStack Router v1.168 initializes its state inside RouterProvider's
// effect; don't call `router.load()` here — it pokes at internal state
// (latestLocation, resolvedLocation) that isn't populated until mount.
const router = await getRouter()

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <AiProvider onApplyProposal={applyAiProposal}>
        <RouterProvider router={router} />
      </AiProvider>
    </AuthProvider>
  </QueryClientProvider>,
)
