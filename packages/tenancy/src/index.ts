export type { Tenant, TenantScopedParams } from './types.ts'
export { TenantContext, useTenant, useTenantId, TenantProvider } from './context.tsx'
export { namespaceFor, labelSelectorFor } from './scoping.ts'
export { DEFAULT_TENANT, STUB_TENANTS } from './stub.ts'
