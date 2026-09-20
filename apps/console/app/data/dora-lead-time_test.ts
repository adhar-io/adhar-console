import { assertEquals } from 'jsr:@std/assert'
import {
  deployRevisions,
  type HistoryEntry,
  leadTimeSummary,
  parseRepoSlug,
  repoKeys,
} from './dora-lead-time.ts'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const T = Date.UTC(2026, 8, 20, 12, 0, 0)
const HOUR = 3_600_000

/* ─────────── repo URL parsing ─────────── */

Deno.test('an in-cluster Service URL resolves to org/repo', () => {
  // This is the form Argo CD actually stores on an Adhar platform.
  assertEquals(
    parseRepoSlug('http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/packages'),
    { org: 'adhar', repo: 'packages' },
  )
})

Deno.test('a public HTTPS URL with .git resolves the same way', () => {
  assertEquals(parseRepoSlug('https://gitea.cloud.adhar.io/adhar/testui.git'), {
    org: 'adhar',
    repo: 'testui',
  })
})

Deno.test('an SSH remote resolves too, since Argo CD accepts them', () => {
  assertEquals(parseRepoSlug('git@gitea.cloud.adhar.io:adhar/packages.git'), {
    org: 'adhar',
    repo: 'packages',
  })
})

Deno.test('a nested path takes the last two segments', () => {
  assertEquals(parseRepoSlug('https://host/sub/group/org/repo'), { org: 'org', repo: 'repo' })
})

Deno.test('an unusable URL yields null rather than a bogus slug', () => {
  assertEquals(parseRepoSlug(''), null)
  assertEquals(parseRepoSlug('https://host'), null)
  assertEquals(parseRepoSlug('not a url'), null)
})

/* ─────────── history extraction ─────────── */

Deno.test('a multi-source entry is read from revisions[] and sources[]', () => {
  // Every application on a real cluster is multi-source, and reading only the
  // singular `revision`/`source` is why lead time looked underivable.
  const h: HistoryEntry[] = [{
    deployedAt: new Date(T).toISOString(),
    revisions: [SHA],
    sources: [{ repoURL: 'http://gitea/adhar/packages' }],
  }]
  assertEquals(deployRevisions(h, 0), [
    { sha: SHA, org: 'adhar', repo: 'packages', deployedAtMs: T },
  ])
})

Deno.test('a single-source entry still works', () => {
  const h: HistoryEntry[] = [{
    deployedAt: new Date(T).toISOString(),
    revision: SHA,
    source: { repoURL: 'https://gitea/adhar/testui.git' },
  }]
  assertEquals(deployRevisions(h, 0).length, 1)
})

Deno.test('a multi-source deploy counts once, not once per source', () => {
  // Otherwise a three-source application outweighs a single-source one
  // threefold in the median.
  const h: HistoryEntry[] = [{
    deployedAt: new Date(T).toISOString(),
    revisions: [SHA, SHA2],
    sources: [{ repoURL: 'http://g/o/a' }, { repoURL: 'http://g/o/b' }],
  }]
  const got = deployRevisions(h, 0)
  assertEquals(got.length, 1)
  assertEquals(got[0].sha, SHA)
})

Deno.test('the repo falls back to the spec when history omits it', () => {
  const h: HistoryEntry[] = [{ deployedAt: new Date(T).toISOString(), revisions: [SHA] }]
  assertEquals(deployRevisions(h, 0, [{ repoURL: 'http://g/adhar/packages' }])[0].repo, 'packages')
})

Deno.test('entries before the window are excluded', () => {
  const h: HistoryEntry[] = [{
    deployedAt: new Date(T - 100 * HOUR).toISOString(),
    revisions: [SHA],
    sources: [{ repoURL: 'http://g/o/r' }],
  }]
  assertEquals(deployRevisions(h, T), [])
})

Deno.test('a branch name or chart version is not treated as a SHA', () => {
  // Argo CD records whatever the source resolved to; only a 40-hex commit can
  // be looked up, and spending a request on "main" or "1.2.3" finds nothing.
  for (const rev of ['main', 'HEAD', '1.2.3', 'v0.1.34', 'abc123']) {
    const h: HistoryEntry[] = [{
      deployedAt: new Date(T).toISOString(),
      revisions: [rev],
      sources: [{ repoURL: 'http://g/o/r' }],
    }]
    assertEquals(deployRevisions(h, 0), [], rev)
  }
})

Deno.test('entries with no deploy time or no resolvable repo are skipped', () => {
  assertEquals(deployRevisions([{ revisions: [SHA] }], 0), [])
  assertEquals(
    deployRevisions([{ deployedAt: new Date(T).toISOString(), revisions: [SHA] }], 0),
    [],
  )
})

Deno.test('repoKeys dedupes so each repo is fetched once', () => {
  const d = deployRevisions(
    [SHA, SHA2, SHA].map((sha, i) => ({
      deployedAt: new Date(T + i).toISOString(),
      revisions: [sha],
      sources: [{ repoURL: 'http://g/adhar/packages' }],
    })),
    0,
  )
  assertEquals(repoKeys(d), [{ org: 'adhar', repo: 'packages' }])
})

/* ─────────── the median ─────────── */

const dep = (sha: string, hoursAfter: number) => ({
  sha,
  org: 'o',
  repo: 'r',
  deployedAtMs: T + hoursAfter * HOUR,
})

Deno.test('lead time is deploy time minus commit time', () => {
  const s = leadTimeSummary([dep(SHA, 2)], new Map([[SHA, T]]))
  assertEquals(s.medianHours, 2)
  assertEquals(s.sampleSize, 1)
  assertEquals(s.unresolved, 0)
})

Deno.test('SHA lookup is case-insensitive', () => {
  const s = leadTimeSummary([dep(SHA.toUpperCase(), 1)], new Map([[SHA, T]]))
  assertEquals(s.sampleSize, 1)
})

Deno.test('a commit that could not be found is counted as unresolved', () => {
  // Narrower sample than the deploy count implies — worth saying on the tile
  // rather than hiding.
  const s = leadTimeSummary([dep(SHA, 1), dep(SHA2, 5)], new Map([[SHA, T]]))
  assertEquals(s.sampleSize, 1)
  assertEquals(s.unresolved, 1)
  assertEquals(s.medianHours, 1)
})

Deno.test('a negative lead time is discarded, not published', () => {
  // Clock skew between Gitea and the cluster, or a rewritten history.
  const s = leadTimeSummary([dep(SHA, -3)], new Map([[SHA, T]]))
  assertEquals(s.medianHours, null)
  assertEquals(s.sampleSize, 0)
})

Deno.test('nothing resolved means null, not zero', () => {
  const s = leadTimeSummary([dep(SHA, 1)], new Map())
  assertEquals(s.medianHours, null)
  assertEquals(s.unresolved, 1)
})

Deno.test('the median of an even sample averages the middle two', () => {
  const m = new Map([[SHA, T]])
  const s = leadTimeSummary(
    [dep(SHA, 1), dep(SHA, 2), dep(SHA, 4), dep(SHA, 9)],
    m,
  )
  assertEquals(s.medianHours, 3)
})

Deno.test('a slow outlier does not move the median', () => {
  const m = new Map([[SHA, T]])
  const s = leadTimeSummary([dep(SHA, 1), dep(SHA, 1), dep(SHA, 500)], m)
  assertEquals(s.medianHours, 1)
})
