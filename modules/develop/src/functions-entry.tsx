import { Functions } from './views/functions.tsx'

/**
 * Functions as its own federated entry, for Deliver → Functions
 * (`/deliver?section=functions`).
 *
 * Develop → Functions is where functions are managed; Deliver shows the SAME
 * component in delivery mode — the drawer opens on its Delivery tab (Kargo
 * stages, freight, the Deploy tab's promote action) — so the two sections can
 * never drift into two tables that disagree, the way the old Deliver view
 * (a read-only table of the `adhar-system` namespace) did.
 */
export default function DevelopFunctions() {
  return (
    <div className='space-y-6'>
      <Functions mode='delivery' />
    </div>
  )
}
