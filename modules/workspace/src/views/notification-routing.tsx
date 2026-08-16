import { useEffect, useState } from 'react'
import { StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  isValidEmail,
  isValidHttpUrl,
  useNotificationRouting,
  useSaveNotificationRouting,
  useTestNotificationRoute,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationRoutes,
  type RouteTestResult,
} from '../data/preferences.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

/**
 * Notification routing — where each category of org event goes: in-app,
 * an email address, or a Slack/webhook URL. Singleton
 * `workspace.notification-routing` doc; the webhook "test" is a real
 * reachability check whose outcome is recorded on the document.
 */
export function NotificationRouting() {
  const q = useNotificationRouting()

  if (q.isError) {
    return (
      <Shell>
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      </Shell>
    )
  }
  if (q.isLoading || !q.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading notification routing…" />
      </Shell>
    )
  }

  const { doc, saved, updatedAt } = q.data
  const routes = doc.routes
  const enabledCount = NOTIFICATION_CATEGORIES.filter((c) => routes[c.id].enabled).length
  const webhookCount = NOTIFICATION_CATEGORIES.filter(
    (c) => routes[c.id].channel === 'webhook' && routes[c.id].target,
  ).length

  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Categories"
          value={`${enabledCount}/${NOTIFICATION_CATEGORIES.length}`}
          hint="routing enabled"
          tone={enabledCount > 0 ? 'good' : 'warn'}
        />
        <StatTile label="Webhooks" value={webhookCount} hint="external destinations" />
        <StatTile
          label="Email routes"
          value={NOTIFICATION_CATEGORIES.filter((c) => routes[c.id].channel === 'email').length}
          hint="to a shared inbox"
        />
        <StatTile
          label="Routing"
          value={saved ? 'Saved' : 'Defaults'}
          tone={saved ? 'good' : 'default'}
          hint={saved && updatedAt ? `updated ${formatRelative(updatedAt)}` : 'not saved yet'}
        />
      </div>

      {!saved ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Showing the default table (everything in-app) — this tenant has not saved a routing
          table yet.
        </p>
      ) : null}

      <RequirePermission perm="integrations.write" required={['admin', 'owner']} readOnly>
        <Editor routes={routes} saved={saved} />
      </RequirePermission>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="Notification routing"
      description="Route each category of organization event to in-app notifications, a shared email address, or a Slack-compatible webhook. Event delivery follows this table; per-endpoint payload webhooks live under Connectivity → Webhooks."
      required={['admin', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

function Editor({ routes, saved }: { routes: NotificationRoutes; saved: boolean }) {
  const save = useSaveNotificationRouting()
  const test = useTestNotificationRoute()
  const [draft, setDraft] = useState<NotificationRoutes>(routes)
  const [lastResult, setLastResult] = useState<
    { category: NotificationCategory; result: RouteTestResult } | null
  >(null)

  useEffect(() => {
    setDraft(routes)
  }, [routes])

  const dirty = JSON.stringify(draft) !== JSON.stringify(routes)

  const routeInvalid = (r: NotificationRoutes[NotificationCategory]) => {
    if (!r.enabled) return false
    if (r.channel === 'email') return !isValidEmail(r.target)
    if (r.channel === 'webhook') return !isValidHttpUrl(r.target)
    return false
  }
  const invalid = NOTIFICATION_CATEGORIES.some((c) => routeInvalid(draft[c.id]))

  const update = (
    id: NotificationCategory,
    patch: Partial<NotificationRoutes[NotificationCategory]>,
  ) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))

  const saveBar = (
    <div className="flex items-center gap-2">
      <SecondaryButton disabled={!dirty || save.isPending} onClick={() => setDraft(routes)}>
        Reset
      </SecondaryButton>
      <PrimaryButton
        disabled={!dirty || invalid || save.isPending}
        onClick={() => save.mutate(draft)}
      >
        {save.isPending ? 'Saving…' : 'Save routing'}
      </PrimaryButton>
    </div>
  )

  return (
    <>
      <SettingsCard
        title="Routing table"
        description="One route per category. Disabled categories stay silent everywhere."
        actions={saveBar}
      >
        <div className="space-y-2">
          {NOTIFICATION_CATEGORIES.map((c) => {
            const r = draft[c.id]
            const bad = routeInvalid(r)
            const testable =
              r.channel === 'webhook' && Boolean(r.target) && !bad && saved && !dirty
            const testingThis = test.isPending && test.variables === c.id
            return (
              <div
                key={c.id}
                className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-content">{c.label}</span>
                      {!r.enabled ? <StatusBadge kind="paused">muted</StatusBadge> : null}
                    </div>
                    <p className="mt-0.5 max-w-md text-[12px] text-content-muted">
                      {c.description}
                    </p>
                  </div>
                  <ToggleField
                    checked={r.enabled}
                    onChange={(v) => update(c.id, { enabled: v })}
                    label={r.enabled ? 'On' : 'Off'}
                  />
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)_auto]">
                  <SelectField<NotificationChannel>
                    value={r.channel}
                    onChange={(v) =>
                      update(c.id, { channel: v, target: v === 'in-app' ? '' : r.target })
                    }
                    options={NOTIFICATION_CHANNELS}
                  />
                  {r.channel === 'in-app' ? (
                    <p className="self-center text-[12px] text-content-subtle">
                      Delivered to the console notification tray.
                    </p>
                  ) : (
                    <div className="min-w-0">
                      <TextField
                        type={r.channel === 'email' ? 'email' : 'url'}
                        mono={r.channel === 'webhook'}
                        value={r.target}
                        onChange={(v) => update(c.id, { target: v })}
                        placeholder={
                          r.channel === 'email'
                            ? 'platform-alerts@acme.com'
                            : 'https://hooks.slack.com/services/…'
                        }
                      />
                      {bad ? (
                        <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
                          {r.channel === 'email'
                            ? 'Enter a valid email address.'
                            : 'Enter an http(s) URL.'}
                        </p>
                      ) : null}
                    </div>
                  )}
                  {r.channel === 'webhook' ? (
                    <SecondaryButton
                      disabled={!testable || test.isPending}
                      onClick={() => {
                        setLastResult(null)
                        test.mutate(c.id, {
                          onSuccess: (result) => setLastResult({ category: c.id, result }),
                        })
                      }}
                    >
                      {testingThis ? 'Testing…' : 'Test'}
                    </SecondaryButton>
                  ) : null}
                </div>

                {r.channel === 'webhook' && !saved ? (
                  <p className="mt-2 text-[11px] text-content-subtle">
                    Save the routing table to enable the reachability test.
                  </p>
                ) : null}
                {r.channel === 'webhook' && saved && dirty ? (
                  <p className="mt-2 text-[11px] text-content-subtle">
                    Save your changes to test the updated URL.
                  </p>
                ) : null}

                {lastResult?.category === c.id ? (
                  <p
                    className={
                      lastResult.result.ok
                        ? 'mt-2 text-[11px] text-emerald-700 dark:text-emerald-400'
                        : 'mt-2 text-[11px] text-rose-700 dark:text-rose-400'
                    }
                  >
                    {lastResult.result.detail}
                  </p>
                ) : r.lastTestAt ? (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-content-subtle">
                    <StatusBadge kind={r.lastTestOk ? 'healthy' : 'failed'}>
                      {r.lastTestOk ? 'reachable' : 'failed'}
                    </StatusBadge>
                    last tested {formatRelative(r.lastTestAt)}
                    {r.lastTestDetail ? ` — ${r.lastTestDetail}` : ''}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
      </SettingsCard>

      {test.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(test.error as Error)?.message ?? 'The reachability test failed to run.'}
        </p>
      ) : null}
      {save.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the routing table.'}
        </p>
      ) : null}
      {save.isSuccess && !dirty ? (
        <p className="text-[12px] text-emerald-700 dark:text-emerald-400">Routing saved.</p>
      ) : null}
    </>
  )
}

export default NotificationRouting
