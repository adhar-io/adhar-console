// ─── Code Generation ─────────────────────────────────────────────────────────
// Generates production-ready framework code from CanvasNode trees.
// Supports React, Vue, Svelte, Angular, Solid, and HTML export.

import type { CanvasNode } from './builder-types.ts';

// ─── Tag mapping ─────────────────────────────────────────────────────────────
export function nodeToTag(type: string): string {
  if (['flex', 'flex-col', 'grid', 'grid-3', 'section', 'card', 'nav', 'footer', 'sidebar',
    'hero-section', 'feature-card', 'pricing-card', 'cta-section', 'login-form', 'stat-card',
    'screen-mobile', 'screen-tablet', 'screen-desktop', 'frame',
    'flow-step', 'data-model', 'api-endpoint', 'note',
    'shape-rect', 'shape-rounded', 'shape-circle', 'shape-line'].includes(type)) return 'div';
  if (['checkbox-row', 'switch-row'].includes(type)) return 'label';
  if (type.startsWith('btn-') || type === 'select-trigger') return 'button';
  if (type === 'label-el') return 'label';
  if (['img-placeholder', 'skeleton-text', 'progress-bar', 'empty-state-el'].includes(type)) return 'div';
  if (type === 'link' || type === 'menu-item') return 'a';
  if (type.startsWith('alert-') || type === 'badge-outline' || type === 'icon-placeholder') return 'span';
  if (type === 'checkbox' || type === 'radio' || type === 'switch') return 'label';
  if (type === 'date-input') return 'input';
  if (type === 'badge' || type === 'avatar') return 'span';
  if (type === 'tab-item') return 'button';
  if (type === 'modal' || type === 'symbol') return 'div';
  if (type === 'sidebar') return 'aside';
  return HTML_TAGS.has(type) ? type : 'div';
}

const HTML_TAGS = new Set([
  'div', 'section', 'nav', 'footer', 'header', 'main', 'aside', 'article', 'span', 'p', 'a', 'label', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'ul', 'ol', 'li', 'blockquote', 'small', 'strong', 'em',
  'input', 'textarea', 'select', 'img', 'hr',
]);

// ─── Detect what features a node tree uses ───────────────────────────────────
interface CodeFeatures {
  hasState: boolean;
  hasEffect: boolean;
  hasInteraction: boolean;
  hasHover: boolean;
  hasForm: boolean;
  hasNavigation: boolean;
  stateVars: { name: string; type: string; initial: string }[];
  handlers: { name: string; body: string }[];
}

function detectFeatures(nodes: CanvasNode[]): CodeFeatures {
  const f: CodeFeatures = { hasState: false, hasEffect: false, hasInteraction: false, hasHover: false, hasForm: false, hasNavigation: false, stateVars: [], handlers: [] };
  const walk = (list: CanvasNode[]) => {
    for (const n of list) {
      if (n.interactions?.length) { f.hasInteraction = true; f.hasState = true; }
      if (n.hoverClassName) f.hasHover = true;
      if (n.type === 'input' || n.type === 'textarea' || n.type === 'select-trigger') f.hasForm = true;
      if (n.interactions?.some((i) => i.action === 'navigate')) f.hasNavigation = true;
      if (n.interactions?.some((i) => i.action === 'toggle-visibility')) {
        f.stateVars.push({ name: `show_${n.id.slice(0, 6)}`, type: 'boolean', initial: String(!n.hidden) });
      }
      walk(n.children);
    }
  };
  walk(nodes);
  if (f.hasForm) { f.hasState = true; }
  return f;
}

// ─── React (Production) ─────────────────────────────────────────────────────
function genReactJSX(nodes: CanvasNode[], depth = 2, features: CodeFeatures): string {
  return nodes.map((n) => {
    if (n.hidden) return '';
    const sp = '  '.repeat(depth);
    const tag = n.componentName || nodeToTag(n.type);

    // Build props
    const propsArr: string[] = [];
    if (n.props.className) {
      let cls = n.props.className;
      if (n.hoverClassName) {
        const hoverCls = n.hoverClassName.split(/\s+/).map((c: string) => `hover:${c}`).join(' ');
        cls = `${cls} ${hoverCls} transition-all duration-200`;
      }
      propsArr.push(`className="${cls}"`);
    }
    if (n.props.placeholder) propsArr.push(`placeholder="${n.props.placeholder}"`);

    // Interaction handlers
    const clickAction = n.interactions?.find((i) => i.trigger === 'click');
    if (clickAction?.action === 'open-url' && clickAction.url) {
      propsArr.push(`onClick={() => window.open("${clickAction.url}", "_blank")}`);
      propsArr.push(`role="button"`)
      propsArr.push(`className="${(n.props.className || '')} cursor-pointer"`);
    } else if (clickAction?.action === 'toggle-visibility') {
      const varName = `show_${n.id.slice(0, 6)}`;
      propsArr.push(`onClick={() => set${varName.charAt(0).toUpperCase() + varName.slice(1)}(v => !v)}`);
    }

    // Form elements
    if (n.type === 'input' || n.type === 'textarea') {
      if (features.hasForm) {
        const fieldName = (n.props.placeholder || 'field').replace(/[^a-zA-Z]/g, '').toLowerCase();
        propsArr.push(`value={formData.${fieldName}}`);
        propsArr.push(`onChange={(e) => setFormData(d => ({ ...d, ${fieldName}: e.target.value }))}`);
      }
    }

    const propsStr = propsArr.length > 0 ? ' ' + propsArr.join(' ') : '';
    const text = typeof n.props.children === 'string' ? n.props.children : '';
    const kids = genReactJSX(n.children, depth + 1, features);

    // Visibility wrapper
    const visAction = n.interactions?.find((i) => i.action === 'toggle-visibility');
    const visVar = visAction ? `show_${n.id.slice(0, 6)}` : null;

    let jsx: string;
    if (['input', 'textarea'].includes(nodeToTag(n.type))) {
      jsx = `${sp}<${tag}${propsStr} />`;
    } else if (n.children.length > 0) {
      jsx = `${sp}<${tag}${propsStr}>\n${text ? `${sp}  ${text}\n` : ''}${kids}\n${sp}</${tag}>`;
    } else {
      jsx = `${sp}<${tag}${propsStr}>${text}</${tag}>`;
    }

    if (visVar) {
      return `${sp}{${visVar} && (\n${jsx}\n${sp})}`;
    }
    return jsx;
  }).filter(Boolean).join('\n');
}

export function generateReactCode(nodes: CanvasNode[], pageName: string): string {
  const name = pageName.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Page';
  const features = detectFeatures(nodes);

  const lines: string[] = [];

  // Imports
  const reactImports: string[] = [];
  if (features.hasState) reactImports.push('useState');
  if (features.hasEffect) reactImports.push('useEffect');
  if (reactImports.length > 0) {
    lines.push(`import { ${reactImports.join(', ')} } from 'react';`);
  }
  if (features.hasNavigation) {
    lines.push(`import { useRouter } from 'next/navigation';`);
  }
  lines.push(`import { cn } from '@/lib/utils';`);
  lines.push('');

  // Component
  lines.push(`export default function ${name}() {`);

  // State variables
  if (features.hasNavigation) lines.push(`  const router = useRouter();`);
  if (features.hasForm) {
    const fields = nodes.flatMap(function collectFields(n: CanvasNode): string[] {
      const f: string[] = [];
      if (n.type === 'input' || n.type === 'textarea') {
        f.push((n.props.placeholder || 'field').replace(/[^a-zA-Z]/g, '').toLowerCase());
      }
      n.children.forEach((c) => f.push(...collectFields(c)));
      return f;
    });
    const uniqueFields = [...new Set(fields)];
    lines.push(`  const [formData, setFormData] = useState({`);
    uniqueFields.forEach((field) => lines.push(`    ${field}: '',`));
    lines.push(`  });`);
  }
  features.stateVars.forEach((v) => {
    const setter = `set${v.name.charAt(0).toUpperCase() + v.name.slice(1)}`;
    lines.push(`  const [${v.name}, ${setter}] = useState(${v.initial});`);
  });

  if (features.hasState || features.hasNavigation) lines.push('');

  // JSX
  lines.push(`  return (`);
  lines.push(`    <div className="mx-auto max-w-7xl px-4 py-8">`);
  lines.push(genReactJSX(nodes, 3, features));
  lines.push(`    </div>`);
  lines.push(`  );`);
  lines.push(`}`);
  lines.push('');

  return lines.join('\n');
}

// ─── Vue SFC ─────────────────────────────────────────────────────────────────
function genVueTemplate(nodes: CanvasNode[], depth = 2): string {
  return nodes.map((n) => {
    if (n.hidden) return '';
    const sp = '  '.repeat(depth);
    const tag = nodeToTag(n.type);
    let cls = n.props.className || '';
    if (n.hoverClassName) cls += ' ' + n.hoverClassName.split(/\s+/).map((c: string) => `hover:${c}`).join(' ');
    const clsAttr = cls ? ` class="${cls.trim()}"` : '';
    const ph = n.props.placeholder ? ` placeholder="${n.props.placeholder}"` : '';
    const text = typeof n.props.children === 'string' ? n.props.children : '';
    const kids = genVueTemplate(n.children, depth + 1);
    if (['input', 'textarea'].includes(tag)) return `${sp}<${tag}${clsAttr}${ph} />`;
    if (n.children.length > 0) return `${sp}<${tag}${clsAttr}>\n${text ? `${sp}  ${text}\n` : ''}${kids}\n${sp}</${tag}>`;
    return `${sp}<${tag}${clsAttr}>${text}</${tag}>`;
  }).filter(Boolean).join('\n');
}

export function generateVueCode(nodes: CanvasNode[], pageName: string): string {
  const name = pageName.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Page';
  const features = detectFeatures(nodes);
  const tmpl = genVueTemplate(nodes);
  const script: string[] = ['<script setup lang="ts">'];
  script.push(`// ${name} component`);
  if (features.hasState) script.push(`import { ref } from 'vue';`);
  if (features.hasForm) {
    script.push(`const formData = ref({`);
    script.push(`  // form fields`);
    script.push(`});`);
  }
  features.stateVars.forEach((v) => script.push(`const ${v.name} = ref(${v.initial});`));
  script.push('</script>');
  return `${script.join('\n')}\n\n<template>\n  <div class="mx-auto max-w-7xl px-4 py-8">\n${tmpl}\n  </div>\n</template>\n`;
}

// ─── Svelte ──────────────────────────────────────────────────────────────────
function genSvelteMarkup(nodes: CanvasNode[], depth = 1): string {
  return nodes.map((n) => {
    if (n.hidden) return '';
    const sp = '  '.repeat(depth);
    const tag = nodeToTag(n.type);
    let cls = n.props.className || '';
    if (n.hoverClassName) cls += ' ' + n.hoverClassName.split(/\s+/).map((c: string) => `hover:${c}`).join(' ');
    const clsAttr = cls ? ` class="${cls.trim()}"` : '';
    const ph = n.props.placeholder ? ` placeholder="${n.props.placeholder}"` : '';
    const text = typeof n.props.children === 'string' ? n.props.children : '';
    const kids = genSvelteMarkup(n.children, depth + 1);
    if (['input', 'textarea'].includes(tag)) return `${sp}<${tag}${clsAttr}${ph} />`;
    if (n.children.length > 0) return `${sp}<${tag}${clsAttr}>\n${text ? `${sp}  ${text}\n` : ''}${kids}\n${sp}</${tag}>`;
    return `${sp}<${tag}${clsAttr}>${text}</${tag}>`;
  }).filter(Boolean).join('\n');
}

export function generateSvelteCode(nodes: CanvasNode[], pageName: string): string {
  const name = pageName.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Page';
  const features = detectFeatures(nodes);
  const markup = genSvelteMarkup(nodes);
  const script: string[] = [`<script lang="ts">`];
  script.push(`  // ${name} component`);
  if (features.hasForm) script.push(`  let formData = $state({});`);
  features.stateVars.forEach((v) => script.push(`  let ${v.name} = $state(${v.initial});`));
  script.push(`</script>`);
  return `${script.join('\n')}\n\n<div class="mx-auto max-w-7xl px-4 py-8">\n${markup}\n</div>\n`;
}

// ─── Angular ─────────────────────────────────────────────────────────────────
export function generateAngularCode(nodes: CanvasNode[], pageName: string): string {
  const name = pageName.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Page';
  const selector = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
  const tmpl = genVueTemplate(nodes);
  const features = detectFeatures(nodes);
  const fields = features.stateVars.map((v) => `  ${v.name} = signal(${v.initial});`).join('\n');
  return `import { Component${features.hasState ? ', signal' : ''} } from '@angular/core';\n\n@Component({\n  selector: 'app-${selector}',\n  standalone: true,\n  template: \`\n  <div class="mx-auto max-w-7xl px-4 py-8">\n${tmpl}\n  </div>\n  \`,\n})\nexport class ${name}Component {\n${fields}\n}\n`;
}

// ─── Solid ───────────────────────────────────────────────────────────────────
export function generateSolidCode(nodes: CanvasNode[], pageName: string): string {
  const name = pageName.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Page';
  const features = detectFeatures(nodes);
  const jsx = genReactJSX(nodes, 2, features);
  const imports: string[] = [];
  if (features.hasState) imports.push(`import { createSignal } from 'solid-js';`);
  const signals = features.stateVars.map((v) => `  const [${v.name}, set${v.name.charAt(0).toUpperCase() + v.name.slice(1)}] = createSignal(${v.initial});`).join('\n');
  return `${imports.join('\n')}\n\nexport default function ${name}() {\n${signals}\n  return (\n    <div class="mx-auto max-w-7xl px-4 py-8">\n${jsx.replace(/className=/g, 'class=')}\n    </div>\n  );\n}\n`;
}

// ─── HTML (with prototyping) ─────────────────────────────────────────────────
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function nodeToHTML(n: CanvasNode): string {
  if (n.hidden) return '';
  const tag = nodeToTag(n.type);
  let classes = n.props.className || '';
  if (n.hoverClassName) {
    const hoverClasses = n.hoverClassName.split(/\s+/).map((c: string) => `hover:${c}`).join(' ');
    classes = `${classes} ${hoverClasses} transition-all duration-200`.trim();
  }
  const cls = classes ? ` class="${esc(classes)}"` : '';
  let attrs = '';
  const clickAction = n.interactions?.find((i: any) => i.trigger === 'click');
  if (clickAction?.action === 'open-url' && clickAction.url) {
    attrs += ` onclick="window.open('${esc(clickAction.url).replace(/'/g, '%27')}','_blank')" style="cursor:pointer"`;
  } else if (clickAction?.action === 'navigate' && clickAction.targetPageId) {
    attrs += ` onclick="document.dispatchEvent(new CustomEvent('navigate',{detail:'${esc(clickAction.targetPageId).replace(/'/g, '')}'}))" style="cursor:pointer"`;
  } else if (clickAction?.action === 'toggle-visibility' && clickAction.targetNodeId) {
    attrs += ` onclick="var el=document.querySelector('[data-node-id=\\'${esc(clickAction.targetNodeId).replace(/'/g, '')}\\']');if(el)el.style.display=el.style.display==='none'?'':'none'" style="cursor:pointer"`;
  }
  const nodeIdAttr = n.interactions?.length ? ` data-node-id="${n.id}"` : '';
  const text = typeof n.props.children === 'string' ? esc(n.props.children) : '';
  const kids = n.children.map(nodeToHTML).join('');
  if (['input', 'textarea'].includes(tag)) return `<${tag}${cls}${attrs}${nodeIdAttr} placeholder="${esc(n.props.placeholder || '')}" />`;
  return `<${tag}${cls}${attrs}${nodeIdAttr}>${text}${kids}</${tag}>`;
}

export function generateHTMLPage(nodes: CanvasNode[]): string {
  return `<!DOCTYPE html>\n<html>\n<head><script src="https://cdn.tailwindcss.com"><\/script></head>\n<body>\n<div class="mx-auto max-w-7xl px-4 py-8">\n${nodes.map(nodeToHTML).join('\n')}\n</div>\n</body>\n</html>`;
}

// ─── Full Project Export ─────────────────────────────────────────────────────
export function generateProjectFiles(pages: { name: string; nodes: CanvasNode[] }[], framework: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  // Package.json
  files.push({ path: 'package.json', content: JSON.stringify({
    name: 'my-adhar-ui-app', version: '0.1.0', private: true,
    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', next: '^15.0.0', tailwindcss: '^4.0.0', clsx: '^2.1.0', 'tailwind-merge': '^2.6.0' },
  }, null, 2) });

  // Utils
  files.push({ path: 'src/lib/utils.ts', content: `import { clsx, type ClassValue } from 'clsx';\nimport { twMerge } from 'tailwind-merge';\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}\n` });

  // Pages
  pages.forEach((page) => {
    const name = page.name.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Page';
    const code = generateCode(page.nodes, page.name, framework);
    const path = framework === 'react' ? `src/app/${name.toLowerCase()}/page.tsx` : `src/pages/${name}.${framework === 'vue' ? 'vue' : framework === 'svelte' ? 'svelte' : 'tsx'}`;
    files.push({ path, content: code });
  });

  return files;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
export function generateCode(nodes: CanvasNode[], pageName: string, framework: string): string {
  switch (framework) {
    case 'vue': return generateVueCode(nodes, pageName);
    case 'svelte': return generateSvelteCode(nodes, pageName);
    case 'angular': return generateAngularCode(nodes, pageName);
    case 'solid': return generateSolidCode(nodes, pageName);
    default: return generateReactCode(nodes, pageName);
  }
}

export { nodeToHTML };
