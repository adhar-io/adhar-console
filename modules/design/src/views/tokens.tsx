import { useMemo, useState } from 'react'
import { Button, Card, CardBody, CardHeader, StatusBadge } from '@adhar-console/shell-ui'

const COLOR_TOKENS = [
  { name: '--adhar-color-primary', value: '#0f172a', role: 'Primary surface' },
  { name: '--adhar-color-accent', value: '#4f46e5', role: 'Accent / link' },
  { name: '--adhar-color-success', value: '#059669', role: 'Success' },
  { name: '--adhar-color-warning', value: '#d97706', role: 'Warning' },
  { name: '--adhar-color-danger', value: '#e11d48', role: 'Danger' },
  { name: '--adhar-color-muted', value: '#f1f5f9', role: 'Muted surface' },
  { name: '--adhar-color-border', value: '#e2e8f0', role: 'Border' },
]

const SPACING_TOKENS = [
  { name: '--adhar-space-1', value: '4px' },
  { name: '--adhar-space-2', value: '8px' },
  { name: '--adhar-space-3', value: '12px' },
  { name: '--adhar-space-4', value: '16px' },
  { name: '--adhar-space-6', value: '24px' },
  { name: '--adhar-space-8', value: '32px' },
  { name: '--adhar-space-12', value: '48px' },
  { name: '--adhar-space-16', value: '64px' },
]

const TYPE_TOKENS = [
  { name: '--adhar-font-sans', value: 'Inter, system-ui, sans-serif' },
  { name: '--adhar-font-mono', value: 'JetBrains Mono, ui-monospace' },
  { name: '--adhar-text-xs', value: '12px / 16px' },
  { name: '--adhar-text-sm', value: '14px / 20px' },
  { name: '--adhar-text-base', value: '16px / 24px' },
  { name: '--adhar-text-lg', value: '18px / 28px' },
  { name: '--adhar-text-xl', value: '20px / 28px' },
  { name: '--adhar-text-2xl', value: '24px / 32px' },
]

const RADIUS_TOKENS = [
  { name: '--adhar-radius-sm', value: '4px' },
  { name: '--adhar-radius-md', value: '8px' },
  { name: '--adhar-radius-lg', value: '12px' },
  { name: '--adhar-radius-xl', value: '16px' },
  { name: '--adhar-radius-2xl', value: '20px' },
  { name: '--adhar-radius-full', value: '9999px' },
]

const ELEVATION_TOKENS = [
  { name: '--adhar-shadow-sm', value: '0 1px 2px rgba(15,23,42,0.05)' },
  { name: '--adhar-shadow-md', value: '0 4px 6px -1px rgba(15,23,42,0.08)' },
  { name: '--adhar-shadow-lg', value: '0 10px 15px -3px rgba(15,23,42,0.10)' },
  { name: '--adhar-shadow-xl', value: '0 20px 25px -5px rgba(15,23,42,0.12)' },
]

const MOTION_TOKENS = [
  { name: '--adhar-duration-fast', value: '120ms', curve: 'ease-out' },
  { name: '--adhar-duration-base', value: '200ms', curve: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  { name: '--adhar-duration-slow', value: '320ms', curve: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { name: '--adhar-duration-page', value: '500ms', curve: 'cubic-bezier(0.22, 1, 0.36, 1)' },
]

const BREAKPOINT_TOKENS = [
  { name: '--adhar-bp-sm', value: '640px', label: 'Phone landscape' },
  { name: '--adhar-bp-md', value: '768px', label: 'Tablet portrait' },
  { name: '--adhar-bp-lg', value: '1024px', label: 'Tablet landscape / laptop' },
  { name: '--adhar-bp-xl', value: '1280px', label: 'Desktop' },
  { name: '--adhar-bp-2xl', value: '1536px', label: 'Wide desktop' },
]

type Format = 'json' | 'css'

export function Tokens() {
  const [exportOpen, setExportOpen] = useState(false)

  const exported = useMemo(() => {
    const flat = {
      color: Object.fromEntries(COLOR_TOKENS.map((t) => [t.name, t.value])),
      spacing: Object.fromEntries(SPACING_TOKENS.map((t) => [t.name, t.value])),
      typography: Object.fromEntries(TYPE_TOKENS.map((t) => [t.name, t.value])),
      radius: Object.fromEntries(RADIUS_TOKENS.map((t) => [t.name, t.value])),
      elevation: Object.fromEntries(ELEVATION_TOKENS.map((t) => [t.name, t.value])),
      motion: Object.fromEntries(MOTION_TOKENS.map((t) => [t.name, `${t.value} ${t.curve}`])),
      breakpoint: Object.fromEntries(BREAKPOINT_TOKENS.map((t) => [t.name, t.value])),
    }
    return flat
  }, [])

  const asCss = useMemo(() => {
    const lines: string[] = [':root {']
    for (const group of Object.values(exported)) {
      for (const [name, value] of Object.entries(group)) lines.push(`  ${name}: ${value};`)
    }
    lines.push('}')
    return lines.join('\n')
  }, [exported])

  const asJson = useMemo(() => JSON.stringify(exported, null, 2), [exported])

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] text-content-muted">
          7 categories · {[
            COLOR_TOKENS,
            SPACING_TOKENS,
            TYPE_TOKENS,
            RADIUS_TOKENS,
            ELEVATION_TOKENS,
            MOTION_TOKENS,
            BREAKPOINT_TOKENS,
          ].reduce((acc, l) => acc + l.length, 0)}{' '}
          tokens
        </div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setExportOpen((o) => !o)} leading={<IconDownload />}>
            {exportOpen ? 'Hide export' : 'Export'}
          </Button>
        </div>
      </div>

      {exportOpen ? <ExportPanel css={asCss} json={asJson} /> : null}

      <Section title="Color" sub="Brand and semantic colors">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {COLOR_TOKENS.map((t) => (
            <div
              key={t.name}
              className="flex items-center gap-3 rounded-lg border border-edge-default bg-white p-3 shadow-sm"
            >
              <div
                className="h-12 w-12 shrink-0 rounded-lg border border-edge-subtle"
                style={{ background: t.value }}
              />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-content">{t.role}</div>
                <div className="truncate font-mono text-[10px] text-content-subtle">{t.name}</div>
                <div className="truncate font-mono text-[10px] text-content-muted">{t.value}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Spacing" sub="Pixel scale that drives layout rhythm">
        <Card>
          <CardBody className="space-y-2 p-3">
            {SPACING_TOKENS.map((t) => (
              <div key={t.name} className="flex items-center gap-3 rounded-md border border-edge-subtle bg-surface-sunken/40 p-2">
                <div className="h-3 rounded-sm bg-brand-500" style={{ width: t.value }} />
                <span className="font-mono text-xs text-content-subtle">{t.name}</span>
                <span className="ml-auto font-mono text-xs text-content">{t.value}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </Section>

      <Section title="Typography" sub="Font families and type scale">
        <Card>
          <CardBody className="space-y-3 p-4">
            {TYPE_TOKENS.map((t) => (
              <div key={t.name} className="flex items-baseline justify-between gap-2 border-b border-edge-subtle pb-2 last:border-0 last:pb-0">
                <span className="font-mono text-xs text-content-subtle">{t.name}</span>
                <span className="font-mono text-xs text-content">{t.value}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </Section>

      <Section title="Radius" sub="Corner rounding for surfaces">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {RADIUS_TOKENS.map((t) => (
            <Card key={t.name}>
              <CardBody className="flex flex-col items-center gap-2 p-3 text-center">
                <div
                  className="h-12 w-full bg-brand-100 ring-1 ring-inset ring-brand-200"
                  style={{ borderRadius: t.value }}
                />
                <div className="font-mono text-[10px] text-content-subtle">{t.name}</div>
                <div className="font-mono text-[11px] text-content">{t.value}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Elevation" sub="Shadow stack for layered surfaces">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ELEVATION_TOKENS.map((t) => (
            <Card key={t.name}>
              <CardBody className="space-y-3 p-4">
                <div
                  className="flex h-16 items-center justify-center rounded-lg bg-white"
                  style={{ boxShadow: t.value }}
                >
                  <span className="font-mono text-[10px] text-content-subtle">{t.name}</span>
                </div>
                <div className="font-mono text-[10px] leading-relaxed text-content-muted">
                  {t.value}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Motion" sub="Durations + easing curves">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {MOTION_TOKENS.map((t) => (
            <Card key={t.name}>
              <CardBody className="space-y-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-content">{t.name}</span>
                  <StatusBadge kind="info">{t.value}</StatusBadge>
                </div>
                <MotionPreview duration={t.value} curve={t.curve} />
                <div className="font-mono text-[10px] text-content-subtle">{t.curve}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Breakpoints" sub="Responsive layout thresholds">
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-edge-subtle">
              {BREAKPOINT_TOKENS.map((t) => (
                <li key={t.name} className="flex items-center gap-3 px-4 py-3">
                  <span className="font-mono text-xs text-content">{t.name}</span>
                  <span className="text-xs text-content-muted">· {t.label}</span>
                  <span className="ml-auto font-mono text-xs font-semibold text-content">
                    {t.value}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </Section>
    </div>
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
            <div className="text-[11px] text-content-subtle">Copy the snippet into your codebase or design tool.</div>
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
