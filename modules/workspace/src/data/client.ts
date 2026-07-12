import { workspace } from '@adhar-console/api-clients'

/**
 * v1 uses the stub directly; production swaps this for a singleton that resolves
 * `.create({ baseUrl: '/api', token })` against the console's BFF.
 */
export const wsClient = workspace.WorkspaceClient.stub()

export const CURRENT_ORG_SLUG = 'acme'
