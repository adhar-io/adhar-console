import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { jobTitle, journeyDrafts, linkFor, mergeLinks, personaDrafts, sourceKey, statusCounts, statusOfGroup, wireframeDraft } from './plane-map.ts'
import { activityByUser, appCoverage, coverageSummary } from './coverage.ts'
import { applyOverrides, cleanDir, computeOverrides, droppedTokens, overrideCount, publishBranch, publishFiles, publishPrBody } from './token-publish.ts'
import { countJsxUsage, isComponentFile, parseComponentExports } from './repo-components.ts'
import { extractJson, toPalette, toPersona, toStages } from './ux-ai.ts'
import { scopeMatcher } from './scope-match.ts'
import { buildJourneyFunnel, journeySteps, stageConversion, summarizePersons } from './analytics.ts'
import { appProjectSlug, appRepo, scopedApps } from './designer-catalog.ts'
import type { Journey, Persona, PlaneLink, TokenSet, Wireframe } from './types.ts'

const persona: Persona = {
  id: 'p1', name: 'Priya Raman', avatar: '', role: 'Platform engineer', bio: '', goals: [], frustrations: [], behaviors: [],
  needs: ['Fast feedback'], tech: [], jobs: ['When a deploy fails, I want to see why in one place, so I can fix it fast', '  '],
}
const journey: Journey = {
  id: 'j1', name: 'First deploy', persona: 'p1', summary: '', goal: 'Ship',
  stages: [
    { id: 's1', name: 'Discover', emotion: 'curious', score: 1, actions: [], thoughts: [], pains: ['Docs are scattered'], opportunities: ['One getting-started page'], components: ['web'], events: ['$pageview'] },
    { id: 's2', name: 'Deploy', emotion: 'stressed', score: -2, actions: [], thoughts: [], pains: ['Build logs <hidden>'], opportunities: [], components: ['api', 'web'], events: ['', 'deploy_started'] },
    { id: 's3', name: 'Reflect', emotion: 'reflective', actions: [], thoughts: [], pains: [], opportunities: [] },
  ],
}

/* ───── Plane mapping ───── */

Deno.test('journey drafts: one per pain/opportunity, escaped, prioritised by feeling', () => {
  const d = journeyDrafts(journey, persona, { include: ['pain', 'opportunity'], link: 'https://c/design?x=1' })
  assertEquals(d.map((x) => x.kind), ['pain', 'opportunity', 'pain'])
  assertEquals(d[0].name, 'Fix: Docs are scattered')
  assertEquals(d[0].priority, 'medium')
  assertEquals(d[2].priority, 'high') // score -2 stage
  assertEquals(d[1].priority, 'low')
  assert(d[2].description_html.includes('Build logs &lt;hidden&gt;'))
  assert(d[0].description_html.includes('https://c/design?x=1'))
  assert(d[2].description_html.includes('api, web'))
  assertEquals(d[0].source, 'pain:s1:docs are scattered')
})

Deno.test('journey drafts skip what is already linked; pains only on request', () => {
  const existing: PlaneLink[] = [{ projectId: 'P', issueId: 'i', name: 'x', source: 'pain:s1:docs are scattered', createdAt: '' }]
  const d = journeyDrafts({ ...journey, planeLinks: existing }, persona, { include: ['pain'] })
  assertEquals(d.map((x) => x.context), ['Deploy'])
  assert(linkFor(existing, 'pain', 's1', '  Docs   are scattered '))
})

Deno.test('persona drafts come from jobs-to-be-done', () => {
  const d = personaDrafts(persona)
  assertEquals(d.length, 1)
  assertEquals(d[0].name, 'Enable: See why in one place')
  assertEquals(jobTitle('just a job'), 'Just a job')
  assertEquals(personaDrafts({ ...persona, planeLinks: [{ projectId: 'P', issueId: 'i', name: '', source: d[0].source, createdAt: '' }] }).length, 0)
  assertEquals(sourceKey('  A  B '), 'a b')
})

Deno.test('wireframe draft, merge links, state groups', () => {
  const w: Wireframe = { id: 'w1', flow: 'onboarding', name: 'Sign up', order: 1, blocks: [], component: { name: 'web', repo: 'acme/web' } }
  const d = wireframeDraft(w)
  assertEquals(d.source, 'wireframe:w1')
  assert(d.description_html.includes('acme/web'))
  const a: PlaneLink = { projectId: 'P', issueId: '1', name: 'a', source: 's', createdAt: '1' }
  const b: PlaneLink = { ...a, issueId: '2', createdAt: '2' }
  assertEquals(mergeLinks([a], [b]).map((l) => l.issueId), ['2'])
  assertEquals(statusOfGroup('started'), 'in-progress')
  assertEquals(statusOfGroup(undefined), 'unknown')
  assertEquals(statusCounts(['done', 'done', 'todo']).done, 2)
})

/* ───── coverage ───── */

Deno.test('app coverage links journeys, personas, wireframes, PRs and tokens', () => {
  const apps = [
    { name: 'web', project: 'shop', repoUrl: 'http://gitea-http.gitea:3000/acme/web.git' },
    { name: 'api', project: 'shop', repoUrl: 'https://git.example.com/acme/api' },
    { name: 'docs', project: 'shop', repoUrl: '' },
  ]
  const wireframes: Wireframe[] = [
    { id: 'w1', flow: 'f', name: 'Home', order: 1, blocks: [], component: { name: 'WEB' }, prs: [{ repo: 'acme/web', number: 3, createdAt: '' }] },
  ]
  const rows = appCoverage({
    apps,
    personas: [persona],
    journeys: [journey],
    wireframes,
    tokenProjects: new Set(['shop']),
    publishes: [{ repo: 'acme/api', base: 'main', dir: 'x', branch: 'b', at: '' }],
  })
  const by = Object.fromEntries(rows.map((r) => [r.app.name, r]))
  assertEquals(by.web.journeys, ['j1'])
  assertEquals(by.web.personas, ['p1'])
  assertEquals(by.web.wireframes, ['w1'])
  assertEquals(by.web.designPrs, 1)
  assertEquals(by.web.tokens, 'project')
  assertEquals(by.web.score, 5)
  assertEquals(by.api.tokens, 'published')
  assertEquals(by.api.wireframes, [])
  assertEquals(by.docs.score, 1) // project tokens only
  assertEquals(rows[0].app.name, 'docs') // least covered first
  const s = coverageSummary(rows)
  assertEquals([s.apps, s.withJourneys, s.withWireframes, s.withDesigns, s.withTokens], [3, 2, 1, 1, 3])
})

Deno.test('activity by user counts edits in the window', () => {
  const since = new Date('2026-10-01T00:00:00Z')
  const rows = activityByUser([
    { key: 'a', title: 'A', ts: '2026-10-10T00:00:00Z', by: 'ann' },
    { key: 'b', title: 'B', ts: '2026-10-12T00:00:00Z', by: 'ann' },
    { key: 'c', title: 'C', ts: '2026-09-01T00:00:00Z', by: 'bob' },
    { key: 'd', title: 'D', ts: '2026-10-11T00:00:00Z', by: 'cy' },
    { key: 'e', title: 'E', ts: '2026-10-11T00:00:00Z', by: null },
  ], since)
  assertEquals(rows.map((r) => [r.user, r.count, r.lastTitle]), [['ann', 2, 'B'], ['cy', 1, 'D']])
})

/* ───── tokens ↔ code ───── */

const ws: TokenSet = {
  color: [{ name: '--c-primary', value: '#111111', role: 'brand' }, { name: '--c-bg', value: '#ffffff', role: 'bg' }],
  spacing: [{ name: '--s-1', value: '4px' }],
  typography: [], radius: [], elevation: [], motion: [], breakpoint: [],
}

Deno.test('project overrides: only differences are stored; workspace changes flow through', () => {
  const effective: TokenSet = { ...ws, color: [{ ...ws.color[0], value: '#ff0000' }, ws.color[1], { name: '--c-x', value: '#00ff00', role: '' }] }
  const ov = computeOverrides(ws, effective)
  assertEquals(ov.color?.map((c) => c.name), ['--c-primary', '--c-x'])
  assertEquals(ov.spacing, undefined)
  assertEquals(overrideCount(ov), 2)
  const nextWs: TokenSet = { ...ws, spacing: [{ name: '--s-1', value: '8px' }] }
  const merged = applyOverrides(nextWs, ov)
  assertEquals(merged.color.find((c) => c.name === '--c-primary')?.value, '#ff0000')
  assertEquals(merged.spacing[0].value, '8px')
  assertEquals(merged.color.length, 3)
  assertEquals(applyOverrides(ws, null), ws)
  assertEquals(droppedTokens(ws, { ...ws, color: [ws.color[0]] }), ['--c-bg'])
})

Deno.test('publish files: four files under a clean folder with headers', () => {
  const files = publishFiles(ws, '/./src//design-tokens/../', { version: 'v2', scope: 'shop', source: 'https://c/design' })
  assertEquals(files.map((f) => f.path), ['src/design-tokens/tokens.json', 'src/design-tokens/tokens.css', 'src/design-tokens/theme.css', 'src/design-tokens/tailwind.preset.js'])
  const json = JSON.parse(files[0].content)
  assertEquals(json.$description, 'Adhar Design tokens — shop, v2')
  assert(files[1].content.includes('--c-primary: #111111;'))
  assert(files[1].content.startsWith('/*\n * Generated by Adhar Design'))
  assert(files[2].content.includes('@theme {'))
  assert(files[3].content.includes('export default'))
  assertEquals(cleanDir(''), '')
  assertEquals(publishFiles(ws, '', { version: 'v', scope: 'w' })[0].path, 'tokens.json')
  assertEquals(publishBranch('My Shop!', new Date('2026-10-20T09:05:00Z')), 'design/tokens-my-shop-20261020-0905')
  assert(publishPrBody(files, { version: 'v2', scope: 'shop' }, { count: 3, overrides: 1 }).includes('`src/design-tokens/theme.css`'))
})

/* ───── repo component scan ───── */

Deno.test('component files and exports are parsed lexically', () => {
  assert(isComponentFile('src/components/ui/Button.tsx'))
  assert(!isComponentFile('src/components/Button.test.tsx'))
  assert(!isComponentFile('src/components/Button.stories.tsx'))
  assert(!isComponentFile('src/pages/Home.tsx'))
  assert(!isComponentFile('node_modules/x/components/A.tsx'))
  const src = `
    // export function Commented() {}
    /* export const Hidden = 1 */
    export function Card({ title }: Props) { return <div/> }
    export const Badge: FC<P> = (p) => <span/>
    export const helper = () => 1
    export class Legacy extends React.Component {}
    const Inner = () => null
    const Other = () => null
    export { Inner, Other as Renamed, type Props }
    export { Re } from './re'
    export default memo(Card)
  `
  assertEquals(parseComponentExports(src, 'src/components/card.tsx'), ['Badge', 'Card', 'Inner', 'Legacy', 'Renamed'])
  assertEquals(parseComponentExports('export default () => <div/>', 'src/components/user-menu.tsx'), ['UserMenu'])
  assertEquals(parseComponentExports('export default function Page() {}', 'x.tsx'), ['Page'])
  const usage = countJsxUsage('<Button x/> <Button>a</Button> <ButtonGroup/> <Card />', ['Button', 'Card', 'Modal'])
  assertEquals([...usage], [['Button', 2], ['Card', 1]])
})

/* ───── AI drafts ───── */

Deno.test('AI drafts are validated and normalised', () => {
  assertEquals(extractJson('Here:\n```json\n{"a":1}\n```\nbye'), { a: 1 })
  assertEquals(extractJson('noise [1,2] tail'), [1, 2])
  assertThrows(() => extractJson('no json here'))
  const p = toPersona({ name: ' Asha ', role: 'PM', goals: ['g', '', 3], behaviours: ['b'], tools: ['Jira'], segments: ['smb'] })
  assertEquals([p.name, p.goals, p.behaviors, p.tech, p.tags], ['Asha', ['g', '3'], ['b'], ['Jira'], ['smb']])
  assertThrows(() => toPersona({ role: 'x' }))
  let n = 0
  const st = toStages({ stages: [{ name: 'A', emotion: 'EXCITED', score: 3.3, pains: ['p'] }, { emotion: 'nope' }] }, (pre) => `${pre}-${++n}`)
  assertEquals(st.map((s) => [s.id, s.name, s.emotion, s.score]), [['stage-1', 'A', 'excited', 2], ['stage-2', 'Stage', 'reflective', undefined]])
  const pal = toPalette({ colors: [{ name: 'Primary', value: '#4F46E5', dark: '#818cf8', role: 'brand' }, { name: 'bad', value: 'red' }, { name: '--adhar-color-primary', value: '#000' }] })
  assertEquals(pal, [{ name: '--adhar-color-primary', value: '#4f46e5', role: 'brand', dark: '#818cf8' }])
})

/* ───── scope ───── */

Deno.test('scope matcher: shared always, project strict, team lens otherwise', () => {
  const lens = { filtering: true, team: 'core', projects: [{ slug: 'shop', teams: ['core'] }, { slug: 'ops', teams: ['infra'] }] }
  const byTeam = scopeMatcher('', lens)
  assert(byTeam(undefined))
  assert(byTeam({ project: 'shop' }))
  assert(!byTeam({ project: 'ops' }))
  assert(byTeam({ team: 'core' }))
  const byProject = scopeMatcher('shop', lens)
  assert(byProject({ project: 'shop', team: 'core' }))
  assert(!byProject({ project: 'ops' }))
  assert(byProject({ team: 'core' })) // team-only artifact of a team that owns the project
  assert(!byProject({ team: 'infra' }))
  assert(scopeMatcher('', { filtering: false, team: '', projects: [] })({ project: 'x' }))
})

Deno.test('catalog apps narrow to the scope by slug or Argo CD project', () => {
  const apps = [{ name: 'a', project: 'shop', repoUrl: 'acme/a' }, { name: 'b', project: 'argo-ops', repoUrl: 'https://g/acme/b.git' }, { name: 'c', repoUrl: '' }]
  const projects = [{ slug: 'shop' }, { slug: 'ops', argoProject: 'argo-ops' }]
  assertEquals(scopedApps(apps, null, projects).length, 3)
  assertEquals(scopedApps(apps, new Set(['ops']), projects).map((a) => a.name), ['b'])
  assertEquals(appProjectSlug(apps[1], projects), 'ops')
  assertEquals(appRepo(apps[1], 'org'), 'acme/b')
  assertEquals(appRepo({ name: 'x', repoUrl: 'just-a-name' }, 'org'), 'org/just-a-name')
})

/* ───── analytics ───── */

Deno.test('journey funnel: one step per stage with an event; conversion per stage', () => {
  const steps = journeySteps(journey)
  assertEquals(steps.map((s) => [s.stageId, s.event]), [['s1', '$pageview'], ['s2', 'deploy_started']])
  const q = buildJourneyFunnel(steps, { cohortId: '7', range: '-90d' })
  assertEquals((q.series as unknown[]).length, 2)
  assertEquals(q.properties, [{ type: 'cohort', key: 'id', value: 7 }])
  assertEquals((q.dateRange as { date_from: string }).date_from, '-90d')
  const conv = stageConversion(steps, [{ order: 1, count: 25 }, { order: 0, count: 100 }])
  assertEquals(conv.map((c) => [c.count, c.fromStart, c.fromPrevious]), [[100, 1, 1], [25, 0.25, 0.25]])
  assertEquals(stageConversion(steps, [[{ order: 0, count: 0 }, { order: 1, count: 0 }]]).map((c) => c.fromStart), [0, 0])
  assertEquals(stageConversion(steps, [{ order: 0, count: 1 }]), []) // shape mismatch → nothing, not a guess
})

Deno.test('cohort person sample summary keeps real values only', () => {
  const s = summarizePersons([
    { properties: { $os: 'Mac OS X', $browser: 'Chrome' } },
    { properties: { $os: 'Mac OS X', $browser: '' } },
    { properties: { $os: 'Windows' } },
  ])
  assertEquals(s.sampled, 3)
  assertEquals(s.props.map((p) => [p.label, p.top]), [['OS', [{ value: 'Mac OS X', n: 2 }, { value: 'Windows', n: 1 }]], ['Browser', [{ value: 'Chrome', n: 1 }]]])
})
