import { createContext, useContext, type ReactNode } from 'react'
import type { Tenant } from './types.ts'

export const TenantContext = createContext<Tenant | null>(null)

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
