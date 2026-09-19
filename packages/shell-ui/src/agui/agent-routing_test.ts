import { assertEquals } from 'jsr:@std/assert'
import { agentForRoute, resolveInitialAgent } from './agent-routing.ts'

const ALL = ['sre', 'delivery', 'security', 'finops', 'platform', 'review', 'design', 'adhar-ai']

Deno.test('each phase opens with the agent that reads its data', () => {
  assertEquals(agentForRoute({ path: '/design' }), 'design')
  assertEquals(agentForRoute({ path: '/develop', section: 'prs' }), 'review')
  assertEquals(agentForRoute({ path: '/deliver', section: 'apps' }), 'delivery')
  assertEquals(agentForRoute({ path: '/discover', section: 'logs' }), 'sre')
  assertEquals(agentForRoute({ path: '/decide', section: 'spend' }), 'finops')
  assertEquals(agentForRoute({ path: '/platform', section: 'pods' }), 'platform')
})

Deno.test('the section overrides the phase where the two disagree', () => {
  // Vulnerability scans live under Deliver but are a security question.
  assertEquals(agentForRoute({ path: '/deliver', section: 'scans' }), 'security')
  assertEquals(agentForRoute({ path: '/deliver', section: 'policy' }), 'security')
  assertEquals(agentForRoute({ path: '/platform', section: 'rbac' }), 'security')
  // CI is a delivery concern even though it is rendered by the platform module.
  assertEquals(agentForRoute({ path: '/platform', section: 'ci' }), 'delivery')
  assertEquals(agentForRoute({ path: '/platform', section: 'chaos' }), 'sre')
})

Deno.test('pages with no agent that reads them suggest nothing', () => {
  // Nothing reads Plane, so pretending an agent fits Define would be a lie.
  assertEquals(agentForRoute({ path: '/define', section: 'issues' }), null)
  assertEquals(agentForRoute({ path: '/catalog' }), null)
  assertEquals(agentForRoute({ path: '/settings' }), null)
  assertEquals(agentForRoute({ path: '/ai' }), null)
  assertEquals(agentForRoute({ path: '/' }), null)
})

Deno.test('an explicit choice always wins over the route', () => {
  // The property that keeps this from being infuriating.
  assertEquals(resolveInitialAgent('finops', { path: '/develop', section: 'prs' }, ALL, 'sre'), 'finops')
  assertEquals(resolveInitialAgent('sre', { path: '/design' }, ALL, 'sre'), 'sre')
})

Deno.test('with no stored choice the route decides, else the fallback', () => {
  assertEquals(resolveInitialAgent(null, { path: '/develop', section: 'prs' }, ALL, 'sre'), 'review')
  assertEquals(resolveInitialAgent(null, { path: '/catalog' }, ALL, 'sre'), 'sre')
})

Deno.test('never routes to an agent the server does not offer', () => {
  // Review and Design are absent on an install without Gitea. Selecting one
  // would leave the switcher pointing at nothing.
  const noSource = ['sre', 'delivery', 'security', 'finops', 'platform']
  assertEquals(resolveInitialAgent(null, { path: '/develop', section: 'prs' }, noSource, 'sre'), 'sre')
  assertEquals(resolveInitialAgent(null, { path: '/design' }, noSource, 'sre'), 'sre')
  // A stale stored choice for a removed agent falls back too.
  assertEquals(resolveInitialAgent('review', { path: '/discover' }, noSource, 'sre'), 'sre')
})

Deno.test('falls back to the first available agent when even the fallback is gone', () => {
  assertEquals(resolveInitialAgent(null, { path: '/catalog' }, ['platform'], 'sre'), 'platform')
})

Deno.test('case and trailing segments do not defeat the match', () => {
  assertEquals(agentForRoute({ path: '/Develop', section: 'PRs' }), 'review')
  assertEquals(agentForRoute({ path: '/platform/extra' }), 'platform')
})
