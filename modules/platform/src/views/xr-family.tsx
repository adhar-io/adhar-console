import { useMemo } from 'react'
import { XR_FAMILIES, xrSectionsOf, type TabDef, type XrSection } from '@adhar/shell-ui'
import { CategoryPage } from '../components/category-page.tsx'
import { useXrds } from '../data/xrds.ts'
import { XrListForKind } from './xr-kinds.tsx'

/**
 * One Adhar Resources category — Data, Messaging, Security… — with its kinds
 * as tabs, from the same xr-sections.ts registry the sidebar is built from.
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
    <CategoryPage title={family?.label ?? section.label} tabs={tabs} active={section.id}>
      <XrListForKind key={section.id} label={section.label} resource={section.plural} namespace={namespace} />
    </CategoryPage>
  )
}
