import type { CSSProperties } from 'react';
import { getThemePreset, type ThemeTokens } from './builder-api.ts';

/**
 * The selected design theme as `--b-*` overrides for the artboard / preview.
 *
 * The chrome's `--b-*` tokens point at the console palette (builder-styles.ts).
 * Inside the artboard they are re-pointed at the design theme the user picked,
 * so `bg-primary` in a design means the design's primary, not the console's.
 * Overrides from the Theme panel are keyed `light.<token>` / `dark.<token>`.
 */
export function designThemeVars(
  themeId: string,
  dark: boolean,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const preset = getThemePreset(themeId);
  const tokens: ThemeTokens = dark ? preset.dark : preset.light;
  const mode = dark ? 'dark' : 'light';
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(tokens)) {
    const value = overrides[`${mode}.${key}`] ?? raw;
    if (key === 'radius') {
      out['--b-radius'] = overrides.radius ?? value;
      continue;
    }
    out[`--b-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`] = `hsl(${value})`;
  }
  return out;
}

export function designThemeStyle(
  themeId: string,
  dark: boolean,
  overrides: Record<string, string> = {},
): CSSProperties {
  return designThemeVars(themeId, dark, overrides) as CSSProperties;
}
