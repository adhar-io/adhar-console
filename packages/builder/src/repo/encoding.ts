/** UTF-8 safe base64 (generated code contains non-ASCII). */
export function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

export function unb64(s: string): string {
  const bin = atob(s.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** `apps/web` + `src/x.ts` → `apps/web/src/x.ts`; tolerant of stray slashes. */
export function joinPath(base: string, path: string): string {
  const b = base.trim().replace(/^\/+|\/+$/g, '')
  const p = path.replace(/^\/+/, '')
  return b ? `${b}/${p}` : p
}
