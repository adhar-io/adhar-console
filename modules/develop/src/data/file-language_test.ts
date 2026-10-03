import { assertEquals } from 'jsr:@std/assert'
import {
  extensionOf,
  isBinaryPath,
  isImagePath,
  languageForFilename,
  looksBinary,
} from './file-language.ts'

/**
 * The file viewer rendered every file as undifferentiated monospace text.
 * Monaco can highlight all of it; the only thing that can tell it which
 * grammar to use is the path.
 */

Deno.test('source files resolve to their grammar', () => {
  assertEquals(languageForFilename('src/app.tsx'), 'typescript')
  assertEquals(languageForFilename('cmd/main.go'), 'go')
  assertEquals(languageForFilename('lib/util.rs'), 'rust')
  assertEquals(languageForFilename('Deploy.kt'), 'kotlin')
  assertEquals(languageForFilename('styles/app.scss'), 'scss')
})

Deno.test('a path is resolved by its last segment, not the directory', () => {
  assertEquals(languageForFilename('go/src/python/thing.rb'), 'ruby')
})

/**
 * `go.mod` and `go.sum` share a family but not a grammar, and a whole-name
 * match has to beat the extension or `.mod` would decide for both.
 */
Deno.test('whole-name matches win over the extension', () => {
  assertEquals(languageForFilename('go.mod'), 'go')
  assertEquals(languageForFilename('go.sum'), 'plaintext')
  assertEquals(languageForFilename('Makefile'), 'makefile')
  assertEquals(languageForFilename('Dockerfile'), 'dockerfile')
})

Deno.test('a suffixed Dockerfile is still a Dockerfile', () => {
  assertEquals(languageForFilename('Dockerfile.dev'), 'dockerfile')
  assertEquals(languageForFilename('Makefile.local'), 'makefile')
})

Deno.test('case does not decide the grammar', () => {
  assertEquals(languageForFilename('DOCKERFILE'), 'dockerfile')
  assertEquals(languageForFilename('README.MD'), 'markdown')
})

/** A leading dot names the file; it does not start an extension. */
Deno.test('dotfiles are names, not extensions', () => {
  assertEquals(extensionOf('.gitignore'), '')
  assertEquals(languageForFilename('.gitignore'), 'plaintext')
  assertEquals(languageForFilename('.editorconfig'), 'ini')
})

Deno.test('an unknown extension degrades to plain text rather than guessing', () => {
  assertEquals(languageForFilename('data.qqq'), 'plaintext')
  assertEquals(languageForFilename('no-extension-at-all'), 'plaintext')
})

Deno.test('images are recognised so they can be shown rather than decoded', () => {
  assertEquals(isImagePath('docs/arch.png'), true)
  assertEquals(isImagePath('logo.SVG'), true)
  assertEquals(isImagePath('main.go'), false)
})

Deno.test('known binaries are refused before anything decodes them', () => {
  assertEquals(isBinaryPath('vendor/lib.so'), true)
  assertEquals(isBinaryPath('report.pdf'), true)
  assertEquals(isBinaryPath('main.go'), false)
})

/**
 * Extensions are not enough — repositories hold binaries under names with no
 * extension. A NUL byte never occurs in UTF-8 text, so one is conclusive.
 */
Deno.test('a NUL byte marks content as binary whatever it is called', () => {
  assertEquals(looksBinary('ELF\u0000\u0000binary'), true)
  assertEquals(looksBinary('package main\n\nfunc main() {}\n'), false)
})

Deno.test('a NUL past the sampled window does not stall the check', () => {
  assertEquals(looksBinary('x'.repeat(5000) + '\u0000'), false)
})
