/**
 * Inject a stylesheet once per document, by id.
 *
 * The builder ships inside federated remotes, and a remote's own CSS file is
 * never loaded by the console host — so every stylesheet the builder needs
 * (its scoped chrome rules, React Flow's base styles, Monaco's) is imported
 * as a string and appended here the first time a surface that needs it mounts.
 */
export function ensureStyle(id: string, css: string): void {
  if (typeof document === 'undefined' || document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = css
  document.head.appendChild(el)
}
