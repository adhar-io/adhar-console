export interface Tenant {
  id: string
  name: string
  description?: string
  namespacePrefix: string
  giteaOrg: string
  argoProject: string
  harborProject: string
  planeWorkspace: string
  labels?: Record<string, string>
}

export interface TenantScopedParams {
  tenantId: string
}
