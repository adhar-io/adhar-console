import type { ReactNode } from 'react'
import { ErrorBoundary, PageHeader, Tabs, type TabDef } from '@adhar/shell-ui'
import { ConnectionGate } from './connection-banner.tsx'

/**
 * A sidebar category — Kubernetes "Workloads", Adhar Resources "Data"… — as
 * one page with its pages as tabs. The category is chosen in the sidebar; the
 * tab row moves between its pages, and every pick is a URL
 * (`?section=<page>`), so Back, reload and shared links land on the same tab.
 */
export function CategoryPage({
  title,
  tabs,
  active,
  children,
}: {
  title: string
  tabs: TabDef[]
  active: string
  children: ReactNode
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      {/* The tab row stays outside the connection check: an unreachable
          cluster must not also take away the way to the category's other
          pages. One page failing must not take its siblings with it either. */}
      <Tabs tabs={tabs} value={active} onChange={goToSection} ariaLabel={title}>
        {() => (
          <ErrorBoundary key={active}>
            <ConnectionGate>{children}</ConnectionGate>
          </ErrorBoundary>
        )}
      </Tabs>
    </div>
  )
}

/** Change tab AND the URL — a history entry the host router hears. */
function goToSection(id: string) {
  const url = new URL(globalThis.location.href)
  url.searchParams.set('section', id)
  history.pushState(history.state, '', `${url.pathname}${url.search}`)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}
