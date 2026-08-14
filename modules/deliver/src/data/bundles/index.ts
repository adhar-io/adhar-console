/**
 * Kyverno policy-pack bundles.
 *
 * Each pack ships as a multi-document ClusterPolicy YAML — the artifact an
 * admin downloads and `kubectl apply`s. The `.yaml` files in this directory
 * are authoritative; the `.ts` files mirror them as string constants so the
 * console (a Vite MF remote type-checked with `deno check`) can render and
 * offer them for download without a raw-asset loader.
 */
export { CIS_BASELINE_YAML } from './cis-baseline.ts'
export { SOC2_BASELINE_YAML } from './soc2-baseline.ts'
