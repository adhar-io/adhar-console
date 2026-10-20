import { useEffect, useMemo, useState } from 'react'
import { Button, Modal } from '@adhar/shell-ui'
import { usePlatformSnapshot } from '../data/platform.ts'
import {
  diffStats,
  type DiffLine,
  generateDiagram,
  GENERATOR_LABEL,
  type GeneratorKind,
  type GeneratorParams,
  generatorTitle,
  refOf,
} from '../data/platform-model.ts'
import { MermaidPreview } from './mermaid-render.tsx'
import { CatalogSources } from './catalog-bits.tsx'

/**
 * "Generate from platform": C4 context / container diagrams from the service
 * catalog, a deployment view from Argo CD per environment, and the tenancy
 * tree — as editable Mermaid that remembers how it was generated, so it can
 * be regenerated later and the drift shown as a diff.
 */

const PAPER_BG: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(99,102,241,0.16) 1px, transparent 0)',
  backgroundSize: '22px 22px',
}

const KINDS: { id: GeneratorKind; hint: string }[] = [
  { id: 'c4-context', hint: 'Systems (or stand-alone components) and who calls whom, from catalog relations.' },
  { id: 'c4-container', hint: 'A system’s components and resources; API calls and dependencies between them.' },
  { id: 'deployment', hint: 'Argo CD applications per environment, dev → test → prod, with live sync and health.' },
  { id: 'tenancy', hint: 'Organisation → Teams → Projects → Apps from the workspace.' },
]

const SELECT = 'h-8 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-[12.5px] text-content'

export function GenerateDiagramModal({
  open,
  onClose,
  initialProject,
  busy,
  onCreate,
}: {
  open: boolean
  onClose(): void
  initialProject?: string
  busy?: boolean
  onCreate(input: { title: string; source: string; kind: GeneratorKind; params: GeneratorParams }): void
}) {
  const snap = usePlatformSnapshot(open)
  const [kind, setKind] = useState<GeneratorKind>('c4-context')
  const [params, setParams] = useState<GeneratorParams>({})
  useEffect(() => {
    if (open) setParams({ project: initialProject })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const systems = snap.data.entities.filter((e) => e.kind === 'System')
  const projects = useMemo(() => {
    const s = new Set<string>([
      ...snap.data.tenancy.projects.map((p) => p.slug),
      ...snap.data.entities.map((e) => e.project).filter((p): p is string => !!p),
    ])
    return [...s].sort()
  }, [snap.data])
  const source = useMemo(() => generateDiagram(kind, params, snap.data), [kind, params, snap.data])
  const sourceNote = kind === 'deployment'
    ? snap.argoError ? `Argo CD unavailable: ${snap.argoError}` : snap.argoLoading ? 'Reading Argo CD…' : `${snap.data.argoApps.length} Argo CD applications`
    : kind === 'tenancy'
    ? snap.tenancyError ? `Workspace unavailable: ${snap.tenancyError}` : `${snap.data.tenancy.teams.length} teams · ${snap.data.tenancy.projects.length} projects · ${snap.data.tenancy.apps.length} apps`
    : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate from platform"
      description="Built from live platform data, as plain Mermaid you can edit. The diagram remembers its generator so you can refresh it and review the drift."
      branded
      width="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={snap.refetch}>Refresh data</Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={busy || !snap.ready}
            onClick={() => onCreate({ title: generatorTitle(kind, params, snap.data.entities), source, kind, params })}
          >
            Create diagram
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="space-y-3">
          <ul className="space-y-1">
            {KINDS.map((k) => (
              <li key={k.id}>
                <button
                  type="button"
                  onClick={() => setKind(k.id)}
                  aria-pressed={kind === k.id}
                  className={`w-full rounded-lg border p-2.5 text-left transition ${
                    kind === k.id ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-400/20 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised hover:border-edge-strong'
                  }`}
                >
                  <div className="text-[13px] font-semibold text-content">{GENERATOR_LABEL[k.id]}</div>
                  <div className="mt-0.5 text-[11.5px] text-content-muted">{k.hint}</div>
                </button>
              </li>
            ))}
          </ul>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">Project</span>
            <select value={params.project ?? ''} onChange={(e) => setParams((p) => ({ ...p, project: e.target.value || undefined }))} className={SELECT}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          {kind === 'c4-container'
            ? (
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">System</span>
                <select value={params.system ?? ''} onChange={(e) => setParams((p) => ({ ...p, system: e.target.value || undefined }))} className={SELECT}>
                  <option value="">All systems</option>
                  {systems.map((s) => <option key={refOf(s)} value={refOf(s)}>{s.title ?? s.name}</option>)}
                </select>
                {!systems.length ? <span className="mt-1 block text-[11px] text-content-subtle">No System entities — add them to a repo’s catalog-info.yaml to group containers.</span> : null}
              </label>
            )
            : null}
          {kind === 'c4-context' || kind === 'c4-container'
            ? <CatalogSources sources={snap.catalog.sources} />
            : <div className="text-[11px] text-content-subtle">{sourceNote}</div>}
        </div>
        <div className="flex min-h-[320px] flex-col overflow-hidden rounded-lg border border-edge-default">
          <div className="relative flex-1 overflow-hidden p-3" style={PAPER_BG}>
            {snap.ready
              ? <MermaidPreview key={source} source={source} className="flex h-full w-full items-center justify-center [&_svg]:!h-full [&_svg]:!max-h-[48vh] [&_svg]:!w-full [&_svg]:!max-w-none" />
              : <div className="p-8 text-center text-sm text-slate-500">Reading the platform…</div>}
          </div>
          <details className="border-t border-edge-subtle bg-surface-raised">
            <summary className="cursor-pointer px-3 py-1.5 text-[11.5px] text-content-muted">Mermaid source ({source.split('\n').length} lines)</summary>
            <pre className="max-h-48 overflow-auto px-3 pb-2 font-mono text-[11px] text-content">{source}</pre>
          </details>
        </div>
      </div>
    </Modal>
  )
}

/** Show regenerated-vs-current as a line diff; replace on confirm. */
export function RegenerateModal({
  open,
  onClose,
  diff,
  handEdited,
  onReplace,
}: {
  open: boolean
  onClose(): void
  diff: DiffLine[]
  /** True when the current source differs from what was last generated. */
  handEdited: boolean
  onReplace(): void
}) {
  const st = diffStats(diff)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Regenerate from platform"
      description={st.added || st.removed ? `${st.added} line${st.added === 1 ? '' : 's'} added, ${st.removed} removed compared with the current source.` : 'The platform matches the current source.'}
      width="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Keep current</Button>
          <Button size="sm" variant="primary" disabled={!st.added && !st.removed} onClick={onReplace}>Replace source</Button>
        </>
      }
    >
      {handEdited
        ? (
          <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            This diagram was edited by hand since it was generated — replacing drops those edits (undo with ⌘Z in the editor).
          </div>
        )
        : null}
      <pre className="max-h-[56vh] overflow-auto rounded-lg border border-edge-default bg-surface-sunken/50 py-2 font-mono text-[11.5px] leading-relaxed">
        {diff.map((d, i) => (
          <div
            key={i}
            className={`px-3 ${d.op === '+' ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : d.op === '-' ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300' : 'text-content-muted'}`}
          >
            {d.op} {d.text}
          </div>
        ))}
      </pre>
    </Modal>
  )
}
