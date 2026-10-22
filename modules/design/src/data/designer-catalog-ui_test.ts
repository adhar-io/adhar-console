import { assertEquals } from 'jsr:@std/assert@1'
import { uiVerdict } from './designer-catalog.ts'

Deno.test('platform app type decides first', () => {
  assertEquals(uiVerdict({ language: 'Go' }, [{ type: 'web' }]), 'ui')
  assertEquals(uiVerdict({ language: 'TypeScript' }, [{ type: 'service' }]), 'not-ui')
  assertEquals(uiVerdict({ language: 'TypeScript' }, [{ type: 'worker' }]), 'not-ui')
})

Deno.test('mirrors, archived and empty repos are never UI targets', () => {
  assertEquals(uiVerdict({ language: 'TypeScript', mirror: true }, []), 'not-ui')
  assertEquals(uiVerdict({ language: 'TypeScript', archived: true }, [{ type: 'web' }]), 'not-ui')
  assertEquals(uiVerdict({ empty: true }, []), 'not-ui')
})

Deno.test('back-end languages are ruled out; web languages and unknown need a package.json check', () => {
  assertEquals(uiVerdict({ language: 'Go' }, []), 'not-ui')
  assertEquals(uiVerdict({ language: 'Java' }, []), 'not-ui')
  assertEquals(uiVerdict({ language: 'TypeScript' }, []), 'check')
  assertEquals(uiVerdict({ language: 'Vue' }, []), 'check')
  assertEquals(uiVerdict({}, []), 'check')
})
