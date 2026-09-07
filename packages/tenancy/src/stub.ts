import type { Tenant } from './types.ts'

/**
 * The built-in default organization.
 *
 * This is NOT a demo company — it is the organization every install starts
 * with, and what a super-admin sees before any organization has been
 * onboarded. Onboarding creates real organizations through
 * `/api/organizations`; the shell's switcher lists those and only falls back to
 * this default while the live list is loading or when signed out. It is fully
 * manageable (rename / delete / switch) like any other organization. Nothing in
 * the console is hardcoded to a made-up company name.
 */
export const DEFAULT_TENANT: Tenant = {
  id: 'default',
  name: 'Default Organization',
  description: 'Built-in organization',
  namespacePrefix: 'default',
  giteaOrg: 'adhar',
  argoProject: 'default',
  harborProject: 'library',
  planeWorkspace: 'adhar',
}

/** The tenant list before the live `/api/organizations` list loads. */
export const STUB_TENANTS: Tenant[] = [DEFAULT_TENANT]
