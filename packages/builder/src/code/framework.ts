/**
 * What kind of web app a repository is — from its package.json and file list.
 * Pure; drives page discovery, code generation style and theming.
 *
 * Supported (editable) families — the ones Adhar UI ships components for, plus
 * plain HTML:
 *
 *   react    Next.js, Remix, React + Vite, React
 *   solid    SolidStart, Solid (+ @solidjs/router)
 *   vue      Nuxt, Vue (+ vue-router)
 *   svelte   SvelteKit, Svelte (+ svelte-spa-router / svelte-routing)
 *   angular  Angular (standalone or NgModule; Router routes)
 *   html     static HTML pages (links between pages are the routes)
 */

export type FrameworkId =
  | 'next' | 'remix' | 'vite-react' | 'react'
  | 'solid-start' | 'solid'
  | 'nuxt' | 'vue'
  | 'sveltekit' | 'svelte'
  | 'angular'
  | 'html' | 'unknown';

/** The template language / engine family a framework's pages are written in. */
export type FrameworkFamily = 'react' | 'solid' | 'vue' | 'svelte' | 'angular' | 'html' | 'unknown';

export interface Framework {
  id: FrameworkId
  label: string
  /** Router flavour for wiring new pages. */
  router:
    | 'next-app' | 'next-pages' | 'react-router' | 'remix'
    | 'solid-start' | 'solid-router'
    | 'nuxt' | 'vue-router'
    | 'sveltekit' | 'svelte-spa-router' | 'svelte-routing'
    | 'angular'
    | 'html'
    | 'none'
  tailwind: boolean
  /** Tailwind major version when known (v4 = CSS-first config). */
  tailwindVersion?: 3 | 4
  typescript: boolean
  /** Folder that holds source (`src` or the repo root). */
  srcDir: string
  /** Directory of the app inside the repo (monorepos: where package.json lives). */
  root: string
  /** The Adhar UI package for this framework, when the app depends on it (e.g. `@adhar-ui/vue`). */
  adharUi?: string
  /** Major version of the framework itself when known (Angular, Svelte, Vue). */
  major?: number
}

interface Pkg {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const major = (v?: string) => (v ? Number((v.match(/\d+/) ?? ['0'])[0]) : 0)

const LABELS: Record<FrameworkId, string> = {
  next: 'Next.js', remix: 'Remix', 'vite-react': 'React + Vite', react: 'React',
  'solid-start': 'SolidStart', solid: 'Solid',
  nuxt: 'Nuxt', vue: 'Vue',
  sveltekit: 'SvelteKit', svelte: 'Svelte',
  angular: 'Angular',
  html: 'Static HTML', unknown: 'Unknown',
}

/** Human list of what the designer edits — for empty states and warnings. */
export const SUPPORTED_FRAMEWORKS = 'React (Vite, Next.js, Remix), Angular, Vue (Nuxt), Svelte (SvelteKit), Solid (SolidStart) and static HTML'

/** The package.json that most likely belongs to the web app (root first, then apps/web, apps/*, packages/*). */
export function findAppPackageJson(paths: string[]): string | null {
  const pkgs = paths.filter((p) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/'))
  if (pkgs.includes('package.json')) return 'package.json'
  const pref = ['apps/web/package.json', 'web/package.json', 'frontend/package.json', 'app/package.json', 'ui/package.json']
  for (const p of pref) if (pkgs.includes(p)) return p
  return pkgs.sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? null
}

export function familyOf(f: Pick<Framework, 'id'>): FrameworkFamily {
  switch (f.id) {
    case 'next': case 'remix': case 'vite-react': case 'react': return 'react'
    case 'solid-start': case 'solid': return 'solid'
    case 'nuxt': case 'vue': return 'vue'
    case 'sveltekit': case 'svelte': return 'svelte'
    case 'angular': return 'angular'
    case 'html': return 'html'
    default: return 'unknown'
  }
}

export function detectFramework(pkgText: string | null, paths: string[], pkgPath: string | null = 'package.json'): Framework {
  let pkg: Pkg = {}
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {}
  } catch {
    pkg = {}
  }
  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) }
  const root = pkgPath && pkgPath.includes('/') ? pkgPath.slice(0, pkgPath.lastIndexOf('/')) : ''
  const rel = (p: string) => (root ? (p.startsWith(root + '/') ? p.slice(root.length + 1) : null) : p)
  const local = paths.map(rel).filter((p): p is string => p !== null)
  const has = (re: RegExp) => local.some((p) => re.test(p))

  const typescript = !!deps.typescript || has(/\.tsx?$/)
  const tailwind = !!(deps.tailwindcss || deps['@tailwindcss/vite'] || deps['@tailwindcss/postcss']) || has(/^tailwind\.config\.(js|cjs|mjs|ts)$/)
  const tailwindVersion = tailwind
    ? (major(deps.tailwindcss) >= 4 || deps['@tailwindcss/vite'] || deps['@tailwindcss/postcss'] ? 4 : 3)
    : undefined
  const srcDir = has(/^src\//) ? 'src' : ''

  let id: FrameworkId = 'unknown'
  let router: Framework['router'] = 'none'
  let fwMajor: number | undefined
  if (deps.next) {
    id = 'next'
    router = has(/^(src\/)?app\/(.+\/)?page\.(tsx|jsx|js|ts)$/) ? 'next-app' : 'next-pages'
  } else if (Object.keys(deps).some((d) => d.startsWith('@remix-run/') || d.startsWith('@react-router/dev'))) {
    id = 'remix'
    router = 'remix'
  } else if (deps['@angular/core'] || has(/^angular\.json$/)) {
    id = 'angular'
    router = 'angular'
    fwMajor = major(deps['@angular/core']) || undefined
  } else if (deps.nuxt || deps.nuxt3) {
    id = 'nuxt'
    router = 'nuxt'
    fwMajor = 3
  } else if (deps.vue) {
    id = 'vue'
    router = deps['vue-router'] ? 'vue-router' : 'none'
    fwMajor = major(deps.vue) || undefined
  } else if (deps['@sveltejs/kit']) {
    id = 'sveltekit'
    router = 'sveltekit'
    fwMajor = major(deps.svelte) || undefined
  } else if (deps.svelte) {
    id = 'svelte'
    router = deps['svelte-spa-router'] ? 'svelte-spa-router' : deps['svelte-routing'] ? 'svelte-routing' : 'none'
    fwMajor = major(deps.svelte) || undefined
  } else if (deps['@solidjs/start']) {
    id = 'solid-start'
    router = 'solid-start'
  } else if (deps['solid-js']) {
    id = 'solid'
    router = deps['@solidjs/router'] ? 'solid-router' : 'none'
  } else if (deps.react && deps.vite) {
    id = 'vite-react'
    router = deps['react-router-dom'] || deps['react-router'] ? 'react-router' : 'none'
  } else if (deps.react) {
    id = 'react'
    router = deps['react-router-dom'] || deps['react-router'] ? 'react-router' : 'none'
  } else if (has(/(^|\/)index\.html?$/)) {
    id = 'html'
    router = 'html'
  }
  const family = familyOf({ id })
  const adharUiPkg = family === 'react' || family === 'unknown' || family === 'html' ? null : `@adhar-ui/${family}`
  const adharUi = adharUiPkg && deps[adharUiPkg] ? adharUiPkg : undefined
  return {
    id, label: LABELS[id], router, tailwind, tailwindVersion, typescript, srcDir, root,
    ...(adharUi ? { adharUi } : {}),
    ...(fwMajor ? { major: fwMajor } : {}),
  }
}

/** Frameworks whose pages the designer can import and edit. */
export function isEditable(f: Framework): boolean {
  return familyOf(f) !== 'unknown'
}
