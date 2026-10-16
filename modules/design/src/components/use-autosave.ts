import { useCallback, useEffect, useRef, useState } from 'react'
import type { SaveState } from './ui-bits.tsx'

/**
 * Debounced autosave for an editor's local draft.
 *
 * Saves `value` `delay` ms after it last changed, skips no-op saves (compared
 * by serialisation), flushes a pending change on unmount / document switch,
 * and exposes `flush()` for ⌘S. `key` identifies the document: when it
 * changes, the new value is treated as already saved.
 */
export function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<unknown>,
  { key, delay = 900, enabled = true, onError }: {
    key: string
    delay?: number
    enabled?: boolean
    onError?(e: Error): void
  },
): { state: SaveState; flush(): Promise<void> } {
  const ser = JSON.stringify(value)
  const lastSaved = useRef(ser)
  const keyRef = useRef(key)
  if (keyRef.current !== key) {
    keyRef.current = key
    lastSaved.current = ser
  }
  const latest = useRef({ ser, value })
  latest.current = { ser, value }
  const saveRef = useRef(save)
  saveRef.current = save
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const [state, setState] = useState<SaveState>('idle')

  const flush = useCallback(async () => {
    const cur = latest.current
    if (cur.ser === lastSaved.current) return
    const prev = lastSaved.current
    lastSaved.current = cur.ser
    setState('saving')
    try {
      await saveRef.current(cur.value)
      setState(latest.current.ser === cur.ser ? 'saved' : 'dirty')
    } catch (e) {
      lastSaved.current = prev
      setState('error')
      onErrorRef.current?.(e instanceof Error ? e : new Error(String(e)))
    }
  }, [])

  useEffect(() => {
    if (!enabled || ser === lastSaved.current) return
    setState('dirty')
    const t = setTimeout(() => void flush(), delay)
    return () => clearTimeout(t)
  }, [ser, enabled, delay, flush])

  // Flush pending edits when the editor unmounts.
  useEffect(() => () => void flush(), [flush])

  return { state, flush }
}
