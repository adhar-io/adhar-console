/**
 * Adhar Cloud launch site — standalone production server (Deno).
 *
 *   1. serves the built SPA from `dist/` with an index.html fallback, and
 *   2. hosts the one API this site has: early-access registration.
 *
 * Registrations are appended to a JSONL file (one object per line) so the
 * site needs no database to run. Point LAUNCH_INTEREST_FILE at a persistent
 * volume in production; `GET /api/interest/count` is there for a dashboard.
 *
 *   deno task serve                     # :3100, ./data/interest.jsonl
 *   PORT=8080 LAUNCH_INTEREST_FILE=/var/lib/adhar/interest.jsonl deno task serve
 */
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type InterestRecord, validateInterest } from './app/data/interest.ts'

const PORT = Number(Deno.env.get('PORT') ?? 3100)
const HOSTNAME = Deno.env.get('HOST') ?? '0.0.0.0'
const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST = join(HERE, 'dist')
const INTEREST_FILE = Deno.env.get('LAUNCH_INTEREST_FILE') ?? join(HERE, 'data', 'interest.jsonl')

/* ─────────────────────────── static files ─────────────────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function cacheHeader(pathname: string): string {
  return /\/assets\//.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache'
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '').replace(
    /^\/+/,
    '',
  )
  const filePath = join(DIST, rel)
  if (filePath !== DIST && !filePath.startsWith(DIST + '/')) return null
  try {
    const stat = await Deno.stat(filePath)
    if (!stat.isFile) return null
    const file = await Deno.open(filePath, { read: true })
    return new Response(file.readable, {
      headers: {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': cacheHeader(pathname),
      },
    })
  } catch {
    return null
  }
}

let indexCache: string | null = null
async function serveIndex(): Promise<Response> {
  try {
    indexCache ??= await Deno.readTextFile(join(DIST, 'index.html'))
    return new Response(indexCache, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  } catch {
    return new Response('Launch site is not built yet. Run `deno task build`.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

/* ───────────────────────── interest registry ─────────────────────────── */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** In-memory index of who has registered, rebuilt from the file at boot. */
const registered = new Map<string, number>()

async function loadRegistry(): Promise<void> {
  try {
    const text = await Deno.readTextFile(INTEREST_FILE)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as InterestRecord
        if (r.email && typeof r.position === 'number') registered.set(r.email, r.position)
      } catch {
        // A torn line from a crashed write — skip it, keep the rest.
      }
    }
  } catch {
    // No file yet: first registration creates it.
  }
}

// Writes are serialised so two simultaneous sign-ups cannot get the same
// position or interleave their lines.
let writeChain: Promise<void> = Promise.resolve()

async function appendRecord(record: InterestRecord): Promise<void> {
  const run = async () => {
    await Deno.mkdir(join(INTEREST_FILE, '..'), { recursive: true }).catch(() => {})
    await Deno.writeTextFile(INTEREST_FILE, JSON.stringify(record) + '\n', { append: true })
  }
  writeChain = writeChain.then(run, run)
  return writeChain
}

async function handleInterest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/interest/count' && req.method === 'GET') {
    return json({ count: registered.size })
  }
  if (url.pathname !== '/api/interest') return null
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ errors: [{ field: 'email', message: 'Send JSON.' }] }, 400)
  }
  const v = validateInterest(body)
  if (!v.ok) {
    // A tripped honeypot gets a cheerful 200 and is written nowhere.
    if (v.errors.some((e) => e.field === 'website')) return json({ position: registered.size + 1 })
    return json({ errors: v.errors }, 400)
  }

  const existing = registered.get(v.value.email)
  if (existing !== undefined) return json({ position: existing, alreadyRegistered: true })

  const position = registered.size + 1
  const record: InterestRecord = { ...v.value, position, registeredAt: new Date().toISOString() }
  registered.set(record.email, position)
  try {
    await appendRecord(record)
  } catch (e) {
    registered.delete(record.email)
    console.error('[launch] failed to persist registration:', e)
    return json({ error: 'could not save registration' }, 500)
  }
  console.log(`[launch] +1 interest (#${position}, ${record.source})`)
  return json({ position, alreadyRegistered: false })
}

/* ──────────────────────────────── router ──────────────────────────────── */

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/healthz') return new Response('ok')

  if (url.pathname.startsWith('/api/')) {
    return (await handleInterest(req, url)) ?? json({ error: 'not found' }, 404)
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }
  const asset = await serveStatic(url.pathname)
  if (asset) return asset
  // Every other path is an SPA route (/, /maintenance, …).
  return serveIndex()
}

await loadRegistry()
console.log(`[launch] ${registered.size} registration(s) on file at ${INTEREST_FILE}`)

const ac = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(sig, () => {
    console.log(`[launch] ${sig} — draining`)
    ac.abort()
  })
}

Deno.serve({ port: PORT, hostname: HOSTNAME, signal: ac.signal }, async (req) => {
  try {
    return await handle(req)
  } catch (e) {
    console.error('[launch] unhandled:', e)
    return new Response('internal error', { status: 500 })
  }
})
