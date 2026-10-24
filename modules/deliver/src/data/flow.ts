import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { gitea, type k8s } from '@adhar/api-clients';
import { useGiteaOrg, useLiveToolPoll } from '@adhar/shell-ui';
import { useCRD } from './k8s.ts';
import { harborClient, k8sClient, kargoClient, kargoWatch } from './delivery.ts';
import { useWatchSignal } from './live.ts';
import { APPLICATION_XR_WATCH, PROJECT_XR_WATCH } from './project-environments.ts';
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

/** Tool REST data with no watch: the BFF checks it once a minute and pushes only on change. */
const TOOL_POLL_MS = 60_000;

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
    // The repo list only changes when an app is created; read once per visit.
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useGiteaCommits(repo?: string, ref?: string, limit = 30) {
  const org = useGiteaOrg();
  const queryKey = ['flow', 'gitea', 'commits', org, repo, ref, limit];
  // Change signal = the head commit of the branch (one tiny read, BFF-side).
  const signal = repo
    ? `/api/v1/repos/${org}/${repo}/commits?limit=1&stat=false&files=false&verification=false${ref ? `&sha=${encodeURIComponent(ref)}` : ''}`
    : '';
  return useQuery({
    queryKey,
    queryFn: () => giteaClient.listCommits(org, repo!, ref, limit),
    enabled: !!repo,
    refetchInterval: useLiveToolPoll('gitea', signal, TOOL_POLL_MS, [queryKey], { enabled: !!repo }),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useGiteaPulls(repo?: string) {
  const org = useGiteaOrg();
  const queryKey = ['flow', 'gitea', 'pulls', org, repo];
  // Most recently updated PRs — any open / merge / new push moves this page.
  const signal = repo ? `/api/v1/repos/${org}/${repo}/pulls?state=all&sort=recentupdate&limit=5` : '';
  return useQuery({
    queryKey,
    queryFn: () => giteaClient.listPullRequests(org, repo!, 'all'),
    enabled: !!repo,
    refetchInterval: useLiveToolPoll('gitea', signal, TOOL_POLL_MS, [queryKey], { enabled: !!repo }),
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
    refetchInterval: useWatchSignal(APPLICATION_XR_WATCH, [['flow', 'xr', 'applications']]),
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
    refetchInterval: useWatchSignal(PROJECT_XR_WATCH, [['flow', 'xr', 'projects']]),
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
    refetchInterval: useWatchSignal(kargoWatch('warehouses'), [['kargo', 'warehouses']]),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Artifacts of one Harbor repository (`<project>/<path>`), with accessories (signatures). */
export function useImageArtifacts(repo?: string) {
  const slash = repo?.indexOf('/') ?? -1;
  const project = slash > 0 ? repo!.slice(0, slash) : '';
  const path = slash > 0 ? repo!.slice(slash + 1) : '';
  const queryKey = ['flow', 'harbor', 'artifacts', project, path];
  // Newest artifact (with its accessories) is the change signal: a push, a
  // signature or a finished scan all show up on it.
  const signal = project && path
    ? `/api/v2.0/projects/${encodeURIComponent(project)}/repositories/${encodeURIComponent(encodeURIComponent(path))}/artifacts?page_size=3&sort=-push_time&with_tag=true&with_scan_overview=true&with_signature=true&with_accessory=true`
    : '';
  return useQuery({
    queryKey,
    queryFn: () => harborClient.listArtifacts(project, path),
    enabled: Boolean(project && path),
    refetchInterval: useLiveToolPoll('harbor', signal, TOOL_POLL_MS, [queryKey], { enabled: Boolean(project && path) }),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
