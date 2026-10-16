import type { BuilderProject } from '../types.ts'
import { defaultProjectFor } from './project.ts'
import { generateSingleVariant } from './design-generator.ts'
import type { CanvasNode, ProjectFile } from './builder-types.ts'
import { modalNode, n } from './blueprints.ts'
import { instanceOf } from './studio.ts'
import { SAMPLE_CUSTOMERS, SAMPLE_ORDERS } from './sample-data.ts'
import type { StarterId } from './starter-list.ts'

/**
 * Starter APPS — several linked pages, a shared component, data-bound tables
 * and working interactions — so a new project demonstrates the whole studio.
 * Imported lazily (it pulls the offline design generator).
 */

const BTN = 'inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-10 px-4 text-sm font-medium shadow-sm'
const BTN_OUT = 'inline-flex items-center justify-center rounded-md border border-input bg-background h-10 px-4 text-sm font-medium'
const INPUT = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground'

const go = (node: CanvasNode, pageId: string): CanvasNode => ({ ...node, interactions: [{ trigger: 'click', action: 'navigate', targetPageId: pageId }] })
const field = (label: string, input: CanvasNode) => n('flex-col', 'flex flex-col gap-1.5', undefined, [n('label-el', 'text-sm font-medium', label), input])
const page = (id: string, name: string, route: string, nodes: CanvasNode[], home = false): ProjectFile =>
  ({ id, name: `${name}.tsx`, type: 'file', language: 'tsx', nodes, route, ...(home ? { home: true } : {}) })
const symbol = (id: string, name: string, node: CanvasNode): ProjectFile => ({ id, name: `${name}.tsx`, type: 'file', language: 'tsx', nodes: [node], symbol: true })
const data = (id: string, name: string, json: string): ProjectFile => ({ id, name: `${name}.json`, type: 'file', language: 'json', content: json })

function sidebar(brand: string, links: Array<[string, string]>, activeFirst = true): CanvasNode {
  return n('sidebar', 'w-60 shrink-0 min-h-[640px] border-r border-border bg-card p-4 flex flex-col gap-1', undefined, [
    n('span', 'px-3 pb-4 text-base font-bold', brand),
    ...links.map(([label, pageId], i) => go(n('menu-item', `flex items-center rounded-md px-3 py-2 text-sm cursor-pointer ${i === 0 && activeFirst ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'}`, label), pageId)),
  ])
}

function withFolders(base: BuilderProject, pages: ProjectFile[], symbols: ProjectFile[], sources: ProjectFile[]): BuilderProject {
  const fill = (fs: ProjectFile[]): ProjectFile[] => fs.map((f) => {
    if (f.id === 'f_pages') return { ...f, children: pages }
    if (f.id === 'f_symbols') return { ...f, children: symbols }
    if (f.id === 'f_data') return { ...f, children: sources }
    return f.children ? { ...f, children: fill(f.children) } : f
  })
  return { ...base, files: fill(base.files) }
}

function crud(base: BuilderProject): BuilderProject {
  const LIST = 'f_page_customers', NEW = 'f_page_new', SIDEBAR = 'f_sym_sidebar', DATA = 'f_data_customers'
  const confirm = modalNode('Delete customer?')
  confirm.componentName = 'Delete dialog'
  const row = n('grid', 'grid grid-cols-[1.5fr_2fr_1fr_1fr_auto] items-center gap-4 px-4 py-3 text-sm', undefined, [
    n('span', 'font-medium', '{{name}}'),
    n('span', 'text-muted-foreground', '{{email}}'),
    n('span', 'text-muted-foreground', '{{plan}}'),
    n('badge', 'inline-flex w-fit items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium', '{{status}}'),
    { ...n('link', 'text-sm text-destructive cursor-pointer', 'Delete'), interactions: [{ trigger: 'click', action: 'toggle-visibility', targetNodeId: confirm.id }] },
  ])
  const rows = { ...n('flex-col', 'flex flex-col divide-y divide-border'), children: [row], bind: { source: DATA } }
  const list = page(LIST, 'Customers', '/', [
    n('flex', 'flex', undefined, [
      instanceOf(SIDEBAR),
      n('flex-col', 'flex-1 flex flex-col gap-6 p-8', undefined, [
        n('flex', 'flex items-center justify-between', undefined, [
          n('flex-col', 'flex flex-col gap-1', undefined, [n('h1', 'text-2xl font-bold', 'Customers'), n('p', 'text-sm text-muted-foreground', 'Everyone with an active account.')]),
          go(n('button', BTN, '+ New customer'), NEW),
        ]),
        n('input', `${INPUT} max-w-sm`, undefined, [], { placeholder: 'Search customers…', inputType: 'search' }),
        n('card', 'rounded-xl border border-border bg-card overflow-hidden', undefined, [
          n('grid', 'grid grid-cols-[1.5fr_2fr_1fr_1fr_auto] gap-4 px-4 py-2.5 bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground', undefined,
            ['Name', 'Email', 'Plan', 'Status', ''].map((h) => n('span', '', h))),
          rows,
        ]),
      ]),
    ]),
    confirm,
  ], true)
  const form = page(NEW, 'NewCustomer', '/customers/new', [
    n('flex', 'flex', undefined, [
      instanceOf(SIDEBAR),
      n('flex-col', 'flex-1 flex flex-col gap-6 p-8', undefined, [
        n('flex', 'flex items-center gap-1.5 text-sm text-muted-foreground', undefined, [go(n('link', 'hover:text-foreground cursor-pointer', 'Customers'), LIST), n('span', '', '/'), n('span', 'text-foreground font-medium', 'New')]),
        n('h1', 'text-2xl font-bold', 'New customer'),
        n('form', 'flex flex-col gap-4 max-w-lg rounded-xl border border-border bg-card p-6', undefined, [
          field('Full name', n('input', INPUT, undefined, [], { placeholder: 'Ada Lovelace', required: true })),
          field('Email', n('input', INPUT, undefined, [], { placeholder: 'ada@example.com', inputType: 'email', required: true })),
          field('Company', n('input', INPUT, undefined, [], { placeholder: 'Analytical Engines' })),
          field('Plan', n('select', INPUT, undefined, [], { options: ['Starter', 'Team', 'Enterprise'] })),
          n('checkbox', 'flex items-center gap-2 text-sm', 'Send a welcome email'),
          n('flex', 'flex justify-end gap-2', undefined, [go(n('btn-outline', BTN_OUT, 'Cancel'), LIST), n('button', BTN, 'Create customer')]),
        ]),
      ]),
    ]),
  ])
  return withFolders(base, [list, form], [symbol(SIDEBAR, 'AppSidebar', sidebar('Acme Admin', [['Customers', LIST], ['New customer', NEW]]))], [data(DATA, 'customers', SAMPLE_CUSTOMERS)])
}

function dashboard(base: BuilderProject): BuilderProject {
  const DASH = 'f_page_dashboard', SETTINGS = 'f_page_settings', SIDEBAR = 'f_sym_sidebar', ORDERS = 'f_data_orders'
  const stat = (label: string, value: string, delta: string) => n('card', 'rounded-xl border border-border bg-card p-5 flex flex-col gap-1', undefined, [n('p', 'text-sm text-muted-foreground', label), n('h3', 'text-2xl font-bold', value), n('span', 'text-xs font-medium text-primary', delta)])
  const orderRow = n('grid', 'grid grid-cols-4 gap-4 px-4 py-3 text-sm', undefined, [n('span', 'font-mono text-xs', '{{id}}'), n('span', 'font-medium', '{{customer}}'), n('span', '', '{{total}}'), n('badge', 'inline-flex w-fit rounded-full bg-secondary px-2 py-0.5 text-xs font-medium', '{{status}}')])
  const dash = page(DASH, 'Dashboard', '/', [
    n('flex', 'flex', undefined, [
      instanceOf(SIDEBAR),
      n('flex-col', 'flex-1 flex flex-col gap-6 p-8', undefined, [
        n('h1', 'text-2xl font-bold', 'Good morning'),
        n('grid', 'grid grid-cols-4 gap-4', undefined, [stat('Revenue', '$48,210', '+12.4%'), stat('Orders', '1,284', '+3.1%'), stat('Customers', '342', '+18'), stat('Refunds', '0.8%', '-0.2%')]),
        n('card', 'rounded-xl border border-border bg-card p-5 flex flex-col gap-3', undefined, [
          n('h3', 'text-sm font-semibold', 'Revenue this week'),
          n('flex', 'flex items-end gap-2 h-40', undefined, ['h-[40%]', 'h-[65%]', 'h-[52%]', 'h-[80%]', 'h-[72%]', 'h-[95%]', 'h-[60%]'].map((h) => n('div', `flex-1 rounded-t-md bg-primary/80 ${h}`))),
        ]),
        n('card', 'rounded-xl border border-border bg-card overflow-hidden', undefined, [
          n('grid', 'grid grid-cols-4 gap-4 px-4 py-2.5 bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground', undefined, ['Order', 'Customer', 'Total', 'Status'].map((h) => n('span', '', h))),
          { ...n('flex-col', 'flex flex-col divide-y divide-border'), children: [orderRow], bind: { source: ORDERS } },
        ]),
      ]),
    ]),
  ], true)
  const settings = page(SETTINGS, 'Settings', '/settings', [
    n('flex', 'flex', undefined, [
      instanceOf(SIDEBAR),
      n('flex-col', 'flex-1 flex flex-col gap-6 p-8', undefined, [
        n('h1', 'text-2xl font-bold', 'Settings'),
        n('form', 'flex flex-col gap-4 max-w-lg rounded-xl border border-border bg-card p-6', undefined, [
          field('Workspace name', n('input', INPUT, undefined, [], { placeholder: 'Acme', required: true })),
          field('Billing email', n('input', INPUT, undefined, [], { placeholder: 'billing@acme.io', inputType: 'email', required: true })),
          n('switch', 'flex items-center gap-2 text-sm', 'Weekly summary email'),
          n('flex', 'flex justify-end', undefined, [n('button', BTN, 'Save changes')]),
        ]),
      ]),
    ]),
  ])
  return withFolders(base, [dash, settings], [symbol(SIDEBAR, 'AppSidebar', sidebar('Acme', [['Dashboard', DASH], ['Settings', SETTINGS]]))], [data(ORDERS, 'orders', SAMPLE_ORDERS)])
}

/** Wire generated marketing nodes: buttons/links whose text names a page navigate to it. */
function linkByText(nodes: CanvasNode[], rules: Array<[RegExp, string]>): CanvasNode[] {
  return nodes.map((node) => {
    const text = typeof node.props?.children === 'string' ? node.props.children : ''
    const rule = !node.interactions?.length && text ? rules.find(([re]) => re.test(text)) : undefined
    const next = rule ? go(node, rule[1]) : node
    return { ...next, children: linkByText(next.children, rules) }
  })
}

function landing(base: BuilderProject): BuilderProject {
  const HOME = 'f_page_home', PRICING = 'f_page_pricing', CONTACT = 'f_page_contact'
  const rules: Array<[RegExp, string]> = [[/^pricing$/i, PRICING], [/contact|book a demo|talk to sales/i, CONTACT], [/^(home|product)$/i, HOME]]
  const home = page(HOME, 'Home', '/', linkByText(generateSingleVariant('SaaS landing page with hero, features and testimonials', 'modern').nodes, rules), true)
  const pricing = page(PRICING, 'Pricing', '/pricing', linkByText(generateSingleVariant('pricing page with three plans', 'modern').nodes, rules))
  const contact = page(CONTACT, 'Contact', '/contact', [
    n('section', 'mx-auto max-w-xl py-16 px-6 flex flex-col gap-6', undefined, [
      go(n('link', 'text-sm text-muted-foreground hover:text-foreground cursor-pointer', '← Back to home'), HOME),
      n('h1', 'text-3xl font-bold tracking-tight', 'Talk to us'),
      n('p', 'text-muted-foreground', 'Tell us about your team and we will get back within one business day.'),
      n('form', 'flex flex-col gap-4', undefined, [
        field('Name', n('input', INPUT, undefined, [], { placeholder: 'Your name', required: true })),
        field('Work email', n('input', INPUT, undefined, [], { placeholder: 'you@company.com', inputType: 'email', required: true })),
        field('Message', n('textarea', `${INPUT} min-h-[120px]`, undefined, [], { placeholder: 'How can we help?' })),
        n('button', BTN, 'Send message'),
      ]),
    ]),
  ])
  return withFolders(base, [home, pricing, contact], [], [])
}

function auth(base: BuilderProject): BuilderProject {
  const SIGNIN = 'f_page_signin', SIGNUP = 'f_page_signup', APP = 'f_page_app'
  const card = (children: CanvasNode[]) => n('flex', 'min-h-[640px] flex items-center justify-center bg-muted/40 p-6', undefined, [
    n('card', 'w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm flex flex-col gap-5', undefined, children),
  ])
  const signin = page(SIGNIN, 'SignIn', '/', [card([
    n('flex-col', 'flex flex-col gap-1 text-center', undefined, [n('h1', 'text-2xl font-bold', 'Welcome back'), n('p', 'text-sm text-muted-foreground', 'Sign in to your account')]),
    n('form', 'flex flex-col gap-4', undefined, [
      field('Email', n('input', INPUT, undefined, [], { placeholder: 'you@company.com', inputType: 'email', required: true })),
      field('Password', n('input', INPUT, undefined, [], { placeholder: '••••••••', inputType: 'password', required: true })),
      n('checkbox', 'flex items-center gap-2 text-sm', 'Remember me'),
      go(n('button', `${BTN} w-full`, 'Sign in'), APP),
    ]),
    n('flex', 'flex justify-center gap-1 text-sm text-muted-foreground', undefined, [n('span', '', 'No account?'), go(n('link', 'font-medium text-primary cursor-pointer', 'Create one'), SIGNUP)]),
  ])], true)
  const signup = page(SIGNUP, 'SignUp', '/sign-up', [card([
    n('flex-col', 'flex flex-col gap-1 text-center', undefined, [n('h1', 'text-2xl font-bold', 'Create your account'), n('p', 'text-sm text-muted-foreground', 'Free for 14 days, no card needed')]),
    n('form', 'flex flex-col gap-4', undefined, [
      field('Full name', n('input', INPUT, undefined, [], { placeholder: 'Ada Lovelace', required: true })),
      field('Email', n('input', INPUT, undefined, [], { placeholder: 'you@company.com', inputType: 'email', required: true })),
      field('Password', n('input', INPUT, undefined, [], { placeholder: 'At least 8 characters', inputType: 'password', required: true })),
      n('button', `${BTN} w-full`, 'Create account'),
    ]),
    n('flex', 'flex justify-center gap-1 text-sm text-muted-foreground', undefined, [n('span', '', 'Have an account?'), go(n('link', 'font-medium text-primary cursor-pointer', 'Sign in'), SIGNIN)]),
  ])])
  const app = page(APP, 'Home', '/app', [
    n('nav', 'flex items-center justify-between h-16 px-6 border-b border-border', undefined, [n('span', 'text-lg font-bold', 'Acme'), go(n('btn-outline', BTN_OUT, 'Sign out'), SIGNIN)]),
    n('section', 'p-10 flex flex-col gap-2', undefined, [n('h1', 'text-3xl font-bold', 'You are signed in'), n('p', 'text-muted-foreground', 'Replace this page with your product.')]),
  ])
  return withFolders(base, [signin, signup, app], [], [])
}

export function createStarterProject(opts: { name: string; starter: StarterId; theme?: string }): BuilderProject {
  const base = defaultProjectFor('visual', opts.name)
  if (opts.theme) base.settings = { ...base.settings, theme: opts.theme }
  switch (opts.starter) {
    case 'crud': return crud(base)
    case 'dashboard': return dashboard(base)
    case 'landing': return landing(base)
    case 'auth': return auth(base)
    default: return base
  }
}
