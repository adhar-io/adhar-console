export { AdharLogo, AdharSymbol, AdharWordmark, AdharWordmarkStack } from './brand.tsx'
export { AiProvider, AiButton, useAi, type AskOptions } from './ai-assistant.tsx'
export {
  streamAi,
  getAiConfig,
  type AiContext,
  type AiMode,
  type AiProposal,
} from './ai.ts'
export { AppShell } from './app-shell.tsx'
export { Sidebar } from './sidebar.tsx'
export { Topbar } from './topbar.tsx'
export { TenantSwitcher } from './tenant-switcher.tsx'
export { useOrganizations, type OrgSummary, type UseOrganizations } from './use-organizations.ts'
export { PlatformSelectionControls } from './platform-selection.tsx'
export {
  LOCAL_CLUSTER,
  getActiveCluster,
  getActiveNamespace,
  getNamespaceScope,
  getSelection,
  setActiveCluster,
  setActiveNamespace,
  setNamespaceScope,
  subscribeSelection,
  useActiveCluster,
  useActiveNamespace,
  useNamespaceScope,
  useSelection,
  type Selection,
} from './selection-store.ts'
export { PhaseNav, PHASES, type Phase } from './phase-nav.tsx'
export { NavItem } from './nav-item.tsx'
export {
  DEFAULT_NAV,
  type NavBadge,
  type NavItem as NavItemDescriptor,
  type NavSection,
} from './nav-tree.tsx'
export {
  can,
  CONSOLE_ROLES,
  filterNavByRole,
  isReadOnly,
  landingPathForRole,
  resolveConsoleRole,
  ROLE_CAPABILITIES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  ROLE_LANDING,
  roleCanSee,
  useCan,
  useConsoleRole,
  type Capability,
  type ConsoleRole,
  type RoleSource,
} from './roles.ts'
export { ErrorBoundary } from './error-boundary.tsx'
export { PageHeader } from './page-header.tsx'
export { EmptyState } from './empty-state.tsx'
export { DataTable, type Column } from './data-table.tsx'
export { StatusBadge, type StatusKind } from './status-badge.tsx'
export { CommandPalette, type CommandItem } from './command-palette.tsx'
export { Modal } from './modal.tsx'
export {
  applyColorMode,
  applyTheme,
  bootColorMode,
  bootTheme,
  DEFAULT_COLOR_MODE,
  DEFAULT_THEME_ID,
  getResolvedMode,
  getStoredMode,
  getStoredThemeId,
  getSystemMode,
  THEMES,
  type ColorMode,
  type ThemePreset,
} from './theme.ts'
export { ModeToggle } from './mode-toggle.tsx'
export { AppLauncher, DEFAULT_APP_LINKS, type AppLink } from './app-launcher.tsx'
export {
  AirbyteIcon,
  ArgoCDIcon,
  ArgoIcon,
  ArgoRolloutsIcon,
  ArgoWorkflowsIcon,
  CiliumIcon,
  CrossplaneIcon,
  GiteaIcon,
  GrafanaIcon,
  HarborIcon,
  IcebergIcon,
  KafkaIcon,
  KargoIcon,
  KeycloakIcon,
  KubernetesIcon,
  KyvernoIcon,
  LokiIcon,
  MetabaseIcon,
  MinIOIcon,
  OTelIcon,
  PlaneIcon,
  PrometheusIcon,
  TempoIcon,
} from './brand-icons.tsx'
export {
  AreaChart,
  BarChart,
  DonutGauge,
  HeatMap,
  LegendDot,
  Sparkline,
  type SeriesPoint,
} from './charts.tsx'
export {
  useNotifications,
  type Notification,
  type NotificationsApi,
  type NotificationKind,
} from './notifications.ts'
export { docStore, DocStoreError, type StoredDoc } from './doc-store.ts'

/* ─ Primitives (new polish layer) ─ */
export {
  Button,
  ButtonLink,
  type ButtonProps,
  type ButtonLinkProps,
  type ButtonVariant,
  type ButtonSize,
} from './button.tsx'
export {
  Field,
  Input,
  Select,
  Textarea,
  Checkbox,
  type SelectOption,
} from './form.tsx'
export { Tabs, type TabDef } from './tabs.tsx'
export {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Skeleton,
  Separator,
  Kbd,
  Badge,
  Spinner,
} from './primitives.tsx'
