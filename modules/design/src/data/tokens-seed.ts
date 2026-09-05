import type { TokenSet } from './types.ts'

/**
 * Canonical default design tokens. The Tokens view shows these until a stored
 * token-set document exists (tenant document store, kind `design.token-set`);
 * the first edit persists the working copy and "Reset to defaults" writes this
 * baseline back. This constant stays the immutable baseline.
 */
export const DEFAULT_TOKENS: TokenSet = {
  color: [
    { name: '--adhar-color-primary', value: '#0f172a', role: 'Primary surface' },
    { name: '--adhar-color-accent', value: '#4f46e5', role: 'Accent / link' },
    { name: '--adhar-color-success', value: '#059669', role: 'Success' },
    { name: '--adhar-color-warning', value: '#d97706', role: 'Warning' },
    { name: '--adhar-color-danger', value: '#e11d48', role: 'Danger' },
    { name: '--adhar-color-muted', value: '#f1f5f9', role: 'Muted surface' },
    { name: '--adhar-color-border', value: '#e2e8f0', role: 'Border' },
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
