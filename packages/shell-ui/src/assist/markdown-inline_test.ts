import { assertEquals } from 'jsr:@std/assert'
import { tokenizeInline } from './markdown-inline.ts'

/**
 * A README opens with a row of badges, and every one of them is an image
 * inside a link. Matching the plain-link pattern first consumed the inner
 * image and left the outer bracket and URL as literal text, so the top of
 * every rendered README was a line of stray punctuation.
 */

Deno.test('a linked badge is one token carrying both the badge and its link', () => {
  const md = '[![Coverage](https://img.shields.io/badge/cov-90%25-green)](https://github.com/adhar-io/kit)'
  assertEquals(tokenizeInline(md), [{
    kind: 'image-link',
    alt: 'Coverage',
    src: 'https://img.shields.io/badge/cov-90%25-green',
    href: 'https://github.com/adhar-io/kit',
  }])
})

Deno.test('a row of badges leaves no literal markup behind', () => {
  const md = '[![A](https://i/a.svg)](https://x/a) [![B](https://i/b.svg)](https://x/b)'
  const toks = tokenizeInline(md)
  assertEquals(toks.filter((t) => t.kind === 'image-link').length, 2)
  // The only text between them is the single space.
  assertEquals(toks.filter((t) => t.kind === 'text').map((t) => (t as { text: string }).text), [' '])
})

/**
 * The tokenizer carries the source; whether anything is fetched is the
 * renderer's decision. The assistant shows alt text, a repository README
 * shows the image.
 */
Deno.test('a bare image keeps its source as well as its alt text', () => {
  assertEquals(tokenizeInline('![Architecture](./docs/arch.png)'), [
    { kind: 'image', alt: 'Architecture', src: './docs/arch.png' },
  ])
})

Deno.test('an image with no alt text still has a source', () => {
  assertEquals(tokenizeInline('![](x.png)'), [{ kind: 'image', alt: '', src: 'x.png' }])
})

/** `![alt](src "title")` is valid markdown; the title is not part of the URL. */
Deno.test('an image title is not taken for part of the source', () => {
  assertEquals(tokenizeInline('![Logo](./logo.png "Our logo")'), [
    { kind: 'image', alt: 'Logo', src: './logo.png' },
  ])
  assertEquals(tokenizeInline('[![B](./b.png "t")](https://x)'), [
    { kind: 'image-link', alt: 'B', src: './b.png', href: 'https://x' },
  ])
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
