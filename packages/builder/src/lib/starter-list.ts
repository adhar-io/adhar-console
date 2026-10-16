/** What a new Visual Designer project can start from. */
export const STARTERS = [
  { id: 'blank', label: 'Blank app', description: 'One empty page — build from the palette.' },
  { id: 'crud', label: 'Admin (CRUD)', description: 'Sidebar, customer table bound to data, create form, delete dialog.' },
  { id: 'dashboard', label: 'Dashboard', description: 'Stats, chart, orders table and a settings page.' },
  { id: 'landing', label: 'Marketing site', description: 'Landing, pricing and contact pages, linked up.' },
  { id: 'auth', label: 'Auth flow', description: 'Sign in → dashboard, sign up, with validated forms.' },
] as const

export type StarterId = (typeof STARTERS)[number]['id']
