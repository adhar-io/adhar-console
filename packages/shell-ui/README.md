# @adhar-console/shell-ui

The components that make every phase look like the same product.

## Exports

- `AppShell` — sidebar + topbar + main content, with tenant switcher,
  breadcrumbs, error boundary, and optional notifications + platform version.
- `Sidebar`, `Topbar`, `PhaseNav`, `TenantSwitcher`, `Breadcrumbs` — the
  pieces composed by `AppShell`, reusable individually.
- `PageHeader` — title + description + optional action slot.
- `DataTable` — generic table with `Column<T>` + row-key + empty-state.
- `StatusBadge` — color-coded pill (`healthy | degraded | progressing |
  paused | failed | unknown | info`).
- `EmptyState` — centered empty view with optional action.
- `ErrorBoundary` — friendly fallback + reset button.

## Principles

- Zero backing-tool-specific knowledge. Every primitive is generic over
  `T`.
- Tailwind-first; no CSS-in-JS.
- Reads theming tokens from `@adhar-ui/tokens` via the app's global CSS.
- Small API surface — if a component starts growing config knobs, prefer
  composition over options.
