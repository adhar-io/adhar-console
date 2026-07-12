import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { k8s } from '@adhar-console/api-clients'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'

/**
 * Full-featured YAML view/edit panel.
 *
 * View mode:  syntax-tinted YAML with copy + download.
 * Edit mode:  monospace editor with line numbers, basic YAML syntax colouring,
 *             apply/cancel. On apply we PUT the parsed YAML back against
 *             `/api/v1/namespaces/{ns}/pods/{name}` (or any object with the
 *             same shape) and refresh the query cache.
 *
 * Editing mutable K8s fields is restricted by the server; we surface the
 * apiserver's rejection message verbatim so the user knows why. For pods,
 * most spec fields are immutable, so edits typically succeed only for labels
 * / annotations — the panel still works for those.
 */

const POD_GVR: k8s.GVR = { group: '', version: 'v1', resource: 'pods', namespaced: true }

export function PodYamlPanel({
  pod,
}: {
  pod: k8s.Pod | undefined
}) {
  const qc = useQueryClient()
  const canWrite = useHasK8sPermission('pods.write')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [showDiff, setShowDiff] = useState(false)

  const yaml = useMemo(() => (pod ? toYaml(pod) : ''), [pod])
  const dirty = editing && draft !== yaml

  // Seed draft whenever the underlying YAML updates and we're not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(yaml)
  }, [yaml, editing])

  const startEdit = () => {
    setDraft(yaml)
    setEditing(true)
    setError(null)
    setSuccess(false)
  }
  const cancel = () => {
    setDraft(yaml)
    setEditing(false)
    setError(null)
  }
  const copy = () => navigator.clipboard?.writeText(editing ? draft : yaml)
  const download = () => {
    if (!pod) return
    const blob = new Blob([editing ? draft : yaml], { type: 'text/yaml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${pod.metadata.name}.yaml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const apply = async () => {
    if (!pod) return
    setError(null)
    setSuccess(false)
    let parsed: unknown
    try {
      // Accept either format — power users may paste raw JSON into the editor.
      const trimmed = draft.trimStart()
      parsed = trimmed.startsWith('{') || trimmed.startsWith('[')
        ? JSON.parse(draft)
        : parseYaml(draft)
    } catch (e) {
      setError(`Parse error: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setApplying(true)
    try {
      await client.replaceGeneric(
        LOCAL_CLUSTER,
        POD_GVR,
        pod.metadata.namespace ?? '',
        pod.metadata.name,
        parsed,
      )
      setSuccess(true)
      setEditing(false)
      // Nudge any open pod queries so the drawer's other tabs refresh too.
      qc.invalidateQueries({ queryKey: ['k8s', 'pod', pod.metadata.namespace, pod.metadata.name] })
    } catch (e) {
      // K8s API errors carry body.message which is usually the useful bit.
      const status = (e as { status?: number }).status
      const body = (e as { body?: { message?: string } }).body
      setError(
        `${status ? `HTTP ${status} · ` : ''}${
          body?.message ?? (e instanceof Error ? e.message : String(e))
        }`,
      )
    } finally {
      setApplying(false)
    }
  }

  if (!pod) {
    return <div className="p-8 text-sm text-content-muted">Loading…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <span className="text-[11px] font-medium text-content-subtle">
          {editing
            ? dirty
              ? 'Editing · unsaved changes will PUT to the apiserver on Apply'
              : 'Editing · no changes yet'
            : 'Live manifest · click Edit to modify'}
        </span>
        {dirty ? (
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition',
              showDiff
                ? 'border-brand-300 bg-brand-50 text-brand-700'
                : 'border-edge-default bg-white text-content-muted hover:text-content',
            )}
          >
            <span className="font-mono">±</span>
            {showDiff ? 'Hide diff' : 'Show diff'}
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={copy}>
            Copy
          </Button>
          <Button size="sm" variant="secondary" onClick={download}>
            Download
          </Button>
          {editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={cancel} disabled={applying}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={apply}
                disabled={applying || !dirty || !canWrite}
                title={
                  !canWrite
                    ? 'Apply requires the Tenant Admin or Platform Admin role'
                    : !dirty
                      ? 'No changes to apply'
                      : undefined
                }
              >
                {applying ? 'Applying…' : 'Apply'}
              </Button>
            </>
          ) : canWrite ? (
            <Button size="sm" onClick={startEdit}>
              Edit
            </Button>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-white px-2 py-1 text-[11px] text-content-muted"
              title="Editing requires the Tenant Admin or Platform Admin role"
            >
              Edit
              <K8sRolePill perm="pods.write" />
            </span>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          <strong className="font-semibold">Apply failed:</strong> {error}
        </div>
      ) : null}
      {success && !editing ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <strong className="font-semibold">Applied.</strong> apiserver accepted the update.
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <YamlEditor value={draft} onChange={setDraft} />
          {showDiff && dirty ? <DiffViewer before={yaml} after={draft} /> : null}
        </div>
      ) : (
        <YamlViewer text={yaml} />
      )}
    </div>
  )
}

/* ───── diff viewer ───── */

function DiffViewer({ before, after }: { before: string; after: string }) {
  const hunks = useMemo(() => diffLines(before, after), [before, after])
  const adds = hunks.filter((h) => h.kind === 'add').length
  const dels = hunks.filter((h) => h.kind === 'del').length
  if (adds === 0 && dels === 0) return null
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-400">
        <span className="font-mono uppercase tracking-wider">Diff vs apiserver</span>
        <span className="font-mono">
          <span className="text-emerald-300">+{adds}</span>{' '}
          <span className="text-rose-300">-{dels}</span>
        </span>
      </div>
      <div className="max-h-[35vh] overflow-auto font-mono text-[12px] leading-[1.55]">
        {hunks.map((h, i) => (
          <div
            key={i}
            className={cn(
              'grid grid-cols-[2.5rem_auto] gap-0',
              h.kind === 'add' && 'bg-emerald-500/10 text-emerald-200',
              h.kind === 'del' && 'bg-rose-500/10 text-rose-200',
              h.kind === 'eq' && 'text-slate-400',
            )}
          >
            <span className="select-none border-r border-slate-800/80 bg-slate-900/40 px-2 text-right text-slate-600">
              {h.kind === 'add' ? '+' : h.kind === 'del' ? '−' : ' '}
            </span>
            <span className="whitespace-pre px-3">{h.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Tiny LCS-based line diff — good enough for the YAML round-trip view. Output
 * preserves original ordering with adds/dels interleaved as deltas, plus
 * unchanged context lines (collapsed into a single span when long).
 */
function diffLines(a: string, b: string): Array<{ kind: 'eq' | 'add' | 'del'; text: string }> {
  const A = a.split('\n')
  const B = b.split('\n')
  const m = A.length
  const n = B.length
  // LCS length table (DP).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<{ kind: 'eq' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: 'eq', text: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: A[i] })
      i++
    } else {
      out.push({ kind: 'add', text: B[j] })
      j++
    }
  }
  while (i < m) out.push({ kind: 'del', text: A[i++] })
  while (j < n) out.push({ kind: 'add', text: B[j++] })
  // Collapse big blocks of unchanged lines into context windows of 3 around
  // each change, so the diff stays focused on the deltas.
  return collapseContext(out, 3)
}

function collapseContext(
  hunks: Array<{ kind: 'eq' | 'add' | 'del'; text: string }>,
  ctx: number,
): Array<{ kind: 'eq' | 'add' | 'del'; text: string }> {
  const keep = new Array(hunks.length).fill(false)
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].kind !== 'eq') {
      keep[i] = true
      for (let k = 1; k <= ctx; k++) {
        if (i - k >= 0) keep[i - k] = true
        if (i + k < hunks.length) keep[i + k] = true
      }
    }
  }
  const out: Array<{ kind: 'eq' | 'add' | 'del'; text: string }> = []
  let suppressed = 0
  for (let i = 0; i < hunks.length; i++) {
    if (keep[i]) {
      if (suppressed > 0) {
        out.push({ kind: 'eq', text: `   …${suppressed} unchanged line${suppressed === 1 ? '' : 's'}…` })
        suppressed = 0
      }
      out.push(hunks[i])
    } else {
      suppressed++
    }
  }
  if (suppressed > 0) {
    out.push({ kind: 'eq', text: `   …${suppressed} unchanged line${suppressed === 1 ? '' : 's'}…` })
  }
  return out
}

function YamlViewer({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-slate-100">
      <div className="max-h-[55vh] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="w-10 select-none border-r border-slate-800/80 bg-slate-900/50 px-2 text-right tabular-nums text-slate-500">
                  {i + 1}
                </td>
                <td className="px-3 py-0 align-top whitespace-pre">
                  {renderYamlLine(l)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function YamlEditor({
  value,
  onChange,
}: {
  value: string
  onChange(v: string): void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const [focused, setFocused] = useState(false)

  const lines = value.split('\n')
  // Soft-sync scroll so the syntax overlay matches the textarea.
  const onScroll = () => {
    const t = textareaRef.current
    const p = preRef.current
    if (t && p) {
      p.scrollTop = t.scrollTop
      p.scrollLeft = t.scrollLeft
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const t = e.currentTarget
      const start = t.selectionStart
      const end = t.selectionEnd
      const next = value.slice(0, start) + '  ' + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        t.selectionStart = t.selectionEnd = start + 2
      })
    }
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border bg-slate-950',
        focused ? 'border-brand-400 ring-2 ring-brand-400/20' : 'border-slate-800',
      )}
    >
      <div className="grid grid-cols-[2.5rem_1fr]">
        <div className="select-none border-r border-slate-800/80 bg-slate-900/60 py-2 text-right font-mono text-[11px] tabular-nums text-slate-500">
          {lines.map((_, i) => (
            <div key={i} className="px-2 leading-[1.55]">
              {i + 1}
            </div>
          ))}
        </div>
        <div className="relative">
          <pre
            ref={preRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre p-2 font-mono text-[12px] leading-[1.55] text-slate-100"
          >
            {lines.map((l, i) => (
              <div key={i}>{renderYamlLine(l)}</div>
            ))}
          </pre>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            spellCheck={false}
            className="relative block h-[55vh] w-full resize-none overflow-auto whitespace-pre bg-transparent p-2 font-mono text-[12px] leading-[1.55] text-transparent caret-white focus:outline-none"
            style={{ tabSize: 2 }}
          />
        </div>
      </div>
    </div>
  )
}

/* ───── YAML rendering ───── */

function renderYamlLine(line: string): React.ReactNode {
  if (!line) return '\u00a0'
  if (/^\s*#/.test(line)) {
    return <span className="text-slate-500">{line}</span>
  }
  // key: value — colourise key + value with simple regex.
  const m = line.match(/^(\s*-?\s*)([A-Za-z0-9_./-]+)(\s*):(\s*)(.*)$/)
  if (m) {
    const [, lead, key, ws1, ws2, rest] = m
    return (
      <>
        <span>{lead}</span>
        <span className="text-sky-300">{key}</span>
        <span>{ws1}:</span>
        <span>{ws2}</span>
        {renderYamlValue(rest)}
      </>
    )
  }
  return <span>{line}</span>
}

function renderYamlValue(raw: string): React.ReactNode {
  if (raw === '') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return <span className="text-amber-300">{raw}</span>
  if (/^(true|false|null|~)$/.test(raw)) return <span className="text-purple-300">{raw}</span>
  if (/^['"]/.test(raw)) return <span className="text-emerald-300">{raw}</span>
  return <span className="text-slate-100">{raw}</span>
}

/* ───── YAML serialize + parse ───── */

const SKIP = new Set(['managedFields'])

export function toYaml(value: unknown): string {
  const emit = (v: unknown, indent: number, inList: boolean): string => {
    const pad = '  '.repeat(indent)
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') {
      if (v.includes('\n')) {
        return `|\n${v
          .split('\n')
          .map((l) => `${pad}${l}`)
          .join('\n')}`
      }
      return /^[-:#?&*!{}[\]|>'"%@`,]/.test(v) || /^(true|false|null|\d)/.test(v)
        ? JSON.stringify(v)
        : v
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      return v
        .map((item) => {
          const body = emit(item, indent + 1, true)
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            return `${pad}- ${body.trimStart()}`
          }
          return `${pad}- ${body}`
        })
        .join('\n')
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => !SKIP.has(k))
      if (entries.length === 0) return '{}'
      return entries
        .map(([k, val], i) => {
          const inlinePad = inList && i === 0 ? '' : pad
          if (
            val !== null &&
            typeof val === 'object' &&
            (Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0)
          ) {
            return `${inlinePad}${k}:\n${emit(val, indent + 1, false)}`
          }
          return `${inlinePad}${k}: ${emit(val, indent + 1, false)}`
        })
        .join('\n')
    }
    return String(v)
  }
  return emit(value, 0, false)
}

/**
 * Minimal YAML parser for the shapes K8s objects round-trip through. Handles
 * nested maps, lists of scalars, and lists of maps at 2-space indentation.
 * Not a general-purpose YAML parser — good enough for the edit flow where we
 * serialise the same way we parse.
 */
export function parseYaml(text: string): unknown {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  let i = 0

  const indentOf = (l: string) => {
    let n = 0
    while (n < l.length && l[n] === ' ') n++
    return n
  }
  const isBlank = (l: string) => !l.trim() || l.trim().startsWith('#')

  const parseScalar = (v: string): unknown => {
    if (v === '' || v === 'null' || v === '~') return null
    if (v === 'true') return true
    if (v === 'false') return false
    if (/^-?\d+$/.test(v)) return parseInt(v, 10)
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return JSON.parse(v.replace(/^'|'$/g, '"'))
    }
    return v
  }

  const parseBlock = (indent: number): unknown => {
    // Peek at first non-blank line to decide map vs list.
    while (i < lines.length && isBlank(lines[i])) i++
    if (i >= lines.length) return null
    const first = lines[i]
    if (indentOf(first) < indent) return null

    if (first.trim().startsWith('- ')) return parseList(indent)
    return parseMap(indent)
  }

  const parseMap = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    while (i < lines.length) {
      const line = lines[i]
      if (isBlank(line)) { i++; continue }
      const lineIndent = indentOf(line)
      if (lineIndent < indent) break
      if (lineIndent > indent) break // shouldn't happen at map level

      const m = line.slice(indent).match(/^([^\s:][^:]*):\s*(.*)$/)
      if (!m) break
      const [, key, rest] = m
      i++
      if (rest === '' || rest === undefined) {
        // Look ahead — nested block.
        const next = lines[i]
        if (next && !isBlank(next) && indentOf(next) > indent) {
          out[key] = parseBlock(indent + 2)
        } else {
          out[key] = null
        }
      } else if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
        // Block scalar.
        const lines2: string[] = []
        while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > indent)) {
          lines2.push(lines[i].slice(indent + 2))
          i++
        }
        out[key] = lines2.join('\n').replace(/\n+$/, '')
      } else if (rest === '{}') {
        out[key] = {}
      } else if (rest === '[]') {
        out[key] = []
      } else {
        out[key] = parseScalar(rest)
      }
    }
    return out
  }

  const parseList = (indent: number): unknown[] => {
    const out: unknown[] = []
    while (i < lines.length) {
      const line = lines[i]
      if (isBlank(line)) { i++; continue }
      const lineIndent = indentOf(line)
      if (lineIndent < indent) break
      if (lineIndent > indent) break
      const trimmed = line.slice(indent)
      if (!trimmed.startsWith('- ')) break
      const rest = trimmed.slice(2)
      i++
      if (!rest) {
        // Block follows.
        const next = lines[i]
        if (next && !isBlank(next) && indentOf(next) > indent) {
          out.push(parseBlock(indent + 2))
        } else {
          out.push(null)
        }
      } else if (rest.includes(':') && !rest.startsWith('"') && !rest.startsWith("'")) {
        // Inline map item — synthesize a pseudo-line and parse as map at
        // indent + 2, back-paddng so the key aligns.
        const inlineLines: string[] = []
        const base = '  '.repeat((indent + 2) / 2)
        inlineLines.push(base + rest)
        // Consume subsequent deeper-indented lines as part of this map item.
        while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > indent)) {
          inlineLines.push(lines[i])
          i++
        }
        // Parse the inline block by resetting the line cursor temporarily.
        const savedLines = lines
        const savedIdx = i
        ;(lines as unknown as string[]).length = 0
        for (const l of inlineLines) (lines as unknown as string[]).push(l)
        i = 0
        const parsed = parseMap(indent + 2)
        ;(lines as unknown as string[]).length = 0
        for (const l of savedLines) (lines as unknown as string[]).push(l)
        i = savedIdx
        out.push(parsed)
      } else {
        out.push(parseScalar(rest))
      }
    }
    return out
  }

  const result = parseBlock(0)
  return result
}
