// ─── Builder theme presets & token export ───────────────────────────────────
// Design-theme presets a page is designed against (applied to the artboard and
// the preview only — never to the console chrome), plus DTCG / CSS exports.
//
// The standalone builder also carried browser-side Penpot/Figma pushes, a
// localStorage project list and a direct-to-vendor LLM call holding a user's
// API key in the browser. None of that belongs in the console: projects
// persist through the console's document store and Gitea, and generation goes
// through Adhar AI (see lib/adhar-ai.ts).

export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  radius: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export const themePresets: ThemePreset[] = [
  {
    // The console's own palette — the default, so a new design starts on-brand.
    id: 'adhar', name: 'Adhar',
    light: {
      background: '0 0% 100%', foreground: '226 57% 15%',
      card: '0 0% 100%', cardForeground: '226 57% 15%',
      popover: '0 0% 100%', popoverForeground: '226 57% 15%',
      primary: '221 83% 53%', primaryForeground: '0 0% 100%',
      secondary: '220 40% 96%', secondaryForeground: '226 57% 15%',
      muted: '220 40% 96%', mutedForeground: '222 15% 40%',
      accent: '220 40% 95%', accentForeground: '226 57% 15%',
      destructive: '347 77% 50%', destructiveForeground: '0 0% 100%',
      border: '220 30% 89%', input: '220 25% 82%', ring: '217 91% 60%', radius: '0.75rem',
    },
    dark: {
      background: '226 40% 8%', foreground: '220 30% 94%',
      card: '226 35% 11%', cardForeground: '220 30% 94%',
      popover: '226 35% 11%', popoverForeground: '220 30% 94%',
      primary: '217 91% 60%', primaryForeground: '0 0% 100%',
      secondary: '226 28% 17%', secondaryForeground: '220 30% 94%',
      muted: '226 28% 17%', mutedForeground: '222 15% 65%',
      accent: '226 28% 17%', accentForeground: '220 30% 94%',
      destructive: '347 77% 50%', destructiveForeground: '0 0% 100%',
      border: '226 25% 20%', input: '226 25% 24%', ring: '217 91% 60%', radius: '0.75rem',
    },
  },
  {
    id: 'zinc', name: 'Zinc',
    light: {
      background: '0 0% 100%', foreground: '240 10% 3.9%',
      card: '0 0% 100%', cardForeground: '240 10% 3.9%',
      popover: '0 0% 100%', popoverForeground: '240 10% 3.9%',
      primary: '240 5.9% 10%', primaryForeground: '0 0% 98%',
      secondary: '240 4.8% 95.9%', secondaryForeground: '240 5.9% 10%',
      muted: '240 4.8% 95.9%', mutedForeground: '240 3.8% 46.1%',
      accent: '240 4.8% 95.9%', accentForeground: '240 5.9% 10%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '0 0% 98%',
      border: '240 5.9% 90%', input: '240 5.9% 90%', ring: '240 5.9% 10%', radius: '0.5rem',
    },
    dark: {
      background: '240 10% 3.9%', foreground: '0 0% 98%',
      card: '240 10% 3.9%', cardForeground: '0 0% 98%',
      popover: '240 10% 3.9%', popoverForeground: '0 0% 98%',
      primary: '0 0% 98%', primaryForeground: '240 5.9% 10%',
      secondary: '240 3.7% 15.9%', secondaryForeground: '0 0% 98%',
      muted: '240 3.7% 15.9%', mutedForeground: '240 5% 64.9%',
      accent: '240 3.7% 15.9%', accentForeground: '0 0% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '0 0% 98%',
      border: '240 3.7% 15.9%', input: '240 3.7% 15.9%', ring: '240 4.9% 83.9%', radius: '0.5rem',
    },
  },
  {
    id: 'slate', name: 'Slate',
    light: {
      background: '0 0% 100%', foreground: '222.2 84% 4.9%',
      card: '0 0% 100%', cardForeground: '222.2 84% 4.9%',
      popover: '0 0% 100%', popoverForeground: '222.2 84% 4.9%',
      primary: '222.2 47.4% 11.2%', primaryForeground: '210 40% 98%',
      secondary: '210 40% 96.1%', secondaryForeground: '222.2 47.4% 11.2%',
      muted: '210 40% 96.1%', mutedForeground: '215.4 16.3% 46.9%',
      accent: '210 40% 96.1%', accentForeground: '222.2 47.4% 11.2%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '210 40% 98%',
      border: '214.3 31.8% 91.4%', input: '214.3 31.8% 91.4%', ring: '222.2 84% 4.9%', radius: '0.5rem',
    },
    dark: {
      background: '222.2 84% 4.9%', foreground: '210 40% 98%',
      card: '222.2 84% 4.9%', cardForeground: '210 40% 98%',
      popover: '222.2 84% 4.9%', popoverForeground: '210 40% 98%',
      primary: '210 40% 98%', primaryForeground: '222.2 47.4% 11.2%',
      secondary: '217.2 32.6% 17.5%', secondaryForeground: '210 40% 98%',
      muted: '217.2 32.6% 17.5%', mutedForeground: '215 20.2% 65.1%',
      accent: '217.2 32.6% 17.5%', accentForeground: '210 40% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '210 40% 98%',
      border: '217.2 32.6% 17.5%', input: '217.2 32.6% 17.5%', ring: '212.7 26.8% 83.9%', radius: '0.5rem',
    },
  },
  {
    id: 'blue', name: 'Blue',
    light: {
      background: '0 0% 100%', foreground: '222.2 84% 4.9%',
      card: '0 0% 100%', cardForeground: '222.2 84% 4.9%',
      popover: '0 0% 100%', popoverForeground: '222.2 84% 4.9%',
      primary: '221.2 83.2% 53.3%', primaryForeground: '210 40% 98%',
      secondary: '210 40% 96.1%', secondaryForeground: '222.2 47.4% 11.2%',
      muted: '210 40% 96.1%', mutedForeground: '215.4 16.3% 46.9%',
      accent: '210 40% 96.1%', accentForeground: '222.2 47.4% 11.2%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '210 40% 98%',
      border: '214.3 31.8% 91.4%', input: '214.3 31.8% 91.4%', ring: '221.2 83.2% 53.3%', radius: '0.5rem',
    },
    dark: {
      background: '222.2 84% 4.9%', foreground: '210 40% 98%',
      card: '222.2 84% 4.9%', cardForeground: '210 40% 98%',
      popover: '222.2 84% 4.9%', popoverForeground: '210 40% 98%',
      primary: '217.2 91.2% 59.8%', primaryForeground: '222.2 47.4% 11.2%',
      secondary: '217.2 32.6% 17.5%', secondaryForeground: '210 40% 98%',
      muted: '217.2 32.6% 17.5%', mutedForeground: '215 20.2% 65.1%',
      accent: '217.2 32.6% 17.5%', accentForeground: '210 40% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '210 40% 98%',
      border: '217.2 32.6% 17.5%', input: '217.2 32.6% 17.5%', ring: '224.3 76.3% 48%', radius: '0.5rem',
    },
  },
  {
    id: 'green', name: 'Green',
    light: {
      background: '0 0% 100%', foreground: '240 10% 3.9%',
      card: '0 0% 100%', cardForeground: '240 10% 3.9%',
      popover: '0 0% 100%', popoverForeground: '240 10% 3.9%',
      primary: '142.1 76.2% 36.3%', primaryForeground: '355.7 100% 97.3%',
      secondary: '240 4.8% 95.9%', secondaryForeground: '240 5.9% 10%',
      muted: '240 4.8% 95.9%', mutedForeground: '240 3.8% 46.1%',
      accent: '240 4.8% 95.9%', accentForeground: '240 5.9% 10%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '0 0% 98%',
      border: '240 5.9% 90%', input: '240 5.9% 90%', ring: '142.1 76.2% 36.3%', radius: '0.5rem',
    },
    dark: {
      background: '20 14.3% 4.1%', foreground: '0 0% 95%',
      card: '24 9.8% 10%', cardForeground: '0 0% 95%',
      popover: '0 0% 9%', popoverForeground: '0 0% 95%',
      primary: '142.1 70.6% 45.3%', primaryForeground: '144.9 80.4% 10%',
      secondary: '240 3.7% 15.9%', secondaryForeground: '0 0% 98%',
      muted: '0 0% 15%', mutedForeground: '240 5% 64.9%',
      accent: '12 6.5% 15.1%', accentForeground: '0 0% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '0 85.7% 97.3%',
      border: '240 3.7% 15.9%', input: '240 3.7% 15.9%', ring: '142.4 71.8% 29.2%', radius: '0.5rem',
    },
  },
  {
    id: 'violet', name: 'Violet',
    light: {
      background: '0 0% 100%', foreground: '224 71.4% 4.1%',
      card: '0 0% 100%', cardForeground: '224 71.4% 4.1%',
      popover: '0 0% 100%', popoverForeground: '224 71.4% 4.1%',
      primary: '262.1 83.3% 57.8%', primaryForeground: '210 20% 98%',
      secondary: '220 14.3% 95.9%', secondaryForeground: '220.9 39.3% 11%',
      muted: '220 14.3% 95.9%', mutedForeground: '220 8.9% 46.1%',
      accent: '220 14.3% 95.9%', accentForeground: '220.9 39.3% 11%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '210 20% 98%',
      border: '220 13% 91%', input: '220 13% 91%', ring: '262.1 83.3% 57.8%', radius: '0.5rem',
    },
    dark: {
      background: '224 71.4% 4.1%', foreground: '210 20% 98%',
      card: '224 71.4% 4.1%', cardForeground: '210 20% 98%',
      popover: '224 71.4% 4.1%', popoverForeground: '210 20% 98%',
      primary: '263.4 70% 50.4%', primaryForeground: '210 20% 98%',
      secondary: '215 27.9% 16.9%', secondaryForeground: '210 20% 98%',
      muted: '215 27.9% 16.9%', mutedForeground: '217.9 10.6% 64.9%',
      accent: '215 27.9% 16.9%', accentForeground: '210 20% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '210 20% 98%',
      border: '215 27.9% 16.9%', input: '215 27.9% 16.9%', ring: '263.4 70% 50.4%', radius: '0.5rem',
    },
  },
  {
    id: 'rose', name: 'Rose',
    light: {
      background: '0 0% 100%', foreground: '240 10% 3.9%',
      card: '0 0% 100%', cardForeground: '240 10% 3.9%',
      popover: '0 0% 100%', popoverForeground: '240 10% 3.9%',
      primary: '346.8 77.2% 49.8%', primaryForeground: '355.7 100% 97.3%',
      secondary: '240 4.8% 95.9%', secondaryForeground: '240 5.9% 10%',
      muted: '240 4.8% 95.9%', mutedForeground: '240 3.8% 46.1%',
      accent: '240 4.8% 95.9%', accentForeground: '240 5.9% 10%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '0 0% 98%',
      border: '240 5.9% 90%', input: '240 5.9% 90%', ring: '346.8 77.2% 49.8%', radius: '0.5rem',
    },
    dark: {
      background: '20 14.3% 4.1%', foreground: '0 0% 95%',
      card: '24 9.8% 10%', cardForeground: '0 0% 95%',
      popover: '0 0% 9%', popoverForeground: '0 0% 95%',
      primary: '346.8 77.2% 49.8%', primaryForeground: '355.7 100% 97.3%',
      secondary: '240 3.7% 15.9%', secondaryForeground: '0 0% 98%',
      muted: '0 0% 15%', mutedForeground: '240 5% 64.9%',
      accent: '12 6.5% 15.1%', accentForeground: '0 0% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '0 85.7% 97.3%',
      border: '240 3.7% 15.9%', input: '240 3.7% 15.9%', ring: '346.8 77.2% 49.8%', radius: '0.5rem',
    },
  },
  {
    id: 'orange', name: 'Orange',
    light: {
      background: '0 0% 100%', foreground: '20 14.3% 4.1%',
      card: '0 0% 100%', cardForeground: '20 14.3% 4.1%',
      popover: '0 0% 100%', popoverForeground: '20 14.3% 4.1%',
      primary: '24.6 95% 53.1%', primaryForeground: '60 9.1% 97.8%',
      secondary: '60 4.8% 95.9%', secondaryForeground: '24 9.8% 10%',
      muted: '60 4.8% 95.9%', mutedForeground: '25 5.3% 44.7%',
      accent: '60 4.8% 95.9%', accentForeground: '24 9.8% 10%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '60 9.1% 97.8%',
      border: '20 5.9% 90%', input: '20 5.9% 90%', ring: '24.6 95% 53.1%', radius: '0.5rem',
    },
    dark: {
      background: '20 14.3% 4.1%', foreground: '60 9.1% 97.8%',
      card: '20 14.3% 4.1%', cardForeground: '60 9.1% 97.8%',
      popover: '20 14.3% 4.1%', popoverForeground: '60 9.1% 97.8%',
      primary: '20.5 90.2% 48.2%', primaryForeground: '60 9.1% 97.8%',
      secondary: '12 6.5% 15.1%', secondaryForeground: '60 9.1% 97.8%',
      muted: '12 6.5% 15.1%', mutedForeground: '24 5.4% 63.9%',
      accent: '12 6.5% 15.1%', accentForeground: '60 9.1% 97.8%',
      destructive: '0 72.2% 50.6%', destructiveForeground: '60 9.1% 97.8%',
      border: '12 6.5% 15.1%', input: '12 6.5% 15.1%', ring: '20.5 90.2% 48.2%', radius: '0.5rem',
    },
  },
  {
    id: 'teal', name: 'Teal',
    light: {
      background: '0 0% 100%', foreground: '240 10% 3.9%',
      card: '0 0% 100%', cardForeground: '240 10% 3.9%',
      popover: '0 0% 100%', popoverForeground: '240 10% 3.9%',
      primary: '173 80.4% 40%', primaryForeground: '0 0% 98%',
      secondary: '240 4.8% 95.9%', secondaryForeground: '240 5.9% 10%',
      muted: '240 4.8% 95.9%', mutedForeground: '240 3.8% 46.1%',
      accent: '240 4.8% 95.9%', accentForeground: '240 5.9% 10%',
      destructive: '0 84.2% 60.2%', destructiveForeground: '0 0% 98%',
      border: '240 5.9% 90%', input: '240 5.9% 90%', ring: '173 80.4% 40%', radius: '0.5rem',
    },
    dark: {
      background: '176 84% 3.5%', foreground: '0 0% 98%',
      card: '176 60% 7%', cardForeground: '0 0% 98%',
      popover: '176 60% 7%', popoverForeground: '0 0% 98%',
      primary: '173 80.4% 40%', primaryForeground: '0 0% 98%',
      secondary: '240 3.7% 15.9%', secondaryForeground: '0 0% 98%',
      muted: '240 3.7% 15.9%', mutedForeground: '240 5% 64.9%',
      accent: '240 3.7% 15.9%', accentForeground: '0 0% 98%',
      destructive: '0 62.8% 30.6%', destructiveForeground: '0 0% 98%',
      border: '240 3.7% 15.9%', input: '240 3.7% 15.9%', ring: '173 80.4% 40%', radius: '0.5rem',
    },
  },
];

/*
 * Presets supplied by the host at runtime — e.g. Design's "Workspace" theme
 * derived from the workspace design-token set. One builder is mounted at a
 * time, so a module-level list is enough; BuilderApp sets it from its props.
 */
let extraPresets: ThemePreset[] = [];

export function setExtraThemePresets(presets: ThemePreset[]): void {
  extraPresets = presets;
}

/** Host presets first (they are the workspace's own), then the built-ins. */
export function allThemePresets(): ThemePreset[] {
  return extraPresets.length ? [...extraPresets, ...themePresets.filter((t) => !extraPresets.some((e) => e.id === t.id))] : themePresets;
}

export function getThemePreset(id: string): ThemePreset {
  const all = allThemePresets();
  return all.find((t) => t.id === id) || themePresets[0];
}

export function generateThemeCSS(theme: ThemePreset): string {
  const tokenToCSS = (tokens: ThemeTokens, indent: string): string => {
    return [
      `${indent}--background: ${tokens.background};`,
      `${indent}--foreground: ${tokens.foreground};`,
      `${indent}--card: ${tokens.card};`,
      `${indent}--card-foreground: ${tokens.cardForeground};`,
      `${indent}--popover: ${tokens.popover};`,
      `${indent}--popover-foreground: ${tokens.popoverForeground};`,
      `${indent}--primary: ${tokens.primary};`,
      `${indent}--primary-foreground: ${tokens.primaryForeground};`,
      `${indent}--secondary: ${tokens.secondary};`,
      `${indent}--secondary-foreground: ${tokens.secondaryForeground};`,
      `${indent}--muted: ${tokens.muted};`,
      `${indent}--muted-foreground: ${tokens.mutedForeground};`,
      `${indent}--accent: ${tokens.accent};`,
      `${indent}--accent-foreground: ${tokens.accentForeground};`,
      `${indent}--destructive: ${tokens.destructive};`,
      `${indent}--destructive-foreground: ${tokens.destructiveForeground};`,
      `${indent}--border: ${tokens.border};`,
      `${indent}--input: ${tokens.input};`,
      `${indent}--ring: ${tokens.ring};`,
      `${indent}--radius: ${tokens.radius};`,
    ].join('\n');
  };

  return `@layer base {\n  :root {\n${tokenToCSS(theme.light, '    ')}\n  }\n\n  .dark {\n${tokenToCSS(theme.dark, '    ')}\n  }\n}`;
}

export function exportDesignTokens(themeId: string): object {
  const theme = getThemePreset(themeId);
  const hslToHex = (hsl: string): string => {
    const parts = hsl.split(/\s+/);
    if (parts.length < 3) return '#000000';
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };

  const toTokens = (tokens: ThemeTokens, mode: string) =>
    Object.fromEntries(
      Object.entries(tokens).map(([key, value]) => {
        const name = key.replace(/([A-Z])/g, '-$1').toLowerCase();
        const isColor = key !== 'radius';
        return [name, {
          $type: isColor ? 'color' : 'dimension',
          $value: isColor ? hslToHex(value) : value,
          $extensions: { 'com.adhar-ui': { hslRaw: value, mode } },
        }];
      })
    );

  return {
    $schema: 'https://design-tokens.github.io/community-group/format/',
    'adhar-ui': {
      theme: theme.id,
      light: toTokens(theme.light, 'light'),
      dark: toTokens(theme.dark, 'dark'),
    },
  };
}

export function exportTokensAsCustomProperties(themeId: string): string {
  const theme = getThemePreset(themeId);
  return generateThemeCSS(theme);
}

// ─── Download Helper ─────────────────────────────────────────────────────────
export function downloadFile(content: string, filename: string, mimeType: string = 'text/plain'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
