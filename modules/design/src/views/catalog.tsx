/**
 * Embeds the adhar-ui Storybook as the canonical component catalog.
 * Storybook runs on its own Vite dev server in the adhar-ui repo.
 */
export function Catalog() {
  const storybookUrl =
    (globalThis as { __ADHAR_STORYBOOK_URL__?: string }).__ADHAR_STORYBOOK_URL__ ??
    'http://localhost:6006'
  return (
    <div className="overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
      <div className="border-b border-edge-default bg-surface-sunken px-4 py-2 text-xs text-content-muted">
        Embedded adhar-ui Storybook — <code>{storybookUrl}</code>
      </div>
      <iframe
        title="Adhar UI Storybook"
        src={storybookUrl}
        className="block h-[calc(100vh-320px)] w-full border-0"
      />
    </div>
  )
}
