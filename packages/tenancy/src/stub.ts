import type { Tenant } from './types.ts'

export const STUB_TENANTS: Tenant[] = [
  {
    id: 'acme',
    name: 'Acme Corp',
    description: 'Flagship tenant',
    namespacePrefix: 'acme',
    giteaOrg: 'acme',
    argoProject: 'acme',
    harborProject: 'acme',
    planeWorkspace: 'acme',
  },
  {
    id: 'globex',
    name: 'Globex',
    namespacePrefix: 'globex',
    giteaOrg: 'globex',
    argoProject: 'globex',
    harborProject: 'globex',
    planeWorkspace: 'globex',
  },
]
