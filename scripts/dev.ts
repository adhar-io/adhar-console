#!/usr/bin/env -S deno run -A
/**
 * Spawn the host app + every federated remote in parallel.
 *
 * - Runs each `deno task dev` in its own subprocess.
 * - Prefixes every line of output with a colored process tag.
 * - Forwards Ctrl+C (SIGINT) and termination (SIGTERM) to every child.
 * - Exits with the first non-zero child exit code.
 *
 * Usage:
 *   deno task dev           # from repo root
 *   pnpm dev                # same, via package.json
 *
 * Filter to a subset:
 *   deno task dev console develop platform
 */

interface Proc {
  name: string
  cwd: string
  port: number
  /** ANSI color (SGR code). */
  color: string
}

const PROCS: Proc[] = [
  { name: 'console  ', cwd: 'apps/console', port: 5100, color: '1;36' },
  { name: 'define   ', cwd: 'modules/define', port: 5101, color: '34' },
  { name: 'design   ', cwd: 'modules/design', port: 5102, color: '35' },
  { name: 'develop  ', cwd: 'modules/develop', port: 5103, color: '32' },
  { name: 'deliver  ', cwd: 'modules/deliver', port: 5104, color: '33' },
  { name: 'discover ', cwd: 'modules/discover', port: 5105, color: '31' },
  { name: 'decide   ', cwd: 'modules/decide', port: 5106, color: '95' },
  { name: 'platform ', cwd: 'modules/platform', port: 5107, color: '96' },
  { name: 'workspace', cwd: 'modules/workspace', port: 5108, color: '94' },
]

const args = Deno.args.map((a) => a.trim()).filter(Boolean)
const selected = args.length === 0
  ? PROCS
  : PROCS.filter((p) => args.some((a) => p.name.trim() === a || p.cwd.endsWith(a)))

if (selected.length === 0) {
  console.error(`No processes matched: ${args.join(', ')}`)
  console.error(`Available: ${PROCS.map((p) => p.name.trim()).join(', ')}`)
  Deno.exit(1)
}

const children: { proc: Proc; child: Deno.ChildProcess }[] = []
let shuttingDown = false

function tag(p: Proc): string {
  return `\x1b[${p.color}m[${p.name}:${p.port}]\x1b[0m`
}

async function pipe(
  proc: Proc,
  stream: ReadableStream<Uint8Array>,
  sink: (line: string) => void,
) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length > 0) sink(`${tag(proc)} ${line}`)
      }
    }
    if (buffer.length > 0) sink(`${tag(proc)} ${buffer}`)
  } catch {
    // Stream closed — process exiting.
  }
}

function spawn(proc: Proc) {
  const cmd = new Deno.Command('deno', {
    args: ['task', 'dev'],
    cwd: proc.cwd,
    stdout: 'piped',
    stderr: 'piped',
    env: { ...Deno.env.toObject(), FORCE_COLOR: '1' },
  })
  const child = cmd.spawn()
  children.push({ proc, child })

  pipe(proc, child.stdout, (line) => console.log(line))
  pipe(proc, child.stderr, (line) => console.error(line))

  child.status.then((status) => {
    if (shuttingDown) return
    console.log(
      `${tag(proc)} exited with code ${status.code}${status.success ? '' : ' ⚠'}`,
    )
    if (!status.success) shutdown(status.code ?? 1)
  })
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n\x1b[90mShutting down…\x1b[0m')
  for (const { proc, child } of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already exited.
    }
    console.log(`${tag(proc)} \x1b[90msent SIGTERM\x1b[0m`)
  }
  // Grace period then exit; children with hanging deno vite processes will be
  // reaped by OS when this process dies anyway.
  setTimeout(() => Deno.exit(code), 2500)
}

Deno.addSignalListener('SIGINT', () => shutdown(0))
Deno.addSignalListener('SIGTERM', () => shutdown(0))

console.log(
  `\x1b[1mAdhar Console dev\x1b[0m · starting ${selected.length} process${
    selected.length === 1 ? '' : 'es'
  }`,
)
for (const p of selected) {
  console.log(`  ${tag(p)} ${p.cwd}`)
}
console.log('')

for (const p of selected) spawn(p)

// Keep the parent alive until a child crashes or the user hits Ctrl+C.
await new Promise<void>(() => {})
