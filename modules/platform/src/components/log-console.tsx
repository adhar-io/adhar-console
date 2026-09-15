/*
 * Both halves of the log console — the surface AND the transport — live in
 * shell-ui now, so the develop remote can stream Argo step logs with the same
 * hook the pipeline drawer uses. Re-exported here so platform call sites keep
 * importing from one place.
 */
export { ConsoleBtn, LogConsole, useLogStream } from '@adhar-console/shell-ui'
export type { LogConsoleProps, LogLine, LogSource, LogStream, StreamStatus, UseLogStreamOptions } from '@adhar-console/shell-ui'
