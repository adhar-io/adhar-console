import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { gitea, type k8s } from '@adhar/api-clients';
import { useGiteaOrg, usePollingInterval } from '@adhar/shell-ui';
import { useCRD } from './k8s.ts';
import { harborClient, k8sClient, kargoClient } from './delivery.ts';
import { type AppXR, CONTROL_PLANE_NS } from './value-stream.ts';

/**
 * Data layer for the **Delivery Flow** value-stream view (see
 * `value-stream.ts` for the model). Every hook errors honestly — no fake
 * fallbacks — and the view turns each source's error into that stage's own
 * "forbidden" / "unreachable" / "not installed" state.
 *
 *  - Gitea (Code + Pull request) via the BFF tool proxy.
 *  - Tekton PipelineRuns (Build + Scan gate) — the app-ci trigger creates
 *    them in `adhar-system`, labelled `adhar.io/app=<app>`.
 *  - Harbor artifacts (Image, signatures).
 *  - Kargo warehouses / freight / stages / promotions (cluster-wide).
 *  - Application + Project XRs (`platform.adhar.io`) — the app list and the
 *    control plane's own reasons when nothing is deployed.
 */

export const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' });

const REFRESH_MS = 15_000;
const SLOW_MS = 30_000;

export type CRDObject = k8s.Generic;

export const FLOW_GVRS = {
  tektonPipelineRuns: {
    group: 'tekton.dev',
    version: 'v1',
    resource: 'pipelineruns',
    namespaced: true,
  },
  applications: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'applications',
    namespaced: true,
  },
  projects: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'projects',
    namespaced: true,
  },
} as const satisfies Record<string, k8s.GVR>;

/* ─────────── Gitea ─────────── */

export function useGiteaRepos() {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['flow', 'gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    staleTime: SLOW_MS,
    refetchInterval: usePollingInterval(SLOW_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useGiteaCommits(repo?: string, ref?: string, limit = 30) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['flow', 'gitea', 'commits', org, repo, ref, limit],
    queryFn: () => giteaClient.listCommits(org, repo!, ref, limit),
    enabled: !!repo,
    refetchInterval: usePollingInterval(REFRESH_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useGiteaPulls(repo?: string) {
  const org = useGiteaOrg();
  return useQuery({
    queryKey: ['flow', 'gitea', 'pulls', org, repo],
    queryFn: () => giteaClient.listPullRequests(org, repo!, 'all'),
    enabled: !!repo,
    refetchInterval: usePollingInterval(REFRESH_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/* ─────────── Tekton ─────────── */

/** PipelineRuns in the CI namespace (where the app-ci EventListener creates them). */
export function useCiRuns() {
  return useCRD(FLOW_GVRS.tektonPipelineRuns, CONTROL_PLANE_NS);
}

/* ─────────── control plane XRs ─────────── */

/** Application XRs. Errors propagate (403 / 404 are states the view reports). */
export function useApplicationXRs() {
  return useQuery({
    queryKey: ['flow', 'xr', 'applications'],
    queryFn: async () =>
      (await k8sClient.listGeneric(
        undefined,
        FLOW_GVRS.applications,
        CONTROL_PLANE_NS,
      )) as unknown as AppXR[],
    refetchInterval: usePollingInterval(SLOW_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useProjectXRs() {
  return useQuery({
    queryKey: ['flow', 'xr', 'projects'],
    queryFn: async () =>
      (await k8sClient.listGeneric(
        undefined,
        FLOW_GVRS.projects,
        CONTROL_PLANE_NS,
      )) as unknown as Array<
        {
          metadata: { name: string; labels?: Record<string, string> };
          spec?: Record<string, unknown>;
          status?: Record<string, unknown>;
        }
      >,
    refetchInterval: usePollingInterval(SLOW_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/* ─────────── Kargo + Harbor ─────────── */

/** Every Warehouse the user can see (each app's is `<project>/<app>`). */
export function useAllWarehouses() {
  return useQuery({
    queryKey: ['kargo', 'warehouses', '*all*'],
    queryFn: () => kargoClient.listWarehouses(''),
    refetchInterval: usePollingInterval(SLOW_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Artifacts of one Harbor repository (`<project>/<path>`), with accessories (signatures). */
export function useImageArtifacts(repo?: string) {
  const slash = repo?.indexOf('/') ?? -1;
  const project = slash > 0 ? repo!.slice(0, slash) : '';
  const path = slash > 0 ? repo!.slice(slash + 1) : '';
  return useQuery({
    queryKey: ['flow', 'harbor', 'artifacts', project, path],
    queryFn: () => harborClient.listArtifacts(project, path),
    enabled: Boolean(project && path),
    refetchInterval: usePollingInterval(SLOW_MS),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
