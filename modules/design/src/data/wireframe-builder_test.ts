import { assert, assertEquals } from 'jsr:@std/assert@1'
import { defaultProjectFor } from '@adhar/builder/project'
import { blockToNode, projectToBlocks, wireframeToProject } from './wireframe-builder.ts'
import type { Wireframe } from './types.ts'

const wf: Wireframe = {
  id: 'wf-1',
  flow: 'onboarding',
  name: 'Sign in',
  order: 1,
  blocks: [
    { type: 'button', x: 24, y: 300, w: 120, h: 34, label: 'Continue' },
    { type: 'h1', x: 24, y: 40, w: 600, h: 36, label: 'Welcome back' },
    { type: 'input', x: 24, y: 120, w: 600, h: 34, label: 'Email' },
  ],
}

Deno.test('wireframe blocks become page nodes, top to bottom', () => {
  const project = wireframeToProject(wf, defaultProjectFor('visual', 'x'))
  assertEquals(project.name, 'Sign in')
  const blocks = projectToBlocks(project)
  assertEquals(blocks.map((b) => b.type), ['h1', 'input', 'button'])
  assertEquals(blocks[0].label, 'Welcome back')
  assert(blocks[1].y > blocks[0].y)
})

Deno.test('input blocks keep their label as a placeholder', () => {
  const n = blockToNode({ type: 'input', x: 0, y: 0, w: 10, h: 10, label: 'Email' })
  assertEquals(n.type, 'input')
  assertEquals(n.props.placeholder, 'Email')
})
