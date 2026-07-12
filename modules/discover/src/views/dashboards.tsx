import { useEffect, useState } from 'react'
import { Card, CardBody, CardHeader, EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { grafanaEmbedUrl, useGrafanaDashboards } from '../data/observability.ts'

/**
 * Grafana boards — list every dashboard returned by the LGTM client and
 * embed the selected one as a kiosk-mode iframe.
 */
export function Dashboards() {
  const q = useGrafanaDashboards()
  const [activeUid, setActiveUid] = useState<string | null>(null)

  useEffect(() => {
    if (!activeUid && q.data?.length) setActiveUid(q.data[0].uid)
  }, [q.data, activeUid])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading boards…
      </div>
    )
  }
  const list = q.data ?? []
  const active = list.find((d) => d.uid === activeUid)

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Boards</div>
            <StatusBadge kind="info">{list.length}</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          {list.length === 0 ? (
            <EmptyState compact title="No dashboards" />
          ) : (
            <ul className="max-h-[70vh] divide-y divide-edge-subtle overflow-y-auto">
              {list.map((d) => (
                <li key={d.uid}>
                  <button
                    type="button"
                    onClick={() => setActiveUid(d.uid)}
                    className={cn(
                      'block w-full px-4 py-2.5 text-left transition-colors',
                      activeUid === d.uid ? 'bg-brand-50' : 'hover:bg-surface-sunken',
                    )}
                  >
                    <div className="text-sm font-semibold text-content">{d.title}</div>
                    <div className="mt-0.5 text-[11px] text-content-subtle">
                      {d.folder ?? '—'}
                    </div>
                    {d.tags?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {d.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-surface-sunken px-1.5 py-0.5 font-mono text-[9px] text-content-subtle"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-content">{active?.title ?? '—'}</div>
              <div className="text-[11px] text-content-subtle">{active?.folder ?? ''}</div>
            </div>
            {active ? (
              <a
                href={grafanaEmbedUrl(active.uid)}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                Open in Grafana ↗
              </a>
            ) : null}
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          {active ? (
            <iframe
              key={active.uid}
              title={active.title}
              src={grafanaEmbedUrl(active.uid)}
              className="block h-[70vh] w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            />
          ) : (
            <EmptyState compact title="Pick a dashboard" />
          )}
        </CardBody>
      </Card>
    </div>
  )
}
