/**
 * Single source of truth for every federated remote.
 * Consumed by:
 *   - packages/build-config/src/host.ts   — to wire the host's `remotes` map
 *   - scripts/dev.ts                      — to spawn each `deno task dev`
 *   - scripts/build.ts                    — to run each `deno task build`
 *     and copy its `dist/` into the host's `public/mf/<name>/`
 */
export interface RemoteDescriptor {
  /** Directory-level name; also the MF `name` and URL segment. */
  name: string
  /** Vite dev server port. Matches conventions in each module's deno.json. */
  port: number
  /** Folder under `modules/` — almost always equal to `name`. */
  dir: string
}

export const REMOTES = [
  { name: 'define', port: 5101, dir: 'define' },
  { name: 'design', port: 5102, dir: 'design' },
  { name: 'develop', port: 5103, dir: 'develop' },
  { name: 'deliver', port: 5104, dir: 'deliver' },
  { name: 'discover', port: 5105, dir: 'discover' },
  { name: 'decide', port: 5106, dir: 'decide' },
  { name: 'platform', port: 5107, dir: 'platform' },
  { name: 'workspace', port: 5108, dir: 'workspace' },
] as const satisfies readonly RemoteDescriptor[]

export type RemoteName = (typeof REMOTES)[number]['name']
