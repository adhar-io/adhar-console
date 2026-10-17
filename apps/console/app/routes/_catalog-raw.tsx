import { type ReactNode, useMemo, useState } from 'react'
import { Select, Spinner, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { CodeViewer } from '~/components/code-viewer.tsx'
import type { Entity } from '~/data/catalog.ts'
import { type CompositionRoots, useLiveObject } from '~/data/catalog-composition.ts'
import { age, compositionOf, type KObj, nodeId, type ObjRef } from '~/data/catalog-composition-model.ts'
import { toYaml } from '~/data/k8s-yaml.ts'

/**
 * The Raw tab: the entity as real YAML in a read-only editor, what it says
 * about itself (identity, owner, source, labels and annotations), and — when
 * platform objects back it — the live YAML of each: the composite, its claim,
 * its Composition and revision, and the Argo CD apps that deploy it.
 */

interface Source {
  id: string
  label: string
  group: string
  ref?: ObjRef
  /** What the resolver already read — shown until the live read lands. */
  object?: KObj
}

const ENTITY = 'entity'

export function RawTab({
  entity,
  roots,
  relationCount,
}: {
  entity: Entity
  roots?: CompositionRoots
  relationCount: number
}) {
  const [sourceId, setSourceId] = useState(ENTITY)

  const sources = useMemo<Source[]>(() => {
    const out: Source[] = [{ id: ENTITY, label: `Catalog entity · ${entity.kind}`, group: 'Catalog' }]
    for (const r of roots?.roots ?? []) {
      const isArgo = (r.ref.apiVersion ?? r.ref.group ?? '').startsWith('argoproj.io')
      out.push({ id: nodeId(r.ref), label: `${r.ref.kind} · ${r.ref.name}`, group: isArgo ? 'Argo CD' : 'Platform', ref: r.ref, object: r.object })
      if (r.object) {
        const { composition, revision } = compositionOf(r.object)
        if (composition) {
          const ref: ObjRef = { group: 'apiextensions.crossplane.io', kind: 'Composition', name: composition }
          if (!out.some((s) => s.id === nodeId(ref))) out.push({ id: nodeId(ref), label: `Composition · ${composition}`, group: 'Crossplane', ref })
        }
        if (revision) {
          const ref: ObjRef = { group: 'apiextensions.crossplane.io', kind: 'CompositionRevision', name: revision }
          if (!out.some((s) => s.id === nodeId(ref))) out.push({ id: nodeId(ref), label: `CompositionRevision · ${revision}`, group: 'Crossplane', ref })
        }
      }
    }
    return out
  }, [entity.kind, roots?.roots])

  const source = sources.find((s) => s.id === sourceId) ?? sources[0]
  const live = useLiveObject(roots?.discovery, source.ref, source.id !== ENTITY)
  const entityDoc = useMemo(() => {
    // `origin` is the console's own provenance hint, not part of the entity.
    const { origin: _origin, ...doc } = entity
    return doc
  }, [entity])
  const value: unknown = source.id === ENTITY ? entityDoc : live.data ?? source.object
  const filename = source.id === ENTITY ? `${entity.kind.toLowerCase()}-${entity.metadata.name}` : `${source.ref!.kind.toLowerCase()}-${source.ref!.name}`

  const picker = sources.length > 1 ? (
    <label className="flex min-w-0 items-center gap-2 text-xs text-content-subtle">
      <span className="hidden sm:inline">Showing</span>
      <Select value={source.id} onChange={(e) => setSourceId(e.target.value)} aria-label="Object to show" className="h-7 py-0 text-xs" wrapperClassName="min-w-0 max-w-[18rem]">
        {[...new Set(sources.map((s) => s.group))].map((g) => (
          <optgroup key={g} label={g}>
            {sources.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </optgroup>
        ))}
      </Select>
    </label>
  ) : (
    <span className="text-xs font-medium text-content-muted">catalog-info</span>
  )

  return (
    <div className="space-y-5">
      {source.id === ENTITY ? (
        <EntitySummary entity={entity} relationCount={relationCount} backing={sources.length - 1} />
      ) : value ? (
        <ObjectSummary obj={value as KObj} />
      ) : null}

      {source.id !== ENTITY && !value ? (
        live.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-content-muted"><Spinner /> Reading the live object…</div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">{picker}</div>
            <p className="text-sm text-content-muted">
              {(live.error as { status?: number } | null)?.status === 403
                ? 'Your Kubernetes role cannot read this object.'
                : (live.error as { status?: number } | null)?.status === 404
                  ? 'This object no longer exists, or its CRD is not installed.'
                  : `Could not read it${live.error instanceof Error ? `: ${live.error.message}` : '.'}`}
            </p>
          </div>
        )
      ) : (
        <CodeViewer value={value} filename={filename} ariaLabel={`${source.label} as ${'YAML'}`} toolbarStart={picker} />
      )}
    </div>
  )
}

/* ───────────────────────── summaries ───────────────────────── */

function EntitySummary({ entity, relationCount, backing }: { entity: Entity; relationCount: number; backing: number }) {
  const ann = entity.metadata.annotations ?? {}
  const sourceLoc = ann['backstage.io/source-location'] ?? ann['adhar.io/source-repo'] ?? entity.metadata.links?.find((l) => l.icon === 'repo')?.url
  const managedBy = ann['adhar.io/managed-by'] ?? ann['backstage.io/managed-by-location'] ?? ann['app.kubernetes.io/managed-by']
  const fields: Array<[string, ReactNode]> = [
    ['API version', entity.apiVersion],
    ['Kind', entity.kind],
    ['Namespace', entity.metadata.namespace ?? 'default'],
    ['Name', entity.metadata.name],
    ['Ref', `${entity.kind.toLowerCase()}:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`],
    ['Type', entity.spec.type ?? '—'],
    ['Owner', entity.spec.owner ?? '—'],
    ['Lifecycle', entity.spec.lifecycle ?? '—'],
    ['System', entity.spec.system ?? '—'],
    ['Origin', entity.origin ?? 'seed'],
    ['Source location', sourceLoc ?? '—'],
    ['Managed by', managedBy ?? '—'],
    ['Created', fmtDate(entity.metadata.createdAt)],
    ['Updated', fmtDate(entity.metadata.updatedAt)],
    ['Relations', String(relationCount)],
    ['Backing objects', backing ? String(backing) : 'none found'],
  ]
  return (
    <div className="space-y-4">
      <FieldGrid fields={fields} />
      <ChipTable title="Tags" entries={(entity.metadata.tags ?? []).map((t) => [t, ''])} empty="No tags." />
      <ChipTable title="Annotations" entries={Object.entries(ann)} empty="No annotations." />
    </div>
  )
}

function ObjectSummary({ obj }: { obj: KObj }) {
  const m = obj.metadata
  const owners = (m.ownerReferences ?? []).map((o) => `${o.kind}/${o.name}${o.controller ? ' (controller)' : ''}`)
  const comp = compositionOf(obj)
  const fields: Array<[string, ReactNode]> = [
    ['API version', obj.apiVersion ?? '—'],
    ['Kind', obj.kind ?? '—'],
    ['Namespace', m.namespace ?? '— (cluster-scoped)'],
    ['Name', m.name],
    ['UID', m.uid ?? '—'],
    ['Created', m.creationTimestamp ? `${fmtDate(m.creationTimestamp)} (${age(m.creationTimestamp)} ago)` : '—'],
    ['Resource version', m.resourceVersion ?? '—'],
    ['Generation', m.generation !== undefined ? String(m.generation) : '—'],
    ['Owner', owners.length ? owners.join(', ') : '—'],
    ['Managed by', m.labels?.['app.kubernetes.io/managed-by'] ?? m.labels?.['adhar.io/managed-by'] ?? m.annotations?.['adhar.io/managed-by'] ?? '—'],
  ]
  if (comp.composition) fields.push(['Composition', comp.composition])
  if (comp.revision) fields.push(['Composition revision', comp.revision])
  if (m.deletionTimestamp) fields.push(['Deleting since', fmtDate(m.deletionTimestamp)])
  return (
    <div className="space-y-4">
      <FieldGrid fields={fields} />
      <ChipTable title="Labels" entries={Object.entries(m.labels ?? {})} empty="No labels." />
      <ChipTable
        title="Annotations"
        entries={Object.entries(m.annotations ?? {}).filter(([k]) => k !== 'kubectl.kubernetes.io/last-applied-configuration')}
        empty="No annotations."
      />
    </div>
  )
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function FieldGrid({ fields }: { fields: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
      {fields.map(([k, v]) => (
        <div key={k} className="flex min-w-0 items-baseline gap-3">
          <dt className="w-28 shrink-0 text-content-subtle">{k}</dt>
          <dd className="min-w-0 break-all font-mono text-content">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function ChipTable({ title, entries, empty }: { title: string; entries: Array<[string, string]>; empty: string }) {
  const toast = useToast()
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 12
  const shown = expanded ? entries : entries.slice(0, LIMIT)
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${what}`)).catch(() => toast.error('Could not copy'))
  const asMap = () => (entries.every(([, v]) => v === '') ? entries.map(([k]) => k).join('\n') : toYaml(Object.fromEntries(entries)))
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <h4 className="text-xs font-semibold text-content">{title}</h4>
        <span className="text-[11px] text-content-subtle">{entries.length}</span>
        {entries.length ? (
          <button type="button" onClick={() => copy(asMap(), title.toLowerCase())} className="ml-auto text-[11px] text-content-subtle hover:text-content">
            Copy all
          </button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-content-subtle">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {shown.map(([k, v]) => (
            <li key={k} className="min-w-0 max-w-full">
              <button
                type="button"
                onClick={() => copy(v ? `${k}: ${v}` : k, v ? k : 'tag')}
                title={v ? `${k}: ${v}\n(click to copy)` : `${k} (click to copy)`}
                className={cn(
                  'inline-flex max-w-full items-center overflow-hidden rounded-md text-[11px] ring-1 ring-inset ring-edge-default hover:ring-brand-300',
                )}
              >
                <span className="truncate bg-surface-sunken px-1.5 py-0.5 font-mono text-content-muted">{k}</span>
                {v ? <span className="max-w-[16rem] truncate bg-surface-raised px-1.5 py-0.5 font-mono text-content">{v}</span> : null}
              </button>
            </li>
          ))}
          {entries.length > LIMIT ? (
            <li>
              <button type="button" onClick={() => setExpanded((e) => !e)} className="rounded-md px-1.5 py-0.5 text-[11px] text-brand-700 hover:underline dark:text-brand-300">
                {expanded ? 'Show fewer' : `+${entries.length - LIMIT} more`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  )
}
