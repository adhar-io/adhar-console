/**
 * Run naming v1 — the contract the Console, the CLI and the kit's launcher all
 * compute independently (design 0025 §8.3, decision D1). They must agree byte
 * for byte: a run's name IS its duplicate guard, so a Console that hashed one
 * value differently from the CLI would start a second run for a business date
 * that already ran.
 *
 *   canonical = the JSON object of the identifying parameters, keys sorted by
 *               code point, every value a string, no whitespace, UTF-8
 *   hash8     = the first 8 lowercase hex characters of SHA-256(canonical)
 *   run       = <batchjob>-<hash8>
 *   restart   = <batchjob>-<hash8>-r<n>   (n = 1..99)
 *
 * The vectors in `testdata/batch/naming-v1-vectors.json` are the same file every
 * repository vendors.
 *
 * SHA-256 is written out here rather than taken from `crypto.subtle` for two
 * reasons: `subtle` exists only in a secure context, and this console is also
 * served over plain HTTP on local clusters; and it is asynchronous, while the
 * run-now form previews the name on every keystroke.
 */

/** The naming scheme this client implements (`naming` in the run template). */
export const NAMING_VERSION = 'v1'

/** A run name's hash length, and the highest restart a run may have. */
export const MAX_RESTARTS = 99

/** True when the string holds a surrogate with no partner — not valid text, and never hashed (D1). */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * Compare by Unicode code point. JavaScript's default string order is by UTF-16
 * code unit, which puts U+10000 and above BEFORE U+E000–U+FFFF — a different
 * order from Go, Java's code-point comparator and Python.
 */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number)
    if (d !== 0) return d
  }
  return x.length - y.length
}

/**
 * The canonical text. Built key by key rather than by stringifying an object:
 * an object would move integer-like keys to the front whatever order they were
 * inserted in. `JSON.stringify` of one string is exactly the normative escaping
 * (ECMAScript's is what D1 was written from).
 */
export function canonicalParams(params: Readonly<Record<string, string>>): string {
  const keys = Object.keys(params).sort(compareCodePoints)
  const body = keys.map((k) => {
    const v = params[k]
    if (hasLoneSurrogate(k) || hasLoneSurrogate(v)) throw new Error(`Parameter ${k} is not valid text (lone surrogate).`)
    return `${JSON.stringify(k)}:${JSON.stringify(v)}`
  })
  return `{${body.join(',')}}`
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** SHA-256 of a byte string, as lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const blocks = Math.ceil((data.length + 9) / 64)
  const padded = new Uint8Array(blocks * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = data.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const w = new Uint32Array(64)
  for (let b = 0; b < blocks; b++) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(b * 64 + t * 4)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let [a, bb, c, d, e, f, g, hh] = h
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[t] + w[t]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & bb) ^ (a & c) ^ (bb & c)
      const t2 = (S0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = bb
      bb = a
      a = (t1 + t2) | 0
    }
    h[0] += a
    h[1] += bb
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('')
}

/** The first 8 hex characters of SHA-256 over the canonical text. */
export function paramsHash(identifying: Readonly<Record<string, string>>): string {
  return sha256Hex(new TextEncoder().encode(canonicalParams(identifying))).slice(0, 8)
}

/** `<batchjob>-<hash8>` for the identifying parameters, AFTER defaults are applied. */
export function runName(batchJob: string, identifying: Readonly<Record<string, string>>): string {
  return `${batchJob}-${paramsHash(identifying)}`
}

/** `<base>-r<n>`, the `n`th restart of a run. */
export function restartName(base: string, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_RESTARTS) throw new Error(`A run restarts at most ${MAX_RESTARTS} times (asked for r${n}).`)
  return `${base}-r${n}`
}

/**
 * The next free restart of `base`, given every run name that exists. `undefined`
 * when all 99 are used. Holes are not refilled: `r2` existing with `r1` gone (a
 * TTL clean-up) is still followed by `r3`, so the numbers keep their order.
 */
export function nextRestartName(base: string, existing: readonly string[]): string | undefined {
  let highest = 0
  const prefix = `${base}-r`
  for (const name of existing) {
    if (!name.startsWith(prefix)) continue
    const tail = name.slice(prefix.length)
    if (/^[1-9][0-9]?$/.test(tail)) highest = Math.max(highest, Number(tail))
  }
  return highest >= MAX_RESTARTS ? undefined : restartName(base, highest + 1)
}
