import { PageHeader } from '@adhar-console/shell-ui'
import { Overview } from './views/overview.tsx'
import { Dashboards } from './views/bi-dashboards.tsx'
import { Questions } from './views/questions.tsx'
import { SqlEditor } from './views/sql-editor.tsx'
import { Databases } from './views/databases.tsx'
import { Pulses } from './views/pulses.tsx'
import { DoraSummary } from './views/dora.tsx'
import { SpendSummary } from './views/spend.tsx'

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
    label: 'Pulses & Alerts',
    description: 'Scheduled email / Slack pulses + threshold alerts driven by saved questions.',
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
      <PageHeader title={def.label} description={def.description} />
      {active === 'dashboard' && <Overview />}
      {active === 'dashboards' && <Dashboards />}
      {active === 'questions' && <Questions />}
      {active === 'sql' && <SqlEditor />}
      {active === 'databases' && <Databases />}
      {active === 'pulses' && <Pulses />}
      {active === 'dora' && <DoraSummary />}
      {active === 'spend' && <SpendSummary />}
    </div>
  )
}
