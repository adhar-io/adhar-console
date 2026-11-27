/**
 * Test support for the corpus (never imported by the app).
 *
 * The platform's catalogue templates are Go templates first: Argo's own
 * `{{…}}` is wrapped in a raw-string action so the seed-time render leaves it
 * alone, and `{{ .PlatformImage }}` is filled in with the image the control
 * plane runs. `renderStackTemplate` does what that render does for exactly
 * those two forms, which are the only ones the files use; `roundtrip_test.ts`
 * fails if a third appears, and (when the adhar checkout is next door) if a
 * vendored copy under `corpus/platform/` no longer matches its source.
 */

export const CORPUS_PLATFORM_IMAGE = 'ghcr.io/adhar-io/adhar:0.0.0-corpus'

export function renderStackTemplate(text: string): string {
  return text.replace(/\{\{`([^`]*)`\}\}/g, '$1').replace(/\{\{\s*\.PlatformImage\s*\}\}/g, CORPUS_PLATFORM_IMAGE)
}

/** A Go template action the render above does not handle. */
export function unrenderedAction(text: string): string | undefined {
  return /\{\{-?\s*(?:\.|if\b|range\b|with\b|end\b|else\b|template\b|define\b|\$)[^}]*\}\}/.exec(text)?.[0]
}

const PKG = 'platform/stack/packages/application/argo-workflows/manifests'

/** corpus file → its source in the adhar repository. */
export const PLATFORM_SOURCES: ReadonlyArray<{ corpus: string; source: string; template: boolean }> = [
  { corpus: 'platform/adhar-steps.yaml', source: `${PKG}/catalog/adhar-steps.yaml.tmpl`, template: true },
  { corpus: 'platform/adhar-batch-steps.yaml', source: `${PKG}/catalog/adhar-batch-steps.yaml.tmpl`, template: true },
  { corpus: 'platform/platform-tasks.yaml', source: `${PKG}/platform-tasks/platform-tasks.yaml`, template: false },
]

/** The adhar checkout: `$ADHAR_DIR`, else the workspace layout the platform's own cross-repo guards assume. */
export async function adharCheckout(consoleRoot: string): Promise<string | undefined> {
  const candidates = [Deno.env.get('ADHAR_DIR'), `${consoleRoot}/../../../Adhar/adhar`, `${consoleRoot}/../adhar`].filter((c): c is string => Boolean(c))
  for (const c of candidates) {
    try {
      if ((await Deno.stat(`${c}/${PKG}/catalog`)).isDirectory) return c
    } catch {
      // not here
    }
  }
  return undefined
}
