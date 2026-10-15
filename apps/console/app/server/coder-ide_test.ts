import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { desktopDeepLink } from './coder-ide.ts'

const p = {
  owner: 'tapas',
  workspace: 'repo-adhar-console',
  agent: 'main',
  url: 'https://coder.example.com',
  token: 'abc-123',
  folder: '/home/coder/adhar-console',
}

Deno.test('VS Code Desktop opens the repo folder through the Coder extension', () => {
  const u = new URL(desktopDeepLink('vscode-desktop', p))
  assertEquals(u.protocol, 'vscode:')
  assertEquals(u.host + u.pathname, 'coder.coder-remote/open')
  assertEquals(u.searchParams.get('owner'), 'tapas')
  assertEquals(u.searchParams.get('workspace'), 'repo-adhar-console')
  assertEquals(u.searchParams.get('agent'), 'main')
  assertEquals(u.searchParams.get('url'), 'https://coder.example.com')
  assertEquals(u.searchParams.get('token'), 'abc-123')
  assertEquals(u.searchParams.get('folder'), '/home/coder/adhar-console')
})

Deno.test('IntelliJ goes through Gateway with both agent spellings and the folder', () => {
  const link = desktopDeepLink('intellij', p)
  assertStringIncludes(link, 'jetbrains-gateway://connect#type=coder&')
  const hash = new URLSearchParams(link.split('#')[1])
  assertEquals(hash.get('agent'), 'main')
  assertEquals(hash.get('agent_name'), 'main')
  assertEquals(hash.get('ide_product_code'), 'IU')
  assertEquals(hash.get('folder'), '/home/coder/adhar-console')
  assertEquals(hash.get('url'), 'https://coder.example.com')
})
