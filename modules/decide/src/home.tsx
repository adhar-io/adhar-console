import { lazy, Suspense } from 'react'
import { PageHeader, Spinner } from '@adhar/shell-ui'

// One chunk per section — BI, DORA and Spend share little, so a visit pays for one.
const Overview = lazy(() => import('./views/overview.tsx').then((m) => ({ default: m.Overview })))
const Dashboards = lazy(() => import('./views/bi-dashboards.tsx').then((m) => ({ default: m.Dashboards })))
const Questions = lazy(() => import('./views/questions.tsx').then((m) => ({ default: m.Questions })))
const SqlEditor = lazy(() => import('./views/sql-editor.tsx').then((m) => ({ default: m.SqlEditor })))
const Databases = lazy(() => import('./views/databases.tsx').then((m) => ({ default: m.Databases })))
const Pulses = lazy(() => import('./views/pulses.tsx').then((m) => ({ default: m.Pulses })))
const DoraSummary = lazy(() => import('./views/dora.tsx').then((m) => ({ default: m.DoraSummary })))
const SpendSummary = lazy(() => import('./views/spend.tsx').then((m) => ({ default: m.SpendSummary })))

type Section =
  | 'dashboard'
  | 'dashboards'
  | 'questions'
  | 'sql'
  | 'databases'
  | 'pulses'
  | 'dora'
  | 'spend'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Decide Overview',
    description: 'Cross-cutting health, DORA, spend, compliance — live from the cluster + warehouse.',
  },
  dashboards: {
    label: 'BI Dashboards',
    description: 'Metabase dashboards — revenue, product, engineering, customer success.',
  },
  questions: {
    label: 'Questions',
    description: 'Saved questions / cards — SQL or GUI-defined, with chart previews and view counts.',
  },
  sql: {
    label: 'SQL Editor',
    description: 'Native SQL workbench — pick a database, run a query, eyeball the result.',
  },
  databases: {
    label: 'Databases',
    description: 'Registered analytics databases with engine + schema/table counts.',
  },
  pulses: {
    label: 'Subscriptions & Alerts',
    description: 'Dashboard subscriptions and question alerts — scheduled email / Slack delivery from Metabase.',
  },
  dora: {
    label: 'DORA',
    description: 'Deploy frequency, lead time, change-failure rate, MTTR.',
  },
  spend: {
    label: 'Spend',
    description: 'Aggregate cloud + SaaS spend with breakdown.',
  },
}

export default function DecideHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      {/* Overview, DORA and Spend render their own PageHeader (with right-side actions). */}
      {active !== 'dashboard' && active !== 'dora' && active !== 'spend' ? <PageHeader title={def.label} /> : null}
      <Suspense fallback={<div className="flex justify-center py-16 text-content-subtle" aria-busy="true"><Spinner size={16} /></div>}>
        {active === 'dashboard' && <Overview />}
        {active === 'dashboards' && <Dashboards />}
        {active === 'questions' && <Questions />}
        {active === 'sql' && <SqlEditor />}
        {active === 'databases' && <Databases />}
        {active === 'pulses' && <Pulses />}
        {active === 'dora' && <DoraSummary />}
        {active === 'spend' && <SpendSummary />}
      </Suspense>
    </div>
  )
}
