import { createFileRoute } from '@tanstack/react-router'
import { handleAlertmanagerWebhook } from '~/server/alertmanager.ts'

/**
 * POST /api/alerts/alertmanager — Alertmanager's webhook receiver.
 *
 * Turns firing/resolved alerts into Notification Center entries for the whole
 * tenant. Bearer-token authenticated. Logic lives in `~/server/alertmanager.ts`
 * and is shared verbatim with the production Deno server — never duplicate it here.
 */
export const Route = createFileRoute('/api/alerts/alertmanager')({
  server: {
    handlers: {
      POST: ({ request }) => handleAlertmanagerWebhook(request),
    },
  },
})
