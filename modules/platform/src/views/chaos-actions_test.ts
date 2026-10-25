import { assertEquals } from 'jsr:@std/assert'
import { shouldShowGlobalNewExperimentAction, type ChaosTab } from './chaos-actions.ts'

Deno.test('hides global New experiment action on overview tab', () => {
  const visible = shouldShowGlobalNewExperimentAction({ tab: 'overview', canLaunch: true, installed: true })
  assertEquals(visible, false)
})

Deno.test('shows global New experiment action on non-overview tabs when launch is allowed', () => {
  const tabs: ChaosTab[] = ['experiments', 'suites', 'gamedays', 'reports', 'library']
  for (const tab of tabs) {
    const visible = shouldShowGlobalNewExperimentAction({ tab, canLaunch: true, installed: true })
    assertEquals(visible, true)
  }
})

Deno.test('hides global New experiment action when launch is not allowed or Litmus is not installed', () => {
  assertEquals(shouldShowGlobalNewExperimentAction({ tab: 'experiments', canLaunch: false, installed: true }), false)
  assertEquals(shouldShowGlobalNewExperimentAction({ tab: 'experiments', canLaunch: true, installed: false }), false)
})
