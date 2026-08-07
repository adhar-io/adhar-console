import { useEffect, useMemo, useState } from 'react'
import { Button, Card, CardBody, CardHeader, StatusBadge } from '@adhar-console/shell-ui'
import { KIND, TOKEN_SET_ID, useDoc, useUpsertDoc } from '../data/store.ts'
import { DEFAULT_TOKENS } from '../data/tokens-seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { TokenSet } from '../data/types.ts'

type Format = 'json' | 'css'

/**
 * Design tokens — now fully editable and persisted. The token set is seeded
 * from DEFAULT_TOKENS into localStorage (`adhar.design.tokens`); every edit
 * writes straight back, the swatches/previews re-render live, and the CSS/JSON
 * export always reflects the current (edited) values. "Reset to defaults"
 * restores the canonical baseline.
 */
export function Tokens() {
  const { data, isLoading, error } = useDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  const upsert = useUpsertDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)

  const [tokens, setTokens] = useState<TokenSet>(DEFAULT_TOKENS)
  const [exportOpen, setExportOpen] = useState(false)

  // Sync the editable working set from the stored document as it loads.
  useEffect(() => {
    if (data) setTokens(mergeDefaults(data))
  }, [data])

  const persist = (next: TokenSet) => {
    setTokens(next)
    upsert.mutate(next)
  }

  const setValue = (category: keyof TokenSet, index: number, value: string) => {
    persist({
      ...tokens,
      [category]: tokens[category].map((t, i) => (i === index ? { ...t, value } : t)),
    })
  }

  const setCurve = (index: number, curve: string) => {
    persist({
      ...tokens,
      motion: tokens.motion.map((t, i) => (i === index ? { ...t, curve } : t)),
    })
  }

  const reset = () => {
    if (!confirm('Reset all tokens to their default values? Your edits will be discarded.')) return
    persist(DEFAULT_TOKENS)
  }

  const total = useMemo(
    () => Object.values(tokens).reduce((acc, list) => acc + list.length, 0),
    [tokens],
  )

  const exported = useMemo(() => {
    return {
      color: Object.fromEntries(tokens.color.map((t) => [t.name, t.value])),
      spacing: Object.fromEntries(tokens.spacing.map((t) => [t.name, t.value])),
      typography: Object.fromEntries(tokens.typography.map((t) => [t.name, t.value])),
      radius: Object.fromEntries(tokens.radius.map((t) => [t.name, t.value])),
      elevation: Object.fromEntries(tokens.elevation.map((t) => [t.name, t.value])),
      motion: Object.fromEntries(tokens.motion.map((t) => [t.name, `${t.value} ${t.curve}`])),
      breakpoint: Object.fromEntries(tokens.breakpoint.map((t) => [t.name, t.value])),
    }
  }, [tokens])

  const asCss = useMemo(() => {
    const lines: string[] = [':root {']
    for (const group of Object.values(exported)) {
      for (const [name, value] of Object.entries(group)) lines.push(`  ${name}: ${value};`)
    }
    lines.push('}')
    return lines.join('\n')
  }, [exported])

  const asJson = useMemo(() => JSON.stringify(exported, null, 2), [exported])

  if (error) return <ErrorBlock error={error} />
  if (isLoading) return <LoadingBlock label="Loading design tokens…" />

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">7 categories · {total} tokens · editable</div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={reset} leading={<IconReset />}>
            Reset to defaults
          </Button>
          <Button size="sm" onClick={() => setExportOpen((o) => !o)} leading={<IconDownload />}>
            {exportOpen ? 'Hide export' : 'Export'}
          </Button>
        </div>
      </div>

      {exportOpen ? <ExportPanel css={asCss} json={asJson} /> : null}

      <Section title="Color" sub="Brand and semantic colors — click a swatch to recolor">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {tokens.color.map((t, i) => (
            <div
              key={t.name}
              className="flex items-center gap-3 rounded-lg border border-edge-default bg-white p-3 shadow-sm"
            >
              <label className="relative h-12 w-12 shrink-0 cursor-pointer">
                <span
                  className="block h-full w-full rounded-lg border border-edge-subtle"
                  style={{ background: t.value }}
                />
                <input
                  type="color"
                  value={normalizeColor(t.value)}
                  onChange={(e) => setValue('color', i, e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label={`${t.role} color`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-content">{t.role}</div>
                <div className="truncate font-mono text-[10px] text-content-subtle">{t.name}</div>
                <input
                  value={t.value}
                  onChange={(e) => setValue('color', i, e.target.value)}
                  spellCheck={false}
                  className="mt-0.5 w-full rounded border border-transparent bg-transparent font-mono text-[10px] text-content-muted hover:border-edge-subtle focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-400/30"
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Spacing" sub="Pixel scale that drives layout rhythm">
        <Card>
          <CardBody className="space-y-2 p-3">
            {tokens.spacing.map((t, i) => (
              <div
                key={t.name}
                className="flex items-center gap-3 rounded-md border border-edge-subtle bg-surface-sunken/40 p-2"
              >
                <div className="h-3 rounded-sm bg-brand-500" style={{ width: t.value }} />
                <span className="font-mono text-xs text-content-subtle">{t.name}</span>
                <ValueInput
                  className="ml-auto w-24 text-right"
                  value={t.value}
                  onChange={(v) => setValue('spacing', i, v)}
                />
              </div>
            ))}
          </CardBody>
        </Card>
      </Section>

      <Section title="Typography" sub="Font families and type scale">
        <Card>
          <CardBody className="space-y-3 p-4">
            {tokens.typography.map((t, i) => (
              <div
                key={t.name}
                className="flex items-baseline justify-between gap-2 border-b border-edge-subtle pb-2 last:border-0 last:pb-0"
              >
                <span className="shrink-0 font-mono text-xs text-content-subtle">{t.name}</span>
                <ValueInput
                  className="w-64 text-right"
                  value={t.value}
                  onChange={(v) => setValue('typography', i, v)}
                />
              </div>
            ))}
          </CardBody>
        </Card>
      </Section>

      <Section title="Radius" sub="Corner rounding for surfaces">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {tokens.radius.map((t, i) => (
            <Card key={t.name}>
              <CardBody className="flex flex-col items-center gap-2 p-3 text-center">
                <div
                  className="h-12 w-full bg-brand-100 ring-1 ring-inset ring-brand-200"
                  style={{ borderRadius: t.value }}
                />
                <div className="font-mono text-[10px] text-content-subtle">{t.name}</div>
                <ValueInput
                  className="w-full text-center"
                  value={t.value}
                  onChange={(v) => setValue('radius', i, v)}
                />
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Elevation" sub="Shadow stack for layered surfaces">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tokens.elevation.map((t, i) => (
            <Card key={t.name}>
              <CardBody className="space-y-3 p-4">
                <div
                  className="flex h-16 items-center justify-center rounded-lg bg-white"
                  style={{ boxShadow: t.value }}
                >
                  <span className="font-mono text-[10px] text-content-subtle">{t.name}</span>
                </div>
                <ValueInput
                  className="w-full font-mono text-[10px]! leading-relaxed"
                  value={t.value}
                  onChange={(v) => setValue('elevation', i, v)}
                />
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Motion" sub="Durations + easing curves">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {tokens.motion.map((t, i) => (
            <Card key={t.name}>
              <CardBody className="space-y-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-content">{t.name}</span>
                  <div className="flex items-center gap-1">
                    <ValueInput
                      className="w-16 text-right"
                      value={t.value}
                      onChange={(v) => setValue('motion', i, v)}
                    />
                    <StatusBadge kind="info">{t.value}</StatusBadge>
                  </div>
                </div>
                <MotionPreview duration={t.value} curve={t.curve} />
                <ValueInput
                  className="w-full font-mono text-[10px]!"
                  value={t.curve}
                  onChange={(v) => setCurve(i, v)}
                />
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Breakpoints" sub="Responsive layout thresholds">
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-edge-subtle">
              {tokens.breakpoint.map((t, i) => (
                <li key={t.name} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-mono text-xs text-content">{t.name}</span>
                  <span className="text-xs text-content-muted">· {t.label}</span>
                  <ValueInput
                    className="ml-auto w-24 text-right font-semibold"
                    value={t.value}
                    onChange={(v) => setValue('breakpoint', i, v)}
                  />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </Section>
    </div>
  )
}

/**
 * Guard against an older/partial persisted shape by backfilling any category
 * missing from the stored set with its default list.
 */
function mergeDefaults(stored: Partial<TokenSet> | null): TokenSet {
  const s = stored ?? {}
  const pick = <K extends keyof TokenSet>(k: K): TokenSet[K] => {
    const v = s[k]
    return Array.isArray(v) && v.length ? (v as TokenSet[K]) : DEFAULT_TOKENS[k]
  }
  return {
    color: pick('color'),
    spacing: pick('spacing'),
    typography: pick('typography'),
    radius: pick('radius'),
    elevation: pick('elevation'),
    motion: pick('motion'),
    breakpoint: pick('breakpoint'),
  }
}

/** A hex string an <input type="color"> will accept, else a neutral fallback. */
function normalizeColor(value: string): string {
  const v = value.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
    if (v.length === 4) {
      return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
    }
    return v
  }
  return '#888888'
}

function ValueInput({
  value,
  onChange,
  className = '',
}: {
  value: string
  onChange(v: string): void
  className?: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className={`rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-xs text-content hover:border-edge-subtle focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-400/30 ${className}`}
    />
  )
}

function Section({
  title,
  sub,
  children,
}: {
  title: string
  sub: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-base font-semibold tracking-tight text-content">{title}</h2>
        <span className="text-xs text-content-subtle">{sub}</span>
      </div>
      {children}
    </section>
  )
}

function ExportPanel({ css, json }: { css: string; json: string }) {
  const [tab, setTab] = useState<Format>('css')
  const value = tab === 'css' ? css : json

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">Export tokens</div>
            <div className="text-[11px] text-content-subtle">
              Reflects your edits — copy the snippet into your codebase or design tool.
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-edge-default bg-white p-1 shadow-sm">
            {(['css', 'json'] as Format[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setTab(f)}
                className={
                  tab === f
                    ? 'rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-brand-700 bg-brand-50'
                    : 'rounded px-2 py-0.5 text-[11px] uppercase tracking-wider text-content-muted hover:bg-surface-sunken'
                }
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="relative">
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(value)}
            className="absolute right-2 top-2 rounded-md bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-muted ring-1 ring-edge-default hover:text-content"
          >
            Copy
          </button>
          <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
            {value}
          </pre>
        </div>
      </CardBody>
    </Card>
  )
}

function MotionPreview({ duration, curve }: { duration: string; curve: string }) {
  const [phase, setPhase] = useState<'a' | 'b'>('a')
  return (
    <button
      type="button"
      onClick={() => setPhase((p) => (p === 'a' ? 'b' : 'a'))}
      className="relative h-8 w-full overflow-hidden rounded-full bg-surface-sunken/60 ring-1 ring-inset ring-edge-subtle"
      aria-label="Replay animation"
    >
      <span
        className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-linear-to-br from-brand-500 to-brand-400 shadow-md"
        style={{
          left: phase === 'a' ? '4px' : 'calc(100% - 24px)',
          transition: `left ${duration} ${curve}`,
        }}
      />
    </button>
  )
}

function IconDownload() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
function IconReset() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}
