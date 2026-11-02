import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CURRENT_ORG_SLUG,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  testWebhook,
  updateWebhook,
  type WebhookInput,
} from './client.ts'

/**
 * React Query hooks for the actionable Settings write-flows — webhook
 * CRUD/test. They wrap the docStore-backed data functions (real Postgres
 * persistence) so the views stay declarative and cache invalidation is
 * centralized. Queries surface a `DocStoreError` verbatim when the database is
 * unavailable — the views render the error rather than fake data.
 *
 * There are no custom-role hooks: an organisation's two roles are its Keycloak
 * groups (`org-<slug>`, `org-<slug>-admin`), and the console keeps no roles of
 * its own (data/access.ts).
 */

/* ─────────────────── Webhooks ─────────────────── */

const WEBHOOKS_KEY = ['ws', 'webhooks', CURRENT_ORG_SLUG] as const

export function useWebhooks() {
  return useQuery({
    queryKey: WEBHOOKS_KEY,
    queryFn: () => listWebhooks(),
  })
}

export function useSaveWebhook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id?: string; input: WebhookInput }) =>
      v.id ? updateWebhook(v.id, v.input) : createWebhook(v.input),
    onSettled: () => qc.invalidateQueries({ queryKey: WEBHOOKS_KEY }),
  })
}

export function useDeleteWebhook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteWebhook(id),
    onSettled: () => qc.invalidateQueries({ queryKey: WEBHOOKS_KEY }),
  })
}

export function useTestWebhook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => testWebhook(id),
    onSettled: (_data, _err, id) => {
      qc.invalidateQueries({ queryKey: WEBHOOKS_KEY })
      qc.invalidateQueries({ queryKey: ['ws', 'webhook-deliveries', CURRENT_ORG_SLUG, id] })
    },
  })
}

export function useWebhookDeliveries(id: string | null) {
  return useQuery({
    queryKey: ['ws', 'webhook-deliveries', CURRENT_ORG_SLUG, id],
    queryFn: () => listWebhookDeliveries(id as string),
    enabled: Boolean(id),
  })
}
