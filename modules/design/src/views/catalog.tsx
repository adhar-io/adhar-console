import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Badge, Checkbox, EmptyState, Input, SearchInput, Select, Tabs, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useDesignParams, useSetDesignParams } from '../data/nav.ts'
import {
  CATALOG,
  type CatalogEntry,
  CATEGORIES,
  type Control,
  type Example,
  type Values,
} from '../components/catalog-registry.tsx'
import { CodeBlock, copyText, IconCopy, IconMoon, IconSun, Segmented } from '../components/ux-kit.tsx'
import { useDesignScope } from '../data/design-scope.ts'
import { ProjectComponents, useShellUsage } from '../components/project-components.tsx'

const SHELL_NAMES = [...new Set(CATALOG.flatMap((c) => c.imports))]

type Mode = 'light' | 'dark'

/**
 * Component Catalog — the live reference for `@adhar/shell-ui`, the design
 * system every console page is built from. Each component renders for real
 * (not a screenshot) with a props playground, worked examples, copyable usage
 * snippets and a props table; previews switch between light and dark
 * independently of the console theme. The open component is deep-linkable
 * (`?section=catalog&component=button`).
 */
export function Catalog() {
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const scope = useDesignScope()
  const tab = params.tab === 'project' ? 'project' : 'shell'
  const usage = useShellUsage(scope, SHELL_NAMES)
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<Mode>(() => (appIsDark() ? 'dark' : 'light'))

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return CATALOG
    return CATALOG.filter((c) =>
      `${c.name} ${c.category} ${c.description} ${c.props.map((p) => p.name).join(' ')}`.toLowerCase().includes(n)
    )
  }, [q])

  const active = CATALOG.find((c) => c.id === params.component) ?? filtered[0] ?? CATALOG[0]

  const tabs = (
    <Tabs<'shell' | 'project'>
      tabs={[
        { id: 'shell', label: 'Adhar UI', badge: String(CATALOG.length) },
        { id: 'project', label: scope.project ? `${scope.activeProject?.name ?? scope.project} components` : 'Project components' },
      ]}
      value={tab}
      onChange={(id) => setParams({ tab: id === 'shell' ? undefined : id, component: undefined })}
      ariaLabel="Component sources"
    />
  )
  if (tab === 'project') {
    return (
      <div className="space-y-4">
        {tabs}
        <ProjectComponents scope={scope} shellNames={SHELL_NAMES} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {tabs}
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-content-muted">
          {CATALOG.length} components from <code className="font-mono text-[11px]">@adhar/shell-ui</code>, rendered live
        </div>
        <div className="ml-auto">
          <Segmented<Mode>
            ariaLabel="Preview theme"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'light', label: <><IconSun size={12} /> Light</> },
              { value: 'dark', label: <><IconMoon size={12} /> Dark</> },
            ]}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <SearchInput value={q} onChange={setQ} placeholder="Find a component" />
          <nav aria-label="Components" className="flex gap-1 overflow-x-auto pb-1 lg:block lg:max-h-[calc(100vh-220px)] lg:space-y-4 lg:overflow-y-auto lg:pb-0">
            {CATEGORIES.map((cat) => {
              const items = filtered.filter((c) => c.category === cat)
              if (!items.length) return null
              return (
                <div key={cat} className="flex shrink-0 gap-1 lg:block">
                  <div className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-content-subtle lg:block">{cat}</div>
                  {items.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setParams({ component: c.id })}
                      aria-current={active.id === c.id ? 'page' : undefined}
                      className={cn(
                        'block shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-sm transition-colors lg:w-full',
                        active.id === c.id
                          ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )
            })}
            {filtered.length === 0 ? <p className="px-2 text-xs text-content-subtle">No components match “{q}”.</p> : null}
          </nav>
        </aside>

        {active ? <ComponentDoc key={active.id} entry={active} mode={mode} usage={usage} /> : (
          <EmptyState title="No component selected" />
        )}
      </div>
    </div>
  )
}

/* ───────────────────────────── doc page ───────────────────────────── */

function ComponentDoc({ entry, mode, usage }: { entry: CatalogEntry; mode: Mode; usage: Map<string, number> | null }) {
  const toast = useToast()
  const importLine = `import { ${entry.imports.join(', ')} } from '@adhar/shell-ui'`
  const copy = (text: string, what: string) =>
    copyText(text).then(() => toast.success(`${what} copied`), () => toast.error('Could not copy'))

  return (
    <article className="min-w-0 space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-content">{entry.name}</h2>
          <Badge tone="brand">{entry.category}</Badge>
          {usage ? (
            <span className="text-xs text-content-muted" title="JSX usages in the scanned project component files (Project components tab)">
              {entry.imports.reduce((n, i) => n + (usage.get(i) ?? 0), 0)} uses in scanned project components
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-content-muted">{entry.description}</p>
        <div className="flex max-w-3xl items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken/60 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-content">{importLine}</code>
          <button
            type="button"
            onClick={() => copy(importLine, 'Import')}
            aria-label="Copy import"
            title="Copy import"
            className="rounded p-1 text-content-subtle hover:bg-surface-raised hover:text-content"
          >
            <IconCopy size={13} />
          </button>
        </div>
      </header>

      {entry.controls && entry.render && entry.code ? (
        <Playground entry={entry} mode={mode} onCopy={(c) => copy(c, 'Code')} />
      ) : null}

      {entry.examples.length ? (
        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-content">Examples</h3>
          {entry.examples.map((ex) => <ExampleBlock key={ex.title} ex={ex} mode={mode} onCopy={(c) => copy(c, 'Code')} />)}
        </section>
      ) : null}

      {entry.guidance?.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-content">Usage guidance</h3>
          <ul className="max-w-3xl list-disc space-y-1 pl-5 text-sm text-content-muted">
            {entry.guidance.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-content">Props</h3>
        <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full min-w-155 text-sm">
            <thead>
              <tr className="border-b border-edge-default text-left text-[11px] font-semibold uppercase tracking-wide text-content-subtle">
                <th className="px-4 py-2.5">Prop</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Default</th>
                <th className="px-4 py-2.5">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {entry.props.map((p) => (
                <tr key={p.name}>
                  <td className="whitespace-nowrap px-4 py-2 align-top font-mono text-xs font-medium text-content">{p.name}</td>
                  <td className="px-4 py-2 align-top font-mono text-[11px] text-violet-700 dark:text-violet-300">{p.type}</td>
                  <td className="whitespace-nowrap px-4 py-2 align-top font-mono text-[11px] text-content-muted">{p.default ?? '—'}</td>
                  <td className="px-4 py-2 align-top text-xs text-content-muted">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  )
}

function Playground({ entry, mode, onCopy }: { entry: CatalogEntry; mode: Mode; onCopy(code: string): void }) {
  const controls = entry.controls!
  const [values, setValues] = useState<Values>(() => Object.fromEntries(controls.map((c) => [c.key, c.default])))
  const set = (k: string, v: string | boolean | number) => setValues((cur) => ({ ...cur, [k]: v }))
  const code = entry.code!(values)
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-content">Playground</h3>
      <div className="overflow-hidden rounded-xl border border-edge-default">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_240px]">
          <PreviewFrame mode={mode} className="min-h-48">{entry.render!(values)}</PreviewFrame>
          <div className="space-y-3 border-t border-edge-default bg-surface-raised p-4 md:border-l md:border-t-0">
            {controls.map((c) => <ControlInput key={c.key} c={c} value={values[c.key]} onChange={(v) => set(c.key, v)} />)}
          </div>
        </div>
        <CodeBlock
          code={code}
          className="rounded-none border-0 border-t border-edge-default"
          maxHeight={220}
          actions={<CopyChip onClick={() => onCopy(code)} />}
        />
      </div>
    </section>
  )
}

function ControlInput({ c, value, onChange }: { c: Control; value: string | boolean | number; onChange(v: string | boolean | number): void }) {
  const label = <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-content-subtle">{c.label}</span>
  switch (c.type) {
    case 'select':
      return (
        <label className="block">
          {label}
          <Select value={String(value)} onChange={(e) => onChange(e.target.value)} className="h-8 py-1 text-xs" options={c.options.map((o) => ({ value: o, label: o }))} />
        </label>
      )
    case 'boolean':
      return <Checkbox label={c.label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
    case 'number':
      return (
        <label className="block">
          {label}
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={c.min ?? 0}
              max={c.max ?? 100}
              value={Number(value)}
              onChange={(e) => onChange(Number(e.target.value))}
              className="flex-1 accent-brand-600"
            />
            <span className="w-8 text-right text-xs tabular-nums text-content-muted">{String(value)}</span>
          </div>
        </label>
      )
    default:
      return (
        <label className="block">
          {label}
          <Input value={String(value)} onChange={(e) => onChange(e.target.value)} className="h-8 py-1 text-xs" />
        </label>
      )
  }
}

function ExampleBlock({ ex, mode, onCopy }: { ex: Example; mode: Mode; onCopy(code: string): void }) {
  const [showCode, setShowCode] = useState(false)
  return (
    <div className="overflow-hidden rounded-xl border border-edge-default">
      <div className="flex items-center gap-2 border-b border-edge-default bg-surface-raised px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-content">{ex.title}</div>
          {ex.description ? <div className="text-xs text-content-muted">{ex.description}</div> : null}
        </div>
        <button
          type="button"
          onClick={() => setShowCode((s) => !s)}
          aria-expanded={showCode}
          className="rounded-md px-2 py-1 text-xs font-medium text-content-muted hover:bg-surface-sunken hover:text-content"
        >
          {showCode ? 'Hide code' : 'Show code'}
        </button>
        <CopyChip onClick={() => onCopy(ex.code)} subtle />
      </div>
      <PreviewFrame mode={mode}>{ex.render()}</PreviewFrame>
      {showCode ? <CodeBlock code={ex.code} className="rounded-none border-0 border-t border-edge-default" maxHeight={320} /> : null}
    </div>
  )
}

function CopyChip({ onClick, subtle }: { onClick(): void; subtle?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Copy code"
      title="Copy code"
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
        subtle ? 'text-content-muted hover:bg-surface-sunken hover:text-content' : 'bg-white/10 text-code-fg hover:bg-white/20',
      )}
    >
      <IconCopy size={12} /> Copy
    </button>
  )
}

/* ───────────────────────────── theme-scoped preview ───────────────────────────── */

function appIsDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/**
 * Light-mode values of every token the `.dark` block overrides, read from the
 * console's own stylesheet — so a "light" preview inside a dark console
 * re-scopes those variables back. (A dark preview inside a light console just
 * adds the `dark` class, which re-scopes the tokens on its own.)
 */
function useLightVars(active: boolean): CSSProperties | undefined {
  const [vars, setVars] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    if (!active || vars || typeof document === 'undefined') return
    const darkProps = new Set<string>()
    const light: Record<string, string> = {}
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) {
          const sel = r.selectorText.trim()
          if (sel === '.dark') {
            for (const p of Array.from(r.style)) if (p.startsWith('--')) darkProps.add(p)
          } else if (/^(:root|:host)(\s*,\s*(:root|:host))*$/.test(sel)) {
            for (const p of Array.from(r.style)) if (p.startsWith('--')) light[p] = r.style.getPropertyValue(p).trim()
          }
        } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) {
          walk((r as CSSGroupingRule).cssRules)
        }
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules)
      } catch { /* cross-origin sheet */ }
    }
    const out: Record<string, string> = {}
    for (const p of darkProps) if (light[p]) out[p] = light[p]
    setVars(out)
  }, [active, vars])
  if (!active || !vars) return undefined
  return { ...(vars as CSSProperties), colorScheme: 'light' }
}

function PreviewFrame({ mode, children, className }: { mode: Mode; children: ReactNode; className?: string }) {
  const [dark, setDark] = useState(appIsDark)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const obs = new MutationObserver(() => setDark(appIsDark()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  const lightVars = useLightVars(mode === 'light' && dark)
  return (
    <div
      className={cn(mode === 'dark' && 'dark', 'flex flex-col bg-surface-app text-content', className)}
      style={lightVars}
    >
      <div
        className="flex min-h-32 flex-1 flex-wrap items-center justify-center gap-3 p-6 bg-[radial-gradient(var(--color-edge-default)_1px,transparent_1px)] bg-size-[16px_16px]"
      >
        {children}
      </div>
    </div>
  )
}
