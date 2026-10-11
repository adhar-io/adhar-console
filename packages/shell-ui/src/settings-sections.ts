/**
 * Workspace settings, by category — one registry for the main sidebar (one row
 * per category) and the settings page (one tab per page of the category the URL
 * is in). `sections` are the `?section=` ids, in tab order; the first is where
 * the category's sidebar row lands.
 */

export interface SettingsCategory {
  id: string
  label: string
  caption: string
  sections: readonly string[]
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'organization', label: 'Organization', caption: 'Identity, people and access shape', sections: ['organization', 'branding', 'members', 'teams', 'roles'] },
  { id: 'identity', label: 'Identity & access', caption: 'Authentication and authorization', sections: ['sso', 'mfa', 'ip-allowlist'] },
  { id: 'security', label: 'Security & compliance', caption: 'Policy, audit and frameworks', sections: ['security', 'audit', 'compliance', 'approvals'] },
  { id: 'workloads', label: 'Workloads', caption: 'Clouds, projects and environments', sections: ['clouds', 'projects', 'environments', 'defaults'] },
  { id: 'connectivity', label: 'Connectivity', caption: 'Tools, tokens and events', sections: ['integrations', 'tokens', 'webhooks', 'notifications'] },
  { id: 'billing', label: 'Billing & finance', caption: 'Plan, invoices and costs', sections: ['plan', 'usage', 'payments', 'invoices', 'cost-centers', 'budgets', 'allocation'] },
  { id: 'preferences', label: 'Preferences', caption: 'Previews, appearance and the danger zone', sections: ['features', 'theming', 'danger'] },
]

/** The category a section belongs to (the first one when the section is unknown). */
export function settingsCategoryOf(section: string | undefined): SettingsCategory {
  return SETTINGS_CATEGORIES.find((c) => section && c.sections.includes(section)) ?? SETTINGS_CATEGORIES[0]
}
