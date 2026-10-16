import { useState } from 'react';
import { allThemePresets, getThemePreset, type ThemePreset, type ThemeTokens } from '../lib/builder-api.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ThemePanelProps {
  theme: string;
  darkMode: boolean;
  framework: string;
  customTokenOverrides: Record<string, string>;
  onSetTheme: (theme: string) => void;
  onSetDarkMode: (dark: boolean) => void;
  onSetFramework: (fw: string) => void;
  onSetTokenOverride: (token: string, value: string) => void;
  onExportDTCG: () => void;
  onExportCSS: () => void;
  onApplyToGlobals: () => void;
}

// ─── Token definitions for the editor ───────────────────────────────────────

const EDITABLE_TOKENS = [
  'primary',
  'secondary',
  'muted',
  'accent',
  'destructive',
  'background',
  'foreground',
  'border',
] as const;

type EditableToken = (typeof EDITABLE_TOKENS)[number];

const RADIUS_OPTIONS = [
  { label: '0', value: '0', preview: '0' },
  { label: 'sm', value: '0.3rem', preview: '2px' },
  { label: 'md', value: '0.5rem', preview: '4px' },
  { label: 'lg', value: '0.75rem', preview: '6px' },
  { label: 'xl', value: '1rem', preview: '8px' },
];

const FRAMEWORKS = [
  { id: 'react', label: 'React' },
  { id: 'vue', label: 'Vue' },
  { id: 'solid', label: 'Solid' },
  { id: 'svelte', label: 'Svelte' },
  { id: 'angular', label: 'Angular' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseHSL(hsl: string): { h: number; s: number; l: number } {
  const parts = hsl.trim().split(/\s+/);
  return {
    h: parseFloat(parts[0]) || 0,
    s: parseFloat(parts[1]) || 0,
    l: parseFloat(parts[2]) || 0,
  };
}

function hslToString(h: number, s: number, l: number): string {
  return `${Math.round(h * 10) / 10} ${Math.round(s * 10) / 10}% ${Math.round(l * 10) / 10}%`;
}

function hslToCSSColor(hsl: string): string {
  return `hsl(${hsl})`;
}

function getSwatchColors(preset: ThemePreset): [string, string] {
  return [hslToCSSColor(preset.light.primary), hslToCSSColor(preset.light.secondary)];
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ThemePanel({
  theme,
  darkMode,
  framework,
  customTokenOverrides,
  onSetTheme,
  onSetDarkMode,
  onSetFramework,
  onSetTokenOverride,
  onExportDTCG,
  onExportCSS,
  onApplyToGlobals,
}: ThemePanelProps) {
  const [expandedToken, setExpandedToken] = useState<EditableToken | null>(null);

  const activePreset = getThemePreset(theme);
  const modeTokens: ThemeTokens = darkMode ? activePreset.dark : activePreset.light;

  function getTokenValue(token: EditableToken): string {
    const overrideKey = `${darkMode ? 'dark' : 'light'}.${token}`;
    return customTokenOverrides[overrideKey] ?? (modeTokens as any)[token] ?? '0 0% 0%';
  }

  function handleTokenChange(token: EditableToken, h: number, s: number, l: number) {
    const overrideKey = `${darkMode ? 'dark' : 'light'}.${token}`;
    onSetTokenOverride(overrideKey, hslToString(h, s, l));
  }

  function handleTokenClick(token: EditableToken) {
    setExpandedToken(expandedToken === token ? null : token);
  }

  const currentRadius = customTokenOverrides['radius'] ?? modeTokens.radius ?? '0.5rem';

  return (
    <div className="flex flex-col gap-4 overflow-y-auto h-full pb-4">
      {/* ── Theme Preset Grid ──────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2 px-1">Theme</h4>
        <div className="grid grid-cols-4 gap-1.5 px-1">
          {allThemePresets().map((preset) => {
            const [c1, c2] = getSwatchColors(preset);
            const isActive = theme === preset.id;
            return (
              <button type='button'
                key={preset.id}
                onClick={() => onSetTheme(preset.id)}
                className={`flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                  isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent hover:border-border hover:bg-muted/50'
                }`}
              >
                <div className="flex gap-0.5">
                  <div
                    className="w-4 h-4 rounded-sm border border-border/30"
                    style={{ backgroundColor: c1 }}
                  />
                  <div
                    className="w-4 h-4 rounded-sm border border-border/30"
                    style={{ backgroundColor: c2 }}
                  />
                </div>
                <span className="text-[10px] text-foreground leading-none">{preset.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Mode Toggle ────────────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2 px-1">Mode</h4>
        <div className="flex rounded-md border border-border overflow-hidden mx-1">
          <button type='button'
            onClick={() => onSetDarkMode(false)}
            className={`flex-1 text-xs py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              !darkMode
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            Light
          </button>
          <button type='button'
            onClick={() => onSetDarkMode(true)}
            className={`flex-1 text-xs py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              darkMode
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            Dark
          </button>
        </div>
      </div>

      {/* ── Token Editor ───────────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2 px-1">Tokens</h4>
        <div className="space-y-0.5 px-1">
          {EDITABLE_TOKENS.map((token) => {
            const hslValue = getTokenValue(token);
            const parsed = parseHSL(hslValue);
            const isExpanded = expandedToken === token;

            return (
              <div key={token}>
                <button type='button'
                  onClick={() => handleTokenClick(token)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    isExpanded ? 'bg-muted' : 'hover:bg-muted/50'
                  }`}
                >
                  <div
                    className="w-5 h-5 rounded-md border border-border/50 flex-shrink-0"
                    style={{ backgroundColor: hslToCSSColor(hslValue) }}
                  />
                  <span className="text-xs font-medium text-foreground flex-1 capitalize">
                    {token}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">{hslValue}</span>
                </button>

                {isExpanded && (
                  <div className="px-2 py-2 ml-7 space-y-2 bg-muted/30 rounded-b-md mb-1">
                    {/* Hue */}
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-muted-foreground w-4">H</label>
                      <input
                        type="range"
                        min="0"
                        max="360"
                        step="0.1"
                        value={parsed.h}
                        onChange={(e) =>
                          handleTokenChange(token, parseFloat(e.target.value), parsed.s, parsed.l)
                        }
                        className="flex-1 h-1.5 accent-primary"
                      />
                      <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">
                        {Math.round(parsed.h)}
                      </span>
                    </div>
                    {/* Saturation */}
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-muted-foreground w-4">S</label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        value={parsed.s}
                        onChange={(e) =>
                          handleTokenChange(token, parsed.h, parseFloat(e.target.value), parsed.l)
                        }
                        className="flex-1 h-1.5 accent-primary"
                      />
                      <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">
                        {Math.round(parsed.s)}%
                      </span>
                    </div>
                    {/* Lightness */}
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-muted-foreground w-4">L</label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        value={parsed.l}
                        onChange={(e) =>
                          handleTokenChange(token, parsed.h, parsed.s, parseFloat(e.target.value))
                        }
                        className="flex-1 h-1.5 accent-primary"
                      />
                      <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">
                        {Math.round(parsed.l)}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Border Radius ──────────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2 px-1">Border Radius</h4>
        <div className="flex gap-1 px-1">
          {RADIUS_OPTIONS.map((opt) => {
            const isActive = currentRadius === opt.value;
            return (
              <button type='button'
                key={opt.value}
                onClick={() => onSetTokenOverride('radius', opt.value)}
                className={`flex-1 flex flex-col items-center gap-1 py-1.5 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                  isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
                title={opt.value}
              >
                <div
                  className="w-6 h-6 border-2 border-foreground/60"
                  style={{
                    borderRadius: opt.value,
                  }}
                />
                <span className="text-[10px] text-muted-foreground">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Framework ──────────────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2 px-1">Framework</h4>
        <div className="px-1">
          <select
            value={framework}
            onChange={(e) => onSetFramework(e.target.value)}
            className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {FRAMEWORKS.map((fw) => (
              <option key={fw.id} value={fw.id}>
                {fw.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Export Actions ─────────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2 px-1">Export</h4>
        <div className="flex flex-col gap-1.5 px-1">
          <button type='button'
            onClick={onExportDTCG}
            className="w-full text-xs py-1.5 rounded-md border border-border text-foreground hover:bg-muted transition-colors font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Export DTCG JSON
          </button>
          <button type='button'
            onClick={onExportCSS}
            className="w-full text-xs py-1.5 rounded-md border border-border text-foreground hover:bg-muted transition-colors font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Export CSS
          </button>
          <button type='button'
            onClick={onApplyToGlobals}
            className="w-full text-xs py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Apply to globals.css
          </button>
        </div>
      </div>
    </div>
  );
}
