import { PageHeader } from '@adhar-console/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { Metrics } from './views/metrics.tsx'
import { Logs } from './views/logs.tsx'
import { Traces } from './views/traces.tsx'
import { ServiceMap } from './views/service-map.tsx'
import { Alerts } from './views/alerts.tsx'
import { Slos } from './views/slos.tsx'
import { Dashboards } from './views/dashboards.tsx'
import { Analytics } from './views/analytics.tsx'
import { Funnels } from './views/funnels.tsx'
import { Cohorts } from './views/cohorts.tsx'
import { Sessions } from './views/sessions.tsx'
import { Flags } from './views/flags.tsx'

type Section =
  | 'dashboard'
  | 'metrics'
  | 'logs'
  | 'traces'
  | 'servicemap'
  | 'alerts'
  | 'slos'
  | 'dashboards'
  | 'analytics'
  | 'funnels'
  | 'cohorts'
  | 'sessions'
  | 'flags'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Discover Dashboard',
    description: 'Observability + analytics pulse — golden signals, alerts, SLOs, product activity.',
  },
  metrics: {
    label: 'Metrics',
    description: 'PromQL against Mimir — RPS, latency, errors, CPU, memory across services.',
  },
  logs: {
    label: 'Logs',
    description: 'Stream, table and pattern views over Loki — label browser, live tail, field facets and line context.',
  },
  traces: {
    label: 'Traces',
    description: 'Tempo trace search with span timeline and service breakdown.',
  },
  servicemap: {
    label: 'Service Map',
    description: 'OpenTelemetry-derived service topology with RPS, error %, p95.',
  },
  alerts: {
    label: 'Alerts',
    description: 'Active and pending Alertmanager alerts — silence, drill into runbook.',
  },
  slos: {
    label: 'SLOs',
    description: 'Service-level objectives with current performance, error budget, burn rate.',
  },
  dashboards: {
    label: 'Grafana boards',
    description: 'Embedded Grafana dashboards — kiosk mode, deep-link parameters.',
  },
  analytics: {
    label: 'Analytics',
    description: 'PostHog insights — DAU, pageviews, retention, top events.',
  },
  funnels: {
    label: 'Funnels',
    description: 'Conversion funnels — onboarding, trial → paid, custom flows.',
  },
  cohorts: {
    label: 'Cohorts',
    description: 'Behavioral and property cohorts — power users, churn risk, plans.',
  },
  sessions: {
    label: 'Sessions',
    description: 'Recent user sessions with rage clicks, console errors, replay links.',
  },
  flags: {
    label: 'Feature Flags',
    description: 'PostHog feature flags + A/B variants — toggle, rollout, audit.',
  },
}

export default function DiscoverHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  /*
   * Logs is a workbench, not a document.
   *
   * Every other section here is a page you read top to bottom, so a title band
   * above it is orientation. The log explorer is the opposite: it is a single
   * pane that wants every pixel of the window, and it already names itself —
   * the LogQL badge sits in its query bar, the sidebar row is highlighted, and
   * the breadcrumb says Discover → Logs. The `<h1>` plus its `mb-6` and the
   * wrapper's `space-y-6` cost about 80px, which is six log lines spent
   * repeating a word that is on screen twice already.
   */
  if (active === 'logs') return <Logs />

  return (
    <div className="space-y-6">
      <PageHeader title={def.label} />
      {active === 'dashboard' && <Dashboard />}
      {active === 'metrics' && <Metrics />}
      {active === 'traces' && <Traces />}
      {active === 'servicemap' && <ServiceMap />}
      {active === 'alerts' && <Alerts />}
      {active === 'slos' && <Slos />}
      {active === 'dashboards' && <Dashboards />}
      {active === 'analytics' && <Analytics />}
      {active === 'funnels' && <Funnels />}
      {active === 'cohorts' && <Cohorts />}
      {active === 'sessions' && <Sessions />}
      {active === 'flags' && <Flags />}
    </div>
  )
}
