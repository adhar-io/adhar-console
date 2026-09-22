/**
 * Who signed in last, remembered in this browser only.
 *
 * The sign-in page greets a returning person by name and shows which account
 * they used, so someone with two identities (a personal and a work login, say)
 * knows which one "Continue" will take them back to before they press it.
 *
 * Name and email only — no token, no id, nothing a page could act on. A demo
 * session is never remembered (`rememberUser` is only called for a session
 * the server issued), and "Not you?" on the sign-in page forgets it.
 */
const KEY = 'adhar.auth.lastUser'

export interface LastUser {
  name: string
  email: string
  /** ISO timestamp of when the session was seen. */
  at: string
}

export function rememberUser(u: { name?: string; email?: string }): void {
  const name = (u.name ?? '').trim()
  const email = (u.email ?? '').trim()
  if (!name && !email) return
  try {
    const blob: LastUser = { name, email, at: new Date().toISOString() }
    localStorage.setItem(KEY, JSON.stringify(blob))
  } catch {
    /* private mode — greeting is a nicety, not a requirement */
  }
}

export function getLastUser(): LastUser | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const b = JSON.parse(raw) as Partial<LastUser>
    if (typeof b.name !== 'string' || typeof b.email !== 'string') return null
    return { name: b.name, email: b.email, at: typeof b.at === 'string' ? b.at : '' }
  } catch {
    return null
  }
}

export function forgetLastUser(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to forget */
  }
}
