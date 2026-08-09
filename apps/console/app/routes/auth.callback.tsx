import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Spinner } from '@adhar-console/shell-ui'

/**
 * Legacy client OIDC callback. In the server-side cookie auth model the
 * callback is handled by the server route `/api/auth/callback`, which sets the
 * session cookie and redirects. This component only runs if something links
 * here directly; it just bounces to the overview.
 */
export const Route = createFileRoute('/auth/callback')({
  head: () => ({ meta: [{ title: 'Signing in… · Adhar Console' }] }),
  component: AuthCallback,
})

function AuthCallback() {
  const nav = useNavigate()
  useEffect(() => {
    nav({ to: '/', replace: true })
  }, [nav])
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-edge-default bg-surface-raised p-8 text-center shadow-sm">
        <Spinner size={20} />
        <h1 className="mt-4 text-base font-semibold text-content">Completing sign-in…</h1>
      </div>
    </div>
  )
}
