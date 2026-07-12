import type { ReactNode } from 'react'
import type { StatusKind } from './status-badge.tsx'
import {
  IconActivity,
  IconAppBox,
  IconBarChart,
  IconCatalog,
  IconCloud,
  IconCode,
  IconCreditCard,
  IconFolder,
  IconGauge,
  IconHeartPulse,
  IconDesign,
  IconHelp,
  IconHome,
  IconKey,
  IconPalette,
  IconPlug,
  IconPlusCircle,
  IconRocket,
  IconServer,
  IconShield,
  IconSparkle,
  IconTarget,
  IconUsers,
  IconWebhook,
} from './icons.tsx'

export interface NavItem {
  id: string
  label: string
  /** Route to navigate to. Leaf if set; a group if undefined. */
  to?: string
  /** Extra query for deep-linking into a module's internal tab. */
  search?: string
  /** Icon rendered left of the label. */
  icon?: ReactNode
  /** Short descriptive text rendered below the label in expanded mode. */
  description?: string
  /** Keyboard shortcut text — rendered right-aligned in a kbd pill. */
  shortcut?: string
  badge?: NavBadge
  children?: NavItem[]
  /** Group items are expanded by default when true. */
  defaultExpanded?: boolean
  /** Requires at least one of these roles to render. */
  roles?: string[]
}

export type NavBadge =
  | string
  | number
  | { kind: StatusKind; value: string | number }

export interface NavSection {
  id: string
  label?: string
  description?: string
  items: NavItem[]
  sticky?: boolean
}

/**
 * Default nav tree — **2 levels max**.
 *
 * Level 1 = top-level items (always have an icon).
 * Level 2 = sub-items (labels only, shown when the parent is expanded).
 *
 * The Workspace section is intentionally flat (just level 1) — grouping
 * sub-sections under "Organization", "Connectivity", etc. would add a
 * third level that doesn't pay for itself.
 */
export const DEFAULT_NAV: NavSection[] = [
  {
    id: 'main',
    items: [
      { id: 'home', label: 'Overview', to: '/', icon: <IconHome />, shortcut: 'g h' },
      {
        id: 'catalog',
        label: 'Service Catalog',
        to: '/catalog',
        icon: <IconCatalog />,
        description: 'Services, APIs, resources & teams',
        shortcut: 'g c',
      },
      {
        id: 'catalog.create',
        label: 'Create New',
        to: '/catalog',
        search: 'create',
        icon: <IconPlusCircle />,
        description: 'Scaffold from a golden-path template',
        shortcut: 'g n',
        badge: { kind: 'info', value: 'templates' },
      },
    ],
  },
  {
    id: 'lifecycle',
    label: 'Software lifecycle',
    items: [
      {
        id: 'define',
        label: 'Define',
        to: '/define',
        icon: <IconTarget />,
        description: 'Plane.so projects & planning',
        children: [
          { id: 'define.dashboard', label: 'Dashboard', to: '/define', search: 'dashboard' },
          { id: 'define.projects', label: 'Projects', to: '/define', search: 'projects' },
          { id: 'define.issues', label: 'Issues', to: '/define', search: 'issues', badge: 12 },
          { id: 'define.cycles', label: 'Cycles', to: '/define', search: 'cycles' },
          { id: 'define.modules', label: 'Modules', to: '/define', search: 'modules' },
          { id: 'define.pages', label: 'Pages', to: '/define', search: 'pages' },
          { id: 'define.views', label: 'Saved Views', to: '/define', search: 'views' },
          { id: 'define.roadmap', label: 'Roadmap', to: '/define', search: 'roadmap' },
          { id: 'define.members', label: 'Members', to: '/define', search: 'members' },
        ],
      },
      {
        id: 'design',
        label: 'Design',
        to: '/design',
        icon: <IconDesign />,
        description: 'Architecture & UI/UX design',
        children: [
          { id: 'design.dashboard', label: 'Dashboard', to: '/design', search: 'dashboard' },
          {
            id: 'design.adrs',
            label: 'ADRs',
            to: '/design',
            search: 'adrs',
            badge: { kind: 'progressing', value: '3 pending' },
          },
          { id: 'design.diagrams', label: 'Diagrams', to: '/design', search: 'diagrams' },
          { id: 'design.whiteboard', label: 'Whiteboard', to: '/design', search: 'whiteboard' },
          { id: 'design.personas', label: 'Personas', to: '/design', search: 'personas' },
          { id: 'design.journeys', label: 'Journey Maps', to: '/design', search: 'journeys' },
          { id: 'design.wireframes', label: 'Wireframes', to: '/design', search: 'wireframes' },
          { id: 'design.tokens', label: 'Design Tokens', to: '/design', search: 'tokens' },
          { id: 'design.catalog', label: 'Component Catalog', to: '/design', search: 'catalog' },
          { id: 'design.builder', label: 'Visual Builder', to: '/design', search: 'builder' },
        ],
      },
      {
        id: 'develop',
        label: 'Develop',
        to: '/develop',
        icon: <IconCode />,
        description: 'Code, environments, CI',
        children: [
          { id: 'develop.dashboard', label: 'Dashboard', to: '/develop', search: 'dashboard' },
          { id: 'develop.repos', label: 'Repositories', to: '/develop', search: 'repos' },
          { id: 'develop.ide', label: 'VS Code', to: '/develop', search: 'ide' },
          { id: 'develop.branches', label: 'Branches', to: '/develop', search: 'branches' },
          { id: 'develop.commits', label: 'Commits', to: '/develop', search: 'commits' },
          { id: 'develop.prs', label: 'Pull Requests', to: '/develop', search: 'prs', badge: 5 },
          { id: 'develop.issues', label: 'Issues', to: '/develop', search: 'issues' },
          { id: 'develop.environments', label: 'Cloud Envs', to: '/develop', search: 'environments' },
          { id: 'develop.workflows', label: 'CI Workflows', to: '/develop', search: 'workflows' },
          { id: 'develop.pipelines', label: 'Data Pipelines', to: '/develop', search: 'pipelines' },
          { id: 'develop.codebuilder', label: 'Code Builder', to: '/develop', search: 'codebuilder' },
        ],
      },
      {
        id: 'deliver',
        label: 'Deliver',
        to: '/deliver',
        icon: <IconRocket />,
        description: 'GitOps & rollouts',
        children: [
          { id: 'deliver.dashboard', label: 'Dashboard', to: '/deliver', search: 'dashboard' },
          { id: 'deliver.apps', label: 'ArgoCD Apps', to: '/deliver', search: 'apps' },
          { id: 'deliver.environments', label: 'Environments', to: '/deliver', search: 'environments' },
          { id: 'deliver.stages', label: 'Kargo Stages', to: '/deliver', search: 'stages' },
          {
            id: 'deliver.rollouts',
            label: 'Rollouts',
            to: '/deliver',
            search: 'rollouts',
            badge: { kind: 'paused', value: '1 paused' },
          },
          { id: 'deliver.releases', label: 'Releases', to: '/deliver', search: 'releases' },
          { id: 'deliver.registry', label: 'Image Registry', to: '/deliver', search: 'registry' },
          {
            id: 'deliver.scans',
            label: 'Vuln Scans',
            to: '/deliver',
            search: 'scans',
            badge: { kind: 'failed', value: '3 critical' },
          },
          {
            id: 'deliver.runtime',
            label: 'Runtime',
            to: '/deliver',
            search: 'runtime',
            badge: { kind: 'progressing', value: 'Falco' },
          },
          { id: 'deliver.policy', label: 'Policy', to: '/deliver', search: 'policy' },
        ],
      },
      {
        id: 'discover',
        label: 'Discover',
        to: '/discover',
        icon: <IconActivity />,
        description: 'Observability + analytics',
        children: [
          { id: 'discover.dashboard', label: 'Dashboard', to: '/discover', search: 'dashboard' },
          { id: 'discover.metrics', label: 'Metrics', to: '/discover', search: 'metrics' },
          { id: 'discover.logs', label: 'Logs', to: '/discover', search: 'logs' },
          { id: 'discover.traces', label: 'Traces', to: '/discover', search: 'traces' },
          { id: 'discover.servicemap', label: 'Service Map', to: '/discover', search: 'servicemap' },
          {
            id: 'discover.alerts',
            label: 'Alerts',
            to: '/discover',
            search: 'alerts',
            badge: { kind: 'failed', value: '2 firing' },
          },
          { id: 'discover.slos', label: 'SLOs', to: '/discover', search: 'slos' },
          { id: 'discover.dashboards', label: 'Grafana boards', to: '/discover', search: 'dashboards' },
          { id: 'discover.analytics', label: 'Analytics', to: '/discover', search: 'analytics' },
          { id: 'discover.funnels', label: 'Funnels', to: '/discover', search: 'funnels' },
          { id: 'discover.cohorts', label: 'Cohorts', to: '/discover', search: 'cohorts' },
          { id: 'discover.sessions', label: 'Sessions', to: '/discover', search: 'sessions' },
          { id: 'discover.flags', label: 'Feature Flags', to: '/discover', search: 'flags' },
        ],
      },
      {
        id: 'decide',
        label: 'Decide',
        to: '/decide',
        icon: <IconBarChart />,
        description: 'BI, KPIs, DORA, spend',
        children: [
          { id: 'decide.dashboard', label: 'Overview', to: '/decide', search: 'dashboard' },
          { id: 'decide.dashboards', label: 'BI Dashboards', to: '/decide', search: 'dashboards' },
          { id: 'decide.questions', label: 'Questions', to: '/decide', search: 'questions' },
          { id: 'decide.sql', label: 'SQL Editor', to: '/decide', search: 'sql' },
          { id: 'decide.databases', label: 'Databases', to: '/decide', search: 'databases' },
          {
            id: 'decide.pulses',
            label: 'Pulses & Alerts',
            to: '/decide',
            search: 'pulses',
          },
          { id: 'decide.dora', label: 'DORA', to: '/decide', search: 'dora' },
          { id: 'decide.spend', label: 'Spend', to: '/decide', search: 'spend' },
        ],
      },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      {
        id: 'platform-root',
        label: 'Kubernetes',
        to: '/platform',
        icon: <IconServer />,
        description: 'Clusters & workloads',
        children: [
          { id: 'platform.dashboard', label: 'Dashboard', to: '/platform', search: 'dashboard' },
          { id: 'platform.clusters', label: 'Clusters', to: '/platform', search: 'clusters', badge: 3 },
          { id: 'platform.nodes', label: 'Nodes', to: '/platform', search: 'nodes' },
          { id: 'platform.workloads', label: 'Workloads', to: '/platform', search: 'workloads' },
          { id: 'platform.pods', label: 'Pods', to: '/platform', search: 'pods' },
          { id: 'platform.networking', label: 'Networking', to: '/platform', search: 'networking' },
          { id: 'platform.storage', label: 'Storage', to: '/platform', search: 'storage' },
          { id: 'platform.config', label: 'Config & Secrets', to: '/platform', search: 'config' },
          { id: 'platform.rbac', label: 'RBAC', to: '/platform', search: 'rbac' },
          {
            id: 'platform.events',
            label: 'Events',
            to: '/platform',
            search: 'events',
            badge: { kind: 'degraded', value: '2 warn' },
          },
          { id: 'platform.crds', label: 'Custom Resources', to: '/platform', search: 'crds' },
          { id: 'platform.policy', label: 'Policy', to: '/platform', search: 'policy' },
          {
            id: 'platform.marketplace',
            label: 'Marketplace',
            to: '/platform',
            search: 'marketplace',
            badge: { kind: 'info', value: 'new' },
          },
        ],
      },
      {
        id: 'platform-resources',
        label: 'Adhar Resources',
        to: '/platform',
        search: 'catalog',
        icon: <IconAppBox />,
        description: 'Crossplane composites',
        children: [
          {
            id: 'platform.catalog',
            label: 'Catalog',
            to: '/platform',
            search: 'catalog',
            badge: { kind: 'info', value: '13' },
          },
          {
            id: 'platform.applications',
            label: 'Applications',
            to: '/platform',
            search: 'applications',
          },
          {
            id: 'platform.functions',
            label: 'Functions',
            to: '/platform',
            search: 'functions',
          },
          {
            id: 'platform.workflows',
            label: 'Workflows',
            to: '/platform',
            search: 'workflows',
          },
          {
            id: 'platform.pipelines',
            label: 'Pipelines',
            to: '/platform',
            search: 'pipelines',
          },
          {
            id: 'platform.databases',
            label: 'Databases',
            to: '/platform',
            search: 'databases',
          },
          {
            id: 'platform.caches',
            label: 'Caches',
            to: '/platform',
            search: 'caches',
          },
          {
            id: 'platform.buckets',
            label: 'Buckets',
            to: '/platform',
            search: 'buckets',
          },
          {
            id: 'platform.topics',
            label: 'Topics',
            to: '/platform',
            search: 'topics',
          },
          {
            id: 'platform.data-pipelines',
            label: 'Data Pipelines',
            to: '/platform',
            search: 'data-pipelines',
          },
          {
            id: 'platform.routes',
            label: 'Routes',
            to: '/platform',
            search: 'routes',
          },
          {
            id: 'platform.domains',
            label: 'Domains',
            to: '/platform',
            search: 'domains',
          },
          {
            id: 'platform.api-contracts',
            label: 'API Contracts',
            to: '/platform',
            search: 'api-contracts',
          },
          {
            id: 'platform.environments',
            label: 'Environments',
            to: '/platform',
            search: 'environments',
            badge: { kind: 'info', value: 'governance' },
          },
        ],
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        id: 'ws.members',
        label: 'Members',
        to: '/settings',
        search: 'members',
        icon: <IconUsers />,
        badge: 12,
      },
      {
        id: 'ws.projects',
        label: 'Projects',
        to: '/settings',
        search: 'projects',
        icon: <IconFolder />,
      },
      {
        id: 'ws.envs',
        label: 'Environments',
        to: '/settings',
        search: 'environments',
        icon: <IconCloud />,
      },
      {
        id: 'ws.integrations',
        label: 'Integrations',
        to: '/settings',
        search: 'integrations',
        icon: <IconPlug />,
        badge: { kind: 'degraded', value: '1' },
      },
      {
        id: 'ws.tokens',
        label: 'API Tokens',
        to: '/settings',
        search: 'tokens',
        icon: <IconKey />,
      },
      {
        id: 'ws.webhooks',
        label: 'Webhooks',
        to: '/settings',
        search: 'webhooks',
        icon: <IconWebhook />,
      },
      {
        id: 'ws.audit',
        label: 'Audit log',
        to: '/settings',
        search: 'audit',
        icon: <IconShield />,
      },
      {
        id: 'ws.plan',
        label: 'Plan',
        to: '/settings',
        search: 'plan',
        icon: <IconCreditCard />,
      },
      {
        id: 'ws.usage',
        label: 'Usage & quotas',
        to: '/settings',
        search: 'usage',
        icon: <IconGauge />,
      },
      {
        id: 'ws.theming',
        label: 'Theming',
        to: '/settings',
        search: 'theming',
        icon: <IconPalette />,
      },
    ],
  },
  {
    id: 'resources',
    label: 'Resources',
    items: [
      { id: 'status', label: 'Platform status', to: '/status', icon: <IconHeartPulse /> },
      { id: 'changelog', label: "What's new", to: '/changelog', icon: <IconSparkle /> },
      { id: 'help', label: 'Help & docs', to: '/help', icon: <IconHelp /> },
    ],
  },
]
