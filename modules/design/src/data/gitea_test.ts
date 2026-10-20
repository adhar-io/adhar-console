import { assertEquals, assertMatch } from 'jsr:@std/assert@1'
import { gitBlobSha, prBranchName } from './gitea-pure.ts'

Deno.test('git blob sha matches git hash-object', async () => {
  assertEquals(await gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a')
  assertEquals(await gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

Deno.test('PR branch names are safe and namespaced', () => {
  assertMatch(prBranchName('ADR-0007 Adopt Tekton!'), /^design\/adr-0007-adopt-tekton-[a-z0-9]+$/)
})
