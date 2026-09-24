import { createContext, useContext, type ReactNode } from 'react'
import { globalSingleton } from '@adhar-console/utils'
import type { Tenant } from './types.ts'

// One context per page, not per bundled copy — see globalSingleton.
export const TenantContext = globalSingleton('tenancy.tenant', () => createContext<Tenant | null>(null))

export function TenantProvider({ tenant, children }: { tenant: Tenant; children: ReactNode }) {
  return <TenantContext.Provider value={tenant}>{children}</TenantContext.Provider>
}

export function useTenant(): Tenant {
  const ctx = useContext(TenantContext)
  if (!ctx) throw new Error('useTenant must be used inside <TenantProvider>')
  return ctx
}

export function useTenantId(): string {
  return useTenant().id
}
