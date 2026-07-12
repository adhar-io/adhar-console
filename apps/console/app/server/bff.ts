import {
  argocd,
  argoRollouts,
  argoWorkflows,
  crossplane,
  gitea,
  harbor,
  k8s,
  kargo,
  kyverno,
  lgtm,
  plane,
} from '@adhar-console/api-clients'

/**
 * BFF facade — plain async functions.
 *
 * Why plain functions and not `createServerFn`?
 *
 * Right now every backing tool is a stub (in-memory fixtures, no tokens),
 * so calling it from the client is harmless and lets dev mode work without
 * TanStack Start's SSR runtime — which is disabled in dev because of a
 * known `@module-federation/vite` × Vite-7 SSR module runner clash.
 *
 * When the real clients land (Keycloak-mediated tokens, cluster access),
 * wrap these in `createServerFn(...)` so the tokens live server-only.
 */

const clients = {
  gitea: gitea.GiteaClient.stub(),
  plane: plane.PlaneClient.stub(),
  argocd: argocd.ArgoCDClient.stub(),
  kargo: kargo.KargoClient.stub(),
  harbor: harbor.HarborClient.stub(),
  k8s: k8s.K8sClient.stub(),
  kyverno: kyverno.KyvernoClient.stub(),
  crossplane: crossplane.CrossplaneClient.stub(),
  argoWorkflows: argoWorkflows.ArgoWorkflowsClient.stub(),
  argoRollouts: argoRollouts.ArgoRolloutsClient.stub(),
  lgtm: lgtm.LgtmClient.stub(),
}

export const listRepos = (input: { org: string }) => clients.gitea.listRepos(input.org)

export const listClusters = () => clients.k8s.listClusters()

export const listPods = (input: { cluster: string; namespace?: string }) =>
  clients.k8s.listPods(input.cluster, input.namespace)

export const listDeployments = (input: { cluster: string; namespace?: string }) =>
  clients.k8s.listDeployments(input.cluster, input.namespace)

export const listEvents = (input: { cluster: string; namespace?: string }) =>
  clients.k8s.listEvents(input.cluster, input.namespace)

export const listApplications = () => clients.argocd.listApplications()

export const listStages = (input: { project: string }) =>
  clients.kargo.listStages(input.project)

export const listWorkflows = (input: { namespace: string }) =>
  clients.argoWorkflows.listWorkflows(input.namespace)

export const listRollouts = (input: { namespace?: string } = {}) =>
  clients.argoRollouts.listRollouts(input.namespace)

export const listPolicyReports = (input: { namespace?: string } = {}) =>
  clients.kyverno.listPolicyReports(input.namespace)

export const listCompositions = () => clients.crossplane.listCompositions()

export const grafanaEmbedUrl = (input: { uid: string }) => ({
  url: clients.lgtm.grafanaEmbedUrl(input.uid),
})
