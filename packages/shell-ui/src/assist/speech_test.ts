import { assertEquals } from 'jsr:@std/assert'
import { scoreVoice, speakableChunks, toSpeakable } from './speech.ts'

/**
 * The read-aloud button never set `voice`, so the browser answered with the
 * system default. On macOS that default pool holds Samantha and Fred in the
 * same array, with nothing in the API to tell them apart but the name.
 */

Deno.test('a novelty voice is disqualified however well it scores otherwise', () => {
  for (const name of ['Fred', 'Zarvox', 'Bahh', 'Albert (English (United States))']) {
    assertEquals(scoreVoice({ name, lang: 'en-US', default: true }) < 0, true, name)
  }
})

Deno.test('a real voice beats a novelty one in the same locale', () => {
  const good = scoreVoice({ name: 'Samantha', lang: 'en-US' })
  const bad = scoreVoice({ name: 'Zarvox', lang: 'en-US' })
  assertEquals(good > bad, true)
})

Deno.test('a neural voice outranks a plain one', () => {
  const natural = scoreVoice({ name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' })
  const plain = scoreVoice({ name: 'Karen', lang: 'en-AU' })
  assertEquals(natural > plain, true)
})

Deno.test('non-English voices are never chosen', () => {
  assertEquals(scoreVoice({ name: 'Anna', lang: 'de-DE' }) < 0, true)
  assertEquals(scoreVoice({ name: 'Google Deutsch', lang: 'de-DE' }) < 0, true)
})

Deno.test('en-US is preferred over other English locales, all else equal', () => {
  const us = scoreVoice({ name: 'Google US English', lang: 'en-US' })
  const gb = scoreVoice({ name: 'Google UK English Female', lang: 'en-GB' })
  const inLocale = scoreVoice({ name: 'Google US English', lang: 'en-IN' })
  assertEquals(us > gb, true)
  assertEquals(us > inLocale, true)
})

Deno.test('a compact voice is refused — it is the low-fidelity rendering', () => {
  assertEquals(scoreVoice({ name: 'Samantha (Compact)', lang: 'en-US' }) < 0, true)
})

/**
 * The old stripper was one character class, which left list bullets to be read
 * as "dash" and link URLs intact — so a cited answer read its own footnotes
 * aloud character by character.
 */
Deno.test('link text is spoken and the URL is not', () => {
  assertEquals(toSpeakable('See [the runbook](https://example.com/a/b?c=d).'), 'See the runbook.')
})

Deno.test('a bare URL becomes the word link rather than its characters', () => {
  assertEquals(toSpeakable('Open https://argocd.adhar.io/applications now'), 'Open link now')
})

Deno.test('list markers are dropped, not read as dashes', () => {
  assertEquals(toSpeakable('- one\n- two\n'), 'one. two.')
})

Deno.test('a fenced code block is summarised, not spelled out', () => {
  assertEquals(toSpeakable('Run this:\n```sh\nkubectl get po -A\n```\ndone'), 'Run this:. Code block omitted. done')
})

Deno.test('inline code keeps its content without the backticks', () => {
  assertEquals(toSpeakable('the `metadata.name` field'), 'the metadata.name field')
})

Deno.test('platform jargon a synth cannot pronounce is expanded', () => {
  assertEquals(toSpeakable('The k8s pod is OOMKilled'), 'The Kubernetes pod is out of memory killed')
  assertEquals(toSpeakable('State: CrashLoopBackOff'), 'State: crash loop back off')
})

Deno.test('emphasis marks never reach the voice', () => {
  assertEquals(toSpeakable('this is **bold** and _soft_'), 'this is bold and soft')
})

/**
 * Chrome truncates a single long utterance, so the text is queued as several
 * short ones.
 */
Deno.test('chunks break on sentence boundaries and stay under the size', () => {
  const text = 'One sentence here. Another one follows. ' + 'A third that is quite a lot longer than the others. '.repeat(6)
  const chunks = speakableChunks(text, 120)
  assertEquals(chunks.length > 1, true)
  for (const c of chunks) assertEquals(c.length <= 240, true, c)
  // Nothing is dropped in the splitting.
  assertEquals(chunks.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim())
})

Deno.test('a single short answer stays one chunk', () => {
  assertEquals(speakableChunks('All good.'), ['All good.'])
})

Deno.test('empty text produces no utterances to queue', () => {
  assertEquals(speakableChunks(''), [])
})
