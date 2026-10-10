import { useSyncExternalStore } from 'react'

/**
 * One tiny piece of page state shared between components with no common
 * parent worth threading props through: which supply-chain stage the lead
 * packet is at right now. The 3D scene writes it every frame; the stage
 * strip under the canvas reads it.
 */
function createStore<T>(initial: T) {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(next: T) {
      if (Object.is(next, state)) return
      state = next
      for (const fn of subs) fn()
    },
    subscribe(fn: () => void) {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

export const activeStage = createStore(0)

export function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
