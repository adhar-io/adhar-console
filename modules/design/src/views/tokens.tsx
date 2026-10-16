import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Badge, Button, EmptyState, Input, Modal, Select, Tabs, Textarea, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  KIND,
  TOKEN_SET_ID,
  useCollection,
  useCreate,
  useDoc,
  useRemove,
  useUpsertDoc,
} from '../data/store.ts'
import { DEFAULT_TOKENS } from '../data/tokens-seed.ts'
import { ErrorBlock, LoadingBlock } from '../components/async-states.tsx'
import type { ColorToken, MotionToken, TokenSet, TokenSnapshot, ValueToken } from '../data/types.ts'
import { useDesignParams, useSetDesignParams } from '../data/nav.ts'
import {
  CATEGORIES,
  CATEGORY_LABEL,
  CATEGORY_PREFIX,
  colorValue,
  contrastRatio,
  countTokens,
  diffTokenSets,
  findColor,
  importTokens,
  type ImportResult,
  isFontFamily,
  mergeDefaults,
  mergeTokenSets,
  type Mode,
  modularScale,
  parseTypeValue,
  readableOn,
  SCALE_RATIOS,
  shortName,
  type TokenCategory,
  toInputColor,
  tokensToCss,
  tokensToFlatJson,
  tokensToTailwindV3,
  tokensToTailwindV4,
  tokensToW3C,
  wcag,
} from '../data/tokens-lib.ts'
import {
  CodeBlock,
  copyText,
  downloadText,
  IconCopy,
  IconDownload,
  IconHistory,
  IconMoon,
  IconPlus,
  IconReset,
  IconSun,
  IconTrash,
  IconUpload,
  InlineText,
  Segmented,
  useDraft,
} from '../components/ux-kit.tsx'

type Tab = 'color' | 'typography' | 'spacing' | 'effects' | 'breakpoints' | 'preview' | 'code' | 'history'
const TABS: Tab[] = ['color', 'typography', 'spacing', 'effects', 'breakpoints', 'preview', 'code', 'history']

type Doc = TokenSet & { id: string }

/**
 * Design Tokens — the workspace's single token set (kind `design.token-set`,
 * id `default`), edited in place and autosaved. Colours carry light + dark
 * values with live WCAG contrast checks; typography, spacing, radius, shadows,
 * motion and breakpoints each get a visual editor; Preview renders sample UI
 * from the tokens in both modes; Code exports W3C Design Tokens JSON, CSS
 * variables and Tailwind; History keeps restorable versions
 * (kind `design.token-snapshot`).
 *
 * The stored shape stays the original `TokenSet` (colours gained an optional
 * `dark`), so the Visual Builder and any older reader keep working.
 */
export function Tokens() {
  const { data, isLoading, error } = useDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  const upsert = useUpsertDoc<TokenSet>(KIND.tokenSet, TOKEN_SET_ID)
  const snapshots = useCollection<TokenSnapshot>(KIND.tokenSnapshot)
  const createSnap = useCreate<TokenSnapshot>(KIND.tokenSnapshot)
  const toast = useToast()
  const params = useDesignParams()
  const setParams = useSetDesignParams()

  const tab: Tab = (TABS as string[]).includes(params.tab ?? '') ? (params.tab as Tab) : 'color'
  const [mode, setMode] = useState<Mode>('light')
  const [importOpen, setImportOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const source = useMemo<Doc | null>(
    () => (isLoading || error ? null : { id: TOKEN_SET_ID, ...mergeDefaults(data) }),
    [data, isLoading, error],
  )
  const { draft, update, saving } = useDraft<Doc>(source, ({ id: _id, ...t }) =>
    upsert.mutateAsync(t).catch((e: Error) => toast.error('Could not save tokens', { description: e.message })), 500)

  if (error) return <ErrorBlock error={error} />
  if (isLoading || !draft) return <LoadingBlock label="Loading design tokens…" />

  const tokens: TokenSet = draft
  const replaceAll = (next: TokenSet) => update(() => ({ id: TOKEN_SET_ID, ...next }))
  const setCat = <C extends TokenCategory>(cat: C, fn: (list: TokenSet[C]) => TokenSet[C]) =>
    update((d) => ({ ...d, [cat]: fn(d[cat]) }))

  const snapshot = (label: string, t: TokenSet = tokens) =>
    createSnap.mutateAsync({
      id: '',
      label,
      created_at: new Date().toISOString(),
      count: countTokens(t),
      tokens: t,
    })

  const withUndo = (label: string, next: TokenSet) => {
    const before = tokens
    replaceAll(next)
    toast.success(label, { action: { label: 'Undo', onClick: () => replaceAll(before) } })
  }

  const reset = async () => {
    try {
      await snapshot('Before reset to defaults')
    } catch { /* history is best effort; the undo toast still covers it */ }
    withUndo('Tokens reset to defaults', DEFAULT_TOKENS)
  }

  const tabDefs = [
    { id: 'color' as const, label: 'Colours', badge: String(tokens.color.length) },
    { id: 'typography' as const, label: 'Typography', badge: String(tokens.typography.length) },
    { id: 'spacing' as const, label: 'Spacing & radius', badge: String(tokens.spacing.length + tokens.radius.length) },
    { id: 'effects' as const, label: 'Shadows & motion', badge: String(tokens.elevation.length + tokens.motion.length) },
    { id: 'breakpoints' as const, label: 'Breakpoints', badge: String(tokens.breakpoint.length) },
    { id: 'preview' as const, label: 'Preview' },
    { id: 'code' as const, label: 'Export' },
    { id: 'history' as const, label: 'History', badge: snapshots.items.length ? String(snapshots.items.length) : undefined },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-content-muted">
          {countTokens(tokens)} tokens · {CATEGORIES.length} categories
          {saving ? <span className="text-content-subtle"> · saving…</span> : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented<Mode>
            ariaLabel="Colour mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'light', label: <><IconSun size={12} /> Light</> },
              { value: 'dark', label: <><IconMoon size={12} /> Dark</> },
            ]}
          />
          <Button size="sm" variant="ghost" onClick={reset} leading={<IconReset size={12} />}>
            Reset
          </Button>
          <Button size="sm" onClick={() => setSaveOpen(true)} leading={<IconHistory size={12} />}>
            Save version
          </Button>
          <Button size="sm" onClick={() => setImportOpen(true)} leading={<IconUpload size={12} />}>
            Import
          </Button>
          <Button size="sm" variant="primary" onClick={() => setParams({ tab: 'code' })} leading={<IconDownload size={12} />}>
            Export
          </Button>
        </div>
      </div>

      <Tabs<Tab>
        tabs={tabDefs.map((t) => ({ id: t.id, label: t.label, badge: t.badge }))}
        value={tab}
        onChange={(id) => setParams({ tab: id === 'color' ? undefined : id })}
        ariaLabel="Token categories"
      />

      {tab === 'color' && <ColorsTab tokens={tokens} mode={mode} setCat={setCat} />}
      {tab === 'typography' && <TypographyTab tokens={tokens} setCat={setCat} withUndo={withUndo} />}
      {tab === 'spacing' && <SpacingTab tokens={tokens} setCat={setCat} />}
      {tab === 'effects' && <EffectsTab tokens={tokens} setCat={setCat} />}
      {tab === 'breakpoints' && <BreakpointsTab tokens={tokens} setCat={setCat} />}
      {tab === 'preview' && <PreviewTab tokens={tokens} />}
      {tab === 'code' && <CodeTab tokens={tokens} />}
      {tab === 'history' && (
        <HistoryTab
          tokens={tokens}
          snapshots={snapshots.items}
          loading={snapshots.isLoading}
          error={snapshots.error}
          onSave={() => setSaveOpen(true)}
          onRestore={async (s) => {
            try {
              await snapshot(`Before restoring “${s.label}”`)
            } catch { /* best effort */ }
            withUndo(`Restored “${s.label}”`, mergeDefaults(s.tokens))
          }}
        />
      )}

      <SaveVersionModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        busy={createSnap.isPending}
        onSave={async (label) => {
          try {
            await snapshot(label)
            setSaveOpen(false)
            toast.success('Version saved', {
              description: label,
              action: { label: 'View history', onClick: () => setParams({ tab: 'history' }) },
            })
          } catch (e) {
            toast.error('Could not save version', { description: (e as Error).message })
          }
        }}
      />
      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        current={tokens}
        onApply={async (next, count) => {
          setImportOpen(false)
          try {
            await snapshot('Before import')
          } catch { /* best effort */ }
          withUndo(`Imported ${count} token${count === 1 ? '' : 's'}`, next)
        }}
      />
    </div>
  )
}

type SetCat = <C extends TokenCategory>(cat: C, fn: (list: TokenSet[C]) => TokenSet[C]) => void

/* ───────────────────────────── shared bits ───────────────────────────── */

function SectionHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-content">{title}</h3>
        {sub ? <p className="text-xs text-content-muted">{sub}</p> : null}
      </div>
      {actions}
    </div>
  )
}

function NameField({ name, onRename, taken }: { name: string; onRename(n: string): void; taken(n: string): boolean }) {
  const toast = useToast()
  return (
    <InlineText
      value={name}
      ariaLabel="Token name"
      className="font-mono text-[11px] text-content-muted"
      onCommit={(v) => {
        let next = v.trim().replace(/\s+/g, '-')
        if (!next) return
        if (!next.startsWith('--')) next = `--${next.replace(/^-+/, '')}`
        if (next !== name && taken(next)) {
          toast.error('Name already in use', { description: next })
          return
        }
        onRename(next)
      }}
    />
  )
}

function ValueField({ value, onChange, className, placeholder }: { value: string; onChange(v: string): void; className?: string; placeholder?: string }) {
  return <InlineText value={value} onCommit={(v) => onChange(v.trim())} placeholder={placeholder} ariaLabel="Value" className={cn('font-mono text-xs', className)} />
}

function RemoveBtn({ onClick, label }: { onClick(): void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1 text-content-subtle opacity-0 transition-opacity hover:bg-surface-sunken hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"
    >
      <IconTrash size={12} />
    </button>
  )
}

function useListOps<C extends TokenCategory>(cat: C, list: TokenSet[C], setCat: SetCat) {
  const toast = useToast()
  type Item = TokenSet[C][number]
  const patch = (i: number, p: Partial<Item>) =>
    setCat(cat, (l) => (l as Item[]).map((x, k) => (k === i ? { ...x, ...p } : x)) as TokenSet[C])
  const remove = (i: number) => {
    const before = list
    const gone = (list as Item[])[i]
    setCat(cat, (l) => (l as Item[]).filter((_, k) => k !== i) as TokenSet[C])
    toast.success(`Removed ${gone.name}`, { action: { label: 'Undo', onClick: () => setCat(cat, () => before) } })
  }
  const add = (item: Item) => setCat(cat, (l) => [...(l as Item[]), item] as TokenSet[C])
  const taken = (n: string) => (list as Item[]).some((x) => x.name === n)
  const uniqueName = (base: string) => {
    let i = 1
    while (taken(`${base}${i}`)) i++
    return `${base}${i}`
  }
  return { patch, remove, add, taken, uniqueName }
}

/* ───────────────────────────── colours ───────────────────────────── */

function RatingBadge({ ratio, compact }: { ratio: number | null; compact?: boolean }) {
  if (ratio === null) return <Badge tone="slate">n/a</Badge>
  const r = wcag(ratio)
  const tone = r.aaa ? 'emerald' : r.aa ? 'sky' : r.aaLarge ? 'amber' : 'rose'
  return (
    <Badge tone={tone} className="tabular-nums">
      {r.ratio.toFixed(2)}{compact ? '' : ':1'} · {r.level}
    </Badge>
  )
}

function ColorsTab({ tokens, mode, setCat }: { tokens: TokenSet; mode: Mode; setCat: SetCat }) {
  const ops = useListOps('color', tokens.color, setCat)
  const defaultBg = findColor(tokens, ['surface', 'background', 'bg'], mode, mode === 'light' ? '#ffffff' : '#0b1120')
  const [bgName, setBgName] = useState<string>('')
  const bgTok = tokens.color.find((c) => c.name === bgName)
  const bg = bgName === '#ffffff' || bgName === '#000000' ? bgName : bgTok ? colorValue(bgTok, mode) : defaultBg
  const [matrix, setMatrix] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <SectionHead
          title="Colour tokens"
          sub={`Light and dark values. Ratios are WCAG 2 contrast against the ${mode} background — AA needs 4.5:1 for body text, 3:1 for large text and UI.`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-content-muted">
                Check against
                <Select value={bgName} onChange={(e) => setBgName(e.target.value)} className="h-8 py-1 text-xs" aria-label="Contrast background">
                  <option value="">Surface ({mode})</option>
                  <option value="#ffffff">White</option>
                  <option value="#000000">Black</option>
                  {tokens.color.map((c) => <option key={c.name} value={c.name}>{c.role || shortName(c.name)}</option>)}
                </Select>
              </label>
              <Button
                size="sm"
                leading={<IconPlus size={12} />}
                onClick={() => ops.add({ name: ops.uniqueName(`${CATEGORY_PREFIX.color}new-`), value: '#6366f1', role: 'New colour' })}
              >
                Add colour
              </Button>
            </div>
          }
        />
        {tokens.color.length === 0 ? (
          <EmptyState compact title="No colour tokens" description="Add a colour to start your palette." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
            <table className="w-full min-w-190 text-sm">
              <thead>
                <tr className="border-b border-edge-default text-left text-[11px] font-semibold uppercase tracking-wide text-content-subtle">
                  <th className="px-4 py-2.5">Token</th>
                  <th className="px-3 py-2.5">Light</th>
                  <th className="px-3 py-2.5">Dark</th>
                  <th className="px-3 py-2.5">Contrast ({mode})</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {tokens.color.map((c, i) => (
                  <tr key={`${c.name}-${i}`} className="group">
                    <td className="px-4 py-2 align-middle">
                      <InlineText value={c.role} onCommit={(v) => ops.patch(i, { role: v })} ariaLabel="Role" className="text-sm font-medium" />
                      <NameField name={c.name} taken={ops.taken} onRename={(name) => ops.patch(i, { name })} />
                    </td>
                    <td className="px-3 py-2"><SwatchInput value={c.value} onChange={(value) => ops.patch(i, { value })} /></td>
                    <td className="px-3 py-2">
                      <SwatchInput
                        value={c.dark ?? ''}
                        placeholder={c.value}
                        onChange={(dark) => ops.patch(i, { dark: dark || undefined } as Partial<ColorToken>)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-7 w-10 items-center justify-center rounded-md border border-edge-subtle text-xs font-semibold"
                          style={{ background: bg, color: colorValue(c, mode) }}
                          title="Sample text on the background"
                        >
                          Aa
                        </span>
                        <RatingBadge ratio={contrastRatio(colorValue(c, mode), bg)} />
                      </div>
                    </td>
                    <td className="pr-2"><RemoveBtn label={`Remove ${c.name}`} onClick={() => ops.remove(i)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <SectionHead
          title="Contrast matrix"
          sub={`Every colour as text (rows) on every colour as background (columns), ${mode} mode.`}
          actions={<Button size="sm" variant="ghost" onClick={() => setMatrix((m) => !m)}>{matrix ? 'Hide' : 'Show'} matrix</Button>}
        />
        {matrix ? <ContrastMatrix colors={tokens.color} mode={mode} /> : null}
      </div>
    </div>
  )
}

function SwatchInput({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder?: string }) {
  const shown = value || placeholder || ''
  return (
    <div className="flex items-center gap-2">
      <label className="relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-edge-default" title="Pick colour">
        <span className="absolute inset-0 bg-[repeating-conic-gradient(#e2e8f0_0_25%,#fff_0_50%)] bg-size-[8px_8px]" />
        <span className={cn('absolute inset-0', !value && 'opacity-40')} style={{ background: shown }} />
        <input
          type="color"
          value={toInputColor(shown)}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Pick colour"
        />
      </label>
      <ValueField value={value} onChange={onChange} placeholder={placeholder ? `inherits ${placeholder}` : '#000000'} className="w-36" />
    </div>
  )
}

function ContrastMatrix({ colors, mode }: { colors: ColorToken[]; mode: Mode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised p-2">
      <table className="text-[11px]">
        <thead>
          <tr>
            <th />
            {colors.map((bg) => (
              <th key={bg.name} className="px-1 pb-1 text-left font-medium text-content-muted">
                <div className="w-20 truncate" title={bg.name}>{bg.role || shortName(bg.name)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {colors.map((fg) => (
            <tr key={fg.name}>
              <th className="pr-2 text-right font-medium text-content-muted">
                <div className="w-24 truncate" title={fg.name}>{fg.role || shortName(fg.name)}</div>
              </th>
              {colors.map((bg) => {
                const ratio = contrastRatio(colorValue(fg, mode), colorValue(bg, mode))
                const r = ratio === null ? null : wcag(ratio)
                return (
                  <td key={bg.name} className="p-0.5">
                    <div
                      className="flex h-12 w-20 flex-col items-center justify-center rounded-md border border-edge-subtle"
                      style={{ background: colorValue(bg, mode), color: colorValue(fg, mode) }}
                      title={r ? `${r.ratio.toFixed(2)}:1 — ${r.level}` : 'n/a'}
                    >
                      <span className="text-sm font-semibold">Aa</span>
                      <span
                        className="rounded px-1 text-[10px] font-medium tabular-nums"
                        style={{ background: readableOn(colorValue(bg, mode)) === '#000000' ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.55)', color: readableOn(colorValue(bg, mode)) === '#000000' ? '#0f172a' : '#fff' }}
                      >
                        {r ? `${r.ratio.toFixed(1)} ${r.level === 'AA Large' ? 'AA+' : r.level}` : '—'}
                      </span>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 px-1 text-[11px] text-content-subtle">AA+ = passes only for large text (≥ 24px, or 18.66px bold) and UI components.</p>
    </div>
  )
}

/* ───────────────────────────── typography ───────────────────────────── */

function TypographyTab({ tokens, setCat, withUndo }: { tokens: TokenSet; setCat: SetCat; withUndo(label: string, t: TokenSet): void }) {
  const ops = useListOps('typography', tokens.typography, setCat)
  const fonts = tokens.typography.map((t, i) => [t, i] as const).filter(([t]) => isFontFamily(t))
  const sizes = tokens.typography.map((t, i) => [t, i] as const).filter(([t]) => !isFontFamily(t))
  const sans = fonts.find(([t]) => /sans/.test(t.name))?.[0].value ?? fonts[0]?.[0].value ?? 'system-ui'
  const [base, setBase] = useState('16')
  const [ratio, setRatio] = useState('1.25')

  const applyScale = () => {
    const b = Number(base)
    const r = Number(ratio)
    if (!(b >= 8 && b <= 32) || !(r > 1 && r <= 2)) return
    const scale = modularScale(b, r)
    withUndo('Type scale applied', {
      ...tokens,
      typography: [...tokens.typography.filter(isFontFamily), ...scale],
    })
  }

  return (
    <div className="space-y-8">
      <div>
        <SectionHead
          title="Font families"
          sub="Font stacks — first available font wins."
          actions={
            <Button size="sm" leading={<IconPlus size={12} />} onClick={() => ops.add({ name: ops.uniqueName('--adhar-font-family-'), value: 'system-ui, sans-serif' })}>
              Add font
            </Button>
          }
        />
        <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
          {fonts.map(([t, i]) => (
            <div key={`${t.name}-${i}`} className="group grid grid-cols-1 items-center gap-2 px-4 py-3 md:grid-cols-[220px_minmax(0,1fr)_minmax(0,1.2fr)_32px]">
              <NameField name={t.name} taken={ops.taken} onRename={(name) => ops.patch(i, { name })} />
              <ValueField value={t.value} onChange={(value) => ops.patch(i, { value })} />
              <div className="truncate text-lg text-content" style={{ fontFamily: t.value }}>The quick brown fox jumps</div>
              <RemoveBtn label={`Remove ${t.name}`} onClick={() => ops.remove(i)} />
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHead
          title="Type scale"
          sub="Size / line-height pairs, e.g. 16px / 24px."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-sunken/50 px-2 py-1">
                <span className="text-[11px] text-content-muted">Generate</span>
                <Input aria-label="Base size (px)" value={base} onChange={(e) => setBase(e.target.value)} className="h-7 w-14 px-2 py-0.5 text-xs" inputMode="numeric" />
                <span className="text-[11px] text-content-subtle">px ×</span>
                <Select aria-label="Scale ratio" value={ratio} onChange={(e) => setRatio(e.target.value)} className="h-7 py-0.5 text-xs">
                  {SCALE_RATIOS.map((r) => <option key={r.value} value={String(r.value)}>{r.label}</option>)}
                </Select>
                <Button size="xs" onClick={applyScale}>Apply</Button>
              </div>
              <Button size="sm" leading={<IconPlus size={12} />} onClick={() => ops.add({ name: ops.uniqueName(`${CATEGORY_PREFIX.typography}new-`), value: '16px / 24px' })}>
                Add size
              </Button>
            </div>
          }
        />
        <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
          {sizes.map(([t, i]) => {
            const p = parseTypeValue(t.value)
            return (
              <div key={`${t.name}-${i}`} className="group grid grid-cols-1 items-center gap-2 px-4 py-3 md:grid-cols-[180px_130px_minmax(0,1fr)_32px]">
                <NameField name={t.name} taken={ops.taken} onRename={(name) => ops.patch(i, { name })} />
                <ValueField value={t.value} onChange={(value) => ops.patch(i, { value })} />
                <div
                  className="truncate text-content"
                  style={{ fontFamily: sans, fontSize: p?.size, lineHeight: p?.lineHeight }}
                >
                  {p ? 'Design is how it works' : <span className="text-xs text-rose-600">Expected “size / line-height”</span>}
                </div>
                <RemoveBtn label={`Remove ${t.name}`} onClick={() => ops.remove(i)} />
              </div>
            )
          })}
          {sizes.length === 0 ? <p className="px-4 py-6 text-center text-xs text-content-muted">No sizes — generate a scale above.</p> : null}
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── spacing & radius ───────────────────────────── */

function px(v: string): number {
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return 0
  return /rem$/.test(v.trim()) ? n * 16 : n
}

function SpacingTab({ tokens, setCat }: { tokens: TokenSet; setCat: SetCat }) {
  const sp = useListOps('spacing', tokens.spacing, setCat)
  const rd = useListOps('radius', tokens.radius, setCat)
  const max = Math.max(64, ...tokens.spacing.map((s) => px(s.value)))
  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
      <div>
        <SectionHead
          title="Spacing"
          sub="Layout rhythm — padding, gaps and margins."
          actions={<Button size="sm" leading={<IconPlus size={12} />} onClick={() => sp.add({ name: sp.uniqueName(CATEGORY_PREFIX.spacing), value: '20px' })}>Add</Button>}
        />
        <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
          {tokens.spacing.map((t, i) => (
            <div key={`${t.name}-${i}`} className="group grid grid-cols-[150px_80px_minmax(0,1fr)_32px] items-center gap-2 px-4 py-2">
              <NameField name={t.name} taken={sp.taken} onRename={(name) => sp.patch(i, { name })} />
              <ValueField value={t.value} onChange={(value) => sp.patch(i, { value })} />
              <div className="h-3 rounded-sm bg-brand-500/80" style={{ width: `${Math.min(100, (px(t.value) / max) * 100)}%`, minWidth: 2 }} title={t.value} />
              <RemoveBtn label={`Remove ${t.name}`} onClick={() => sp.remove(i)} />
            </div>
          ))}
        </div>
      </div>
      <div>
        <SectionHead
          title="Radius"
          sub="Corner rounding for controls, cards and pills."
          actions={<Button size="sm" leading={<IconPlus size={12} />} onClick={() => rd.add({ name: rd.uniqueName(CATEGORY_PREFIX.radius), value: '6px' })}>Add</Button>}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tokens.radius.map((t, i) => (
            <div key={`${t.name}-${i}`} className="group rounded-xl border border-edge-default bg-surface-raised p-3">
              <div className="flex items-start justify-between">
                <div className="h-14 w-14 border-2 border-brand-500 bg-brand-500/10" style={{ borderRadius: t.value }} />
                <RemoveBtn label={`Remove ${t.name}`} onClick={() => rd.remove(i)} />
              </div>
              <div className="mt-2">
                <NameField name={t.name} taken={rd.taken} onRename={(name) => rd.patch(i, { name })} />
                <ValueField value={t.value} onChange={(value) => rd.patch(i, { value })} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── shadows & motion ───────────────────────────── */

function EffectsTab({ tokens, setCat }: { tokens: TokenSet; setCat: SetCat }) {
  const sh = useListOps('elevation', tokens.elevation, setCat)
  const mo = useListOps('motion', tokens.motion, setCat)
  return (
    <div className="space-y-8">
      <div>
        <SectionHead
          title="Shadows"
          sub="Elevation for cards, popovers and dialogs. Any CSS box-shadow value."
          actions={<Button size="sm" leading={<IconPlus size={12} />} onClick={() => sh.add({ name: sh.uniqueName(CATEGORY_PREFIX.elevation), value: '0 8px 24px rgba(15,23,42,0.12)' })}>Add</Button>}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {tokens.elevation.map((t, i) => (
            <div key={`${t.name}-${i}`} className="group rounded-xl border border-edge-default bg-surface-sunken/50 p-4">
              <div className="flex h-20 items-center justify-center rounded-lg bg-white text-xs text-slate-500" style={{ boxShadow: t.value }}>
                {shortName(t.name)}
              </div>
              <div className="mt-3 flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <NameField name={t.name} taken={sh.taken} onRename={(name) => sh.patch(i, { name })} />
                  <ValueField value={t.value} onChange={(value) => sh.patch(i, { value })} />
                </div>
                <RemoveBtn label={`Remove ${t.name}`} onClick={() => sh.remove(i)} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <SectionHead
          title="Motion"
          sub="Durations and easing curves. Hover a row to play it."
          actions={<Button size="sm" leading={<IconPlus size={12} />} onClick={() => mo.add({ name: mo.uniqueName(CATEGORY_PREFIX.motion), value: '240ms', curve: 'ease-in-out' })}>Add</Button>}
        />
        <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
          {tokens.motion.map((t, i) => (
            <MotionRow key={`${t.name}-${i}`} t={t} taken={mo.taken} onPatch={(p) => mo.patch(i, p)} onRemove={() => mo.remove(i)} />
          ))}
        </div>
      </div>
    </div>
  )
}

function MotionRow({ t, taken, onPatch, onRemove }: { t: MotionToken; taken(n: string): boolean; onPatch(p: Partial<MotionToken>): void; onRemove(): void }) {
  const [on, setOn] = useState(false)
  return (
    <div
      className="group grid grid-cols-1 items-center gap-2 px-4 py-2.5 md:grid-cols-[180px_90px_minmax(0,1fr)_minmax(0,1fr)_32px]"
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
    >
      <NameField name={t.name} taken={taken} onRename={(name) => onPatch({ name })} />
      <ValueField value={t.value} onChange={(value) => onPatch({ value })} />
      <ValueField value={t.curve} onChange={(curve) => onPatch({ curve })} />
      <div className="relative h-6 rounded-full bg-surface-sunken" aria-hidden>
        <span
          className="absolute top-1 h-4 w-4 rounded-full bg-brand-500"
          style={{ left: on ? 'calc(100% - 20px)' : '4px', transition: `left ${t.value} ${t.curve}` }}
        />
      </div>
      <RemoveBtn label={`Remove ${t.name}`} onClick={onRemove} />
    </div>
  )
}

/* ───────────────────────────── breakpoints ───────────────────────────── */

function BreakpointsTab({ tokens, setCat }: { tokens: TokenSet; setCat: SetCat }) {
  const ops = useListOps('breakpoint', tokens.breakpoint, setCat)
  const max = Math.max(1600, ...tokens.breakpoint.map((b) => px(b.value)))
  const sorted = tokens.breakpoint.map((b, i) => [b, i] as const).sort((a, b) => px(a[0].value) - px(b[0].value))
  return (
    <div className="space-y-6">
      <SectionHead
        title="Breakpoints"
        sub="Min-widths where layouts change."
        actions={<Button size="sm" leading={<IconPlus size={12} />} onClick={() => ops.add({ name: ops.uniqueName(CATEGORY_PREFIX.breakpoint), value: '1920px', label: 'New breakpoint' })}>Add</Button>}
      />
      <div className="rounded-xl border border-edge-default bg-surface-raised p-4">
        <div className="relative h-16">
          <div className="absolute inset-x-0 top-7 h-px bg-edge-default" />
          {sorted.map(([b]) => (
            <div key={b.name} className="absolute top-0 -translate-x-1/2 text-center" style={{ left: `${(px(b.value) / max) * 100}%` }}>
              <div className="text-[10px] font-semibold text-content">{shortName(b.name)}</div>
              <div className="mx-auto mt-1 h-4 w-px bg-brand-500" />
              <div className="mt-1 text-[10px] tabular-nums text-content-subtle">{b.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
        {sorted.map(([b, i]) => (
          <div key={`${b.name}-${i}`} className="group grid grid-cols-[160px_100px_minmax(0,1fr)_32px] items-center gap-2 px-4 py-2">
            <NameField name={b.name} taken={ops.taken} onRename={(name) => ops.patch(i, { name })} />
            <ValueField value={b.value} onChange={(value) => ops.patch(i, { value })} />
            <InlineText value={b.label} onCommit={(label) => ops.patch(i, { label })} ariaLabel="Label" className="text-sm" />
            <RemoveBtn label={`Remove ${b.name}`} onClick={() => ops.remove(i)} />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ───────────────────────────── preview ───────────────────────────── */

function PreviewTab({ tokens }: { tokens: TokenSet }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <PreviewPane tokens={tokens} mode="light" />
      <PreviewPane tokens={tokens} mode="dark" />
    </div>
  )
}

function tokenValue(list: ValueToken[], keys: string[], fallback: string): string {
  for (const k of keys) {
    const hit = list.find((t) => shortName(t.name) === k)
    if (hit) return hit.value
  }
  return fallback
}

function PreviewPane({ tokens, mode }: { tokens: TokenSet; mode: Mode }) {
  const dark = mode === 'dark'
  const c = (keys: string[], fb: string) => findColor(tokens, keys, mode, fb)
  const surface = c(['surface', 'background', 'bg'], dark ? '#0b1120' : '#ffffff')
  const text = c(['text', 'foreground', 'fg'], dark ? '#e2e8f0' : '#0f172a')
  const primary = c(['primary', 'brand'], dark ? '#f8fafc' : '#0f172a')
  const accent = c(['accent', 'link'], '#4f46e5')
  const success = c(['success'], '#059669')
  const warning = c(['warning'], '#b45309')
  const danger = c(['danger', 'error'], '#e11d48')
  const muted = c(['muted', 'subtle'], dark ? '#1e293b' : '#f1f5f9')
  const border = c(['border', 'edge'], dark ? '#334155' : '#e2e8f0')
  const font = tokenValue(tokens.typography, ['sans', 'body'], 'system-ui, sans-serif')
  const ts = (k: string, fb: string) => parseTypeValue(tokenValue(tokens.typography, [k], fb)) ?? { size: fb }
  const h = ts('2xl', '24px / 32px')
  const body = ts('base', '16px / 24px')
  const small = ts('sm', '14px / 20px')
  const r = tokenValue(tokens.radius, ['md'], '8px')
  const rl = tokenValue(tokens.radius, ['lg'], '12px')
  const sh = tokenValue(tokens.elevation, ['md'], 'none')
  const s4 = tokenValue(tokens.spacing, ['4'], '16px')
  const s2 = tokenValue(tokens.spacing, ['2'], '8px')
  const s6 = tokenValue(tokens.spacing, ['6'], '24px')
  const dur = tokens.motion[1]?.value ?? '200ms'

  const btn = (bg: string, extra: CSSProperties = {}): CSSProperties => ({
    background: bg,
    color: readableOn(bg),
    borderRadius: r,
    padding: `${s2} ${s4}`,
    fontSize: small.size,
    lineHeight: small.lineHeight,
    fontWeight: 600,
    border: '1px solid transparent',
    transition: `filter ${dur}`,
    ...extra,
  })
  const alert = (col: string, label: string) => (
    <div style={{ borderLeft: `3px solid ${col}`, background: muted, borderRadius: r, padding: `${s2} ${s4}`, fontSize: small.size, lineHeight: small.lineHeight }}>
      <strong style={{ color: col }}>{label}</strong> <span style={{ color: text }}>— {label === 'Success' ? 'Deployment finished.' : label === 'Warning' ? 'Quota at 85%.' : 'Build failed.'}</span>
      <span className="ml-2 align-middle"><RatingBadge compact ratio={contrastRatio(col, muted)} /></span>
    </div>
  )

  return (
    <div className="overflow-hidden rounded-xl border border-edge-default">
      <div className="flex items-center gap-2 border-b border-edge-default bg-surface-sunken px-3 py-1.5 text-[11px] font-medium text-content-muted">
        {dark ? <IconMoon size={11} /> : <IconSun size={11} />} {dark ? 'Dark' : 'Light'}
        <span className="ml-auto">Body text <RatingBadge compact ratio={contrastRatio(text, surface)} /></span>
      </div>
      <div style={{ background: surface, color: text, fontFamily: font, padding: s6, fontSize: body.size, lineHeight: body.lineHeight }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: s4, marginBottom: s6 }}>
          <div style={{ fontWeight: 700, fontSize: body.size }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: accent, marginRight: 8 }} />
            Acme Cloud
          </div>
          <div style={{ display: 'flex', gap: s4, fontSize: small.size }}>
            <span style={{ color: accent, fontWeight: 600 }}>Overview</span>
            <span>Services</span>
            <span>Settings</span>
          </div>
        </div>
        <div style={{ fontSize: h.size, lineHeight: h.lineHeight, fontWeight: 700, color: primary }}>Ship with confidence</div>
        <p style={{ marginTop: s2, marginBottom: s4, maxWidth: 460 }}>
          Every token on this page comes from your set — colours, type scale, spacing, radius, shadows. Read the <a style={{ color: accent, textDecoration: 'underline' }}>docs</a> to learn more.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: s2, marginBottom: s6 }}>
          <button type="button" style={btn(primary)}>Primary</button>
          <button type="button" style={btn(accent)}>Accent</button>
          <button type="button" style={btn(danger)}>Delete</button>
          <button type="button" style={btn('transparent', { color: text, borderColor: border })}>Outline</button>
        </div>
        <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: rl, boxShadow: sh, padding: s4, marginBottom: s4 }}>
          <div style={{ fontWeight: 600 }}>Create project</div>
          <label style={{ display: 'block', fontSize: small.size, marginTop: s2, opacity: 0.85 }}>Name</label>
          <div style={{ marginTop: 4, border: `1px solid ${border}`, borderRadius: r, padding: `${s2} ${s4}`, fontSize: small.size, background: dark ? muted : surface }}>
            payments-api
          </div>
          <div style={{ display: 'flex', gap: s2, marginTop: s4, flexWrap: 'wrap' }}>
            {[['Healthy', success], ['Degraded', warning], ['Down', danger]].map(([l, col]) => (
              <span key={l} style={{ fontSize: 12, fontWeight: 600, borderRadius: 999, padding: '2px 10px', border: `1px solid ${col}`, color: col }}>{l}</span>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gap: s2 }}>
          {alert(success, 'Success')}
          {alert(warning, 'Warning')}
          {alert(danger, 'Error')}
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── code / export ───────────────────────────── */

type Format = 'w3c' | 'css' | 'tw4' | 'tw3' | 'flat'
const FORMATS: Array<{ value: Format; label: string; file: string; mime: string; hint: string }> = [
  { value: 'w3c', label: 'W3C JSON', file: 'tokens.json', mime: 'application/json', hint: 'Design Tokens Community Group format — Style Dictionary, Tokens Studio, Figma plugins.' },
  { value: 'css', label: 'CSS variables', file: 'tokens.css', mime: 'text/css', hint: 'Custom properties on :root, dark values under .dark.' },
  { value: 'tw4', label: 'Tailwind v4', file: 'theme.css', mime: 'text/css', hint: 'An @theme block — utilities like bg-primary, text-sm, p-4 follow your tokens.' },
  { value: 'tw3', label: 'Tailwind v3', file: 'tailwind.config.js', mime: 'text/javascript', hint: 'theme.extend config; colours reference the CSS variables so dark mode follows.' },
  { value: 'flat', label: 'Flat JSON', file: 'tokens.flat.json', mime: 'application/json', hint: 'The previous export format, kept for existing consumers.' },
]

function CodeTab({ tokens }: { tokens: TokenSet }) {
  const [fmt, setFmt] = useState<Format>('w3c')
  const toast = useToast()
  const def = FORMATS.find((f) => f.value === fmt)!
  const code = useMemo(() => {
    switch (fmt) {
      case 'w3c':
        return JSON.stringify(tokensToW3C(tokens), null, 2)
      case 'css':
        return tokensToCss(tokens)
      case 'tw4':
        return tokensToTailwindV4(tokens)
      case 'tw3':
        return tokensToTailwindV3(tokens)
      default:
        return JSON.stringify(tokensToFlatJson(tokens), null, 2)
    }
  }, [fmt, tokens])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Format> ariaLabel="Format" value={fmt} onChange={setFmt} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} />
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            leading={<IconCopy size={12} />}
            onClick={() => copyText(code).then(() => toast.success(`${def.label} copied`), () => toast.error('Could not copy'))}
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="primary"
            leading={<IconDownload size={12} />}
            onClick={() => {
              downloadText(def.file, code, def.mime)
              toast.success(`Downloaded ${def.file}`)
            }}
          >
            Download
          </Button>
        </div>
      </div>
      <p className="text-xs text-content-muted">{def.hint}</p>
      <CodeBlock code={code} maxHeight={560} />
    </div>
  )
}

/* ───────────────────────────── history ───────────────────────────── */

function HistoryTab({
  tokens,
  snapshots,
  loading,
  error,
  onSave,
  onRestore,
}: {
  tokens: TokenSet
  snapshots: Array<TokenSnapshot & { _updatedBy?: string | null }>
  loading: boolean
  error: Error | null
  onSave(): void
  onRestore(s: TokenSnapshot): void
}) {
  const remove = useRemove(KIND.tokenSnapshot)
  const toast = useToast()
  if (error) return <ErrorBlock error={error} />
  if (loading) return <LoadingBlock label="Loading history…" />
  const list = [...snapshots].sort((a, b) => b.created_at.localeCompare(a.created_at))
  if (!list.length) {
    return (
      <EmptyState
        title="No saved versions"
        description="Save a version before a big change and you can compare against it or roll back later. Versions are also saved automatically before imports, resets and restores."
        action={<Button size="sm" variant="primary" onClick={onSave} leading={<IconHistory size={12} />}>Save version</Button>}
      />
    )
  }
  return (
    <div className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
      {list.map((s) => {
        const d = diffTokenSets(mergeDefaults(s.tokens), tokens)
        const same = !d.added.length && !d.removed.length && !d.changed.length
        return (
          <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-content-subtle">
              <IconHistory size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-content">{s.label}</div>
              <div className="text-[11px] text-content-subtle" title={new Date(s.created_at).toLocaleString()}>
                {formatRelative(s.created_at)}
                {s._updatedBy ? ` · ${s._updatedBy}` : ''} · {s.count} tokens
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]" title="Difference between this version and the current tokens">
              {same ? (
                <Badge tone="emerald">Same as current</Badge>
              ) : (
                <>
                  {d.changed.length ? <Badge tone="amber">{d.changed.length} changed</Badge> : null}
                  {d.added.length ? <Badge tone="sky">{d.added.length} added since</Badge> : null}
                  {d.removed.length ? <Badge tone="rose">{d.removed.length} removed since</Badge> : null}
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button size="xs" disabled={same} onClick={() => onRestore(s)}>Restore</Button>
              <button
                type="button"
                aria-label="Delete version"
                title="Delete version"
                onClick={() =>
                  remove.mutate(s.id, {
                    onSuccess: () => toast.success('Version deleted'),
                    onError: (e) => toast.error('Could not delete version', { description: e.message }),
                  })}
                className="rounded p-1.5 text-content-subtle hover:bg-surface-sunken hover:text-rose-600"
              >
                <IconTrash size={12} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SaveVersionModal({ open, onClose, onSave, busy }: { open: boolean; onClose(): void; onSave(label: string): void; busy: boolean }) {
  const [label, setLabel] = useState('')
  useEffect(() => {
    if (open) setLabel(`Version of ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`)
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save version"
      description="A restorable snapshot of every token as it is now."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!label.trim()} onClick={() => onSave(label.trim())}>Save version</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (label.trim()) onSave(label.trim()) }}>
        <Input autoFocus aria-label="Version label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Before rebrand" />
      </form>
    </Modal>
  )
}

/* ───────────────────────────── import ───────────────────────────── */

const IMPORT_PLACEHOLDER = [
  '{',
  '  "color": {',
  '    "brand": { "$type": "color", "$value": "#4f46e5" }',
  '  }',
  '}',
].join('\n')

function ImportModal({
  open,
  onClose,
  current,
  onApply,
}: {
  open: boolean
  onClose(): void
  current: TokenSet
  onApply(next: TokenSet, count: number): void
}) {
  const [text, setText] = useState('')
  const [how, setHow] = useState<'merge' | 'replace'>('merge')
  useEffect(() => {
    if (open) setText('')
  }, [open])

  const parsed = useMemo<{ ok: ImportResult } | { err: string } | null>(() => {
    if (!text.trim()) return null
    try {
      return { ok: importTokens(text) }
    } catch (e) {
      return { err: (e as Error).message }
    }
  }, [text])
  const result = parsed && 'ok' in parsed ? parsed.ok : null
  const next = result ? mergeTokenSets(current, result.tokens, how) : null
  const diff = next ? diffTokenSets(current, next) : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import tokens"
      description="Paste or upload W3C Design Tokens JSON, a previous Adhar export, or CSS custom properties."
      width="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!next} onClick={() => next && result && onApply(next, result.count)}>
            Import{result ? ` ${result.count} tokens` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-content shadow-sm hover:bg-surface-sunken">
            <IconUpload size={12} /> Choose file…
            <input
              type="file"
              accept=".json,.css,.tokens,.txt,application/json,text/css"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setText(await f.text())
                e.target.value = ''
              }}
            />
          </label>
          <span className="text-[11px] text-content-subtle">or paste below</span>
          <div className="ml-auto">
            <Segmented<'merge' | 'replace'>
              size="xs"
              ariaLabel="Import mode"
              value={how}
              onChange={setHow}
              options={[
                { value: 'merge', label: 'Merge', title: 'Update matching names, add new ones, keep the rest' },
                { value: 'replace', label: 'Replace categories', title: 'Imported categories replace yours entirely' },
              ]}
            />
          </div>
        </div>
        <Textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={IMPORT_PLACEHOLDER}
          className="font-mono text-xs"
        />
        {parsed && 'err' in parsed ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">{parsed.err}</div>
        ) : null}
        {result && diff ? (
          <div className="space-y-2 rounded-lg border border-edge-default bg-surface-sunken/50 px-3 py-2 text-xs">
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.filter((c) => result.tokens[c]?.length).map((c) => (
                <Badge key={c} tone="slate">{CATEGORY_LABEL[c]} · {result.tokens[c]!.length}</Badge>
              ))}
            </div>
            <div className="text-content-muted">
              Will add <strong className="text-content">{diff.added.length}</strong>, change{' '}
              <strong className="text-content">{diff.changed.length}</strong>
              {how === 'replace' ? <>, remove <strong className="text-content">{diff.removed.length}</strong></> : null}. Current tokens are saved to History first.
            </div>
            {result.warnings.length ? (
              <details className="text-amber-700 dark:text-amber-300">
                <summary className="cursor-pointer">{result.warnings.length} skipped</summary>
                <ul className="mt-1 list-disc pl-4">{result.warnings.slice(0, 20).map((w) => <li key={w}>{w}</li>)}</ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
