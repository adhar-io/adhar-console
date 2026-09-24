/**
 * One instance of a value per PAGE, not per bundled copy of a module.
 *
 * The console is a Module Federation host with a remote per lifecycle phase.
 * Workspace packages are aliased to their source in every build, which means
 * federation cannot share them: the host and each remote end up with their own
 * copy of `@adhar-console/shell-ui`, `@adhar-console/auth` and so on.
 *
 * For plain functions that is harmless. For a React CONTEXT it is not: a
 * context's identity IS the module-level object `createContext` returned, so a
 * remote calling `useContext(ToastContext)` reads a different object than the
 * one the host's `<ToastProvider>` filled. It gets `null`, silently, and the
 * component falls back to whatever it does when no provider is mounted — a
 * toast that only reaches the console, a session that reads as signed out, a
 * navigate that warns and does nothing. Every one of those looks to a person
 * like a button that does nothing at all.
 *
 * Keying the object on `globalThis` fixes it at the only layer both copies
 * share: whichever copy runs first creates the value, and every later copy
 * gets that same one.
 *
 * Use it for module-level singletons whose IDENTITY matters across the host /
 * remote boundary — React contexts above all. It is not a cache: `create` may
 * run once per page, so it must be cheap and free of side effects.
 */
const REGISTRY = Symbol.for('adhar.console.singletons')

interface Host {
  [REGISTRY]?: Map<string, unknown>
}

export function globalSingleton<T>(key: string, create: () => T): T {
  const host = globalThis as Host
  const registry = (host[REGISTRY] ??= new Map<string, unknown>())
  if (!registry.has(key)) registry.set(key, create())
  return registry.get(key) as T
}
