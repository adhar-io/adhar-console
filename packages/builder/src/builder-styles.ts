/**
 * The builder's chrome stylesheet, scoped to `.adhar-builder`.
 *
 * The standalone builder shipped a global stylesheet: a Tailwind entry, a
 * shadcn-style `:root` palette, `*` scrollbar and border rules, and component
 * classes like `.tab` and `.dropdown`. Loaded inside the console that would
 * restyle the host. Everything here is nested under `.adhar-builder` instead,
 * and the palette is not a palette of its own — every `--b-*` token points at
 * a console token (`--color-surface-*`, `--color-content-*`, `--color-edge-*`,
 * `--color-brand-*`). The console swaps those under `.dark`, so the builder
 * follows the console's light/dark mode with no theme logic of its own.
 *
 * The utilities (`bg-card`, `text-muted-foreground`, `border-border`, …) are
 * compiled by the console's single Tailwind build: `apps/console/app/styles.css`
 * scans this package and maps those names onto `--b-*` with `@theme inline`.
 * Outside `.adhar-builder` the `--b-*` variables are undefined, so the names
 * do nothing anywhere else in the console.
 *
 * The design canvas (the artboard and the preview) overrides `--b-*` again
 * with the selected design theme preset — that is what a user is designing,
 * not the console's chrome.
 *
 * Imported as a string and injected once (see `ensureStyle`): a federated
 * remote's CSS file is never loaded by the host.
 */
export const BUILDER_CSS = String.raw`
.adhar-builder {
  --b-background: var(--color-surface-app);
  --b-foreground: var(--color-content);
  --b-card: var(--color-surface-raised);
  --b-card-foreground: var(--color-content);
  --b-popover: var(--color-surface-raised);
  --b-popover-foreground: var(--color-content);
  --b-primary: var(--color-brand-600);
  --b-primary-foreground: #fff;
  --b-secondary: var(--color-surface-sunken);
  --b-secondary-foreground: var(--color-content);
  --b-muted: var(--color-surface-sunken);
  --b-muted-foreground: var(--color-content-muted);
  --b-accent: var(--color-surface-hover);
  --b-accent-foreground: var(--color-content);
  --b-destructive: oklch(0.586 0.253 17.585);
  --b-destructive-foreground: #fff;
  --b-border: var(--color-edge-default);
  --b-input: var(--color-edge-strong);
  --b-ring: var(--color-brand-500);
  --b-canvas: var(--color-surface-sunken);
  --b-canvas-dot: var(--color-edge-strong);
  --b-canvas-dark: var(--color-code);
  color: var(--b-foreground);
  font-family: var(--font-sans);
}

.adhar-builder *,
.adhar-builder ::before,
.adhar-builder ::after {
  border-color: var(--b-border);
}

.adhar-builder ::selection {
  background: color-mix(in oklab, var(--b-primary) 15%, transparent);
  color: var(--b-foreground);
}

/* Icon button — 28px square */
.adhar-builder .btn-icon {
  height: 1.75rem; width: 1.75rem; border-radius: 0.375rem;
  display: flex; align-items: center; justify-content: center;
  color: var(--b-muted-foreground);
  transition: color 0.15s, background-color 0.15s;
}
.adhar-builder .btn-icon:hover { color: var(--b-foreground); background: var(--b-accent); }
.adhar-builder .btn-icon:active { background: var(--b-accent); transform: scale(0.95); }
.adhar-builder .btn-icon:disabled { opacity: 0.25; pointer-events: none; }
.adhar-builder .btn-icon:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in oklab, var(--b-ring) 40%, transparent); }

/* Small icon button — 24px */
.adhar-builder .btn-icon-sm {
  height: 1.5rem; min-width: 24px; padding: 0 0.125rem; border-radius: 0.375rem;
  display: flex; align-items: center; justify-content: center;
  color: var(--b-muted-foreground);
  transition: color 0.15s, background-color 0.15s, transform 0.1s;
}
.adhar-builder .btn-icon-sm:hover { color: var(--b-foreground); background: var(--b-accent); }
.adhar-builder .btn-icon-sm:active { transform: scale(0.93); }
.adhar-builder .btn-icon-sm:disabled { opacity: 0.25; pointer-events: none; }
.adhar-builder .btn-icon-sm:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in oklab, var(--b-ring) 40%, transparent); }
.adhar-builder .btn-icon-sm.active { background: color-mix(in oklab, var(--b-primary) 10%, transparent); color: var(--b-primary); }

/* Input — 28px */
.adhar-builder .input-sm {
  height: 1.75rem; width: 100%; border-radius: 0.375rem; padding: 0 0.5rem; font-size: 0.75rem;
  border: 1px solid var(--b-input);
  background: var(--b-background);
  color: var(--b-foreground);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.adhar-builder .input-sm::placeholder { color: color-mix(in oklab, var(--b-muted-foreground) 55%, transparent); }
.adhar-builder .input-sm:focus { outline: none; border-color: var(--b-ring); box-shadow: 0 0 0 2px color-mix(in oklab, var(--b-ring) 15%, transparent); }

.adhar-builder .panel-section {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 0.75rem; cursor: pointer; user-select: none;
  font-size: 0.75rem; font-weight: 500;
  color: var(--b-muted-foreground);
  transition: color 0.15s;
}
.adhar-builder .panel-section:hover { color: var(--b-foreground); }

.adhar-builder .label-xs {
  display: block; margin-bottom: 0.25rem; font-size: 0.75rem; font-weight: 500;
  color: var(--b-muted-foreground);
}

/* Toggle group — pill container */
.adhar-builder .toggle-group {
  display: flex; align-items: center; border-radius: 0.5rem; padding: 3px;
  border: 1px solid color-mix(in oklab, var(--b-border) 60%, transparent);
  background: color-mix(in oklab, var(--b-muted) 70%, transparent);
}
.adhar-builder .toggle-group > button {
  height: 1.5rem; padding: 0 0.5rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 500;
  color: var(--b-muted-foreground);
  transition: color 0.15s, background-color 0.15s, box-shadow 0.15s;
}
.adhar-builder .toggle-group > button:hover { color: var(--b-foreground); }
.adhar-builder .toggle-group > button:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in oklab, var(--b-ring) 30%, transparent); }
.adhar-builder .toggle-group > button.active {
  background: var(--b-background);
  color: var(--b-foreground);
  box-shadow: 0 1px 3px color-mix(in oklab, var(--b-foreground) 6%, transparent), 0 0 0 1px color-mix(in oklab, var(--b-border) 50%, transparent);
}

/* Dropdown popover */
.adhar-builder .dropdown {
  position: absolute; border-radius: 0.75rem; padding: 0.375rem 0; z-index: 100; min-width: 180px;
  animation: ab-scale-in 0.15s ease-out;
  background: var(--b-popover);
  border: 1px solid color-mix(in oklab, var(--b-border) 80%, transparent);
  box-shadow: var(--shadow-lg);
}
.adhar-builder .dropdown-item {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  padding: 0.375rem 0.75rem; font-size: 0.75rem; text-align: left; border-radius: 0.375rem;
  margin: 0 0.125rem; max-width: calc(100% - 4px);
  color: var(--b-foreground);
  transition: background-color 0.1s;
}
.adhar-builder .dropdown-item:disabled { opacity: 0.25; pointer-events: none; }
.adhar-builder .dropdown-item:hover,
.adhar-builder .dropdown-item:focus-visible { outline: none; background: var(--b-accent); }
.adhar-builder .dropdown-separator { height: 1px; margin: 0.375rem 0.5rem; background: color-mix(in oklab, var(--b-border) 60%, transparent); }

/* Activity bar item */
.adhar-builder .activity-item {
  width: 2.25rem; height: 2.25rem; border-radius: 0.5rem;
  display: flex; align-items: center; justify-content: center;
  color: var(--b-muted-foreground);
  transition: color 0.15s, background-color 0.15s;
}
.adhar-builder .activity-item:hover { color: var(--b-foreground); background: var(--b-accent); }
.adhar-builder .activity-item:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in oklab, var(--b-ring) 30%, transparent); }
.adhar-builder .activity-item.active {
  background: color-mix(in oklab, var(--b-primary) 10%, transparent);
  color: var(--b-primary);
}

.adhar-builder .scrollbar-none { scrollbar-width: none; -ms-overflow-style: none; }
.adhar-builder .scrollbar-none::-webkit-scrollbar { display: none; }

@keyframes ab-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ab-scale-in { from { opacity: 0; transform: scale(0.97) translateY(-2px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes ab-slide-down { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ab-slide-up { from { opacity: 0; margin-bottom: -6px; } to { opacity: 1; margin-bottom: 0; } }
.adhar-builder .animate-fade-in { animation: ab-fade-in 0.2s ease-out; }
.adhar-builder .animate-scale-in { animation: ab-scale-in 0.15s ease-out; }
.adhar-builder .animate-slide-down { animation: ab-slide-down 0.15s ease-out; }
.adhar-builder .animate-slide-up { animation: ab-slide-up 0.2s ease-out; }

/* React Flow, themed to the builder tokens */
.adhar-builder .react-flow__node { cursor: grab; }
.adhar-builder .react-flow__node.selected { cursor: default; }
.adhar-builder .react-flow__pane { cursor: default; }
.adhar-builder .react-flow__edge-path { stroke: var(--b-border); stroke-width: 1.5; }
.adhar-builder .react-flow__edge.animated .react-flow__edge-path { stroke: color-mix(in oklab, var(--b-primary) 50%, transparent); }
.adhar-builder .react-flow__handle { opacity: 0; transition: opacity 0.15s; }
.adhar-builder .react-flow__node:hover .react-flow__handle,
.adhar-builder .react-flow__node.selected .react-flow__handle { opacity: 1; }
.adhar-builder .react-flow__minimap { border-radius: 0.75rem; background: var(--b-card); }
.adhar-builder .react-flow__controls { border-radius: 0.75rem; overflow: hidden; }
.adhar-builder .react-flow__controls button { background: var(--b-card); color: var(--b-foreground); border-color: var(--b-border); fill: currentColor; }
.adhar-builder .react-flow__controls button:hover { background: var(--b-accent); }
.adhar-builder .react-flow__background { opacity: 0.5; }
.adhar-builder .react-flow__selection { background: color-mix(in oklab, var(--b-primary) 5%, transparent); border: 1px solid color-mix(in oklab, var(--b-primary) 30%, transparent); }

/* Mermaid output keeps its own palette; let it size to its container. */
.adhar-builder .diagram-render svg { max-width: 100%; height: auto; }
`
