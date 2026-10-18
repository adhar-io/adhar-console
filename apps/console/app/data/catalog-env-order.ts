/**
 * Promotion order of an environment key — dev → test → prod, the platform's
 * chain (`globals.PlatformEnvironmentsCSV`). Unknown keys sort between the
 * known pre-production tiers and production. Kept dependency-free so every
 * tab (Deployment, Resources, Tech stack) and its tests can share it.
 */
export function envOrder(key: string): number {
  const k = key.toLowerCase()
  if (k === 'dev' || k === 'development') return 0
  if (k === 'sandbox' || k === 'preview') return 1
  if (k === 'qa' || k === 'test') return 2
  if (k === 'uat') return 3
  if (k.startsWith('stag') || k === 'stg') return 4
  if (k === 'canary') return 5
  if (k.startsWith('prod')) return 7
  return 6
}
