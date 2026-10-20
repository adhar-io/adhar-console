import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { draftPrompt, extractFenced, ideaLines } from './ai-text.ts'

Deno.test('extracts the fenced block in the requested language', () => {
  assertEquals(extractFenced('Here:\n```mermaid\nflowchart LR\n A-->B\n```\nDone', 'mermaid'), 'flowchart LR\n A-->B\n')
  assertEquals(extractFenced('```text\nx\n```\n```yaml\nopenapi: 3.0.3\n```', 'yaml'), 'openapi: 3.0.3\n')
  assertEquals(extractFenced('no fence at all'), 'no fence at all\n')
  assertEquals(extractFenced('```markdown\n# T\nunterminated'), '# T\nunterminated\n')
})

Deno.test('idea lines strip bullets and numbering', () => {
  assertEquals(ideaLines('```text\n- one\n2) two\n\n• three\n```'), ['one', 'two', 'three'])
})

Deno.test('prompts carry the format rules and the request', () => {
  const p = draftPrompt('diagram', '  checkout flow ')
  assertStringIncludes(p, '```mermaid')
  assertStringIncludes(p, 'Request:\ncheckout flow')
})
