/**
 * Deliver's watch signal now lives in shell-ui, shared by every module
 * (`useWatchSignal` and its pure helpers in `live-signal.ts`). Re-exported
 * here so existing imports keep working.
 */
export { useWatchSignal, type WatchSignalOpts } from '@adhar/shell-ui'
