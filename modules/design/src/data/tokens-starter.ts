import type { TokenSet } from './types.ts'

/**
 * The Adhar starter design-token set — a TEMPLATE. It is only ever written to
 * the tenant's store (kind `design.token-set`) when the user explicitly picks
 * "Start from the Adhar starter set" (or "Reset"); with no stored set the
 * Tokens view shows an empty state instead. `mergeDefaults` also uses it to
 * fill a category a stored document lacks entirely.
 *
 * Colours carry an optional `dark` value (absent = same in both modes). The
 * stored shape is otherwise unchanged, so older readers keep working.
 */
export const DEFAULT_TOKENS: TokenSet = {
  color: [
    { name: '--adhar-color-primary', value: '#0f172a', role: 'Primary', dark: '#f8fafc' },
    { name: '--adhar-color-accent', value: '#4f46e5', role: 'Accent / link', dark: '#818cf8' },
    { name: '--adhar-color-success', value: '#059669', role: 'Success', dark: '#34d399' },
    { name: '--adhar-color-warning', value: '#b45309', role: 'Warning', dark: '#fbbf24' },
    { name: '--adhar-color-danger', value: '#e11d48', role: 'Danger', dark: '#fb7185' },
    { name: '--adhar-color-surface', value: '#ffffff', role: 'Page surface', dark: '#0b1120' },
    { name: '--adhar-color-text', value: '#0f172a', role: 'Body text', dark: '#e2e8f0' },
    { name: '--adhar-color-muted', value: '#f1f5f9', role: 'Muted surface', dark: '#1e293b' },
    { name: '--adhar-color-border', value: '#e2e8f0', role: 'Border', dark: '#334155' },
  ],
  spacing: [
    { name: '--adhar-space-1', value: '4px' },
    { name: '--adhar-space-2', value: '8px' },
    { name: '--adhar-space-3', value: '12px' },
    { name: '--adhar-space-4', value: '16px' },
    { name: '--adhar-space-6', value: '24px' },
    { name: '--adhar-space-8', value: '32px' },
    { name: '--adhar-space-12', value: '48px' },
    { name: '--adhar-space-16', value: '64px' },
  ],
  typography: [
    { name: '--adhar-font-sans', value: 'Inter, system-ui, sans-serif' },
    { name: '--adhar-font-mono', value: 'JetBrains Mono, ui-monospace' },
    { name: '--adhar-text-xs', value: '12px / 16px' },
    { name: '--adhar-text-sm', value: '14px / 20px' },
    { name: '--adhar-text-base', value: '16px / 24px' },
    { name: '--adhar-text-lg', value: '18px / 28px' },
    { name: '--adhar-text-xl', value: '20px / 28px' },
    { name: '--adhar-text-2xl', value: '24px / 32px' },
  ],
  radius: [
    { name: '--adhar-radius-sm', value: '4px' },
    { name: '--adhar-radius-md', value: '8px' },
    { name: '--adhar-radius-lg', value: '12px' },
    { name: '--adhar-radius-xl', value: '16px' },
    { name: '--adhar-radius-2xl', value: '20px' },
    { name: '--adhar-radius-full', value: '9999px' },
  ],
  elevation: [
    { name: '--adhar-shadow-sm', value: '0 1px 2px rgba(15,23,42,0.05)' },
    { name: '--adhar-shadow-md', value: '0 4px 6px -1px rgba(15,23,42,0.08)' },
    { name: '--adhar-shadow-lg', value: '0 10px 15px -3px rgba(15,23,42,0.10)' },
    { name: '--adhar-shadow-xl', value: '0 20px 25px -5px rgba(15,23,42,0.12)' },
  ],
  motion: [
    { name: '--adhar-duration-fast', value: '120ms', curve: 'ease-out' },
    { name: '--adhar-duration-base', value: '200ms', curve: 'cubic-bezier(0.4, 0, 0.2, 1)' },
    { name: '--adhar-duration-slow', value: '320ms', curve: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    { name: '--adhar-duration-page', value: '500ms', curve: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  ],
  breakpoint: [
    { name: '--adhar-bp-sm', value: '640px', label: 'Phone landscape' },
    { name: '--adhar-bp-md', value: '768px', label: 'Tablet portrait' },
    { name: '--adhar-bp-lg', value: '1024px', label: 'Tablet landscape / laptop' },
    { name: '--adhar-bp-xl', value: '1280px', label: 'Desktop' },
    { name: '--adhar-bp-2xl', value: '1536px', label: 'Wide desktop' },
  ],
}
