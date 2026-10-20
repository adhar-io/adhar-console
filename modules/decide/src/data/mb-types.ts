/**
 * Metabase wire types for the pure BI helpers, imported straight from the
 * client's `types.ts` (type-only, erased at build) rather than through the
 * `@adhar/api-clients` barrel — so `deno test` on these helpers type-checks
 * without dragging in every other client.
 */
export type * from '../../../../packages/api-clients/src/metabase/types.ts'
