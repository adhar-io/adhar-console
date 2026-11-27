import { parse, splitStream, toJS } from './doc.ts'
import type { CatalogueStep } from './kinds.ts'
import { catalogueSteps } from './kinds.ts'

/** Test support (never imported by the app): corpus files and the catalogue the platform ships. */

const here = new URL('./corpus/', import.meta.url)

export function corpusText(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, here))
}

/** The step libraries in `corpus/platform/`, as the cluster would list them. */
export function platformCatalogue(): CatalogueStep[] {
  const cwts: unknown[] = []
  for (const f of ['platform/adhar-steps.yaml', 'platform/adhar-batch-steps.yaml']) {
    for (const part of splitStream(corpusText(f))) {
      const js = toJS(parse(part)) as { kind?: string } | null
      if (js?.kind === 'ClusterWorkflowTemplate') cwts.push(js)
    }
  }
  return catalogueSteps(cwts)
}
