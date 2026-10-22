/**
 * Compile the repo's Tailwind CSS in the browser — bundled Tailwind v4, no
 * CDN, its own lazy chunk. Preflight is left out (the console already applies
 * it); the output is scoped to `.adhar-repo-canvas` (see css-theme.ts).
 */
import { compile } from 'tailwindcss';
import themeCss from 'tailwindcss/theme.css?raw';
import utilitiesCss from 'tailwindcss/utilities.css?raw';
import { scopeCss, scopePlainCss, toTailwindInput } from './css-theme.ts';

const ENTRY = `@layer theme, base, components, utilities;\n@import 'tailwindcss/theme.css' layer(theme);\n@import 'tailwindcss/utilities.css' layer(utilities);\n`;

export interface RepoCssCompiler {
  build(candidates: string[]): string;
}

/** `extraCss`: component styles (Vue / Svelte `<style>`, Angular `styles`), appended as plain scoped CSS. */
export async function createRepoCssCompiler(appCss: string | null, extraCss = ''): Promise<RepoCssCompiler> {
  const input = toTailwindInput(appCss ?? '@import "tailwindcss";');
  const compiler = await compile(input, {
    base: '/',
    loadStylesheet: (id: string) => {
      const content = id === 'tailwindcss' ? ENTRY
        : id === 'tailwindcss/theme.css' ? themeCss
        : id === 'tailwindcss/utilities.css' ? utilitiesCss
        : '';
      return Promise.resolve({ path: id, base: '/', content });
    },
    loadModule: () => Promise.reject(new Error('Tailwind plugins are not loaded in the designer')),
  } as never);
  const extra = extraCss.trim() ? scopePlainCss(extraCss) : '';
  return { build: (candidates) => scopeCss(compiler.build(candidates)) + extra };
}
