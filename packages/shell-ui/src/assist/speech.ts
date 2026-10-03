/**
 * Voice for the assistant — choosing one, and preparing text for it.
 *
 * The read-aloud button used to create a `SpeechSynthesisUtterance`, set its
 * `lang`, and speak it without ever setting `voice`. That hands the choice to
 * the browser, which answers with the system default for the locale — and on
 * macOS the default pool is mostly 1980s formant synths (Fred, Albert,
 * Zarvox, Bahh) sitting in the same list as the good ones. There was no
 * reason for it to sound good and several reasons for it to sound terrible.
 *
 * So the voice is chosen here, deliberately, and the same resolved language
 * drives dictation so the two halves of the feature agree.
 */

/**
 * Voices that exist to be jokes, plus the low-fidelity compact ones.
 *
 * macOS ships these in the same `getVoices()` array as Samantha and Ava, with
 * nothing in the API marking them as novelties — no flag, no category, and
 * `localService` is true for the good ones too. The only thing separating
 * "sounds like a person" from "sounds like a 1984 arcade cabinet" is the name,
 * so the name is what we filter on.
 */
const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
  'deranged', 'eddy', 'flo', 'fred', 'good news', 'grandma', 'grandpa',
  'hysterical', 'jester', 'junior', 'kathy', 'organ', 'ralph', 'reed',
  'rocko', 'sandy', 'shelley', 'superstar', 'trinoids', 'whisper',
  'wobble', 'zarvox',
])

/**
 * Families worth asking for by name, best first.
 *
 * These are the neural and premium engines. Where a platform ships one, it is
 * a different class of thing from the older concatenative voices — the reason
 * to name them rather than take whatever is first in the array.
 */
const PREFERRED = [
  'microsoft aria', 'microsoft jenny', 'microsoft guy', 'microsoft emma',
  'google us english', 'google uk english female', 'google uk english male',
  'samantha', 'ava', 'allison', 'susan', 'nicky', 'tom', 'alex', 'daniel', 'karen', 'moira',
]

/** Markers a platform puts in the name when the voice is a better rendering of itself. */
const QUALITY = ['(natural)', 'online (natural)', 'premium', 'enhanced', 'neural']

interface Voice {
  name: string
  lang: string
  localService?: boolean
  default?: boolean
}

/**
 * Score a voice. Higher is better; anything below zero is disqualified.
 *
 * Deliberately ranks by name and language rather than by `localService`.
 * Network voices are usually the neural ones on Chrome, which argues for
 * preferring remote; on Safari the best voices are the local premium ones,
 * which argues for the opposite. The flag means different things per browser,
 * so it is not evidence — it is only used as a last tie-break.
 */
export function scoreVoice(v: Voice): number {
  const name = v.name.toLowerCase()
  const lang = (v.lang || '').toLowerCase().replace('_', '-')

  if (!lang.startsWith('en')) return -1
  // `includes`, not equality: macOS writes these as "Albert", Chrome as
  // "Albert (English (United States))".
  for (const bad of NOVELTY) {
    if (name === bad || name.startsWith(`${bad} `) || name.startsWith(`${bad}(`)) return -1
  }
  if (name.includes('compact')) return -1

  let score = 0
  for (const q of QUALITY) if (name.includes(q)) score += 40
  const rank = PREFERRED.findIndex((p) => name.includes(p))
  if (rank >= 0) score += 60 - rank * 2

  // en-US first, then en-GB: the two accents a reader is least likely to find
  // distracting in a product used worldwide. Other English locales still
  // qualify, just behind these.
  if (lang.startsWith('en-us')) score += 12
  else if (lang.startsWith('en-gb')) score += 8
  else score += 2

  if (v.default) score += 1
  return score
}

/**
 * The best available English voice, or null to let the browser decide.
 *
 * `getVoices()` is empty on the first call in Chrome — the list arrives later
 * and fires `voiceschanged`. A picker that reads it once at module load gets
 * nothing and silently falls back to the default voice forever, which is the
 * bug this function exists to not have.
 */
export function bestVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  const voices = synth.getVoices()
  if (!voices.length) return null
  let best: SpeechSynthesisVoice | null = null
  let bestScore = 0
  for (const v of voices) {
    const s = scoreVoice(v)
    if (s > bestScore) {
      best = v
      bestScore = s
    }
  }
  return best
}

/** Resolve the voice list, waiting for `voiceschanged` if it has not arrived. */
export function whenVoicesReady(synth: SpeechSynthesis, timeoutMs = 1500): Promise<void> {
  if (synth.getVoices().length) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      synth.removeEventListener?.('voiceschanged', finish)
      resolve()
    }
    synth.addEventListener?.('voiceschanged', finish)
    // Resolve anyway: a browser with no voices at all must not hang the button.
    setTimeout(finish, timeoutMs)
  })
}

/**
 * The language to speak and listen in.
 *
 * `navigator.language` was used directly for both. It is the right default
 * only when it is an English locale: a console whose entire interface is in
 * English, read aloud by a browser set to `de-DE`, gets an English sentence
 * pronounced with German letter values. For dictation it is worse than
 * cosmetic — recognition is scored against the wrong phoneme set, so
 * "kubectl" and "CrashLoopBackOff" have no chance.
 */
export function speechLang(): string {
  const nav = globalThis.navigator?.language || ''
  return /^en\b/i.test(nav) ? nav : 'en-US'
}

/** Words the platform uses constantly that a synth reads as letters or gibberish. */
const SAY_AS: Array<[RegExp, string]> = [
  [/\bk8s\b/gi, 'Kubernetes'],
  [/\bOOMKilled\b/gi, 'out of memory killed'],
  [/\bCrashLoopBackOff\b/gi, 'crash loop back off'],
  [/\bImagePullBackOff\b/gi, 'image pull back off'],
  [/\bkubectl\b/gi, 'cube control'],
  [/\bPVC\b/g, 'P V C'],
  [/\bCRD\b/g, 'C R D'],
  [/\bPR\b/g, 'pull request'],
]

/**
 * Markdown → something worth hearing.
 *
 * The old version stripped `[#*\`>_|]` with one character class, which left
 * list bullets to be read as "dash", table pipes as nothing but their columns
 * run together, and link URLs intact — so a cited answer read its own
 * footnote URLs aloud, character by character.
 */
export function toSpeakable(md: string, max = 4000): string {
  const text = md
    .replace(/```[\s\S]*?```/g, ' . Code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Headings and list items get a full stop so the synth pauses between
    // them. Without one the whole list runs together as a single breathless
    // clause, which is the main reason a read-aloud answer is hard to follow.
    .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*$/gm, '$1. ')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+(.*?)\s*$/gm, '$1. ')
    .replace(/^\s*\|?[\s:|-]{6,}\|?\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/https?:\/\/\S+/g, ' link ')
    // Newlines first, THEN collapse. Collapsing spaces before the newlines
    // became spaces left every join doubled.
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.?!])\s*\1+/g, '$1')
    .replace(/\.{2,}/g, '.')
    .trim()

  let out = text
  for (const [re, say] of SAY_AS) out = out.replace(re, say)
  return out.slice(0, max)
}

/**
 * Split for speaking.
 *
 * Chrome stops a long utterance partway through — a documented, long-standing
 * limit on utterance length rather than anything to do with the text. Speaking
 * sentence groups queues several short utterances instead, which it handles,
 * and has the side effect of letting Stop take effect immediately rather than
 * at the end of one enormous one.
 */
export function speakableChunks(text: string, size = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]
  const out: string[] = []
  let buf = ''
  for (const s of sentences) {
    if (buf && buf.length + s.length > size) {
      out.push(buf.trim())
      buf = ''
    }
    buf += s
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(Boolean)
}
