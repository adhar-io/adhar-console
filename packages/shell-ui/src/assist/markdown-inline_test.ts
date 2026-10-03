import { assertEquals } from 'jsr:@std/assert'
import { tokenizeInline } from './markdown-inline.ts'

/**
 * A README opens with a row of badges, and every one of them is an image
 * inside a link. Matching the plain-link pattern first consumed the inner
 * image and left the outer bracket and URL as literal text, so the top of
 * every rendered README was a line of stray punctuation.
 */

Deno.test('a linked badge becomes one link, not a bracket and a bare URL', () => {
  const md = '[![Coverage](https://img.shields.io/badge/cov-90%25-green)](https://github.com/adhar-io/kit)'
  assertEquals(tokenizeInline(md), [
    { kind: 'link', text: 'Coverage', href: 'https://github.com/adhar-io/kit' },
  ])
})

Deno.test('a row of badges leaves no literal markup behind', () => {
  const md = '[![A](https://i/a.svg)](https://x/a) [![B](https://i/b.svg)](https://x/b)'
  const toks = tokenizeInline(md)
  assertEquals(toks.filter((t) => t.kind === 'link').length, 2)
  // The only text between them is the single space.
  assertEquals(toks.filter((t) => t.kind === 'text').map((t) => (t as { text: string }).text), [' '])
})

Deno.test('a bare image becomes its alt text, never an external fetch', () => {
  assertEquals(tokenizeInline('![Architecture](./docs/arch.png)'), [
    { kind: 'image', alt: 'Architecture' },
  ])
})

Deno.test('an image with no alt text yields nothing to render', () => {
  assertEquals(tokenizeInline('![](x.png)'), [{ kind: 'image', alt: '' }])
})

Deno.test('an ordinary link is unaffected', () => {
  assertEquals(tokenizeInline('see [the docs](https://adhar.io/docs) now'), [
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'the docs', href: 'https://adhar.io/docs' },
    { kind: 'text', text: ' now' },
  ])
})

Deno.test('code, bold and italic still tokenise', () => {
  assertEquals(tokenizeInline('`x` **b** _i_'), [
    { kind: 'code', text: 'x' },
    { kind: 'text', text: ' ' },
    { kind: 'strong', text: 'b' },
    { kind: 'text', text: ' ' },
    { kind: 'em', text: 'i' },
  ])
})

Deno.test('inline code containing brackets is not mistaken for a link', () => {
  assertEquals(tokenizeInline('`[not](a-link)`'), [{ kind: 'code', text: '[not](a-link)' }])
})

Deno.test('plain prose passes through whole', () => {
  assertEquals(tokenizeInline('just words'), [{ kind: 'text', text: 'just words' }])
})
