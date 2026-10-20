import { assertEquals } from 'jsr:@std/assert@1'
import { mentionsKey, repoFromUrl } from './work-dev-match.ts'

Deno.test('mentionsKey matches whole keys only', () => {
  assertEquals(mentionsKey('CON-42: fix login', 'CON-42'), true)
  assertEquals(mentionsKey('feature/con-42-login', 'CON-42'), true)
  assertEquals(mentionsKey('Fixes CON-420', 'CON-42'), false)
  assertEquals(mentionsKey('XCON-42', 'CON-42'), false)
  assertEquals(mentionsKey('(CON-42)', 'CON-42'), true)
  assertEquals(mentionsKey(undefined, 'CON-42'), false)
})

Deno.test('repoFromUrl handles https and ssh remotes', () => {
  assertEquals(repoFromUrl('https://gitea.adhar.local/Adhar/billing.git'), { owner: 'adhar', repo: 'billing' })
  assertEquals(repoFromUrl('git@gitea.local:adhar/billing.git'), { owner: 'adhar', repo: 'billing' })
  assertEquals(repoFromUrl('https://gitea.local/adhar/gitops/'), { owner: 'adhar', repo: 'gitops' })
  assertEquals(repoFromUrl(''), undefined)
})
