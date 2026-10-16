import { useState, type ReactNode } from 'react'
import {
  AreaChart,
  Badge,
  BarChart,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  DataTable,
  DonutGauge,
  EmptyState,
  Field,
  Input,
  Kbd,
  LegendDot,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Separator,
  Skeleton,
  Sparkline,
  Spinner,
  StatusBadge,
  Tabs,
  Textarea,
  TimeSeriesChart,
  useToast,
} from '@adhar/shell-ui'

/**
 * The Component Catalog's registry: the REAL `@adhar/shell-ui` components,
 * rendered live — not screenshots. Each entry documents its props, offers a
 * playground (controls → live render → generated JSX) and worked examples.
 *
 * Add a component here when it is exported from shell-ui and used by pages.
 */

export type Category = 'Actions' | 'Forms' | 'Feedback' | 'Data display' | 'Layout' | 'Overlays' | 'Charts'

export const CATEGORIES: Category[] = ['Actions', 'Forms', 'Feedback', 'Data display', 'Layout', 'Overlays', 'Charts']

export interface PropDoc {
  name: string
  type: string
  default?: string
  description: string
}

export type Control =
  | { key: string; label: string; type: 'select'; options: string[]; default: string }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'text'; default: string }
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number }

export type Values = Record<string, string | boolean | number>

export interface Example {
  title: string
  description?: string
  render(): ReactNode
  code: string
}

export interface CatalogEntry {
  id: string
  name: string
  category: Category
  description: string
  /** Named exports to import from `@adhar/shell-ui`. */
  imports: string[]
  props: PropDoc[]
  controls?: Control[]
  render?(v: Values): ReactNode
  code?(v: Values): string
  examples: Example[]
  /** Usage guidance — do / don't. */
  guidance?: string[]
}

/* ─── jsx code helper ─── */

function attrs(v: Values, defaults: Values, order: string[]): string {
  const out: string[] = []
  for (const k of order) {
    const val = v[k]
    if (val === defaults[k]) continue
    if (typeof val === 'boolean') out.push(val ? k : `${k}={false}`)
    else if (typeof val === 'number') out.push(`${k}={${val}}`)
    else out.push(`${k}="${val}"`)
  }
  return out.length ? ' ' + out.join(' ') : ''
}

function defaultsOf(controls: Control[]): Values {
  return Object.fromEntries(controls.map((c) => [c.key, c.default]))
}

/* ─── stateful example helpers ─── */

function ModalDemo({ width = 'md' as 'sm' | 'md' | 'lg' | 'xl', branded = false }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>Open dialog</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create service"
        description="Services are deployed from a template."
        width={width}
        branded={branded}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={() => setOpen(false)}>Create</Button>
          </>
        }
      >
        <Field label="Name" required>
          <Input placeholder="payments-api" />
        </Field>
      </Modal>
    </>
  )
}

function ToastDemo() {
  const toast = useToast()
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => toast.success('Changes saved')}>Success</Button>
      <Button size="sm" onClick={() => toast.error('Could not save', { description: 'The server returned 503.' })}>Error</Button>
      <Button size="sm" onClick={() => toast.warning('Quota at 85%')}>Warning</Button>
      <Button size="sm" onClick={() => toast.info('Deployment queued', { action: { label: 'View', onClick: () => {} } })}>With action</Button>
      <Button
        size="sm"
        onClick={() =>
          void toast.promise(new Promise((r) => setTimeout(r, 1200)), {
            loading: 'Deploying…',
            success: 'Deployed',
          })}
      >
        Promise
      </Button>
    </div>
  )
}

function SearchDemo() {
  const [q, setQ] = useState('')
  return <SearchInput value={q} onChange={setQ} placeholder="Search services…" shortcut={false} className="max-w-xs" />
}

function TabsDemo({ vertical = false }) {
  const [tab, setTab] = useState<'overview' | 'logs' | 'settings'>('overview')
  return (
    <Tabs<'overview' | 'logs' | 'settings'>
      orientation={vertical ? 'vertical' : 'horizontal'}
      value={tab}
      onChange={setTab}
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'logs', label: 'Logs', badge: '12' },
        { id: 'settings', label: 'Settings' },
      ]}
    >
      {(id) => <div className="p-3 text-sm text-content-muted">Content for “{id}”.</div>}
    </Tabs>
  )
}

interface Svc {
  name: string
  owner: string
  status: 'healthy' | 'degraded'
  rps: number
}
const SERVICES: Svc[] = [
  { name: 'payments-api', owner: 'Payments', status: 'healthy', rps: 412 },
  { name: 'ledger', owner: 'Payments', status: 'degraded', rps: 96 },
  { name: 'search', owner: 'Discovery', status: 'healthy', rps: 1280 },
]

const now = Date.parse('2026-10-17T12:00:00Z')
const SERIES = Array.from({ length: 24 }, (_, i) => [now - (23 - i) * 3_600_000, 40 + Math.round(20 * Math.sin(i / 3) + i)] as [number, number])
const SERIES_B = SERIES.map(([t, v]) => [t, Math.round(v * 0.6)] as [number, number])

/* ─── registry ─── */

const buttonControls: Control[] = [
  { key: 'variant', label: 'Variant', type: 'select', options: ['primary', 'secondary', 'ghost', 'danger', 'link'], default: 'secondary' },
  { key: 'size', label: 'Size', type: 'select', options: ['xs', 'sm', 'md', 'lg'], default: 'md' },
  { key: 'loading', label: 'Loading', type: 'boolean', default: false },
  { key: 'disabled', label: 'Disabled', type: 'boolean', default: false },
  { key: 'block', label: 'Full width', type: 'boolean', default: false },
  { key: 'label', label: 'Label', type: 'text', default: 'Deploy' },
]

const badgeControls: Control[] = [
  { key: 'tone', label: 'Tone', type: 'select', options: ['slate', 'brand', 'emerald', 'rose', 'amber', 'indigo', 'sky', 'violet'], default: 'slate' },
  { key: 'label', label: 'Label', type: 'text', default: 'v1.4.2' },
]

const statusControls: Control[] = [
  { key: 'kind', label: 'Kind', type: 'select', options: ['healthy', 'degraded', 'progressing', 'paused', 'failed', 'unknown', 'info'], default: 'healthy' },
  { key: 'dot', label: 'Dot', type: 'boolean', default: true },
  { key: 'label', label: 'Label', type: 'text', default: 'Healthy' },
]

const inputControls: Control[] = [
  { key: 'placeholder', label: 'Placeholder', type: 'text', default: 'payments-api' },
  { key: 'invalid', label: 'Invalid', type: 'boolean', default: false },
  { key: 'disabled', label: 'Disabled', type: 'boolean', default: false },
]

const emptyControls: Control[] = [
  { key: 'title', label: 'Title', type: 'text', default: 'No services yet' },
  { key: 'description', label: 'Description', type: 'text', default: 'Create a service from a template to get started.' },
  { key: 'compact', label: 'Compact', type: 'boolean', default: false },
  { key: 'action', label: 'With action', type: 'boolean', default: true },
]

const donutControls: Control[] = [
  { key: 'value', label: 'Value', type: 'number', default: 72, min: 0, max: 100 },
  { key: 'size', label: 'Size', type: 'number', default: 120, min: 60, max: 200 },
  { key: 'thickness', label: 'Thickness', type: 'number', default: 12, min: 4, max: 24 },
]

export const CATALOG: CatalogEntry[] = [
  {
    id: 'button',
    name: 'Button',
    category: 'Actions',
    description: 'Triggers an action. Defaults to the secondary variant — pass variant="primary" for the one main action on a surface.',
    imports: ['Button'],
    props: [
      { name: 'variant', type: "'primary' | 'secondary' | 'ghost' | 'danger' | 'link'", default: "'secondary'", description: 'Visual weight. One primary per surface.' },
      { name: 'size', type: "'xs' | 'sm' | 'md' | 'lg'", default: "'md'", description: 'Height; sm and up grow to 44px on touch pointers.' },
      { name: 'loading', type: 'boolean', default: 'false', description: 'Shows a spinner and disables the button.' },
      { name: 'leading / trailing', type: 'ReactNode', description: 'Icons before / after the label.' },
      { name: 'block', type: 'boolean', default: 'false', description: 'Full width.' },
      { name: '...rest', type: 'ButtonHTMLAttributes', description: 'Any native button attribute (onClick, disabled, type…).' },
    ],
    controls: buttonControls,
    render: (v) => (
      <Button
        variant={v.variant as 'primary'}
        size={v.size as 'md'}
        loading={!!v.loading}
        disabled={!!v.disabled}
        block={!!v.block}
      >
        {String(v.label)}
      </Button>
    ),
    code: (v) =>
      `<Button${attrs(v, defaultsOf(buttonControls), ['variant', 'size', 'loading', 'disabled', 'block'])}>${v.label}</Button>`,
    examples: [
      {
        title: 'Variants',
        render: () => (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Delete</Button>
            <Button variant="link">Link</Button>
          </div>
        ),
        code: `<Button variant="primary">Primary</Button>
<Button>Secondary</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="danger">Delete</Button>
<Button variant="link">Link</Button>`,
      },
      {
        title: 'Sizes',
        render: () => (
          <div className="flex flex-wrap items-center gap-2">
            {(['xs', 'sm', 'md', 'lg'] as const).map((s) => <Button key={s} size={s}>Size {s}</Button>)}
          </div>
        ),
        code: `<Button size="xs">Size xs</Button>
<Button size="sm">Size sm</Button>
<Button size="md">Size md</Button>
<Button size="lg">Size lg</Button>`,
      },
      {
        title: 'Page header actions',
        description: 'Secondary actions first, the primary action last (rightmost).',
        render: () => (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost">Export</Button>
            <Button size="sm" variant="primary">New service</Button>
          </div>
        ),
        code: `<Button size="sm" variant="ghost">Export</Button>
<Button size="sm" variant="primary">New service</Button>`,
      },
    ],
    guidance: [
      'Use one primary button per view — usually the create / confirm action at the right of the header.',
      'Report the outcome of an action with a toast, not inline text next to the button.',
      'Prefer `loading` over disabling + a separate spinner while an action runs.',
    ],
  },
  {
    id: 'badge',
    name: 'Badge',
    category: 'Data display',
    description: 'A small label for metadata — versions, counts, categories.',
    imports: ['Badge'],
    props: [
      { name: 'tone', type: "'slate' | 'brand' | 'emerald' | 'rose' | 'amber' | 'indigo' | 'sky' | 'violet'", default: "'slate'", description: 'Colour family; adapts to dark mode.' },
      { name: 'children', type: 'ReactNode', description: 'Label.' },
    ],
    controls: badgeControls,
    render: (v) => <Badge tone={v.tone as 'slate'}>{String(v.label)}</Badge>,
    code: (v) => `<Badge${attrs(v, defaultsOf(badgeControls), ['tone'])}>${v.label}</Badge>`,
    examples: [
      {
        title: 'Tones',
        render: () => (
          <div className="flex flex-wrap gap-1.5">
            {(['slate', 'brand', 'emerald', 'rose', 'amber', 'indigo', 'sky', 'violet'] as const).map((t) => <Badge key={t} tone={t}>{t}</Badge>)}
          </div>
        ),
        code: `<Badge tone="emerald">emerald</Badge>`,
      },
    ],
  },
  {
    id: 'status-badge',
    name: 'StatusBadge',
    category: 'Feedback',
    description: 'The health / lifecycle state of a resource. Progressing pulses by default.',
    imports: ['StatusBadge'],
    props: [
      { name: 'kind', type: "'healthy' | 'degraded' | 'progressing' | 'paused' | 'failed' | 'unknown' | 'info'", description: 'State.' },
      { name: 'dot', type: 'boolean', default: 'true', description: 'Leading dot.' },
      { name: 'pulse', type: 'boolean', default: "kind === 'progressing'", description: 'Animate the dot.' },
    ],
    controls: statusControls,
    render: (v) => <StatusBadge kind={v.kind as 'healthy'} dot={!!v.dot}>{String(v.label)}</StatusBadge>,
    code: (v) => `<StatusBadge kind="${v.kind}"${v.dot ? '' : ' dot={false}'}>${v.label}</StatusBadge>`,
    examples: [
      {
        title: 'All states',
        render: () => (
          <div className="flex flex-wrap gap-1.5">
            {(['healthy', 'degraded', 'progressing', 'paused', 'failed', 'unknown', 'info'] as const).map((k) => <StatusBadge key={k} kind={k}>{k}</StatusBadge>)}
          </div>
        ),
        code: `<StatusBadge kind="progressing">Syncing</StatusBadge>`,
      },
    ],
  },
  {
    id: 'input',
    name: 'Input',
    category: 'Forms',
    description: 'Single-line text input with optional leading / trailing adornments.',
    imports: ['Input', 'Field'],
    props: [
      { name: 'invalid', type: 'boolean', default: 'false', description: 'Error styling.' },
      { name: 'leading / trailing', type: 'ReactNode', description: 'Adornments inside the field.' },
      { name: '...rest', type: 'InputHTMLAttributes', description: 'Any native input attribute.' },
    ],
    controls: inputControls,
    render: (v) => (
      <div className="w-72">
        <Input placeholder={String(v.placeholder)} invalid={!!v.invalid} disabled={!!v.disabled} />
      </div>
    ),
    code: (v) => `<Input${attrs(v, { ...defaultsOf(inputControls), placeholder: '' }, ['placeholder', 'invalid', 'disabled'])} />`,
    examples: [
      {
        title: 'In a field with label, hint and error',
        render: () => (
          <div className="grid w-full max-w-md gap-4">
            <Field label="Service name" hint="lowercase, dashes" required>
              <Input placeholder="payments-api" />
            </Field>
            <Field label="Port" error="Port must be between 1 and 65535">
              <Input invalid defaultValue="70000" />
            </Field>
          </div>
        ),
        code: `<Field label="Service name" hint="lowercase, dashes" required>
  <Input placeholder="payments-api" />
</Field>
<Field label="Port" error="Port must be between 1 and 65535">
  <Input invalid defaultValue="70000" />
</Field>`,
      },
      {
        title: 'With adornments',
        render: () => (
          <div className="w-72">
            <Input leading={<span className="text-xs">https://</span>} placeholder="example.com" />
          </div>
        ),
        code: `<Input leading={<span>https://</span>} placeholder="example.com" />`,
      },
    ],
  },
  {
    id: 'select',
    name: 'Select',
    category: 'Forms',
    description: 'Native select styled to match inputs. Pass `options` or `<option>` children.',
    imports: ['Select'],
    props: [
      { name: 'options', type: 'SelectOption[]', description: '`{ value, label }` list (alternative to children).' },
      { name: 'invalid', type: 'boolean', default: 'false', description: 'Error styling.' },
      { name: 'wrapperClassName', type: 'string', description: 'Classes for the positioning wrapper (e.g. flex-1).' },
    ],
    examples: [
      {
        title: 'Options',
        render: () => (
          <div className="w-60">
            <Select options={[{ value: 'dev', label: 'Development' }, { value: 'stg', label: 'Staging' }, { value: 'prd', label: 'Production' }]} />
          </div>
        ),
        code: `<Select options={[
  { value: 'dev', label: 'Development' },
  { value: 'prd', label: 'Production' },
]} />`,
      },
    ],
  },
  {
    id: 'textarea',
    name: 'Textarea',
    category: 'Forms',
    description: 'Multi-line text input; vertically resizable.',
    imports: ['Textarea'],
    props: [
      { name: 'invalid', type: 'boolean', default: 'false', description: 'Error styling.' },
      { name: '...rest', type: 'TextareaHTMLAttributes', description: 'rows, placeholder, value…' },
    ],
    examples: [
      {
        title: 'Basic',
        render: () => <Textarea rows={3} placeholder="Describe the change…" className="max-w-md" />,
        code: `<Textarea rows={3} placeholder="Describe the change…" />`,
      },
    ],
  },
  {
    id: 'checkbox',
    name: 'Checkbox',
    category: 'Forms',
    description: 'A labelled checkbox with optional description.',
    imports: ['Checkbox'],
    props: [
      { name: 'label', type: 'ReactNode', description: 'Label text.' },
      { name: 'description', type: 'ReactNode', description: 'Helper text under the label.' },
    ],
    examples: [
      {
        title: 'With description',
        render: () => <Checkbox label="Auto-sync" description="Apply changes as soon as they land on main." defaultChecked />,
        code: `<Checkbox label="Auto-sync" description="Apply changes as soon as they land on main." defaultChecked />`,
      },
    ],
  },
  {
    id: 'search-input',
    name: 'SearchInput',
    category: 'Forms',
    description: 'The console search field, with a “/” focus shortcut and clear button.',
    imports: ['SearchInput'],
    props: [
      { name: 'value / onChange', type: 'string / (v: string) => void', description: 'Controlled value.' },
      { name: 'shortcut', type: 'string | false', default: "'/'", description: 'Key that focuses the field.' },
      { name: 'block', type: 'boolean', default: 'true', description: 'Fill available width.' },
    ],
    examples: [{ title: 'Controlled', render: () => <SearchDemo />, code: `const [q, setQ] = useState('')\n<SearchInput value={q} onChange={setQ} placeholder="Search services…" />` }],
  },
  {
    id: 'toast',
    name: 'Toast (useToast)',
    category: 'Feedback',
    description: 'The one way to report an action’s outcome. Stacks bottom-right, supports actions (Undo) and promise tracking.',
    imports: ['useToast'],
    props: [
      { name: 'success / error / warning / info', type: '(title, opts?) => id', description: 'Show a toast of that kind.' },
      { name: 'opts.description', type: 'ReactNode', description: 'Second line.' },
      { name: 'opts.action', type: '{ label, onClick }', description: 'A button, e.g. Undo.' },
      { name: 'promise', type: '(p, { loading, success, error })', description: 'Loading → success | error, in place.' },
    ],
    examples: [
      {
        title: 'Kinds',
        render: () => <ToastDemo />,
        code: `const toast = useToast()
toast.success('Changes saved')
toast.error('Could not save', { description: err.message })
toast.info('Deleted', { action: { label: 'Undo', onClick: restore } })
toast.promise(deploy(), { loading: 'Deploying…', success: 'Deployed' })`,
      },
    ],
    guidance: ['Never render “Saved.” style inline text — use a toast.', 'Offer Undo for destructive actions instead of a confirm dialog where possible.'],
  },
  {
    id: 'empty-state',
    name: 'EmptyState',
    category: 'Feedback',
    description: 'What a list shows when it has nothing — say why and offer the next step.',
    imports: ['EmptyState', 'Button'],
    props: [
      { name: 'title', type: 'string', description: 'What is empty.' },
      { name: 'description', type: 'ReactNode', description: 'Why, and what to do.' },
      { name: 'action', type: 'ReactNode', description: 'Usually a primary button.' },
      { name: 'icon', type: 'ReactNode', description: 'Replaces the default icon.' },
      { name: 'compact', type: 'boolean', default: 'false', description: 'Smaller, for inside tables / panels.' },
    ],
    controls: emptyControls,
    render: (v) => (
      <EmptyState
        className="w-full"
        title={String(v.title)}
        description={String(v.description)}
        compact={!!v.compact}
        action={v.action ? <Button size="sm" variant="primary">New service</Button> : undefined}
      />
    ),
    code: (v) =>
      `<EmptyState\n  title="${v.title}"\n  description="${v.description}"${v.compact ? '\n  compact' : ''}${
        v.action ? '\n  action={<Button size="sm" variant="primary">New service</Button>}' : ''
      }\n/>`,
    examples: [],
  },
  {
    id: 'spinner',
    name: 'Spinner & Skeleton',
    category: 'Feedback',
    description: 'Loading indicators — Skeleton for content placeholders, Spinner for short waits.',
    imports: ['Spinner', 'Skeleton'],
    props: [
      { name: 'Spinner.size', type: 'number', default: '16', description: 'Pixel size.' },
      { name: 'Skeleton.width / height', type: 'number | string', description: 'Box size.' },
      { name: 'Skeleton.rounded', type: "'sm' | 'md' | 'lg' | 'full'", default: "'md'", description: 'Corner radius.' },
    ],
    examples: [
      {
        title: 'Loading row',
        render: () => (
          <div className="flex w-full max-w-md items-center gap-3">
            <Skeleton width={36} height={36} rounded="full" />
            <div className="flex-1 space-y-2">
              <Skeleton height={10} width="60%" />
              <Skeleton height={10} width="40%" />
            </div>
            <Spinner />
          </div>
        ),
        code: `<Skeleton width={36} height={36} rounded="full" />
<Skeleton height={10} width="60%" />
<Spinner />`,
      },
    ],
  },
  {
    id: 'card',
    name: 'Card',
    category: 'Layout',
    description: 'The surface for grouped content, with header / body / footer slots and three elevations.',
    imports: ['Card', 'CardHeader', 'CardBody', 'CardFooter'],
    props: [
      { name: 'elevation', type: "'flat' | 'raised' | 'float'", default: "'raised'", description: 'Shadow depth.' },
      { name: 'interactive', type: 'boolean', default: 'false', description: 'Hover lift for clickable cards.' },
      { name: 'as', type: "'div' | 'section' | 'article'", default: "'div'", description: 'Element.' },
    ],
    controls: [
      { key: 'elevation', label: 'Elevation', type: 'select', options: ['flat', 'raised', 'float'], default: 'raised' },
      { key: 'interactive', label: 'Interactive', type: 'boolean', default: false },
      { key: 'footer', label: 'Footer', type: 'boolean', default: true },
    ],
    render: (v) => (
      <Card elevation={v.elevation as 'raised'} interactive={!!v.interactive} className="w-80">
        <CardHeader>
          <div className="text-sm font-semibold text-content">payments-api</div>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-content-muted">Handles card payments and refunds.</p>
        </CardBody>
        {v.footer ? (
          <CardFooter>
            <Button size="sm" variant="primary" className="ml-auto">Open</Button>
          </CardFooter>
        ) : null}
      </Card>
    ),
    code: (v) =>
      `<Card${v.elevation !== 'raised' ? ` elevation="${v.elevation}"` : ''}${v.interactive ? ' interactive' : ''}>
  <CardHeader>payments-api</CardHeader>
  <CardBody>Handles card payments and refunds.</CardBody>${v.footer ? '\n  <CardFooter><Button size="sm" variant="primary">Open</Button></CardFooter>' : ''}
</Card>`,
    examples: [],
    guidance: ['Don’t wrap a whole page or a list in a card — lay grids and tables out directly.'],
  },
  {
    id: 'page-header',
    name: 'PageHeader',
    category: 'Layout',
    description: 'A page’s title row: title (and optional badge) on the left, actions on the right.',
    imports: ['PageHeader', 'Button'],
    props: [
      { name: 'title', type: 'ReactNode', description: 'Page title.' },
      { name: 'badge', type: 'ReactNode', description: 'Inline pill next to the title.' },
      { name: 'actions', type: 'ReactNode', description: 'Right-aligned buttons; primary last.' },
      { name: 'compact', type: 'boolean', default: 'false', description: 'Tighter bottom margin.' },
    ],
    examples: [
      {
        title: 'With actions',
        render: () => (
          <PageHeader
            compact
            className="w-full"
            title="Services"
            badge={<Badge tone="brand">12</Badge>}
            actions={
              <>
                <Button size="sm" variant="ghost">Export</Button>
                <Button size="sm" variant="primary">New service</Button>
              </>
            }
          />
        ),
        code: `<PageHeader
  title="Services"
  badge={<Badge tone="brand">12</Badge>}
  actions={<>
    <Button size="sm" variant="ghost">Export</Button>
    <Button size="sm" variant="primary">New service</Button>
  </>}
/>`,
      },
    ],
  },
  {
    id: 'tabs',
    name: 'Tabs',
    category: 'Layout',
    description: 'Switch between views of the same object. Horizontal or vertical (becomes a chip row on small screens).',
    imports: ['Tabs'],
    props: [
      { name: 'tabs', type: 'TabDef[]', description: '`{ id, label, badge?, disabled?, hidden? }`.' },
      { name: 'value / onChange', type: 'T / (id: T) => void', description: 'Controlled mode.' },
      { name: 'orientation', type: "'horizontal' | 'vertical'", default: "'horizontal'", description: 'Layout.' },
      { name: 'actions', type: 'ReactNode', description: 'Right-side actions (horizontal).' },
      { name: 'children', type: '(activeId) => ReactNode', description: 'Render the active panel.' },
    ],
    examples: [
      { title: 'Horizontal', render: () => <div className="w-full"><TabsDemo /></div>, code: `<Tabs value={tab} onChange={setTab} tabs={[\n  { id: 'overview', label: 'Overview' },\n  { id: 'logs', label: 'Logs', badge: '12' },\n]}>\n  {(id) => <Panel id={id} />}\n</Tabs>` },
      { title: 'Vertical', render: () => <div className="w-full"><TabsDemo vertical /></div>, code: `<Tabs orientation="vertical" … />` },
    ],
  },
  {
    id: 'separator-kbd',
    name: 'Separator & Kbd',
    category: 'Layout',
    description: 'A hairline divider, and keyboard-key hints.',
    imports: ['Separator', 'Kbd'],
    props: [
      { name: 'Separator.orientation', type: "'horizontal' | 'vertical'", default: "'horizontal'", description: 'Direction.' },
      { name: 'Kbd.size', type: "'xs' | 'sm'", default: "'sm'", description: 'Key size.' },
    ],
    examples: [
      {
        title: 'Shortcut hint',
        render: () => (
          <div className="flex h-6 items-center gap-3 text-sm text-content-muted">
            <span>Ask Assist <Kbd>⌘</Kbd> <Kbd>K</Kbd></span>
            <Separator orientation="vertical" />
            <span>Search <Kbd>/</Kbd></span>
          </div>
        ),
        code: `<Kbd>⌘</Kbd> <Kbd>K</Kbd>\n<Separator orientation="vertical" />`,
      },
    ],
  },
  {
    id: 'modal',
    name: 'Modal',
    category: 'Overlays',
    description: 'Centered dialog (bottom sheet on phones) with ESC-to-close, scroll lock and a footer slot.',
    imports: ['Modal', 'Button'],
    props: [
      { name: 'open / onClose', type: 'boolean / () => void', description: 'Controlled visibility.' },
      { name: 'title / description', type: 'ReactNode', description: 'Header text.' },
      { name: 'footer', type: 'ReactNode', description: 'Cancel + primary action, right-aligned.' },
      { name: 'width', type: "'sm' | 'md' | 'lg' | 'xl'", default: "'md'", description: 'Max width.' },
      { name: 'branded', type: 'boolean', default: 'false', description: 'Brand-tinted header for create flows.' },
    ],
    examples: [
      {
        title: 'Create dialog',
        render: () => <ModalDemo branded />,
        code: `<Modal
  open={open}
  onClose={() => setOpen(false)}
  title="Create service"
  branded
  footer={<>
    <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
    <Button variant="primary" size="sm" onClick={create}>Create</Button>
  </>}
>
  <Field label="Name" required><Input /></Field>
</Modal>`,
      },
    ],
  },
  {
    id: 'data-table',
    name: 'DataTable',
    category: 'Data display',
    description: 'Sortable, searchable, filterable table with column resize / reorder / visibility and CSV export.',
    imports: ['DataTable', 'StatusBadge', 'type Column'],
    props: [
      { name: 'columns', type: 'Column<T>[]', description: '`{ key, header, cell, value?, numeric?, filter? }`.' },
      { name: 'rows / rowKey', type: 'T[] / (row) => string', description: 'Data.' },
      { name: 'features', type: 'boolean | TableFeatures', description: 'Built-in toolbar: search, filters, columns, density, export.' },
      { name: 'tableId', type: 'string', description: 'Persists layout per browser.' },
      { name: 'onRowClick', type: '(row) => void', description: 'Row activation.' },
      { name: 'loading / empty', type: 'boolean / ReactNode', description: 'Skeleton rows / empty content.' },
    ],
    examples: [
      {
        title: 'Services',
        render: () => (
          <div className="w-full">
            <DataTable<Svc>
              rows={SERVICES}
              rowKey={(r) => r.name}
              features={{ search: true }}
              columns={[
                { key: 'name', header: 'Service', cell: (r) => <span className="font-medium">{r.name}</span>, pinned: true },
                { key: 'owner', header: 'Owner', cell: (r) => r.owner },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge kind={r.status}>{r.status}</StatusBadge>, value: (r) => r.status },
                { key: 'rps', header: 'Req/s', cell: (r) => r.rps.toLocaleString(), value: (r) => r.rps, numeric: true },
              ]}
            />
          </div>
        ),
        code: `<DataTable
  rows={services}
  rowKey={(r) => r.name}
  features={{ search: true }}
  columns={[
    { key: 'name', header: 'Service', cell: (r) => r.name, pinned: true },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge kind={r.status}>{r.status}</StatusBadge>, value: (r) => r.status },
    { key: 'rps', header: 'Req/s', cell: (r) => r.rps, numeric: true },
  ]}
/>`,
      },
    ],
  },
  {
    id: 'time-series',
    name: 'TimeSeriesChart',
    category: 'Charts',
    description: 'Metrics over time: gridlines, axes, several series, thresholds and a hover tooltip.',
    imports: ['TimeSeriesChart', 'LegendDot'],
    props: [
      { name: 'series', type: 'TimeSeries[]', description: '`{ name, points: [ms, value][], color?, dashed? }`.' },
      { name: 'thresholds', type: 'Threshold[]', description: 'Horizontal reference lines.' },
      { name: 'yMax', type: 'number', description: 'Pin the axis top (e.g. 100 for %).' },
      { name: 'formatY / formatTime', type: '(v) => string', description: 'Axis + tooltip formatting.' },
      { name: 'height', type: 'number', default: '160', description: 'Chart height.' },
    ],
    examples: [
      {
        title: 'Two series with a threshold',
        render: () => (
          <div className="w-full space-y-2">
            <div className="flex gap-3">
              <LegendDot color="var(--color-brand-500)">p95 latency</LegendDot>
              <LegendDot color="var(--color-accent-500)">p50 latency</LegendDot>
            </div>
            <TimeSeriesChart
              series={[
                { name: 'p95', points: SERIES, color: 'var(--color-brand-500)' },
                { name: 'p50', points: SERIES_B, color: 'var(--color-accent-500)' },
              ]}
              thresholds={[{ value: 80, label: 'SLO' }]}
              formatY={(v) => `${Math.round(v)}ms`}
            />
          </div>
        ),
        code: `<TimeSeriesChart
  series={[
    { name: 'p95', points: p95, color: 'var(--color-brand-500)' },
    { name: 'p50', points: p50, color: 'var(--color-accent-500)' },
  ]}
  thresholds={[{ value: 80, label: 'SLO' }]}
  formatY={(v) => \`\${v}ms\`}
/>`,
      },
    ],
    guidance: ['Show a legend whenever there are two or more series.', 'Keep marks thin and axes recessive; label text uses text colours, not series colours.'],
  },
  {
    id: 'area-chart',
    name: 'AreaChart & Sparkline',
    category: 'Charts',
    description: 'Compact trend visuals for stat tiles and cards.',
    imports: ['AreaChart', 'Sparkline'],
    props: [
      { name: 'points', type: 'SeriesPoint[]', description: 'Numbers or `{ v, t?, label? }`.' },
      { name: 'color', type: 'string', default: 'var(--color-brand-500)', description: 'Stroke / fill.' },
      { name: 'height', type: 'number', description: 'Chart height.' },
      { name: 'showAxis (AreaChart)', type: 'boolean', default: 'true', description: 'Min / max labels.' },
    ],
    examples: [
      {
        title: 'Stat tile',
        render: () => (
          <div className="grid w-full max-w-lg grid-cols-2 gap-3">
            <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
              <div className="text-xs text-content-muted">Deploys / day</div>
              <div className="text-2xl font-semibold text-content">42</div>
              <Sparkline points={SERIES.map(([, v]) => v)} />
            </div>
            <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
              <AreaChart points={SERIES.map(([, v]) => v)} height={80} />
            </div>
          </div>
        ),
        code: `<Sparkline points={values} />\n<AreaChart points={values} height={80} />`,
      },
    ],
  },
  {
    id: 'bar-chart',
    name: 'BarChart',
    category: 'Charts',
    description: 'Simple categorical bars with hover values.',
    imports: ['BarChart'],
    props: [
      { name: 'bars', type: '{ label, value, color? }[]', description: 'Data.' },
      { name: 'height', type: 'number', default: '96', description: 'Chart height.' },
      { name: 'formatY', type: '(v) => string', description: 'Value formatting.' },
    ],
    examples: [
      {
        title: 'Weekly deploys',
        render: () => (
          <div className="w-full max-w-md">
            <BarChart bars={['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, i) => ({ label: d, value: [12, 18, 9, 22, 15][i] }))} />
          </div>
        ),
        code: `<BarChart bars={[{ label: 'Mon', value: 12 }, { label: 'Tue', value: 18 }]} />`,
      },
    ],
  },
  {
    id: 'donut',
    name: 'DonutGauge',
    category: 'Charts',
    description: 'A single ratio against a maximum — quota, completion, SLO budget.',
    imports: ['DonutGauge'],
    props: [
      { name: 'value / max', type: 'number', default: 'max = 100', description: 'Filled fraction.' },
      { name: 'size / thickness', type: 'number', default: '120 / 12', description: 'Geometry.' },
      { name: 'label / caption', type: 'ReactNode', description: 'Centre text.' },
      { name: 'color / trackColor', type: 'string', description: 'Fill + track colours.' },
    ],
    controls: donutControls,
    render: (v) => (
      <DonutGauge value={Number(v.value)} size={Number(v.size)} thickness={Number(v.thickness)} label={`${v.value}%`} caption="CPU quota" />
    ),
    code: (v) => `<DonutGauge value={${v.value}}${v.size !== 120 ? ` size={${v.size}}` : ''}${v.thickness !== 12 ? ` thickness={${v.thickness}}` : ''} label="${v.value}%" caption="CPU quota" />`,
    examples: [],
  },
]
