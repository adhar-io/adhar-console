/**
 * Early-access registration — the shape, the validation and the client call.
 *
 * Pure functions only: `server.ts` imports `validateInterest` to vet the body
 * it receives, and `interest-form.tsx` runs the same function before sending,
 * so the two never disagree about what a valid registration is.
 */

export const ROLES = [
  { value: 'engineering', label: 'Engineering' },
  { value: 'platform', label: 'Platform / SRE' },
  { value: 'security', label: 'Security' },
  { value: 'product', label: 'Product / Design' },
  { value: 'leadership', label: 'Leadership' },
  { value: 'other', label: 'Other' },
] as const

export type Role = (typeof ROLES)[number]['value']

/** Where on the site the registration came from. */
export type InterestSource = 'launch' | 'maintenance'

export interface InterestInput {
  email: string
  name?: string
  company?: string
  role?: Role | ''
  /** Free text: what they hope to build or move onto Adhar Cloud. */
  building?: string
  source: InterestSource
  /** Honeypot. Real people never see it; bots fill it. */
  website?: string
}

export interface InterestRecord extends Omit<InterestInput, 'website'> {
  /** Server-assigned, 1-based position in the queue. */
  position: number
  registeredAt: string
}

export type ValidationError = { field: keyof InterestInput; message: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const MAX = { email: 254, name: 120, company: 120, building: 600 } as const
const SOURCES: InterestSource[] = ['launch', 'maintenance']

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/**
 * Normalise + validate an untrusted body. Returns either the cleaned input or
 * the first error per field. A filled honeypot is reported as `website` so the
 * server can quietly accept-and-drop it rather than teach the bot anything.
 */
export function validateInterest(
  raw: unknown,
): { ok: true; value: InterestInput } | { ok: false; errors: ValidationError[] } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: ValidationError[] = []

  const email = clean(body.email, MAX.email).toLowerCase()
  if (!email) errors.push({ field: 'email', message: 'Enter your work email.' })
  else if (!EMAIL_RE.test(email)) {
    errors.push({ field: 'email', message: 'That email does not look right.' })
  }

  const role = clean(body.role, 32)
  if (role && !ROLES.some((r) => r.value === role)) {
    errors.push({ field: 'role', message: 'Pick a role from the list.' })
  }

  const source = clean(body.source, 32) as InterestSource
  if (!SOURCES.includes(source)) errors.push({ field: 'source', message: 'Unknown source.' })

  const website = clean(body.website, 200)
  if (website) errors.push({ field: 'website', message: 'Leave this field empty.' })

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      email,
      name: clean(body.name, MAX.name) || undefined,
      company: clean(body.company, MAX.company) || undefined,
      role: (role as Role) || undefined,
      building: clean(body.building, MAX.building) || undefined,
      source,
    },
  }
}

/** Result of a submission, as the form sees it. */
export type SubmitResult =
  | { ok: true; position: number; alreadyRegistered: boolean }
  | { ok: false; reason: 'invalid' | 'offline' | 'server'; errors?: ValidationError[] }

/**
 * POST the registration. Network and 5xx failures come back as `offline` /
 * `server` so the form can keep the person's input and offer a retry instead
 * of throwing it away.
 */
export async function submitInterest(
  input: InterestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  const v = validateInterest(input)
  if (!v.ok) return { ok: false, reason: 'invalid', errors: v.errors }
  try {
    const res = await fetchImpl('/api/interest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(v.value),
    })
    if (res.status === 400) {
      const data = (await res.json().catch(() => ({}))) as { errors?: ValidationError[] }
      return { ok: false, reason: 'invalid', errors: data.errors ?? [] }
    }
    if (!res.ok) return { ok: false, reason: 'server' }
    const data = (await res.json()) as { position: number; alreadyRegistered?: boolean }
    return {
      ok: true,
      position: data.position,
      alreadyRegistered: data.alreadyRegistered ?? false,
    }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}
