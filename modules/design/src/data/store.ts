/**
 * Lightweight client-side persistence for the Design module. Nothing here
 * talks to a backend yet — ADRs / personas / journeys / whiteboard notes /
 * wireframes all live in localStorage so the views are interactive end-to-end
 * while the BFF endpoints are still being wired up.
 *
 * Shape and key naming match the eventual server schema so swapping to a
 * `useQuery` against the BFF later is a one-import change.
 */

const PREFIX = 'adhar.design'

function read<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(`${PREFIX}.${key}`)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`${PREFIX}.${key}`, JSON.stringify(value))
}

export const store = {
  get<T>(key: string, fallback: T): T {
    return read(key, fallback)
  },
  set<T>(key: string, value: T): void {
    write(key, value)
  },
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}
