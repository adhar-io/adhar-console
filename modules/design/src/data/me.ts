import { useQuery } from '@tanstack/react-query'

/** The signed-in member (`/api/workspace/me`) — for review attribution. Null when unknown. */
export function useMe() {
  return useQuery({
    queryKey: ['workspace', 'me'],
    queryFn: async () => {
      const r = await fetch('/api/workspace/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!r.ok) return null
      const b = (await r.json()) as { email?: string; name?: string }
      return { email: b.email ?? '', name: b.name || b.email || '' }
    },
    staleTime: 10 * 60_000,
    retry: false,
  })
}
