export { cn } from './cn.ts'
export { globalSingleton } from './global-singleton.ts'
export { formatRelative, formatAbsolute, formatDuration } from './time.ts'
export { invariant, assertNever } from './invariant.ts'
export { env, requireEnv } from './env.ts'
export type { Result } from './result.ts'
export { ok, err, isOk, isErr } from './result.ts'
export { derivedUrl, platformDomain, resetPlatformDomain, subdomainUrl, type PlatformDomain } from './domain.ts'
export {
  GENERATIVE_CATALOG,
  GENERATIVE_COMPONENT_IDS,
  catalogEnumDescription,
  catalogPropsDescription,
  type GenerativeComponentSpec,
} from './agui-catalog.ts'
export { parseYaml, tryParseYaml, type YamlValue } from './yaml-lite.ts'
export {
  escapeHtml,
  REPORT_CSS,
  REPORT_GRADE_COLOR,
  REPORT_PRIORITY_COLOR,
  REPORT_TONE_COLOR,
  REPORT_TONE_LABEL,
  reportPill,
  reportRing,
  reportTime,
  scoreTone,
  type ReportTone,
} from './report-html.ts'
export {
  bandsFrom,
  captureWindow,
  chartScale,
  clockUtc,
  closePhases,
  compactPoints,
  deltaFromFirst,
  downsample,
  faultImpact,
  formatMetric,
  MAX_POINTS,
  METRIC_DEFS,
  metricDef,
  metricsBytes,
  missingReason,
  niceCeil,
  parseRunnerTimeline,
  PHASE_COLOR,
  podRegexForApp,
  podRegexFromPods,
  pointsFromMatrix,
  probeSeries,
  rateFor,
  roundSig,
  runMetricQueries,
  segments,
  segmentsFor,
  seriesStats,
  stepFor,
  WINDOW_PAD_MS,
  yMaxFor,
  type ChartBand,
  type ChartFrame,
  type ChartScale,
  type MetricDef,
  type MetricId,
  type MetricPoint,
  type MetricQuery,
  type MetricSeries,
  type MetricUnit,
  type MissingMetric,
  type PhaseKind,
  type PhaseWindow,
  type RunMetrics,
  type RunnerTimeline,
} from './run-metrics.ts'
