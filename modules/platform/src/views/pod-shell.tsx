import { useEffect, useRef, useState } from 'react'
import { Button, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'

/**
 * Browser-side pod exec terminal.
 *
 * Production path: opens a WebSocket against `/kube-api/.../exec` using the
 * Kubernetes v4/v5.channel.k8s.io binary subprotocol. Frames are prefixed
 * with a single channel byte:
 *
 *   0 stdin    1 stdout    2 stderr    3 err    4 resize
 *
 * Fallback path: if the live exec channel can't be reached (no kubectl proxy
 * in dev, RBAC denial server-side, or the cluster simply isn't there), the
 * panel transparently switches to a simulated session backed by an in-process
 * command interpreter. The user keeps a usable terminal for demos and
 * documentation, with a clear banner that calls out the simulation.
 */

interface ConnectParams {
  namespace: string
  pod: string
  container: string
  shell: string
}

type Status = 'idle' | 'connecting' | 'open' | 'simulated' | 'closed' | 'error'

const CHANNEL_STDIN = 0
const CHANNEL_STDOUT = 1
const CHANNEL_STDERR = 2
const CHANNEL_ERR = 3
const CHANNEL_RESIZE = 4

export function PodShell({
  namespace,
  name,
  containers,
  defaultContainer,
}: {
  namespace: string
  name: string
  containers: string[]
  defaultContainer?: string
}) {
  const canExec = useHasK8sPermission('pods.exec')
  const [container, setContainer] = useState<string>(defaultContainer ?? containers[0] ?? '')
  const [shell, setShell] = useState<string>('/bin/sh')
  const [params, setParams] = useState<ConnectParams | null>(null)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <label className="text-[11px] font-medium text-content-subtle">Container</label>
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          disabled={!!params}
          className="rounded-md border border-edge-default bg-white px-2 py-1 text-xs disabled:opacity-60"
        >
          {containers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="ml-2 text-[11px] font-medium text-content-subtle">Shell</label>
        <select
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          disabled={!!params}
          className="rounded-md border border-edge-default bg-white px-2 py-1 text-xs disabled:opacity-60"
        >
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
          <option value="/usr/bin/env sh">/usr/bin/env sh</option>
        </select>
        <span className="ml-auto text-[11px] text-content-subtle">
          {params ? 'session active' : 'disconnected'}
        </span>
        {params ? (
          <Button size="sm" variant="secondary" onClick={() => setParams(null)}>
            Disconnect
          </Button>
        ) : canExec ? (
          <Button
            size="sm"
            onClick={() => {
              if (!container) return
              setParams({ namespace, pod: name, container, shell })
            }}
          >
            Connect
          </Button>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-white px-2 py-1 text-[11px] text-content-muted"
            title="Pod exec requires the Developer or higher role"
          >
            Connect
            <K8sRolePill perm="pods.exec" />
          </span>
        )}
      </div>

      {params ? (
        <TerminalSession key={`${params.pod}/${params.container}/${params.shell}`} params={params} />
      ) : (
        <div className="rounded-xl border border-dashed border-edge-default bg-surface-sunken p-10 text-center">
          <div className="text-sm font-medium text-content">Exec into this pod</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-content-muted">
            Opens a WebSocket session against{' '}
            <code className="font-mono">/api/v1/.../exec</code> — your keystrokes stream into{' '}
            <code className="font-mono">{shell}</code> in container{' '}
            <code className="font-mono">{container || '—'}</code>. If the live cluster is
            unreachable, a simulated session is provided for the most common shell commands.
          </p>
        </div>
      )}
    </div>
  )
}

function TerminalSession({ params }: { params: ConnectParams }) {
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string>('')
  const [history, setHistory] = useState<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const simRef = useRef<SimSession | null>(null)
  const outputRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Buffer for the in-progress line in simulated mode.
  const lineRef = useRef<string>('')
  const historyIdxRef = useRef<number>(-1)

  // Auto-scroll.
  useEffect(() => {
    const el = outputRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [output])

  // Keep focus on the hidden input.
  useEffect(() => {
    inputRef.current?.focus()
  }, [status])

  useEffect(() => {
    let cancelled = false
    setStatus('connecting')
    setError(null)
    setOutput('')
    lineRef.current = ''
    historyIdxRef.current = -1

    const proto = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const qs = new URLSearchParams()
    qs.set('container', params.container)
    qs.set('stdin', 'true')
    qs.set('stdout', 'true')
    qs.set('stderr', 'true')
    qs.set('tty', 'true')
    for (const part of params.shell.split(' ')) qs.append('command', part)

    const url = `${proto}//${globalThis.location.host}/kube-api/api/v1/namespaces/${encodeURIComponent(
      params.namespace,
    )}/pods/${encodeURIComponent(params.pod)}/exec?${qs.toString()}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url, ['v4.channel.k8s.io', 'v5.channel.k8s.io'])
    } catch (e) {
      if (cancelled) return () => {}
      // Couldn't even open the WS object (CSP, malformed URL) — drop straight
      // to simulated mode so the user has something to interact with.
      startSimulated(params, setStatus, setOutput, simRef, e instanceof Error ? e.message : String(e))
      return () => {
        simRef.current?.dispose()
        simRef.current = null
      }
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      if (cancelled) return
      setStatus('open')
      appendOutput(
        setOutput,
        `\x1b[36m* connected to ${params.pod}/${params.container} via ${params.shell}\x1b[0m\n`,
      )
      sendResize(ws, 80, 24)
    }
    ws.onerror = () => {
      if (cancelled) return
      // Likely no kubectl proxy / RBAC denial / no cluster. Switch to the
      // simulated terminal so the user can keep working.
      startSimulated(
        params,
        setStatus,
        setOutput,
        simRef,
        'Live cluster unreachable — running in interactive demo mode.',
      )
      setError(
        'WebSocket error — kubectl proxy not running, /kube-api isn\'t forwarding WS upgrades, or the cluster denied the exec request. Switched to simulated session.',
      )
    }
    ws.onclose = (e) => {
      if (cancelled) return
      // If we never reached open, defer to the error path which already
      // started the simulator. Otherwise mark closed.
      if (status === 'open') {
        setStatus('closed')
        appendOutput(
          setOutput,
          `\n\x1b[90m* session closed (code ${e.code}${e.reason ? `, reason: ${e.reason}` : ''})\x1b[0m\n`,
        )
      }
    }
    ws.onmessage = (ev) => {
      if (cancelled) return
      const data = ev.data
      if (typeof data === 'string') {
        appendOutput(setOutput, data)
        return
      }
      const buf = new Uint8Array(data as ArrayBuffer)
      if (buf.byteLength === 0) return
      const channel = buf[0]
      const payload = new TextDecoder().decode(buf.subarray(1))
      switch (channel) {
        case CHANNEL_STDOUT:
        case CHANNEL_STDERR:
          appendOutput(setOutput, payload)
          break
        case CHANNEL_ERR:
          appendOutput(setOutput, `\n\x1b[31m[err channel] ${payload}\x1b[0m\n`)
          break
      }
    }

    return () => {
      cancelled = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
      simRef.current?.dispose()
      simRef.current = null
    }
  }, [params])

  const sendLive = (text: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    const payload = new TextEncoder().encode(text)
    const framed = new Uint8Array(payload.length + 1)
    framed[0] = CHANNEL_STDIN
    framed.set(payload, 1)
    ws.send(framed)
    return true
  }

  const isLive = status === 'open'
  const isSim = status === 'simulated'

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isLive && !isSim) return

    // Live (real shell): pass keys through as bytes/control codes.
    if (isLive) {
      if (e.key === 'Enter') return finalize(e, () => sendLive('\r'))
      if (e.key === 'Tab') return finalize(e, () => sendLive('\t'))
      if (e.key === 'Backspace') return finalize(e, () => sendLive('\x7f'))
      if (e.key === 'ArrowUp') return finalize(e, () => sendLive('\x1b[A'))
      if (e.key === 'ArrowDown') return finalize(e, () => sendLive('\x1b[B'))
      if (e.key === 'ArrowRight') return finalize(e, () => sendLive('\x1b[C'))
      if (e.key === 'ArrowLeft') return finalize(e, () => sendLive('\x1b[D'))
      if (e.ctrlKey && e.key.length === 1) {
        const c = e.key.toLowerCase().charCodeAt(0)
        if (c >= 97 && c <= 122) return finalize(e, () => sendLive(String.fromCharCode(c - 96)))
      }
      if (e.key.length === 1) return finalize(e, () => sendLive(e.key))
      return
    }

    // Simulated (in-process) — buffer until Enter, then run.
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = lineRef.current
      lineRef.current = ''
      historyIdxRef.current = -1
      appendOutput(setOutput, '\n')
      if (cmd.trim()) {
        setHistory((h) => [...h, cmd])
        const result = simRef.current?.run(cmd)
        if (result) appendOutput(setOutput, result + '\n')
      }
      appendOutput(setOutput, simRef.current?.prompt() ?? '$ ')
      return
    }
    if (e.key === 'Backspace') {
      e.preventDefault()
      if (lineRef.current.length > 0) {
        lineRef.current = lineRef.current.slice(0, -1)
        // Echo with a destructive backspace so the prompt redraws.
        appendOutput(setOutput, '\b \b')
      }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const completed = simRef.current?.complete(lineRef.current)
      if (completed && completed !== lineRef.current) {
        const tail = completed.slice(lineRef.current.length)
        lineRef.current = completed
        appendOutput(setOutput, tail)
      }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const idx =
        historyIdxRef.current === -1
          ? history.length - 1
          : Math.max(0, historyIdxRef.current - 1)
      historyIdxRef.current = idx
      replaceLine(setOutput, lineRef, history[idx])
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIdxRef.current === -1) return
      const next = historyIdxRef.current + 1
      if (next >= history.length) {
        historyIdxRef.current = -1
        replaceLine(setOutput, lineRef, '')
      } else {
        historyIdxRef.current = next
        replaceLine(setOutput, lineRef, history[next])
      }
      return
    }
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      setOutput(simRef.current?.prompt() ?? '$ ')
      return
    }
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      lineRef.current = ''
      appendOutput(setOutput, '^C\n' + (simRef.current?.prompt() ?? '$ '))
      return
    }
    if (e.key.length === 1) {
      e.preventDefault()
      lineRef.current += e.key
      appendOutput(setOutput, e.key)
    }
  }

  return (
    <div
      className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-inner"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 items-center justify-center">
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                status === 'open'
                  ? 'bg-emerald-400'
                  : status === 'simulated'
                    ? 'bg-sky-400'
                    : status === 'connecting'
                      ? 'animate-pulse bg-amber-400'
                      : status === 'error'
                        ? 'bg-rose-500'
                        : 'bg-slate-500',
              )}
            />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-wide text-slate-300">
            {status === 'simulated' ? 'demo' : status}
          </span>
          <span className="text-[11px] text-slate-500">
            · {params.pod} / {params.container}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge kind={status === 'open' ? 'healthy' : status === 'simulated' ? 'info' : 'unknown'}>
            {params.shell}
          </StatusBadge>
        </div>
      </div>
      {status === 'simulated' ? (
        <div className="border-b border-sky-900/60 bg-sky-950/40 px-3 py-1.5 text-[11px] text-sky-200">
          <strong>Demo mode</strong> — live cluster unreachable. Output is simulated for{' '}
          <code className="font-mono">ls / pwd / whoami / cat / env / ps / id / uname / echo</code>.
        </div>
      ) : null}
      <pre
        ref={outputRef}
        className="h-[50vh] w-full overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-2 font-mono text-[12px] leading-relaxed"
      >
        {renderWithAnsi(output)}
        {isLive || isSim ? <Cursor /> : null}
      </pre>
      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        aria-label="Terminal input"
        spellCheck={false}
        className="h-0 w-0 resize-none border-0 p-0 opacity-0"
      />
      {error && status === 'error' ? (
        <div className="border-t border-rose-900/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function finalize(e: React.KeyboardEvent, fn: () => void) {
  e.preventDefault()
  fn()
}

function Cursor() {
  return (
    <span className="ml-px inline-block h-[1em] w-[0.55em] translate-y-0.5 animate-pulse bg-slate-200/80 align-baseline" />
  )
}

/* ───── helpers ───── */

function appendOutput(setter: (fn: (prev: string) => string) => void, chunk: string) {
  // Cap scroll buffer to avoid unbounded memory growth on chatty shells.
  const LIMIT = 64 * 1024
  setter((prev) => {
    let next = prev
    // Apply destructive `\b \b` (backspace + space + backspace) so the
    // simulated terminal can erase the previous char without a redraw.
    for (const ch of chunk) {
      if (ch === '\b') next = next.length > 0 ? next.slice(0, -1) : next
      else next += ch
    }
    return next.length > LIMIT ? next.slice(next.length - LIMIT) : next
  })
}

function replaceLine(
  setOutput: (fn: (prev: string) => string) => void,
  lineRef: React.RefObject<string>,
  next: string,
) {
  const old = lineRef.current
  // Erase the current input by emitting backspaces for each char, then write
  // the replacement so cursor stays in the right spot.
  const erase = '\b'.repeat(old.length)
  lineRef.current = next
  appendOutput(setOutput, erase + next)
}

function sendResize(ws: WebSocket, Width: number, Height: number) {
  const payload = new TextEncoder().encode(JSON.stringify({ Width, Height }))
  const framed = new Uint8Array(payload.length + 1)
  framed[0] = CHANNEL_RESIZE
  framed.set(payload, 1)
  ws.send(framed)
}

/**
 * Minimal ANSI SGR renderer — covers the subset most shells emit. Swap for
 * xterm.js if we ever need scroll regions, DECSTBM, mouse input.
 */
function renderWithAnsi(text: string): React.ReactNode {
  if (!text) return null
  const parts: React.ReactNode[] = []
  // ANSI CSI escape — `\x1b` (0x1B / ESC) is intentional here.
  // deno-lint-ignore no-control-regex
  const regex = /\x1b\[([\d;]*)m/g
  let last = 0
  let style: { color?: string; bold?: boolean; dim?: boolean } = {}
  let key = 0
  const flush = (to: number) => {
    if (to <= last) return
    const chunk = text.slice(last, to)
    parts.push(
      <span
        key={key++}
        style={{
          color: style.color,
          fontWeight: style.bold ? 700 : undefined,
          opacity: style.dim ? 0.6 : undefined,
        }}
      >
        {chunk}
      </span>,
    )
  }
  let m: RegExpExecArray | null
  while ((m = regex.exec(text))) {
    flush(m.index)
    style = applySgr(style, m[1])
    last = regex.lastIndex
  }
  flush(text.length)
  return parts
}

function applySgr(
  style: { color?: string; bold?: boolean; dim?: boolean },
  code: string,
): { color?: string; bold?: boolean; dim?: boolean } {
  if (!code) return {}
  const PALETTE: Record<string, string> = {
    '30': '#94a3b8',
    '31': '#f87171',
    '32': '#34d399',
    '33': '#fbbf24',
    '34': '#60a5fa',
    '35': '#f472b6',
    '36': '#22d3ee',
    '37': '#e2e8f0',
    '90': '#64748b',
    '91': '#fca5a5',
    '92': '#6ee7b7',
    '93': '#fde68a',
    '94': '#93c5fd',
    '95': '#f9a8d4',
    '96': '#67e8f9',
    '97': '#f1f5f9',
  }
  let next = { ...style }
  for (const raw of code.split(';')) {
    if (raw === '0' || raw === '') next = {}
    else if (raw === '1') next.bold = true
    else if (raw === '2') next.dim = true
    else if (PALETTE[raw]) next.color = PALETTE[raw]
  }
  return next
}

/* ───── simulated session ─────────────────────────────────────────────── */

interface SimSession {
  prompt(): string
  run(cmd: string): string | null
  complete(prefix: string): string
  dispose(): void
}

function startSimulated(
  params: ConnectParams,
  setStatus: (s: Status) => void,
  setOutput: (fn: (prev: string) => string) => void,
  ref: React.RefObject<SimSession | null>,
  banner: string,
) {
  if (ref.current) ref.current.dispose()
  const sim = createSimSession(params)
  ref.current = sim
  setStatus('simulated')
  setOutput(() => '')
  appendOutput(
    setOutput,
    `\x1b[33m${banner}\x1b[0m\n\x1b[36m* simulated ${params.pod}/${params.container} via ${params.shell}\x1b[0m\n${sim.prompt()}`,
  )
}

function createSimSession(params: ConnectParams): SimSession {
  let cwd = '/app'
  const env: Record<string, string> = {
    HOSTNAME: params.pod,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    SHELL: params.shell,
    TERM: 'xterm-256color',
    HOME: '/root',
    PWD: cwd,
    POD_NAMESPACE: params.namespace,
    POD_NAME: params.pod,
    CONTAINER: params.container,
  }
  // Tiny fake filesystem rooted at /. Each entry is either a string (file
  // contents) or null (directory marker — children listed elsewhere).
  const files: Record<string, string> = {
    '/app/server.log':
      '2026-04-26T08:14:01Z INFO  starting server on :8080\n2026-04-26T08:14:02Z INFO  ready\n',
    '/app/package.json':
      '{\n  "name": "app",\n  "version": "1.4.2",\n  "scripts": { "start": "node ./dist/main.js" }\n}\n',
    '/etc/hostname': params.pod + '\n',
    '/etc/os-release':
      'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.19.1\nPRETTY_NAME="Alpine Linux v3.19"\n',
    '/etc/resolv.conf':
      'nameserver 10.96.0.10\nsearch ' + params.namespace + '.svc.cluster.local svc.cluster.local cluster.local\n',
  }
  const dirs: Record<string, string[]> = {
    '/': ['app', 'bin', 'etc', 'home', 'root', 'tmp', 'usr', 'var', 'proc'],
    '/app': ['server.log', 'package.json', 'dist'],
    '/app/dist': ['main.js'],
    '/etc': ['hostname', 'os-release', 'resolv.conf', 'shadow'],
  }
  const builtins = [
    'ls',
    'pwd',
    'cd',
    'cat',
    'echo',
    'whoami',
    'hostname',
    'env',
    'export',
    'ps',
    'id',
    'uname',
    'date',
    'clear',
    'exit',
    'help',
    'kubectl',
  ]

  const resolve = (p: string): string => {
    if (!p.startsWith('/')) p = (cwd === '/' ? '' : cwd) + '/' + p
    const parts: string[] = []
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return '/' + parts.join('/')
  }

  return {
    prompt() {
      const home = cwd === '/root' ? '~' : cwd
      return `\x1b[1;36mroot@${params.pod}\x1b[0m:\x1b[1;34m${home}\x1b[0m# `
    },
    run(line) {
      const [cmd, ...args] = line.trim().split(/\s+/)
      if (!cmd) return ''
      switch (cmd) {
        case 'help':
          return 'Built-ins: ' + builtins.join(', ')
        case 'pwd':
          return cwd
        case 'whoami':
          return 'root'
        case 'hostname':
          return params.pod
        case 'id':
          return 'uid=0(root) gid=0(root) groups=0(root)'
        case 'uname': {
          if (args.includes('-a')) return `Linux ${params.pod} 5.15.0 #1 SMP x86_64 GNU/Linux`
          if (args.includes('-r')) return '5.15.0'
          return 'Linux'
        }
        case 'date':
          return new Date().toUTCString()
        case 'env':
          return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
        case 'export':
          if (args.length === 0) {
            return Object.entries(env).map(([k, v]) => `declare -x ${k}="${v}"`).join('\n')
          }
          for (const a of args) {
            const eq = a.indexOf('=')
            if (eq > 0) env[a.slice(0, eq)] = a.slice(eq + 1)
          }
          return ''
        case 'echo':
          return args
            .map((a) => a.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, k) => env[k] ?? ''))
            .join(' ')
        case 'cd': {
          const target = resolve(args[0] ?? env.HOME)
          if (target in dirs) {
            cwd = target === '' ? '/' : target
            env.PWD = cwd
            return ''
          }
          return `cd: ${args[0]}: No such directory`
        }
        case 'ls': {
          const target = resolve(args[args.length - 1] ?? cwd)
          const long = args.includes('-l') || args.includes('-la') || args.includes('-al')
          const entries = dirs[target]
          if (!entries) {
            if (target in files) return target.split('/').pop() ?? target
            return `ls: ${args[args.length - 1] ?? cwd}: No such file or directory`
          }
          const sorted = entries.slice().sort()
          if (!long) return sorted.join('  ')
          return sorted
            .map((e) => {
              const full = target + (target === '/' ? '' : '/') + e
              const isDir = full in dirs
              const size = isDir ? 4096 : (files[full]?.length ?? 0)
              const mode = isDir ? 'drwxr-xr-x' : '-rw-r--r--'
              return `${mode}  1 root root ${String(size).padStart(6)} Apr 26 08:15 ${e}`
            })
            .join('\n')
        }
        case 'cat': {
          if (args.length === 0) return 'cat: missing operand'
          const out: string[] = []
          for (const a of args) {
            const target = resolve(a)
            if (target in files) out.push(files[target])
            else if (target in dirs) out.push(`cat: ${a}: Is a directory`)
            else out.push(`cat: ${a}: No such file or directory`)
          }
          return out.join('').replace(/\n$/, '')
        }
        case 'ps': {
          const wide = args.includes('aux') || args.includes('-ef')
          if (wide) {
            return [
              'USER       PID %CPU %MEM    VSZ   RSS TTY   STAT START   TIME COMMAND',
              'root         1  0.0  0.1   1140   780 ?     Ss   08:14   0:00 /sbin/tini -- ' + params.shell,
              'root         7  0.4  1.2 728340 49512 ?     Sl   08:14   0:08 node ./dist/main.js',
              'root        42  0.0  0.0   3232  1428 pts/0 Ss+  08:21   0:00 ' + params.shell,
            ].join('\n')
          }
          return [
            '  PID TTY          TIME CMD',
            '    1 ?        00:00:00 tini',
            '    7 ?        00:00:08 node',
            '   42 pts/0    00:00:00 ' + params.shell.split('/').pop(),
          ].join('\n')
        }
        case 'kubectl':
          return 'sh: kubectl: not found (this container has no Kubernetes client)'
        case 'clear':
          return null
        case 'exit':
          return '\x1b[90m* session ended (use Disconnect to close)\x1b[0m'
        default:
          return `sh: ${cmd}: not found`
      }
    },
    complete(prefix) {
      const trimmed = prefix.trimStart()
      const lead = prefix.slice(0, prefix.length - trimmed.length)
      // Complete first word against builtins.
      if (!trimmed.includes(' ')) {
        const matches = builtins.filter((b) => b.startsWith(trimmed))
        if (matches.length === 1) return lead + matches[0] + ' '
        return prefix
      }
      // Complete final path-arg against the in-memory FS.
      const parts = trimmed.split(/\s+/)
      const last = parts[parts.length - 1] ?? ''
      const slash = last.lastIndexOf('/')
      const dir = slash >= 0 ? resolve(last.slice(0, slash) || '/') : cwd
      const stub = slash >= 0 ? last.slice(slash + 1) : last
      const entries = dirs[dir] ?? []
      const matches = entries.filter((e) => e.startsWith(stub))
      if (matches.length === 1) {
        const completed = (slash >= 0 ? last.slice(0, slash + 1) : '') + matches[0]
        const isDir = (resolve(completed) in dirs)
        parts[parts.length - 1] = completed + (isDir ? '/' : ' ')
        return lead + parts.join(' ')
      }
      return prefix
    },
    dispose() {
      /* no-op for now */
    },
  }
}
