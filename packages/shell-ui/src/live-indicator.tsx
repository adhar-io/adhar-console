import { useEffect, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { useLiveStatus } from './live.ts'

/**
 * Connection state for the realtime hub.
 *
 * The console is push-driven: the apiserver's own watch events reach the
 * browser over one WebSocket, and views update on the change rather than on a
 * timer. That is invisible when it works, which is exactly why it needs to be
 * visible when it doesn't — a page that has quietly stopped receiving updates
 * looks identical to a cluster where nothing is happening.
 *
 * So the indicator earns its place by being quiet: while the socket is live it
 * is a small dot, and it only expands into words when the connection is
 * degraded and the user's data may be behind. Polling continues throughout, so
 * "reconnecting" means slower, not broken — and the tooltip says so.
 */
export function LiveIndicator({ className }: { className?: string }) {
  const status = useLiveStatus()

  // A brief reconnect during a deploy or a laptop waking up is normal and not
  // worth shouting about. Only surface the degraded state once it has actually
  // persisted, so the indicator doesn't flicker on every transient blip.
  const [settled, setSettled] = useState(status)
  useEffect(() => {
    if (status === 'live') {
      setSettled('live')
      return
    }
    const t = setTimeout(() => setSettled(status), 4000)
    return () => clearTimeout(t)
  }, [status])

  const live = settled === 'live'
  const connecting = settled === 'connecting'

  const label = live
    ? 'Live — updates arrive as they happen'
    : connecting
      ? 'Connecting to the live update stream…'
      : 'Live updates are disconnected. The console is falling back to periodic refresh, so data is still current but arrives more slowly.'

  return (
    <span
      title={label}
      aria-label={label}
      role="status"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] font-medium transition-colors',
        live
          ? 'text-content-subtle'
          : connecting
            ? 'text-content-muted'
            : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {live ? (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden"
            aria-hidden
          />
        ) : null}
        <span
          className={cn(
            'relative inline-flex h-1.5 w-1.5 rounded-full',
            live ? 'bg-emerald-500' : connecting ? 'bg-slate-400' : 'bg-amber-500',
          )}
        />
      </span>
      {/* The word only appears when it carries information. */}
      {live ? null : <span>{connecting ? 'Connecting' : 'Reconnecting'}</span>}
    </span>
  )
}
