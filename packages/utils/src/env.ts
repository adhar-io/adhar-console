declare const Deno: { env: { get(key: string): string | undefined } } | undefined

export function env(key: string, fallback?: string): string | undefined {
  if (typeof Deno !== 'undefined' && Deno?.env) return Deno.env.get(key) ?? fallback
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[key] ?? fallback
}

export function requireEnv(key: string): string {
  const v = env(key)
  if (!v) throw new Error(`Missing required environment variable: ${key}`)
  return v
}
