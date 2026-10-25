export type ChaosTab = 'overview' | 'experiments' | 'suites' | 'gamedays' | 'reports' | 'library'

export function shouldShowGlobalNewExperimentAction(input: { tab: ChaosTab; canLaunch: boolean; installed: boolean }): boolean {
  return input.canLaunch && input.installed && input.tab !== 'overview'
}
