import { useEffect, useMemo } from 'react'
import {
  ErrorBoundary,
  PageHeader,
  Tabs,
  XR_FAMILIES,
  xrSectionsOf,
  type TabDef,
  type XrSection,
} from '@adhar/shell-ui'
import { ConnectionGate } from '../components/connection-banner.tsx'
import { useXrds } from '../data/xrds.ts'
import { XrListForKind } from './xr-kinds.tsx'

/**
 * One Adhar Resources category — Data, Messaging, Security… — with its kinds
 * as tabs. The category is chosen in the sidebar (one row each, built from the
 * same xr-sections.ts registry); this page moves between its kinds, and every
 * pick is a URL (`?section=<kind>`), so Back, reload and shared links land on
 * the same tab.
 */
export function XrFamilyPage({ section, namespace }: { section: XrSection; namespace?: string }) {
  const family = XR_FAMILIES.find((f) => f.id === section.family)
  const pages = useMemo(() => xrSectionsOf(section.family), [section.family])
  // Already fetched once for the page below (one cached XRD list) — used here
  // only to mute the tabs of kinds this cluster does not have.
  const xrds = useXrds()
  const installed = useMemo(() => new Set((xrds.data ?? []).map((x) => x.plural)), [xrds.data])

  const tabs: TabDef[] = pages.map((p) => {
    const missing = Boolean(xrds.data) && !installed.has(p.plural)
    return {
      id: p.id,
      label: missing ? (
        <span className="opacity-60" title="Not installed on this cluster">
          {p.label}
        </span>
      ) : (
        p.label
      ),
    }
  })

  return (
    <div className="space-y-6">
      <PageHeader title={family?.label ?? section.label} />
      <ConnectionGate>
        <Tabs tabs={tabs} value={section.id} onChange={goToSection} ariaLabel={family?.label}>
          {() => (
            // One kind failing must not take the category's other tabs with it.
            <ErrorBoundary key={section.id}>
              <RevealTab id={section.id} />
              <XrListForKind key={section.id} label={section.label} resource={section.plural} namespace={namespace} />
            </ErrorBoundary>
          )}
        </Tabs>
      </ConnectionGate>
    </div>
  )
}

/**
 * A deep link to a late tab must not open with it scrolled out of the strip.
 * Rendered inside the panel so it runs once the tab row is in the DOM (the
 * row only mounts after the connection check).
 */
function RevealTab({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(`tab-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [id])
  return null
}

/** Change tab AND the URL — a history entry the host router hears. */
function goToSection(id: string) {
  const url = new URL(globalThis.location.href)
  url.searchParams.set('section', id)
  history.pushState(history.state, '', `${url.pathname}${url.search}`)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}
