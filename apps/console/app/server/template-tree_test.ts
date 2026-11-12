import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { TEMPLATE_TREE_MAX_PAGES, templateTree } from './scaffolder.ts'

/**
 * The templates repository's tree is PAGED by Gitea (1000 entries a page), and
 * the scaffolder used to read page 1 only — so a template whose skeleton fell
 * past it was rendered without those files, and the scaffold said it worked
 * (transaction-service: 35 files, no src/, an empty jar; 2026-11-12).
 */

const entry = (i: number) => ({ path: `templates/t/skeleton/f${i}`, type: 'blob' })

/** A Gitea that holds `total` entries, serves `size` a page, and records what it was asked. */
function gitea(total: number, size = 1000, opts: { ignorePage?: boolean; lie?: number } = {}) {
  const asked: string[] = []
  const all = Array.from({ length: total }, (_, i) => entry(i + 1))
  const api = (path: string) => {
    asked.push(path)
    const page = opts.ignorePage ? 1 : Number(new URL(`http://x${path}`).searchParams.get('page') ?? '1')
    const slice = all.slice((page - 1) * size, page * size)
    return Promise.resolve(
      Response.json({ sha: 'abc123', tree: slice, truncated: page * size < total, total_count: opts.lie ?? total, page }),
    )
  }
  return { api, asked }
}

Deno.test('every page of the tree is read, and later pages are pinned to the SHA the first one resolved', async () => {
  const g = gitea(1142)
  const got = await templateTree(g.api, 'adhar', 'adhar-templates')
  assertEquals(got.length, 1142)
  assertEquals(got[1141].path, 'templates/t/skeleton/f1142')
  assertEquals(g.asked.length, 2)
  assertEquals(g.asked[0], '/repos/adhar/adhar-templates/git/trees/main?recursive=true&per_page=1000&page=1')
  assertEquals(g.asked[1], '/repos/adhar/adhar-templates/git/trees/abc123?recursive=true&per_page=1000&page=2')
})

Deno.test('a collection that fits one page is one request', async () => {
  const g = gitea(917)
  assertEquals((await templateTree(g.api, 'adhar', 'adhar-templates')).length, 917)
  assertEquals(g.asked.length, 1)
})

Deno.test('a server that ignores the page parameter is an error, not a template with doubled files', async () => {
  const g = gitea(1142, 1000, { ignorePage: true })
  await assertRejects(() => templateTree(g.api, 'adhar', 'adhar-templates'), Error, 'more than the 1142 entries it announced')
})

Deno.test('a listing that ends short of the total it announced is an error, not a template with missing files', async () => {
  const g = gitea(900, 1000, { lie: 1142 })
  await assertRejects(() => templateTree(g.api, 'adhar', 'adhar-templates'), Error, 'lists 1142 entries but only 900 were returned')
})

Deno.test('a server that never stops saying truncated is bounded', async () => {
  let pages = 0
  const api = () => {
    pages++
    return Promise.resolve(Response.json({ sha: 'abc', tree: [entry(pages)], truncated: true, total_count: 0 }))
  }
  await assertRejects(() => templateTree(api, 'adhar', 'adhar-templates'), Error, `still truncated after ${TEMPLATE_TREE_MAX_PAGES} pages`)
  assertEquals(pages, TEMPLATE_TREE_MAX_PAGES)
})

Deno.test('an HTTP failure on any page fails the listing', async () => {
  const api = () => Promise.resolve(new Response('nope', { status: 502 }))
  await assertRejects(() => templateTree(api, 'adhar', 'adhar-templates'), Error, 'git tree 502 (page 1)')
})
