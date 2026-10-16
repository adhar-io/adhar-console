import { assertEquals } from 'jsr:@std/assert@1'
import { detectSyntax, parseMermaidError, slugify, withDirective } from './mermaid-util.ts'

Deno.test('detects the header keyword past comments and front-matter', () => {
  assertEquals(detectSyntax('flowchart LR\n A-->B'), { keyword: 'flowchart', type: 'flowchart' })
  assertEquals(detectSyntax('%% note\n\nsequenceDiagram\n A->>B: hi'), { keyword: 'sequenceDiagram', type: 'sequence' })
  assertEquals(detectSyntax('---\ntitle: X\n---\nC4Container\n'), { keyword: 'C4Container', type: 'C4Context' })
  assertEquals(detectSyntax('pie title Pets\n "Dogs": 3'), { keyword: 'pie', type: null })
  assertEquals(detectSyntax('graph TD;A-->B'), { keyword: 'graph', type: 'flowchart' })
  assertEquals(detectSyntax('   '), null)
})

Deno.test('extracts line numbers from jison and langium errors', () => {
  const jison = Object.assign(new Error("Parse error on line 3:\n...B --> \n-------^\nExpecting 'SEMI', got 'EOF'"), {
    hash: { loc: { first_line: 3 } },
  })
  assertEquals(parseMermaidError(jison, 'a\nb\nc\nd'), { line: 3, message: "Expecting 'SEMI', got 'EOF'" })
  assertEquals(parseMermaidError(new Error('Lexer error on line 2, column 5: unexpected character'), 'x\ny').line, 2)
  assertEquals(parseMermaidError('No diagram type detected', '').line, 1)
  // Clamped to the source length.
  assertEquals(parseMermaidError(new Error('Parse error on line 99:'), 'a\nb').line, 2)
})

Deno.test('slugify and directive injection', () => {
  assertEquals(slugify('Platform — C4 view!'), 'platform-c4-view')
  assertEquals(slugify('***'), 'untitled')
  assertEquals(withDirective('flowchart LR', { a: 1 }), '%%{init: {"a":1}}%%\nflowchart LR')
  assertEquals(withDirective('---\ntitle: T\n---\npie', { a: 1 }), '---\ntitle: T\n---\n%%{init: {"a":1}}%%\npie')
})
