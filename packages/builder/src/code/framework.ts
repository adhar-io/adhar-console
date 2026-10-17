/**
 * What kind of web app a repository is — from its package.json and file list.
 * Pure; drives page discovery, code generation style and theming.
 */

export type FrameworkId = 'next' | 'remix' | 'vite-react' | 'react' | 'html' | 'unknown'

export interface Framework {
  id: FrameworkId
  label: string
  /** Router flavour for wiring new pages. */
  router: 'next-app' | 'next-pages' | 'react-router' | 'remix' | 'none'
  tailwind: boolean
  /** Tailwind major version when known (v4 = CSS-first config). */
  tailwindVersion?: 3 | 4
  typescript: boolean
  /** Folder that holds source (`src` or the repo root). */
  srcDir: string
  /** Directory of the app inside the repo (monorepos: where package.json lives). */
  root: string
}

interface Pkg {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const major = (v?: string) => (v ? Number((v.match(/\d+/) ?? ['0'])[0]) : 0)

/** The package.json that most likely belongs to the web app (root first, then apps/web, apps/*, packages/*). */
export function findAppPackageJson(paths: string[]): string | null {
  const pkgs = paths.filter((p) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/'))
  if (pkgs.includes('package.json')) return 'package.json'
  const pref = ['apps/web/package.json', 'web/package.json', 'frontend/package.json', 'app/package.json', 'ui/package.json']
  for (const p of pref) if (pkgs.includes(p)) return p
  return pkgs.sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? null
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
  if (deps.next) {
    id = 'next'
    router = has(/^(src\/)?app\/(.+\/)?page\.(tsx|jsx|js|ts)$/) ? 'next-app' : 'next-pages'
  } else if (Object.keys(deps).some((d) => d.startsWith('@remix-run/') || d.startsWith('@react-router/dev'))) {
    id = 'remix'
    router = 'remix'
  } else if (deps.react && deps.vite) {
    id = 'vite-react'
    router = deps['react-router-dom'] || deps['react-router'] ? 'react-router' : 'none'
  } else if (deps.react) {
    id = 'react'
    router = deps['react-router-dom'] || deps['react-router'] ? 'react-router' : 'none'
  } else if (has(/(^|\/)index\.html$/)) {
    id = 'html'
  }
  const label = { next: 'Next.js', remix: 'Remix', 'vite-react': 'React + Vite', react: 'React', html: 'Static HTML', unknown: 'Unknown' }[id]
  return { id, label, router, tailwind, tailwindVersion, typescript, srcDir, root }
}

/** Frameworks whose pages the designer can import and edit. */
export function isEditable(f: Framework): boolean {
  return f.id === 'next' || f.id === 'vite-react' || f.id === 'react' || f.id === 'remix'
}
