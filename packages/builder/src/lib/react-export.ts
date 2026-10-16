/**
 * Project → a runnable React + Tailwind app (Vite, React Router).
 *
 *   package.json · vite.config.ts · index.html · tsconfig.json · README.md
 *   src/main.tsx · src/App.tsx (routes) · src/index.css (design theme → Tailwind v4)
 *   src/pages/<Page>.tsx · src/components/<Component>.tsx · src/data/<source>.json
 *
 * The output is plain, readable code: reusable components become real
 * components, repeaters become `.map()` over imported JSON, "navigate"
 * interactions use React Router, "toggle" interactions become page state.
 */

import type { BuilderProject, GeneratedFile } from '../types.ts';
import { findFileInTree, type CanvasNode, type ProjectFile } from './builder-types.ts';
import { nodeToTag } from './builder-codegen.ts';
import { generateThemeCSS, getThemePreset } from './builder-api.ts';
import { dataSourceName, homePage, listDataSources, listPages, listSymbols, pageRoute, symbolName } from './studio.ts';

const KNOWN_TAGS = new Set([
  'div', 'section', 'nav', 'footer', 'header', 'main', 'aside', 'article', 'span', 'p', 'a', 'label',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'ul', 'ol', 'li', 'blockquote', 'small', 'strong', 'em',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'form', 'img',
]);

export function pascal(s: string, fallback = 'Page'): string {
  const v = s.replace(/\.\w+$/, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/(?:^|\s)(\w)/g, (_m, c: string) => c.toUpperCase());
  const out = v || fallback;
  return /^[0-9]/.test(out) ? `${fallback}${out}` : out;
}

export function camel(s: string): string {
  const p = pascal(s, 'data');
  return p.charAt(0).toLowerCase() + p.slice(1);
}

const attr = (v: string) => (v.includes('"') || v.includes('\\') ? `{${JSON.stringify(v)}}` : `"${v}"`);
const jsxText = (t: string) => (/[{}<>]/.test(t) ? `{${JSON.stringify(t)}}` : t);
const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Text with `{{field}}` templates → JSX children reading from `item`. */
function templateJsx(text: string, itemVar: string | null): string {
  if (!itemVar) return jsxText(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TEMPLATE)) {
    out += jsxText(text.slice(last, m.index));
    const chain = m[1].split('.').map((k) => (/^\d+$/.test(k) ? `[${k}]` : `?.${k}`)).join('');
    out += `{String(${itemVar}${chain} ?? '')}`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + jsxText(text.slice(last));
}

interface Ctx {
  files: ProjectFile[];
  symbols: Map<string, string>;
  data: Map<string, string>;
  usesNavigate: boolean;
  usesSymbols: Set<string>;
  usesData: Set<string>;
  toggles: Set<string>;
  initiallyHidden: Set<string>;
  depth: number;
}

function collectToggles(nodes: CanvasNode[], into: Set<string>) {
  for (const n of nodes) {
    for (const it of n.interactions ?? []) if (it.action === 'toggle-visibility' && it.targetNodeId) into.add(it.targetNodeId);
    collectToggles(n.children, into);
  }
}

function onClickFor(n: CanvasNode, ctx: Ctx): string {
  const it = n.interactions?.find((i) => i.trigger === 'click');
  if (!it) return '';
  if (it.action === 'navigate' && it.targetPageId) {
    const page = findFileInTree(ctx.files, it.targetPageId);
    if (!page) return '';
    ctx.usesNavigate = true;
    return ` onClick={() => navigate(${JSON.stringify(pageRoute(page, ctx.files))})}`;
  }
  if (it.action === 'open-url' && it.url) return ` onClick={() => window.open(${JSON.stringify(it.url)}, '_blank')}`;
  if (it.action === 'toggle-visibility' && it.targetNodeId) return ` onClick={() => toggle(${JSON.stringify(it.targetNodeId)})}`;
  return '';
}

function emit(n: CanvasNode, ctx: Ctx, indent: string, itemVar: string | null): string {
  if (n.hidden && !ctx.toggles.has(n.id)) return '';
  const body = emitInner(n, ctx, indent, itemVar);
  if (!ctx.toggles.has(n.id)) return body;
  if (n.hidden || n.type === 'modal') ctx.initiallyHidden.add(n.id);
  return `${indent}{!hidden[${JSON.stringify(n.id)}] && (\n${body}\n${indent})}`;
}

function emitInner(n: CanvasNode, ctx: Ctx, indent: string, itemVar: string | null): string {
  const cls = typeof n.props?.className === 'string' && n.props.className ? ` className=${attr(n.props.className)}` : '';
  const click = onClickFor(n, ctx);
  const text = typeof n.props?.children === 'string' ? n.props.children : '';
  const ph = n.props?.placeholder ? ` placeholder=${attr(String(n.props.placeholder))}` : '';
  const req = n.props?.required ? ' required' : '';

  switch (n.type) {
    case 'symbol': {
      const name = ctx.symbols.get(String(n.props?.symbolId ?? ''));
      if (!name) return `${indent}{/* missing component */}`;
      ctx.usesSymbols.add(name);
      return `${indent}<${name} />`;
    }
    case 'input':
    case 'date-input':
      return `${indent}<input type=${attr(n.type === 'date-input' ? 'date' : String(n.props?.inputType || 'text'))}${cls}${ph}${req} />`;
    case 'textarea':
      return `${indent}<textarea${cls}${ph}${req} />`;
    case 'checkbox':
    case 'radio':
    case 'switch':
      return `${indent}<label${cls}><input type=${attr(n.type === 'radio' ? 'radio' : 'checkbox')}${n.type === 'switch' ? ' role="switch"' : ''}${n.props?.name ? ` name=${attr(String(n.props.name))}` : ''} className="accent-[hsl(var(--primary))]" /> ${templateJsx(text, itemVar)}</label>`;
    case 'select': {
      const opts = Array.isArray(n.props?.options) ? (n.props.options as unknown[]).map(String) : [];
      const inner = opts.map((o) => `${indent}  <option>${jsxText(o)}</option>`).join('\n');
      return `${indent}<select${cls}${req}>\n${inner}\n${indent}</select>`;
    }
    case 'separator':
      return `${indent}<hr${cls} />`;
    case 'progress-bar':
      return `${indent}<div${cls}><div className="h-full rounded-full bg-primary" style={{ width: '${Number(n.props?.['data-value'] ?? 66)}%' }} /></div>`;
  }

  const raw = nodeToTag(n.type);
  const tag = n.type === 'link' ? 'a' : KNOWN_TAGS.has(raw) ? raw : 'div';
  const href = tag === 'a' && !click ? ' href="#"' : '';
  const open = `${indent}<${tag}${cls}${href}${click}>`;
  const kids: string[] = [];
  if (text) kids.push(`${indent}  ${templateJsx(text, itemVar)}`);

  if (n.bind) {
    const varName = ctx.data.get(n.bind.source);
    if (varName) {
      ctx.usesData.add(varName);
      const chain = (n.bind.path ?? '').split('.').filter(Boolean).map((k) => `?.${k}`).join('');
      const src = chain ? `((${varName} as any)${chain} ?? [])` : `(${varName} as any[])`;
      const inner = n.children.map((c) => emit(c, ctx, `${indent}      `, 'item')).filter(Boolean).join('\n');
      kids.push(`${indent}  {${src}.map((item: any, i: number) => (\n${indent}    <Fragment key={i}>\n${inner}\n${indent}    </Fragment>\n${indent}  ))}`);
    }
  } else {
    for (const c of n.children) {
      const s = emit(c, ctx, `${indent}  `, itemVar);
      if (s) kids.push(s);
    }
  }
  if (!kids.length) return `${open.slice(0, -1)} />`;
  return `${open}\n${kids.join('\n')}\n${indent}</${tag}>`;
}

function componentModule(name: string, nodes: CanvasNode[], base: Omit<Ctx, 'usesNavigate' | 'usesSymbols' | 'usesData' | 'toggles' | 'initiallyHidden' | 'depth'>, importDir: '..'): string {
  const ctx: Ctx = { ...base, usesNavigate: false, usesSymbols: new Set(), usesData: new Set(), toggles: new Set(), initiallyHidden: new Set(), depth: 0 };
  collectToggles(nodes, ctx.toggles);
  const body = nodes.map((n) => emit(n, ctx, '      ', null)).filter(Boolean).join('\n');
  const reactImports: string[] = [];
  if (/<Fragment key=/.test(body)) reactImports.push('Fragment');
  if (ctx.toggles.size) reactImports.push('useState');
  const lines: string[] = [];
  if (reactImports.length) lines.push(`import { ${reactImports.join(', ')} } from 'react'`);
  if (ctx.usesNavigate) lines.push(`import { useNavigate } from 'react-router-dom'`);
  for (const s of [...ctx.usesSymbols].sort()) if (s !== name) lines.push(`import ${s} from '${importDir}/components/${s}.tsx'`);
  for (const [fileId, v] of base.data) {
    if (!ctx.usesData.has(v)) continue;
    const src = findFileInTree(base.files, fileId);
    lines.push(`import ${v} from '${importDir}/data/${src ? dataSourceName(src) : v}.json'`);
  }
  lines.push('')
  lines.push(`export default function ${name}() {`);
  if (ctx.usesNavigate) lines.push(`  const navigate = useNavigate()`);
  if (ctx.toggles.size) {
    const init = Object.fromEntries([...ctx.initiallyHidden].map((id) => [id, true]));
    lines.push(`  const [hidden, setHidden] = useState<Record<string, boolean>>(${JSON.stringify(init)})`);
    lines.push(`  const toggle = (id: string) => setHidden((h) => ({ ...h, [id]: !h[id] }))`);
  }
  lines.push(`  return (`);
  lines.push(`    <>`);
  if (body) lines.push(body);
  lines.push(`    </>`);
  lines.push(`  )`);
  lines.push(`}`);
  return lines.join('\n') + '\n';
}

const THEME_INLINE = `@theme inline {
  --color-background: hsl(var(--background));
  --color-foreground: hsl(var(--foreground));
  --color-card: hsl(var(--card));
  --color-card-foreground: hsl(var(--card-foreground));
  --color-popover: hsl(var(--popover));
  --color-popover-foreground: hsl(var(--popover-foreground));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-secondary: hsl(var(--secondary));
  --color-secondary-foreground: hsl(var(--secondary-foreground));
  --color-muted: hsl(var(--muted));
  --color-muted-foreground: hsl(var(--muted-foreground));
  --color-accent: hsl(var(--accent));
  --color-accent-foreground: hsl(var(--accent-foreground));
  --color-destructive: hsl(var(--destructive));
  --color-destructive-foreground: hsl(var(--destructive-foreground));
  --color-border: hsl(var(--border));
  --color-input: hsl(var(--input));
  --color-ring: hsl(var(--ring));
  --radius-lg: var(--radius);
}`;

export function generateReactApp(project: BuilderProject): GeneratedFile[] {
  const files = project.files;
  const appName = project.name || 'Adhar app';
  const pkgName = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'adhar-app';

  const symbols = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const s of listSymbols(files)) {
    let n = pascal(symbolName(s), 'Component');
    while (usedNames.has(n)) n += 'X';
    usedNames.add(n);
    symbols.set(s.id, n);
  }
  const data = new Map<string, string>();
  for (const d of listDataSources(files)) {
    let v = camel(dataSourceName(d));
    while ([...data.values()].includes(v)) v += 'X';
    data.set(d.id, v);
  }
  const base = { files, symbols, data };
  const out: GeneratedFile[] = [];

  const pages = listPages(files);
  const pageNames = new Map<string, string>();
  for (const p of pages) {
    let n = pascal(p.name);
    if (usedNames.has(n)) n += 'Page';
    usedNames.add(n);
    pageNames.set(p.id, n);
    out.push({ path: `src/pages/${n}.tsx`, content: componentModule(n, p.nodes ?? [], base, '..') });
  }
  for (const s of listSymbols(files)) {
    const n = symbols.get(s.id)!;
    out.push({ path: `src/components/${n}.tsx`, content: componentModule(n, s.nodes ?? [], base, '..') });
  }
  for (const d of listDataSources(files)) {
    out.push({ path: `src/data/${dataSourceName(d)}.json`, content: (d.content ?? 'null').trim() + '\n' });
  }

  const home = homePage(files);
  const routes = pages.map((p) => `        <Route path=${JSON.stringify(pageRoute(p, files))} element={<${pageNames.get(p.id)} />} />`);
  out.push({
    path: 'src/App.tsx',
    content: [
      `import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'`,
      ...pages.map((p) => `import ${pageNames.get(p.id)} from './pages/${pageNames.get(p.id)}.tsx'`),
      '',
      'export default function App() {',
      '  return (',
      '    <BrowserRouter>',
      '      <Routes>',
      ...routes,
      `        <Route path="*" element={<Navigate to=${JSON.stringify(home ? pageRoute(home, files) : '/')} replace />} />`,
      '      </Routes>',
      '    </BrowserRouter>',
      '  )',
      '}',
      '',
    ].join('\n'),
  });

  const theme = getThemePreset(project.settings.theme);
  out.push({
    path: 'src/index.css',
    content: `@import "tailwindcss";\n\n@custom-variant dark (&:where(.dark, .dark *));\n\n${THEME_INLINE}\n\n${generateThemeCSS(theme)}\n\nbody {\n  background: hsl(var(--background));\n  color: hsl(var(--foreground));\n  font-family: Inter, ui-sans-serif, system-ui, sans-serif;\n}\n`,
  });
  out.push({
    path: 'src/main.tsx',
    content: `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\nimport './index.css'\n${project.settings.darkMode ? "\ndocument.documentElement.classList.add('dark')\n" : ''}\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n`,
  });
  out.push({
    path: 'index.html',
    content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${appName.replace(/[<>&"]/g, '')}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
  });
  out.push({
    path: 'vite.config.ts',
    content: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport tailwindcss from '@tailwindcss/vite'\n\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n})\n`,
  });
  out.push({
    path: 'package.json',
    content: JSON.stringify({
      name: pkgName,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
      dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0', 'react-router-dom': '^7.9.0' },
      devDependencies: {
        '@tailwindcss/vite': '^4.1.0',
        '@types/react': '^19.2.0',
        '@types/react-dom': '^19.2.0',
        '@vitejs/plugin-react': '^5.0.0',
        tailwindcss: '^4.1.0',
        typescript: '^5.7.0',
        vite: '^7.1.0',
      },
    }, null, 2) + '\n',
  });
  out.push({
    path: 'tsconfig.json',
    content: JSON.stringify({
      compilerOptions: {
        target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler',
        jsx: 'react-jsx', strict: true, resolveJsonModule: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true,
      },
      include: ['src'],
    }, null, 2) + '\n',
  });
  out.push({
    path: 'README.md',
    content: `# ${appName}\n\nDesigned in the Adhar Visual Designer and exported as a React + Tailwind app.\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n\n- Pages: ${pages.map((p) => `\`${pageRoute(p, files)}\``).join(', ') || 'none'}\n- Components: ${[...symbols.values()].join(', ') || 'none'}\n- Data: ${[...data.values()].join(', ') || 'none'}\n\nTo keep designing, open the project again from this repository (\`.adhar/builder.json\`).\n`,
  });
  return out;
}
