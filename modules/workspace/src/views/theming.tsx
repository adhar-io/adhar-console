import { useEffect, useState } from 'react'
import { cn } from '@adhar-console/utils'
import {
  applyTheme,
  DEFAULT_THEME_ID,
  getStoredThemeId,
  ModeToggle,
  StatusBadge,
  THEMES,
  type ThemePreset,
} from '@adhar-console/shell-ui'
import { SecondaryButton, ViewShell } from '../components/section-shell.tsx'

export function Theming() {
  const [activeId, setActiveId] = useState<string>(DEFAULT_THEME_ID)

  useEffect(() => {
    setActiveId(getStoredThemeId())
  }, [])

  const select = (id: string) => {
    applyTheme(id)
    setActiveId(id)
  }

  const reset = () => select(DEFAULT_THEME_ID)

  return (
    <ViewShell
      title="Appearance"
      description="Pick a palette for the whole console. Colors update instantly and persist across sessions — only you see them."
      actions={<SecondaryButton onClick={reset}>Reset to default</SecondaryButton>}
    >

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
            Color mode
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-edge-default bg-surface-raised p-4">
          <ModeToggle variant="segmented" />
          <p className="text-xs text-content-muted">
            Light, dark, or follow your operating-system preference. Tracks live when set to System.
          </p>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
            Color theme
          </h3>
          <span className="text-xs text-content-subtle">{THEMES.length} presets</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {THEMES.map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              active={activeId === t.id}
              onSelect={() => select(t.id)}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">
          Live preview
        </h3>
        <Preview />
      </section>
    </ViewShell>
  )
}

function ThemeCard({
  theme,
  active,
  onSelect,
}: {
  theme: ThemePreset
  active: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'group relative flex flex-col rounded-xl border bg-white p-4 text-left shadow-sm transition',
        active
          ? 'border-brand-500 ring-2 ring-brand-500/25'
          : 'border-edge-default hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
      )}
    >
      <div
        className="h-20 w-full rounded-lg"
        style={{
          backgroundImage: `linear-gradient(135deg, ${theme.swatches[0]}, ${theme.swatches[1]})`,
        }}
      />
      <div className="mt-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-content">{theme.name}</div>
            {active ? <StatusBadge kind="healthy">Active</StatusBadge> : null}
          </div>
          <p className="mt-0.5 text-xs text-content-muted">{theme.description}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        {theme.swatches.map((hex, i) => (
          <span
            key={i}
            className="h-5 w-5 rounded-full ring-1 ring-inset ring-black/10"
            style={{ backgroundColor: hex }}
            aria-hidden
          />
        ))}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-content-subtle">
          {theme.id}
        </span>
      </div>
    </button>
  )
}

function Preview() {
  return (
    <div className="rounded-xl border border-edge-default bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button className="h-9 rounded-md bg-brand-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700">
          Primary
        </button>
        <button className="h-9 rounded-md border border-brand-200 bg-brand-50 px-4 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100">
          Soft
        </button>
        <button className="h-9 rounded-md border border-edge-strong bg-white px-4 text-sm font-medium text-content transition-colors hover:bg-surface-sunken">
          Secondary
        </button>
        <button className="h-9 rounded-md bg-accent-500 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-600">
          Accent
        </button>
        <StatusBadge kind="healthy">Healthy</StatusBadge>
        <StatusBadge kind="progressing">Progressing</StatusBadge>
        <StatusBadge kind="degraded">Degraded</StatusBadge>
        <StatusBadge kind="failed">Failed</StatusBadge>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-edge-default bg-surface-sunken p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">
            Deploys (7d)
          </div>
          <div className="mt-1 text-2xl font-semibold text-content">128</div>
          <div className="mt-0.5 text-xs font-medium text-brand-600">+24% vs last week</div>
        </div>
        <div className="rounded-lg border border-edge-default bg-surface-sunken p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">
            Lead time
          </div>
          <div className="mt-1 text-2xl font-semibold text-content">2h 14m</div>
          <div className="mt-0.5 text-xs font-medium text-accent-600">−18% vs last week</div>
        </div>
        <div
          className="overflow-hidden rounded-lg p-4 text-white shadow-sm"
          style={{
            backgroundImage:
              'linear-gradient(135deg, var(--color-brand-700), var(--color-brand-950))',
          }}
        >
          <div className="text-xs font-medium uppercase tracking-wide text-white/70">
            Brand gradient
          </div>
          <div className="mt-1 text-2xl font-semibold">Adhar</div>
          <div className="mt-0.5 text-xs text-white/70">brand-700 → brand-950</div>
        </div>
      </div>

      <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full"
          style={{
            width: '62%',
            backgroundImage: 'linear-gradient(90deg, var(--color-brand-500), var(--color-accent-500))',
          }}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-content-muted">
        <span>
          Body text uses <code className="font-mono text-content">--color-content</code>.
        </span>
        <a className="font-medium text-brand-700 hover:text-brand-800" href="#">
          A primary link
        </a>
        <span className="text-content-subtle">
          and subtle metadata (<code className="font-mono">content-subtle</code>)
        </span>
      </div>
    </div>
  )
}

export default Theming
