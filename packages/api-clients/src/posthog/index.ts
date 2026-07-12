import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * PostHog product analytics client.
 *
 * Surfaces events, insights (trends / funnels / retention), persons,
 * cohorts, feature flags, and session replays. The console pulls the
 * analytics layer through one consolidated HTTP shape via the BFF.
 */

/* ─────────── events ─────────── */

export const PHEventSchema = z.object({
  id: z.string(),
  event: z.string(),
  distinct_id: z.string(),
  timestamp: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
  person: z
    .object({ id: z.string(), name: z.string().optional(), email: z.string().optional() })
    .optional(),
})
export type PHEvent = z.infer<typeof PHEventSchema>

/* ─────────── persons ─────────── */

export const PHPersonSchema = z.object({
  id: z.string(),
  distinct_id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  created_at: z.string(),
  last_seen_at: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  /** 30d session count. */
  sessions_30d: z.number().optional(),
})
export type PHPerson = z.infer<typeof PHPersonSchema>

/* ─────────── insights ─────────── */

export const InsightTypeSchema = z.enum([
  'trend',
  'funnel',
  'retention',
  'paths',
  'lifecycle',
  'stickiness',
])
export type InsightType = z.infer<typeof InsightTypeSchema>

export const InsightSchema = z.object({
  id: z.string(),
  short_id: z.string(),
  name: z.string(),
  type: InsightTypeSchema,
  description: z.string().optional(),
  dashboards: z.array(z.string()).optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  /** Latest result series — interpretation depends on `type`. */
  result: z
    .union([
      z.object({
        kind: z.literal('trend'),
        labels: z.array(z.string()),
        series: z.array(
          z.object({ label: z.string(), data: z.array(z.number()), color: z.string().optional() }),
        ),
      }),
      z.object({
        kind: z.literal('funnel'),
        steps: z.array(
          z.object({ name: z.string(), count: z.number(), conversion_rate: z.number(), avg_time_s: z.number().optional() }),
        ),
      }),
      z.object({
        kind: z.literal('retention'),
        cohorts: z.array(
          z.object({
            label: z.string(),
            size: z.number(),
            values: z.array(z.number()),
          }),
        ),
      }),
    ])
    .optional(),
})
export type Insight = z.infer<typeof InsightSchema>

/* ─────────── cohorts ─────────── */

export const CohortSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  count: z.number(),
  is_static: z.boolean(),
  groups: z
    .array(z.object({ property: z.string(), operator: z.string(), value: z.string() }))
    .optional(),
  created_at: z.string(),
})
export type Cohort = z.infer<typeof CohortSchema>

/* ─────────── feature flags ─────────── */

export const FeatureFlagSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  active: z.boolean(),
  rollout_percentage: z.number().optional(),
  variants: z
    .array(z.object({ key: z.string(), name: z.string(), rollout_percentage: z.number() }))
    .optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
})
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>

/* ─────────── sessions ─────────── */

export const SessionSchema = z.object({
  id: z.string(),
  person: z.object({ distinct_id: z.string(), name: z.string().optional() }),
  start_time: z.string(),
  duration_s: z.number(),
  pageview_count: z.number(),
  click_count: z.number(),
  rage_click_count: z.number().optional(),
  console_error_count: z.number().optional(),
  device: z.string().optional(),
  country: z.string().optional(),
  recording_available: z.boolean(),
})
export type Session = z.infer<typeof SessionSchema>

export interface PostHogClient {
  listEvents(filter?: { event?: string; sinceMs?: number }): Promise<PHEvent[]>
  listPersons(filter?: { search?: string }): Promise<PHPerson[]>
  listInsights(filter?: { type?: InsightType }): Promise<Insight[]>
  getInsight(id: string): Promise<Insight>
  listCohorts(): Promise<Cohort[]>
  listFeatureFlags(): Promise<FeatureFlag[]>
  toggleFeatureFlag(id: string, active: boolean): Promise<void>
  listSessions(filter?: { hasErrors?: boolean }): Promise<Session[]>
}

function build(http: HttpClient): PostHogClient {
  return {
    listEvents: async (filter) => {
      const qs = new URLSearchParams()
      if (filter?.event) qs.set('event', filter.event)
      if (filter?.sinceMs) qs.set('after', new Date(Date.now() - filter.sinceMs).toISOString())
      const res = await http.get<{ results: PHEvent[] }>(`/api/projects/@current/events?${qs}`)
      return res.results
    },
    listPersons: async (filter) => {
      const qs = new URLSearchParams()
      if (filter?.search) qs.set('search', filter.search)
      const res = await http.get<{ results: PHPerson[] }>(`/api/projects/@current/persons?${qs}`)
      return res.results
    },
    listInsights: async (filter) => {
      const qs = new URLSearchParams()
      if (filter?.type) qs.set('insight', filter.type)
      const res = await http.get<{ results: Insight[] }>(`/api/projects/@current/insights?${qs}`)
      return res.results
    },
    getInsight: (id) => http.get<Insight>(`/api/projects/@current/insights/${id}`),
    listCohorts: async () => {
      const res = await http.get<{ results: Cohort[] }>(`/api/projects/@current/cohorts`)
      return res.results
    },
    listFeatureFlags: async () => {
      const res = await http.get<{ results: FeatureFlag[] }>(`/api/projects/@current/feature_flags`)
      return res.results
    },
    toggleFeatureFlag: async (id, active) => {
      await http.patch<void>(`/api/projects/@current/feature_flags/${id}`, { active })
    },
    listSessions: async (filter) => {
      const qs = new URLSearchParams()
      if (filter?.hasErrors) qs.set('has_errors', 'true')
      const res = await http.get<{ results: Session[] }>(`/api/projects/@current/session_recordings?${qs}`)
      return res.results
    },
  }
}

/* ─────────── stub data ─────────── */

const now = Date.now()
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString()

const PERSONS: PHPerson[] = [
  {
    id: 'p-1',
    distinct_id: 'tapas@adhar.dev',
    name: 'Tapas Mahapatra',
    email: 'tapas@adhar.dev',
    created_at: daysAgo(120),
    last_seen_at: minutesAgo(8),
    properties: { plan: 'enterprise', team: 'platform', country: 'IN' },
    sessions_30d: 42,
  },
  {
    id: 'p-2',
    distinct_id: 'maya@adhar.dev',
    name: 'Maya Iyer',
    email: 'maya@adhar.dev',
    created_at: daysAgo(95),
    last_seen_at: minutesAgo(22),
    properties: { plan: 'enterprise', team: 'product', country: 'IN' },
    sessions_30d: 36,
  },
  {
    id: 'p-3',
    distinct_id: 'priya@adhar.dev',
    name: 'Priya Sharma',
    email: 'priya@adhar.dev',
    created_at: daysAgo(60),
    last_seen_at: minutesAgo(140),
    properties: { plan: 'team', team: 'billing', country: 'IN' },
    sessions_30d: 28,
  },
  {
    id: 'p-4',
    distinct_id: 'anika@adhar.dev',
    name: 'Anika Patel',
    email: 'anika@adhar.dev',
    created_at: daysAgo(28),
    last_seen_at: minutesAgo(310),
    properties: { plan: 'team', team: 'design', country: 'IN' },
    sessions_30d: 22,
  },
  {
    id: 'p-5',
    distinct_id: 'rahul@external.com',
    name: 'Rahul (external)',
    email: 'rahul@external.com',
    created_at: daysAgo(7),
    last_seen_at: minutesAgo(720),
    properties: { plan: 'team', team: '—', country: 'US' },
    sessions_30d: 5,
  },
]

const EVENT_TEMPLATES: Array<Pick<PHEvent, 'event'> & { props?: Record<string, unknown> }> = [
  { event: '$pageview', props: { $current_url: '/define/projects' } },
  { event: '$pageview', props: { $current_url: '/develop/ide' } },
  { event: '$pageview', props: { $current_url: '/deliver/dashboard' } },
  { event: 'project.created', props: { source: 'modal' } },
  { event: 'workspace.started', props: { template: 'fullstack-tilt' } },
  { event: 'wireframe.saved', props: { blocks: 14 } },
  { event: 'diagram.exported', props: { kind: 'svg', type: 'flowchart' } },
  { event: 'pr.opened', props: { repo: 'adhar-console' } },
  { event: 'rollout.promoted', props: { service: 'platform-bff', step: 2 } },
  { event: 'invoice.finalized', props: { amount_usd: 4200 } },
  { event: 'feature_flag.evaluated', props: { flag: 'new-builder', value: true } },
]

const STUB_EVENTS: PHEvent[] = (() => {
  const out: PHEvent[] = []
  let s = 7
  for (let i = 0; i < 80; i++) {
    s = (s * 1103515245 + 12345) % 2 ** 31
    const tpl = EVENT_TEMPLATES[i % EVENT_TEMPLATES.length]
    const person = PERSONS[(s >> 4) % PERSONS.length]
    out.push({
      id: `ev-${i}`,
      event: tpl.event,
      distinct_id: person.distinct_id,
      timestamp: minutesAgo(i * 3 + ((s >> 8) % 5)),
      properties: tpl.props,
      person: { id: person.id, name: person.name, email: person.email },
    })
  }
  return out
})()

const TREND_LABELS = (() => {
  const out: string[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000)
    out.push(`${d.getMonth() + 1}/${d.getDate()}`)
  }
  return out
})()

function gen(seed: number, count: number, min: number, max: number, trend: 'up' | 'down' | 'flat' = 'flat') {
  let s = seed
  const span = max - min
  const trendStep = trend === 'up' ? span * 0.5 : trend === 'down' ? -span * 0.5 : 0
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    s = (s * 9301 + 49297) % 233280
    const r = s / 233280
    const wave = Math.sin((i / count) * Math.PI * 2) * span * 0.18
    const baseline = min + span * 0.5 + (trendStep * i) / count
    out.push(Math.max(min, Math.min(max, baseline + wave + (r - 0.5) * span * 0.4)))
  }
  return out.map((v) => Math.round(v))
}

const STUB_INSIGHTS: Insight[] = [
  {
    id: 'i-mau',
    short_id: 'mau14',
    name: 'Daily active users · 14d',
    type: 'trend',
    description: 'Users with at least one $pageview per day.',
    dashboards: ['d-product'],
    created_at: daysAgo(60),
    updated_at: minutesAgo(8),
    result: {
      kind: 'trend',
      labels: TREND_LABELS,
      series: [
        { label: 'DAU', data: gen(11, 14, 80, 220, 'up'), color: 'var(--color-brand-500)' },
        { label: 'WAU/7', data: gen(13, 14, 600, 1100, 'up'), color: 'var(--color-emerald-500)' },
      ],
    },
  },
  {
    id: 'i-pageviews',
    short_id: 'pv',
    name: 'Pageviews by section',
    type: 'trend',
    description: 'Pageviews split by top-level section path.',
    created_at: daysAgo(40),
    updated_at: minutesAgo(15),
    result: {
      kind: 'trend',
      labels: TREND_LABELS,
      series: [
        { label: '/define', data: gen(21, 14, 220, 460, 'up') },
        { label: '/develop', data: gen(23, 14, 180, 340) },
        { label: '/deliver', data: gen(25, 14, 90, 200, 'up') },
        { label: '/discover', data: gen(27, 14, 60, 140, 'up') },
      ],
    },
  },
  {
    id: 'i-projects',
    short_id: 'pr',
    name: 'Projects created · 14d',
    type: 'trend',
    created_at: daysAgo(30),
    updated_at: minutesAgo(40),
    result: {
      kind: 'trend',
      labels: TREND_LABELS,
      series: [{ label: 'project.created', data: gen(31, 14, 4, 28, 'up'), color: 'var(--color-brand-500)' }],
    },
  },
  {
    id: 'i-funnel-onboarding',
    short_id: 'fo',
    name: 'Onboarding funnel',
    type: 'funnel',
    description: 'Sign-up → first project → first deploy → invite teammate.',
    created_at: daysAgo(50),
    updated_at: minutesAgo(120),
    result: {
      kind: 'funnel',
      steps: [
        { name: 'Visited landing page', count: 1840, conversion_rate: 1 },
        { name: 'Signed up', count: 622, conversion_rate: 0.338, avg_time_s: 92 },
        { name: 'Created first project', count: 412, conversion_rate: 0.662, avg_time_s: 184 },
        { name: 'Connected first cluster', count: 314, conversion_rate: 0.762, avg_time_s: 312 },
        { name: 'Shipped first workload', count: 218, conversion_rate: 0.694, avg_time_s: 487 },
        { name: 'Invited a teammate', count: 142, conversion_rate: 0.651, avg_time_s: 1240 },
      ],
    },
  },
  {
    id: 'i-funnel-purchase',
    short_id: 'fp',
    name: 'Trial → paid funnel',
    type: 'funnel',
    description: 'Visited /pricing → started trial → invoice paid.',
    created_at: daysAgo(40),
    updated_at: minutesAgo(180),
    result: {
      kind: 'funnel',
      steps: [
        { name: 'Visited /pricing', count: 940, conversion_rate: 1 },
        { name: 'Started trial', count: 318, conversion_rate: 0.338, avg_time_s: 48 },
        { name: 'Invited teammate', count: 192, conversion_rate: 0.604, avg_time_s: 720 },
        { name: 'Card on file', count: 122, conversion_rate: 0.635, avg_time_s: 5400 },
        { name: 'Invoice paid', count: 87, conversion_rate: 0.713, avg_time_s: 86400 * 7 },
      ],
    },
  },
  {
    id: 'i-retention',
    short_id: 're',
    name: 'Weekly retention · 8w',
    type: 'retention',
    created_at: daysAgo(20),
    updated_at: minutesAgo(60),
    result: {
      kind: 'retention',
      cohorts: Array.from({ length: 8 }).map((_, i) => {
        const size = 80 + Math.round(Math.random() * 60)
        const week = `Week ${8 - i}`
        const values = Array.from({ length: 8 - i }).map((_, j) =>
          Math.round((j === 0 ? 1 : Math.max(0.06, 1 - 0.18 * j - Math.random() * 0.12)) * 100),
        )
        return { label: week, size, values }
      }),
    },
  },
]

const STUB_COHORTS: Cohort[] = [
  {
    id: 'co-power',
    name: 'Power users',
    description: '10+ sessions in last 30 days.',
    count: 142,
    is_static: false,
    groups: [{ property: 'sessions_30d', operator: 'gte', value: '10' }],
    created_at: daysAgo(30),
  },
  {
    id: 'co-trial',
    name: 'In trial · ending in 7d',
    description: 'Users on trial whose end-date is within 7 days.',
    count: 38,
    is_static: false,
    groups: [{ property: 'plan', operator: 'eq', value: 'trial' }],
    created_at: daysAgo(14),
  },
  {
    id: 'co-enterprise',
    name: 'Enterprise plan',
    count: 24,
    is_static: false,
    groups: [{ property: 'plan', operator: 'eq', value: 'enterprise' }],
    created_at: daysAgo(60),
  },
  {
    id: 'co-churn-risk',
    name: 'Churn risk',
    description: 'No activity in 14d on enterprise plan.',
    count: 6,
    is_static: false,
    created_at: daysAgo(7),
  },
]

const STUB_FLAGS: FeatureFlag[] = [
  {
    id: 'ff-1',
    key: 'new-builder',
    name: 'New visual builder',
    active: true,
    rollout_percentage: 80,
    created_at: daysAgo(40),
    updated_at: minutesAgo(60),
  },
  {
    id: 'ff-2',
    key: 'ai-suggestions',
    name: 'AI code suggestions',
    active: true,
    rollout_percentage: 25,
    variants: [
      { key: 'control', name: 'Control', rollout_percentage: 50 },
      { key: 'variant', name: 'Variant — gpt-5', rollout_percentage: 50 },
    ],
    created_at: daysAgo(20),
    updated_at: minutesAgo(120),
  },
  {
    id: 'ff-3',
    key: 'self-serve-billing',
    name: 'Self-serve billing portal',
    active: false,
    rollout_percentage: 0,
    created_at: daysAgo(60),
  },
  {
    id: 'ff-4',
    key: 'kargo-promote-ui',
    name: 'Inline Kargo promote',
    active: true,
    rollout_percentage: 100,
    created_at: daysAgo(80),
  },
]

const STUB_SESSIONS: Session[] = [
  {
    id: 'sess-1',
    person: { distinct_id: 'tapas@adhar.dev', name: 'Tapas Mahapatra' },
    start_time: minutesAgo(12),
    duration_s: 1842,
    pageview_count: 24,
    click_count: 168,
    rage_click_count: 0,
    console_error_count: 1,
    device: 'desktop',
    country: 'IN',
    recording_available: true,
  },
  {
    id: 'sess-2',
    person: { distinct_id: 'maya@adhar.dev', name: 'Maya Iyer' },
    start_time: minutesAgo(38),
    duration_s: 942,
    pageview_count: 12,
    click_count: 76,
    rage_click_count: 2,
    console_error_count: 0,
    device: 'desktop',
    country: 'IN',
    recording_available: true,
  },
  {
    id: 'sess-3',
    person: { distinct_id: 'priya@adhar.dev', name: 'Priya Sharma' },
    start_time: minutesAgo(85),
    duration_s: 312,
    pageview_count: 6,
    click_count: 28,
    console_error_count: 4,
    device: 'desktop',
    country: 'IN',
    recording_available: true,
  },
  {
    id: 'sess-4',
    person: { distinct_id: 'anika@adhar.dev', name: 'Anika Patel' },
    start_time: minutesAgo(220),
    duration_s: 612,
    pageview_count: 9,
    click_count: 41,
    rage_click_count: 1,
    console_error_count: 0,
    device: 'mobile',
    country: 'IN',
    recording_available: true,
  },
  {
    id: 'sess-5',
    person: { distinct_id: 'rahul@external.com', name: 'Rahul (external)' },
    start_time: minutesAgo(610),
    duration_s: 124,
    pageview_count: 3,
    click_count: 9,
    rage_click_count: 0,
    console_error_count: 0,
    device: 'desktop',
    country: 'US',
    recording_available: false,
  },
]

export const PostHogClient = defineClient<PostHogClient>(build, () => ({
  listEvents: async (filter) => {
    let list = STUB_EVENTS.slice()
    if (filter?.event) list = list.filter((e) => e.event === filter.event)
    if (filter?.sinceMs) {
      const cutoff = now - filter.sinceMs
      list = list.filter((e) => new Date(e.timestamp).getTime() >= cutoff)
    }
    return list.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
  },
  listPersons: async (filter) => {
    if (filter?.search) {
      const f = filter.search.toLowerCase()
      return PERSONS.filter(
        (p) =>
          p.distinct_id.toLowerCase().includes(f) ||
          p.name?.toLowerCase().includes(f) ||
          p.email?.toLowerCase().includes(f),
      )
    }
    return PERSONS
  },
  listInsights: async (filter) => {
    if (filter?.type) return STUB_INSIGHTS.filter((i) => i.type === filter.type)
    return STUB_INSIGHTS
  },
  getInsight: async (id) => {
    const i = STUB_INSIGHTS.find((x) => x.id === id || x.short_id === id)
    if (!i) throw new Error(`Stub: insight ${id} not found`)
    return i
  },
  listCohorts: async () => STUB_COHORTS,
  listFeatureFlags: async () => STUB_FLAGS,
  toggleFeatureFlag: async (id, active) => {
    const f = STUB_FLAGS.find((x) => x.id === id)
    if (f) f.active = active
  },
  listSessions: async (filter) => {
    if (filter?.hasErrors) return STUB_SESSIONS.filter((s) => (s.console_error_count ?? 0) > 0)
    return STUB_SESSIONS
  },
}))
