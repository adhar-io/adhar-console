/**
 * A small, realistic React + Vite + Tailwind repository — used by the tests
 * and the headless UI harness (stubbed Gitea).
 */
export const DEMO_REPO: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'acme-portal', private: true, type: 'module',
    scripts: { dev: 'vite', build: 'tsc -b && vite build' },
    dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0', 'react-router-dom': '^7.9.0', clsx: '^2.1.1' },
    devDependencies: { vite: '^7.1.0', '@vitejs/plugin-react': '^5.0.0', tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0', typescript: '^5.7.0' },
  }, null, 2) + '\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "jsx": "react-jsx",\n    "baseUrl": ".",\n    "paths": { "@/*": ["./src/*"] }\n  }\n}\n',
  'index.html': '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  'src/main.tsx': `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n`,
  'src/index.css': `@import "tailwindcss";\n\n@theme {\n  --color-brand: #4f46e5;\n  --color-brand-foreground: #ffffff;\n  --radius-card: 14px;\n}\n\nbody {\n  font-family: Inter, system-ui, sans-serif;\n}\n`,
  'src/App.tsx': `import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Customers from './pages/Customers'
import { Settings } from '@/pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="customers" element={<Customers />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
`,
  'src/components/Layout.tsx': `import { Link, Outlet } from 'react-router-dom'

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="flex items-center gap-6 border-b bg-white px-6 py-3">
        <span className="font-bold text-brand">Acme</span>
        <Link to="/" className="text-sm text-slate-600">Home</Link>
        <Link to="/customers" className="text-sm text-slate-600">Customers</Link>
      </nav>
      <Outlet />
    </div>
  )
}
`,
  'src/pages/Home.tsx': `import { Link } from 'react-router-dom'

// Landing page for signed-in users.
export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">Welcome to Acme</h1>
      <p className="mt-3 text-lg text-slate-600">Everything about your customers, in one place.</p>
      <div className="mt-8 flex gap-3">
        <Link to="/customers" className="rounded-[var(--radius-card)] bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground">View customers</Link>
        <a href="https://example.com/docs" className="rounded-lg border px-5 py-2.5 text-sm font-semibold">Read the docs</a>
      </div>
    </main>
  )
}
`,
  'src/pages/Customers.tsx': `import { useState } from 'react'
import clsx from 'clsx'
import customers from '../data/customers.json'

export default function Customers() {
  const [query, setQuery] = useState('')
  const rows = customers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <section className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Customers</h1>
        <button className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white" onClick={() => alert('todo')}>Add customer</button>
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customers…" className="mt-6 w-full max-w-sm rounded-lg border px-3 py-2 text-sm" />
      <ul className="mt-6 divide-y rounded-xl border bg-white">
        {rows.map((c) => (
          <li key={c.id} className={clsx('flex justify-between px-4 py-3 text-sm', c.status === 'Paused' && 'opacity-60')}>
            <span className="font-medium">{c.name}</span>
            <span className="text-slate-500">{c.email}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
`,
  'src/pages/Settings.tsx': `export function Settings() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold">Settings</h1>
      <form className="mt-6 flex flex-col gap-4 rounded-xl border bg-white p-6">
        <label className="text-sm font-medium">Workspace name</label>
        <input placeholder="Acme" required className="rounded-lg border px-3 py-2 text-sm" />
        <button type="submit" className="self-end rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">Save</button>
      </form>
    </section>
  )
}
`,
  'src/data/customers.json': JSON.stringify([
    { id: 1, name: 'Ada Lovelace', email: 'ada@analytical.io', status: 'Active' },
    { id: 2, name: 'Grace Hopper', email: 'grace@cobol.dev', status: 'Active' },
    { id: 3, name: 'Alan Turing', email: 'alan@enigma.org', status: 'Paused' },
  ], null, 2) + '\n',
  'README.md': '# Acme portal\n',
}

/** Fake blob sha: stable per content. */
export function fakeSha(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) { h ^= content.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
