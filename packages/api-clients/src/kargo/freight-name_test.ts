import { assertEquals } from 'jsr:@std/assert@1'
import { freightDisplayName } from './index.ts'

// Kargo names freight with a random adjective-animal alias ("dunking-seagull").
// Shown as-is it reads like a placeholder deployment; people need to see WHICH
// application and WHICH build.
Deno.test('freight reads as the application and its build, not the random alias', () => {
  const f = {
    id: 'a1b2c3d4e5f6a7b8', alias: 'dunking-seagull', warehouse: 'reactapp',
    images: [{ repoURL: 'harbor-core.adhar-system.svc.cluster.local/library/reactapp', tag: '33406bf9276dce6c33dd7b697ae8909349174ec5', digest: 'sha256:302d251d' }],
  }
  assertEquals(freightDisplayName(f), 'reactapp 33406bf')
  assertEquals(freightDisplayName({ ...f, warehouse: undefined }), 'reactapp 33406bf')
  assertEquals(freightDisplayName({ ...f, images: [{ ...f.images[0], tag: '1.4.2' }] }), 'reactapp 1.4.2')
  assertEquals(freightDisplayName({ id: 'abcdef1234567890', alias: 'dunking-seagull', images: [] }), 'dunking-seagull')
})
