import { assertEquals } from 'jsr:@std/assert@1'
import { chaosReportsHref, freightCommit } from './chaos-link.ts'

const SHA = 'ab'.repeat(20)

Deno.test('the freight commit is a full SHA from the image tag, else from git commits, else nothing', () => {
  assertEquals(freightCommit({ images: [{ repoURL: 'h/a', tag: SHA.toUpperCase() }] }), SHA)
  assertEquals(freightCommit({ images: [{ repoURL: 'h/a', tag: 'v1.2.0' }], commits: [{ repoURL: 'g', id: SHA }] }), SHA)
  assertEquals(freightCommit({ images: [{ repoURL: 'h/a', tag: 'latest' }], commits: [{ repoURL: 'g', id: 'abc1234' }] }), undefined)
})

Deno.test('the link opens the Chaos reports tab filtered to the commit', () => {
  assertEquals(chaosReportsHref(SHA, 'cart'), `/deliver?section=chaos&tab=reports&commit=${SHA}&app=cart`)
})
