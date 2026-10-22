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

/* ───────────────────────── other frameworks (tests + harness) ───────────────────────── */

const pkg = (name: string, dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) =>
  JSON.stringify({ name, private: true, type: 'module', dependencies, devDependencies }, null, 2) + '\n';

/** Angular 19, standalone components, Router with lazy routes, `@adhar-ui/angular`. */
export const ANGULAR_REPO: Record<string, string> = {
  'package.json': pkg('acme-ng', { '@angular/core': '^19.2.0', '@angular/common': '^19.2.0', '@angular/router': '^19.2.0', '@adhar-ui/angular': '^0.1.1' }, { typescript: '~5.7.0', '@angular/cli': '^19.2.0' }),
  'angular.json': JSON.stringify({ projects: { 'acme-ng': { architect: { build: { options: { styles: ['src/styles.css'] } } } } } }, null, 2) + '\n',
  'tsconfig.json': '{\n  "compilerOptions": { "strict": true }\n}\n',
  'src/styles.css': 'body {\n  font-family: Inter, sans-serif;\n}\n.btn {\n  padding: 0.5rem 1rem;\n  border-radius: 8px;\n}\n',
  'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app/app.component';\nimport { appConfig } from './app/app.config';\n\nbootstrapApplication(AppComponent, appConfig);\n`,
  'src/app/app.config.ts': `import { ApplicationConfig } from '@angular/core';\nimport { provideRouter } from '@angular/router';\nimport { routes } from './app.routes';\n\nexport const appConfig: ApplicationConfig = {\n  providers: [provideRouter(routes)],\n};\n`,
  'src/app/app.component.ts': `import { Component } from '@angular/core';\nimport { RouterOutlet } from '@angular/router';\n\n@Component({\n  selector: 'app-root',\n  imports: [RouterOutlet],\n  template: \`<router-outlet />\`,\n})\nexport class AppComponent {}\n`,
  'src/app/app.routes.ts': `import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'customers', loadComponent: () => import('./pages/customers/customers.component').then((m) => m.CustomersComponent) },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
  { path: '**', redirectTo: '' },
];
`,
  'src/app/pages/home/home.component.ts': `import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { UpperCasePipe } from '@angular/common';

@Component({
  selector: 'app-home',
  imports: [RouterLink, UpperCasePipe],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
})
export class HomeComponent {
  user = signal({ name: 'Ada' });
  open = signal(false);
}
`,
  'src/app/pages/home/home.component.html': `<main class="hero">
  <!-- greeting -->
  <h1 class="title">Welcome to Acme</h1>
  <p class="lead">Hello {{ user().name | uppercase }} &amp; team</p>
  <a routerLink="/customers" class="btn">View customers</a>
  @if (open()) {
    <p class="note">Open</p>
  } @else {
    <p class="note">Closed</p>
  }
  <button type="button" (click)="open.set(!open())" [class.active]="open()">Toggle</button>
  <app-stats [period]="'week'" />
</main>
`,
  'src/app/pages/home/home.component.css': '.hero { padding: 3rem; }\n.title { font-size: 2.5rem; }\n',
  'src/app/pages/customers/customers.component.ts': `import { Component } from '@angular/core';

@Component({
  selector: 'app-customers',
  template: \`
    <section class="page">
      <h1>Customers</h1>
      <ul>
        @for (c of customers; track c.id) {
          <li>{{ c.name }}</li>
        } @empty {
          <li>No customers</li>
        }
      </ul>
    </section>
  \`,
  styles: [\`.page { padding: 2rem; }\`],
})
export class CustomersComponent {
  customers = [{ id: 1, name: 'Ada' }];
}
`,
  'src/app/admin/admin.routes.ts': `import { Routes } from '@angular/router';\nimport { SettingsComponent } from './settings.component';\n\nexport const ADMIN_ROUTES: Routes = [\n  { path: 'settings', component: SettingsComponent },\n];\n`,
  'src/app/admin/settings.component.ts': `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-settings',\n  template: \`<section><h1>Settings</h1><input placeholder="Workspace" required></section>\`,\n})\nexport class SettingsComponent {}\n`,
};

/** Vue 3 + vue-router + Tailwind v4 + `@adhar-ui/vue`. */
export const VUE_REPO: Record<string, string> = {
  'package.json': pkg('acme-vue', { vue: '^3.5.0', 'vue-router': '^4.5.0', '@adhar-ui/vue': '^0.1.1' }, { vite: '^7.1.0', '@vitejs/plugin-vue': '^6.0.0', tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0', typescript: '^5.7.0' }),
  'index.html': '<!doctype html>\n<html><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n',
  'src/main.ts': `import { createApp } from 'vue'\nimport App from './App.vue'\nimport router from './router'\nimport './assets/main.css'\n\ncreateApp(App).use(router).mount('#app')\n`,
  'src/assets/main.css': '@import "tailwindcss";\n\n@theme {\n  --color-brand: #16a34a;\n}\n',
  'src/App.vue': `<script setup lang="ts">\nimport { RouterView } from 'vue-router'\n</script>\n\n<template>\n  <RouterView />\n</template>\n`,
  'src/router/index.ts': `import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/about', name: 'about', component: () => import('../views/AboutView.vue') },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: HomeView },
  ],
})

export default router
`,
  'src/views/HomeView.vue': `<script setup lang="ts">
import { ref } from 'vue'
import StatCard from '@/components/StatCard.vue'

const count = ref(3)
const open = ref(false)
</script>

<template>
  <main class="mx-auto max-w-4xl p-8">
    <!-- hero -->
    <h1 class="text-4xl font-bold text-brand">Welcome to Acme</h1>
    <p class="mt-2 text-slate-600" :class="{ 'opacity-50': !open }">You have {{ count }} new messages &amp; more</p>
    <RouterLink to="/about" class="text-brand underline">About us</RouterLink>
    <p v-if="open" class="text-sm">Open</p>
    <p v-else class="text-sm">Closed</p>
    <ul>
      <li v-for="n in count" :key="n" class="py-1">Item {{ n }}</li>
    </ul>
    <StatCard title="Revenue" :value="42" />
    <button type="button" class="rounded bg-brand px-4 py-2 text-white" @click="open = !open">Toggle</button>
  </main>
</template>

<style scoped>
.text-brand { letter-spacing: -0.01em; }
</style>
`,
  'src/views/AboutView.vue': `<template>\n  <section class="p-8">\n    <h1 class="text-2xl font-bold">About</h1>\n    <p>We build things.</p>\n  </section>\n</template>\n`,
  'src/components/StatCard.vue': `<script setup lang="ts">\ndefineProps<{ title: string; value: number }>()\n</script>\n\n<template>\n  <div class="rounded border p-4"><span>{{ title }}</span> <strong>{{ value }}</strong></div>\n</template>\n`,
};

/** SvelteKit 2 / Svelte 5, file routes, plain CSS, `@adhar-ui/svelte`. */
export const SVELTEKIT_REPO: Record<string, string> = {
  'package.json': pkg('acme-kit', {}, { svelte: '^5.39.0', '@sveltejs/kit': '^2.20.0', '@sveltejs/vite-plugin-svelte': '^6.0.0', vite: '^7.1.0', typescript: '^5.7.0', '@adhar-ui/svelte': '^0.1.1' }),
  'svelte.config.js': `import adapter from '@sveltejs/adapter-auto';\n\nexport default { kit: { adapter: adapter() } };\n`,
  'src/app.css': 'body { font-family: Inter, sans-serif; }\n.card { border: 1px solid #ddd; border-radius: 12px; padding: 1rem; }\n',
  'src/routes/+layout.svelte': `<script>\n  import '../app.css';\n  let { children } = $props();\n</script>\n\n<nav><a href="/">Home</a> <a href="/about">About</a></nav>\n{@render children()}\n`,
  'src/routes/+page.svelte': `<script lang="ts">
  import Counter from '$lib/Counter.svelte';
  let { data } = $props();
  let open = $state(false);
</script>

<svelte:head>
  <title>Home</title>
</svelte:head>

<main class="hero">
  <!-- hero -->
  <h1 class="title">Welcome to Acme</h1>
  <p class="lead {open ? 'open' : ''}">Hello {data.user} &amp; friends</p>
  <a href="/about" class="link">About us</a>
  {#if open}
    <p>Open</p>
  {:else}
    <p>Closed</p>
  {/if}
  <Counter start={3} />
  <button type="button" onclick={() => (open = !open)}>Toggle</button>
</main>

<style>
  .hero { padding: 3rem; }
</style>
`,
  'src/routes/about/+page.svelte': `<section class="card">\n  <h1>About</h1>\n  <p>We build things.</p>\n</section>\n`,
  'src/routes/blog/[slug]/+page.svelte': `<script>\n  let { data } = $props();\n</script>\n\n<article><h1>{data.title}</h1></article>\n`,
  'src/lib/Counter.svelte': `<script>\n  let { start = 0 } = $props();\n  let n = $state(start);\n</script>\n\n<button onclick={() => n++}>{n}</button>\n`,
};

/** Solid + @solidjs/router (JSX config, lazy pages), Tailwind v4. */
export const SOLID_REPO: Record<string, string> = {
  'package.json': pkg('acme-solid', { 'solid-js': '^1.9.0', '@solidjs/router': '^0.15.0' }, { vite: '^7.1.0', 'vite-plugin-solid': '^2.11.0', tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0', typescript: '^5.7.0' }),
  'src/index.css': '@import "tailwindcss";\n',
  'src/index.tsx': `import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { lazy } from 'solid-js';
import Home from './pages/Home';
import './index.css';

const About = lazy(() => import('./pages/About'));

render(
  () => (
    <Router>
      <Route path="/" component={Home} />
      <Route path="/about" component={About} />
    </Router>
  ),
  document.getElementById('root')!,
);
`,
  'src/pages/Home.tsx': `import { createSignal, For, Show } from 'solid-js';
import { A } from '@solidjs/router';

export default function Home() {
  const [open, setOpen] = createSignal(false);
  const items = ['a', 'b'];
  return (
    <main class="mx-auto max-w-4xl p-8">
      <h1 class="text-4xl font-bold">Welcome to Acme</h1>
      <A href="/about" class="text-blue-600">About us</A>
      <Show when={open()} fallback={<p>Closed</p>}>
        <p>Open</p>
      </Show>
      <ul>
        <For each={items}>{(it) => <li class="py-1">{it}</li>}</For>
      </ul>
      <button class="rounded border px-3" onClick={() => setOpen(!open())}>Toggle</button>
    </main>
  );
}
`,
  'src/pages/About.tsx': `export default function About() {\n  return (\n    <section class="p-8">\n      <h1 class="text-2xl font-bold">About</h1>\n    </section>\n  );\n}\n`,
};

/** A hand-written static site: shared nav, linked stylesheet, scripts, a table. */
export const HTML_REPO: Record<string, string> = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Acme</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <nav class="nav">
    <a href="index.html" class="nav-link">Home</a>
    <a href="about.html" class="nav-link">About</a>
  </nav>
  <main class="hero">
    <!-- hero -->
    <h1 class="title">Welcome to Acme</h1>
    <p class="lead">Everything &amp; more, in one place.</p>
    <a href="about.html" class="btn">Learn more</a>
    <table class="prices"><tr><td>Basic</td><td>$9</td></tr></table>
    <ul>
      <li>Fast
      <li>Simple
    </ul>
  </main>
  <footer class="footer">© Acme</footer>
  <script src="js/app.js"></script>
</body>
</html>
`,
  'about.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>About · Acme</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <nav class="nav">
    <a href="index.html" class="nav-link">Home</a>
    <a href="about.html" class="nav-link">About</a>
  </nav>
  <section>
    <h1>About us</h1>
    <p>We build things.</p>
  </section>
</body>
</html>
`,
  'css/style.css': 'body { margin: 0; font-family: Georgia, serif; }\n.nav { display: flex; gap: 1rem; }\n.btn { background: #222; color: #fff; padding: .5rem 1rem; }\n',
  'js/app.js': "console.log('hi')\n",
  'README.md': '# Acme site\n',
};
