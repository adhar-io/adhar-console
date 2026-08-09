import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Spinner } from '@adhar-console/shell-ui'
import { useAuth } from '@adhar-console/auth'

/**
 * Logout endpoint. Calls `signout()` which:
 *   - in real-Keycloak mode: hits `/realms/.../logout?post_logout_redirect_uri=…`
 *     so Keycloak invalidates the SSO cookie and redirects back to `/login`.
 *   - in stub mode: just clears local state and navigates to `/login`.
 */
export const Route = createFileRoute('/auth/logout')({
  head: () => ({ meta: [{ title: 'Signing out… · Adhar Console' }] }),
  component: LogoutPage,
})

function LogoutPage() {
  const nav = useNavigate()
  const { signout, configured } = useAuth()

  useEffect(() => {
    void (async () => {
      try {
        await signout()
      } finally {
        if (!configured) nav({ to: '/login', replace: true })
        // When configured, signout() does a full-page redirect to Keycloak.
      }
    })()
  }, [signout, configured, nav])

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <div className="flex items-center gap-3 rounded-xl border border-edge-default bg-surface-raised px-4 py-3 text-sm text-content-muted shadow-sm">
        <Spinner size={14} />
        <span>Signing you out…</span>
      </div>
    </div>
  )
}
