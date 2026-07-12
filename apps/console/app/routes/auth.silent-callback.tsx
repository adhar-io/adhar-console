import { createFileRoute } from '@tanstack/react-router'

/**
 * Obsolete in the server-side cookie auth model — token refresh now happens
 * server-side in the BFF, so there is no browser silent-renew iframe. Kept as
 * a harmless no-op route so the generated route tree still resolves.
 */
export const Route = createFileRoute('/auth/silent-callback')({
  component: () => null,
})
