import { env } from '@adhar-console/utils'

/**
 * Outbound email for the console (workspace provisioning, invitations).
 *
 * Two dependency-free transports, chosen by what the platform configured:
 *
 *   1. **HTTP API** — `MAIL_API_URL` (+ optional `MAIL_API_TOKEN`,
 *      `MAIL_API_AUTH_HEADER`). The console POSTs
 *      `{from, to, subject, text, html}` as JSON. Works with an internal relay
 *      or any provider that accepts that shape (Resend, Mailgun-compatible
 *      gateways, a Kubernetes-side webhook).
 *   2. **SMTP** — `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USERNAME`,
 *      `SMTP_PASSWORD`, `SMTP_TLS=starttls|implicit|none`). Implemented
 *      directly over `Deno.connect` / `Deno.startTls`: EHLO → optional
 *      STARTTLS → AUTH LOGIN/PLAIN → MAIL/RCPT/DATA. No third-party module, so
 *      the container build stays hermetic.
 *
 * When neither is configured `sendMail` resolves `{ sent: false, reason:
 * 'not_configured' }` — callers still record the in-app notification and tell
 * the user email wasn't sent, rather than pretending it was.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
}

export interface MailResult {
  sent: boolean
  transport?: 'http' | 'smtp'
  reason?: 'not_configured' | 'invalid_recipient' | 'error'
  detail?: string
}

export function isMailConfigured(): boolean {
  return Boolean(env('MAIL_API_URL') || env('SMTP_HOST'))
}

function fromAddress(): string {
  return env('MAIL_FROM') ?? env('SMTP_FROM') ?? 'Adhar Console <no-reply@adhar.local>'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  if (!EMAIL_RE.test(msg.to.trim())) return { sent: false, reason: 'invalid_recipient', detail: msg.to }
  try {
    if (env('MAIL_API_URL')) return await sendViaHttp(msg)
    if (env('SMTP_HOST')) return await sendViaSmtp(msg)
    return { sent: false, reason: 'not_configured' }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.warn('[mail] send failed:', detail)
    return { sent: false, reason: 'error', detail }
  }
}

/* ─────────── HTTP transport ─────────── */

async function sendViaHttp(msg: MailMessage): Promise<MailResult> {
  const url = env('MAIL_API_URL')!
  const headers = new Headers({ 'content-type': 'application/json' })
  const token = env('MAIL_API_TOKEN')
  if (token) headers.set(env('MAIL_API_AUTH_HEADER') ?? 'authorization', token.startsWith('Bearer ') || env('MAIL_API_AUTH_HEADER') ? token : `Bearer ${token}`)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: fromAddress(),
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      reply_to: msg.replyTo,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { sent: false, transport: 'http', reason: 'error', detail: `HTTP ${res.status} ${body.slice(0, 200)}` }
  }
  return { sent: true, transport: 'http' }
}

/* ─────────── SMTP transport ─────────── */

interface SmtpConn {
  read(): Promise<string>
  write(line: string): Promise<void>
  upgrade(hostname: string): Promise<void>
  close(): void
}

function makeConn(conn: Deno.Conn): SmtpConn {
  let current: Deno.Conn = conn
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  return {
    async read() {
      const buf = new Uint8Array(4096)
      const n = await current.read(buf)
      return n ? dec.decode(buf.subarray(0, n)) : ''
    },
    async write(line) {
      await current.write(enc.encode(line))
    },
    async upgrade(hostname) {
      current = await Deno.startTls(current as Deno.TcpConn, { hostname })
    },
    close() {
      try {
        current.close()
      } catch {
        // already closed
      }
    },
  }
}

/** Read a reply and assert its status code prefix (SMTP replies may be multi-line). */
async function expect(conn: SmtpConn, codes: string[], step: string): Promise<string> {
  const reply = await conn.read()
  const code = reply.slice(0, 3)
  if (!codes.includes(code)) throw new Error(`SMTP ${step}: expected ${codes.join('/')}, got ${reply.trim().slice(0, 160)}`)
  return reply
}

async function sendViaSmtp(msg: MailMessage): Promise<MailResult> {
  const hostname = env('SMTP_HOST')!
  const mode = (env('SMTP_TLS') ?? 'starttls').toLowerCase()
  const port = Number(env('SMTP_PORT') ?? (mode === 'implicit' ? 465 : 587))
  const user = env('SMTP_USERNAME')
  const pass = env('SMTP_PASSWORD')
  const helo = env('SMTP_HELO') ?? 'adhar-console'

  const raw = mode === 'implicit'
    ? await Deno.connectTls({ hostname, port })
    : await Deno.connect({ hostname, port })
  const conn = makeConn(raw)
  try {
    await expect(conn, ['220'], 'greeting')
    await conn.write(`EHLO ${helo}\r\n`)
    let ehlo = await expect(conn, ['250'], 'EHLO')

    if (mode === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('SMTP server does not advertise STARTTLS (set SMTP_TLS=none to allow plaintext)')
      await conn.write('STARTTLS\r\n')
      await expect(conn, ['220'], 'STARTTLS')
      await conn.upgrade(hostname)
      await conn.write(`EHLO ${helo}\r\n`)
      ehlo = await expect(conn, ['250'], 'EHLO (TLS)')
    }

    if (user && pass) {
      if (/AUTH[ =-][^\n]*PLAIN/i.test(ehlo)) {
        const payload = btoa(`\0${user}\0${pass}`)
        await conn.write(`AUTH PLAIN ${payload}\r\n`)
        await expect(conn, ['235'], 'AUTH PLAIN')
      } else {
        await conn.write('AUTH LOGIN\r\n')
        await expect(conn, ['334'], 'AUTH LOGIN')
        await conn.write(`${btoa(user)}\r\n`)
        await expect(conn, ['334'], 'AUTH username')
        await conn.write(`${btoa(pass)}\r\n`)
        await expect(conn, ['235'], 'AUTH password')
      }
    }

    const from = fromAddress()
    const fromAddr = /<([^>]+)>/.exec(from)?.[1] ?? from
    await conn.write(`MAIL FROM:<${fromAddr}>\r\n`)
    await expect(conn, ['250'], 'MAIL FROM')
    await conn.write(`RCPT TO:<${msg.to.trim()}>\r\n`)
    await expect(conn, ['250', '251'], 'RCPT TO')
    await conn.write('DATA\r\n')
    await expect(conn, ['354'], 'DATA')
    await conn.write(buildMime(from, msg))
    await expect(conn, ['250'], 'body')
    await conn.write('QUIT\r\n')
    return { sent: true, transport: 'smtp' }
  } finally {
    conn.close()
  }
}

/** RFC 5322 message with a plain/HTML alternative body; dot-stuffed and terminated. */
function buildMime(from: string, msg: MailMessage): string {
  const boundary = `adhar-${crypto.randomUUID()}`
  const headers = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@adhar>`,
    'MIME-Version: 1.0',
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
  ]
  let body: string
  if (msg.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      msg.html,
      `--${boundary}--`,
    ].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8')
    body = msg.text
  }
  // Dot-stuffing: a line that is just "." would otherwise end the DATA phase.
  const stuffed = body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
  return `${headers.join('\r\n')}\r\n\r\n${stuffed}\r\n.\r\n`
}

/** RFC 2047 encode a header value when it isn't plain ASCII. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(v)))}?=`
}

/* ─────────── templates ─────────── */

export interface ProvisioningMailInput {
  orgName: string
  orgSlug: string
  recipientName?: string
  consoleUrl: string
  steps: Array<{ label: string; status: 'done' | 'skipped' | 'failed'; detail?: string }>
}

/** "Your workspace is ready" — sent when provisioning finishes. */
export function provisioningMail(input: ProvisioningMailInput): MailMessage {
  const failed = input.steps.filter((s) => s.status === 'failed')
  const ok = failed.length === 0
  const greeting = input.recipientName ? `Hi ${input.recipientName},` : 'Hi,'
  const lines = input.steps.map((s) => `  ${s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '✗'} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`)
  const text = [
    greeting,
    '',
    ok
      ? `Your Adhar workspace "${input.orgName}" is ready.`
      : `Your Adhar workspace "${input.orgName}" was created, but some steps need attention.`,
    '',
    'What we provisioned:',
    ...lines,
    '',
    `Open the console: ${input.consoleUrl}`,
    '',
    '— Adhar',
  ].join('\n')
  const rows = input.steps
    .map(
      (s) =>
        `<tr><td style="padding:6px 10px;font:14px system-ui;color:${s.status === 'failed' ? '#b91c1c' : s.status === 'skipped' ? '#6b7280' : '#047857'}">${s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '✗'}</td><td style="padding:6px 10px;font:14px system-ui;color:#111827">${escapeHtml(s.label)}${s.detail ? `<div style="color:#6b7280;font-size:12px">${escapeHtml(s.detail)}</div>` : ''}</td></tr>`,
    )
    .join('')
  const html = `<div style="background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
    <div style="padding:20px 24px;background:linear-gradient(135deg,#4f46e5,#0ea5e9);color:#fff">
      <div style="font:600 18px system-ui">Your workspace is ready</div>
      <div style="font:14px system-ui;opacity:.9">${escapeHtml(input.orgName)}</div>
    </div>
    <div style="padding:20px 24px">
      <p style="font:14px system-ui;color:#111827;margin:0 0 12px">${escapeHtml(greeting)}</p>
      <p style="font:14px system-ui;color:#374151;margin:0 0 16px">${ok ? `Provisioning finished for <strong>${escapeHtml(input.orgName)}</strong>. Everything below is live on the platform.` : `We created <strong>${escapeHtml(input.orgName)}</strong>, but some steps need attention — details below.`}</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:10px">${rows}</table>
      <p style="margin:20px 0 0"><a href="${escapeHtml(input.consoleUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;font:600 14px system-ui;padding:10px 18px;border-radius:10px;text-decoration:none">Open the console</a></p>
    </div>
  </div>
</div>`
  return {
    to: '',
    subject: ok ? `Your Adhar workspace "${input.orgName}" is ready` : `Adhar workspace "${input.orgName}" needs attention`,
    text,
    html,
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
