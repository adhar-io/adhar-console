/**
 * The repo's own styling, for rendering its pages faithfully.
 *
 *   • find the app's main stylesheet (`src/index.css`, `app/globals.css`, …)
 *   • turn it into Tailwind v4 input (v3 `@tailwind` directives → v4 import;
 *     shadcn-style `--primary: 222 47% 11%` variables → `bg-primary` etc.)
 *   • scope the compiled CSS to `.adhar-repo-canvas` so it styles the canvas
 *     and nothing else in the console
 */

export const CSS_CANDIDATES = [
  'src/index.css', 'src/globals.css', 'src/app/globals.css', 'app/globals.css', 'styles/globals.css',
  'src/styles/globals.css', 'src/styles.css', 'src/main.css', 'src/App.css', 'app/tailwind.css', 'app/app.css', 'app/root.css',
];

/** Candidate stylesheet paths that exist, most likely first. */
export function cssCandidates(paths: string[], root = ''): string[] {
  const set = new Set(paths);
  return CSS_CANDIDATES.map((p) => (root ? `${root}/${p}` : p)).filter((p) => set.has(p));
}

/** Pick the stylesheet that actually pulls in Tailwind (or the first one). */
export function pickAppCss(files: Array<{ path: string; content: string }>): { path: string; content: string } | null {
  return files.find((f) => /@import\s+["']tailwindcss|@tailwind\s+(base|utilities)/.test(f.content)) ?? files[0] ?? null;
}

const SHADCN = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary', 'primary-foreground',
  'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'destructive-foreground',
  'border', 'input', 'ring'];

/** Repo CSS → Tailwind v4 compiler input. */
export function toTailwindInput(css: string): string {
  let out = css
    .replace(/@tailwind\s+base\s*;?/g, '')
    .replace(/@tailwind\s+components\s*;?/g, '')
    .replace(/@tailwind\s+utilities\s*;?/g, '@import "tailwindcss";')
    // Plugins / JS config can't load in the browser; their utilities just won't preview.
    .replace(/^\s*@(plugin|config)\s+[^;]+;?/gm, '')
    // Other local stylesheets aren't fetched.
    .replace(/^\s*@import\s+(?!["']tailwindcss)["'][^"']+["'][^;]*;?/gm, '');
  if (!/@import\s+["']tailwindcss["']/.test(out)) out = `@import "tailwindcss";\n${out}`;
  // shadcn v3 convention: HSL triplets in variables, colours in tailwind.config.
  const hasVar = (n: string) => new RegExp(`--${n}\\s*:`).test(css);
  const hasThemeColor = /--color-primary\s*:/.test(css);
  if (!hasThemeColor && hasVar('primary')) {
    const triplet = /--primary\s*:\s*[\d.]+\s+[\d.]+%\s+[\d.]+%/.test(css);
    const wrap = (n: string) => (triplet ? `hsl(var(--${n}))` : `var(--${n})`);
    out += `\n@theme inline {\n${SHADCN.filter(hasVar).map((n) => `  --color-${n}: ${wrap(n)};`).join('\n')}\n${hasVar('radius') ? '  --radius-lg: var(--radius);\n  --radius-md: calc(var(--radius) - 2px);\n  --radius-sm: calc(var(--radius) - 4px);\n' : ''}}\n`;
  }
  return out;
}

/** Split CSS into top-level items: `@x …;` statements and `prelude { body }` blocks. */
function topLevel(css: string): Array<{ prelude: string; body: string | null; raw: string }> {
  const out: Array<{ prelude: string; body: string | null; raw: string }> = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    const start = i;
    let depth = 0;
    let quote: string | null = null;
    let bodyStart = -1;
    for (; i < n; i++) {
      const c = css[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i + 2); i = (e === -1 ? n : e + 2) - 1; continue; }
      if (c === ';' && depth === 0) { i++; break; }
      if (c === '{') { if (depth === 0) bodyStart = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const raw = css.slice(start, i);
    if (bodyStart >= 0) out.push({ prelude: css.slice(start, bodyStart).trim(), body: css.slice(bodyStart + 1, i - 1), raw });
    else out.push({ prelude: raw.trim(), body: null, raw });
  }
  return out;
}

/** Flatten `@layer x { … }` wrappers and drop layer-order statements. */
function unlayer(css: string): Array<{ prelude: string; body: string | null; raw: string }> {
  const out: Array<{ prelude: string; body: string | null; raw: string }> = [];
  for (const item of topLevel(css)) {
    if (item.prelude.startsWith('@layer')) {
      if (item.body !== null) out.push(...unlayer(item.body));
      continue;
    }
    out.push(item);
  }
  return out;
}

const KEEP_TOP = /^@(property|keyframes|-webkit-keyframes|font-face|charset|import|namespace)\b/;

/**
 * Scope compiled CSS to `scope`: theme variables land on the scope element,
 * every rule only applies inside it, and — because the result is unlayered —
 * the repo's utilities win over the console's own inside the canvas.
 */
export function scopeCss(css: string, scope = '.adhar-repo-canvas'): string {
  const top: string[] = [];
  const inner: string[] = [];
  for (const item of unlayer(css)) {
    if (KEEP_TOP.test(item.prelude)) { top.push(item.raw); continue; }
    if (item.body === null) continue;
    const prelude = item.prelude.replace(/:root\s*,\s*:host/g, '&').replace(/(^|[\s,]):root\b/g, '$1&').replace(/(^|[\s,]):host\b/g, '$1&');
    inner.push(`${prelude}{${item.body}}`);
  }
  return `${top.join('\n')}\n${scope}{\n${inner.join('\n')}\n}\n`;
}

/** Every class-ish token in a set of class strings (Tailwind candidates). */
export function classCandidates(classStrings: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const s of classStrings) for (const t of s.split(/\s+/)) if (t) set.add(t);
  return [...set];
}
