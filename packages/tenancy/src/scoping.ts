import type { Tenant } from './types.ts'

export function namespaceFor(tenant: Tenant, suffix: string): string {
  return `${tenant.namespacePrefix}-${suffix}`
}

export function labelSelectorFor(tenant: Tenant): string {
  return `adhar.io/tenant=${tenant.id}`
}
