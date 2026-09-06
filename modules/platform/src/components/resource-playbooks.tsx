import { useState } from 'react'
import { useDocsUrl } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'

/**
 * Minimal, copy-paste playbooks for day-to-day operations on a resource —
 * split into a **Developer** lane (inspect, understand, debug) and an
 * **Operator** lane (change, watch, remove). Commands are pre-filled with the
 * resource's kind/name/namespace so they run as-is. A "Full documentation" link
 * points at the platform docs site for anything deeper.
 *
 * Reusable across resource pages (the resource drawer, the Adhar Resources
 * catalog, …). Pass explicit `developer`/`operator` steps to tailor them, or
 * rely on the sensible kubectl defaults generated from kind/name/namespace.
 */

export interface PlaybookStep {
  title: string
  desc?: string
  /** Shell command shown in a copyable code block. */
  cmd?: string
}

interface Props {
  kind: string
  name?: string
  namespace?: string
  /** Path under the docs base, e.g. "resources/databases". */
  docsPath?: string
  developer?: PlaybookStep[]
  operator?: PlaybookStep[]
  defaultOpen?: boolean
}

function kctl(kind: string, name: string, ns?: string): string {
  const n = ns ? ` -n ${ns}` : ''
  return `kubectl ${kind.toLowerCase()} ${name}${n}`.trim()
}

function defaultDeveloper(kind: string, name: string, ns?: string): PlaybookStep[] {
  const ref = `${kind.toLowerCase()} ${name}${ns ? ` -n ${ns}` : ''}`
  return [
    {
      title: 'Inspect the live spec & status',
      desc: 'See exactly what is applied and its current status conditions.',
      cmd: `kubectl get ${ref} -o yaml`,
    },
    {
      title: 'Describe & recent events',
      desc: 'Human-readable summary plus the events that explain what happened.',
      cmd: `kubectl describe ${ref}`,
    },
    {
      title: 'Watch it settle',
      desc: 'Stream changes until the resource reaches its desired state.',
      cmd: `kubectl get ${ref} -w`,
    },
  ]
}

function defaultOperator(kind: string, name: string, ns?: string): PlaybookStep[] {
  const ref = `${kind.toLowerCase()} ${name}${ns ? ` -n ${ns}` : ''}`
  return [
    {
      title: 'Edit in place',
      desc: 'Open the live object in your editor and apply changes on save.',
      cmd: `kubectl edit ${ref}`,
    },
    {
      title: 'Re-apply from Git (GitOps)',
      desc: 'Prefer changing the source of truth — let Argo CD reconcile it.',
      cmd: `# edit the manifest in Git, then\nargocd app sync <app>`,
    },
    {
      title: 'Delete',
      desc: 'Remove the resource. In GitOps, delete it from Git instead.',
      cmd: `kubectl delete ${ref}`,
    },
  ]
}

export function ResourcePlaybooks({
  kind,
  name = '<name>',
  namespace,
  docsPath,
  developer,
  operator,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const [lane, setLane] = useState<'developer' | 'operator'>('developer')
  const docsBase = useDocsUrl()
  const docsHref = docsPath ? `${docsBase}/${docsPath.replace(/^\//, '')}` : docsBase

  const dev = developer ?? defaultDeveloper(kind, name, namespace)
  const ops = operator ?? defaultOperator(kind, name, namespace)
  const steps = lane === 'developer' ? dev : ops

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
          <IconBook />
        </span>
        <span className="text-sm font-semibold text-content">Playbooks</span>
        <span className="text-[11px] text-content-subtle">
          common {kind} operations for developers &amp; operators
        </span>
        <span className={cn('ml-auto text-content-subtle transition-transform', open && 'rotate-180')}>
          <IconChevron />
        </span>
      </button>

      {open ? (
        <div className="border-t border-edge-default px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-edge-default bg-surface-sunken p-0.5">
              {(['developer', 'operator'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLane(l)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                    lane === l
                      ? 'bg-brand-600 text-white'
                      : 'text-content-muted hover:text-content',
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
            <a
              href={docsHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
            >
              Full documentation <IconExternal />
            </a>
          </div>

          <ol className="space-y-2.5">
            {steps.map((s, i) => (
              <li key={i} className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-raised text-[11px] font-semibold text-content-muted ring-1 ring-inset ring-edge-default">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-content">{s.title}</div>
                    {s.desc ? (
                      <p className="mt-0.5 text-[12px] text-content-muted">{s.desc}</p>
                    ) : null}
                    {s.cmd ? <CmdBlock cmd={s.cmd} /> : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-content-subtle">
            Commands run with your identity and Kubernetes RBAC. For anything beyond these, see the
            documentation.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function CmdBlock({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-edge-subtle bg-slate-950 px-2.5 py-1.5">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-100">
        {cmd}
      </pre>
      <button
        type="button"
        onClick={() => {
          try {
            navigator.clipboard?.writeText(cmd)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } catch {
            /* clipboard blocked */
          }
        }}
        title={copied ? 'Copied' : 'Copy'}
        className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  )
}

/* icons */
const svg = (children: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
)
const IconBook = () => svg(<><path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4z" /><path d="M9 8h6M9 12h6M9 16h4" /></>)
const IconChevron = () => svg(<path d="m6 9 6 6 6-6" />, 16)
const IconExternal = () => svg(<><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14 21 3" /></>, 12)
const IconCopy = () => svg(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, 12)
const IconCheck = () => svg(<path d="M20 6 9 17l-5-5" />, 12)
