import { kargo } from '@adhar/api-clients';
import type { argocd, argoRollouts, gitea, harbor } from '@adhar/api-clients';
import { appCategory, isPlatformApp, packageName } from './app-category.ts';
import { looksLikeSha, revisionOf, shaEq } from './commit-journey.ts';

/**
 * The Delivery Flow's model — a value stream of the applications TEAMS build.
 *
 * The view used to start from Argo CD Applications filtered to those without
 * an `adhar.io/category` label. Every Argo CD app the platform's
 * ApplicationSets create carries one, and a team's app is not one Argo CD app
 * but one PER ENVIRONMENT (`<project>-<app>-<env>`), so the list was always
 * empty ("No custom applications — all 77 are platform packages") or, when an
 * app did show up, each environment was treated as a separate service whose
 * repository was looked up by the Argo CD app's name — which never matched.
 *
 * Here an application is what the control plane says it is:
 *
 *  - an Application XR (`platform.adhar.io/v1alpha1`, `adhar-system`) — names
 *    an app before anything is deployed, and carries the conditions that say
 *    why nothing is;
 *  - Argo CD apps labelled `adhar.io/application` (+ `adhar.io/project`,
 *    `adhar.io/environment`) — one per environment, grouped into one app;
 *  - as a fallback, a Gitea repository that is not platform infrastructure.
 *
 * Every stage is derived from the real source that owns it, and a source that
 * is unreachable or forbidden says so at its own stage — nothing is inferred
 * from a neighbour, and nothing is invented.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

/* ─────────── source state ─────────── */

export type SourceStatus = 'ok' | 'loading' | 'forbidden' | 'unreachable' | 'not-installed';

/** One backend's answer: its data, or why there is none. */
export interface Src<T> {
  status: SourceStatus;
  data?: T;
  message?: string;
}

export const ok = <T>(data: T): Src<T> => ({ status: 'ok', data });

/** Classify a fetch error by its HTTP status (the shared HttpError carries `.status`). */
export function errorStatus(err: unknown): SourceStatus {
  const s = (err as { status?: number } | null)?.status;
  if (s === 401 || s === 403) return 'forbidden';
  if (s === 404) return 'not-installed';
  return 'unreachable';
}

/** A react-query-shaped result → `Src`. Cached data wins over a failed background refetch. */
export function toSrc<T>(
  q: { data?: T; isLoading?: boolean; isError?: boolean; error?: unknown },
): Src<T> {
  if (q.data !== undefined) return { status: 'ok', data: q.data };
  if (q.isError) {
    return {
      status: errorStatus(q.error),
      message: q.error instanceof Error ? q.error.message : undefined,
    };
  }
  return { status: 'loading' };
}

/** Human words for an unavailable source. */
export function sourceProblem(tool: string, s: Src<unknown>): string | undefined {
  switch (s.status) {
    case 'forbidden':
      return `You are not allowed to read ${tool}.`;
    case 'unreachable':
      return `${tool} is not reachable${s.message ? ` — ${s.message}` : '.'}`;
    case 'not-installed':
      return `${tool} is not installed on this cluster.`;
    default:
      return undefined;
  }
}

/* ─────────── applications ─────────── */

export const CONTROL_PLANE_NS = 'adhar-system';

/**
 * Gitea repositories that are platform infrastructure, not a team's software.
 * The same set the supply chain's app-ci trigger skips (mirrors the console's
 * `catalog-platform-repos.ts`, which this module cannot import).
 */
export const PLATFORM_REPOS = new Set([
  'packages',
  'environments',
  'templates',
  'adhar-templates',
  'adhar-ui',
  'adhar-kit',
  'adhar',
]);

export function isPlatformRepo(
  name: string | undefined,
  repo?: { mirror?: boolean; template?: boolean },
): boolean {
  if (repo?.mirror || repo?.template) return true;
  return PLATFORM_REPOS.has((name ?? '').toLowerCase());
}

export interface XRCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** The Application XR fields read here. */
export interface AppXR {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    parameters?: {
      project?: string;
      displayName?: string;
      description?: string;
      source?: { repoURL?: string; path?: string; targetRevision?: string };
    };
  };
  status?: { conditions?: XRCondition[]; phase?: string; message?: string };
}

export interface FlowApp {
  /** `<project>/<app>` — the deep-link value. Project is empty when nothing names one. */
  key: string;
  project: string;
  name: string;
  displayName?: string;
  /** Where the app is known from. */
  from: Array<'xr' | 'argo' | 'repo'>;
  xr?: AppXR;
  /** Its Argo CD apps — one per environment. */
  argoApps: argocd.Application[];
  /** The Gitea repository the app is built from, when one can be named. */
  repo?: string;
}

const lower = (v: string | undefined) => (v ?? '').trim().toLowerCase();

/** The project an Application XR belongs to (the control plane maps `default`/empty to `adhar`). */
export function xrProject(x: AppXR): string {
  const p = lower(x.spec?.parameters?.project ?? x.metadata.labels?.[kargo.LABEL_PROJECT]);
  return !p || p === 'default' ? 'adhar' : p;
}

/** `https://gitea.x/org/repo.git` → `repo`. */
export function repoNameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const s = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const last = s.split('/').filter(Boolean).pop();
  return last ? last.toLowerCase() : undefined;
}

/** Environment names the platform uses — for reading unlabelled `<project>-<app>-<env>` names. */
const KNOWN_ENVS = [
  'dev',
  'development',
  'test',
  'qa',
  'uat',
  'staging',
  'stage',
  'stg',
  'preview',
  'sandbox',
  'canary',
  'prod',
  'production',
];

export interface CollectInput {
  xrs: readonly AppXR[];
  argoApps: readonly argocd.Application[];
  repos: readonly Pick<gitea.Repo, 'name' | 'mirror' | 'template' | 'archived' | 'empty'>[];
  /** Project names known from Project XRs (to read unlabelled Argo CD app names). */
  projects?: readonly string[];
}

/**
 * Every team application, grouped: Application XRs ∪ Argo CD apps labelled
 * `adhar.io/application` ∪ non-platform Gitea repositories. Platform packages
 * (`adhar.io/category`) are never included.
 */
export function collectApps(input: CollectInput): FlowApp[] {
  const byKey = new Map<string, FlowApp>();
  const get = (project: string, name: string): FlowApp => {
    const key = `${project}/${name}`;
    let a = byKey.get(key);
    if (!a) byKey.set(key, a = { key, project, name, from: [], argoApps: [] });
    return a;
  };
  const mark = (a: FlowApp, f: FlowApp['from'][number]) => {
    if (!a.from.includes(f)) a.from.push(f);
  };

  for (const x of input.xrs) {
    const name = lower(x.metadata.name);
    if (!name) continue;
    const a = get(xrProject(x), name);
    a.xr = x;
    a.displayName = x.spec?.parameters?.displayName || undefined;
    mark(a, 'xr');
    // The XR's source may be the app's repository — or a GitOps repo the
    // platform seeds, which is not where the app is built from.
    const fromSource = repoNameOf(x.spec?.parameters?.source?.repoURL);
    if (fromSource && !isPlatformRepo(fromSource)) a.repo = fromSource;
  }

  const projects = new Set(
    [...(input.projects ?? []), ...[...byKey.values()].map((a) => a.project)].map(lower).filter(
      Boolean,
    ),
  );
  for (const app of input.argoApps) {
    if (isPlatformApp(app)) continue;
    const l = app.metadata.labels ?? {};
    const labelled = lower(l[kargo.LABEL_APPLICATION]);
    if (labelled) {
      let p = lower(l[kargo.LABEL_PROJECT]);
      if (!p || p === 'default') p = 'adhar';
      const a = get(p, labelled);
      a.argoApps.push(app);
      mark(a, 'argo');
      continue;
    }
    // An unlabelled `<project>-<app>-<env>` (an older control plane).
    const n = lower(app.metadata.name);
    const p = [...projects].sort((x, y) => y.length - x.length).find((pr) =>
      n.startsWith(`${pr}-`)
    );
    const env = KNOWN_ENVS.find((e) => n.endsWith(`-${e}`));
    if (p && env && n.length > p.length + env.length + 2) {
      const a = get(p, n.slice(p.length + 1, -(env.length + 1)));
      a.argoApps.push(app);
      mark(a, 'argo');
      continue;
    }
    // A team's own Argo CD app the control plane did not compose.
    const a = get(lower(app.spec.project) === 'default' ? '' : lower(app.spec.project), n);
    a.argoApps.push(app);
    mark(a, 'argo');
  }

  const claimed = new Set<string>();
  for (const a of byKey.values()) {
    claimed.add(a.name);
    if (a.repo) claimed.add(a.repo);
  }
  for (const r of input.repos) {
    const name = lower(r.name);
    if (!name || r.archived || isPlatformRepo(name, r) || claimed.has(name)) continue;
    const a = get('', name);
    a.repo = name;
    mark(a, 'repo');
  }

  return [...byKey.values()].sort((x, y) =>
    x.project.localeCompare(y.project) || x.name.localeCompare(y.name)
  );
}

/** The Gitea repository an app is built from — only one that actually exists. */
export function resolveRepo<R extends Pick<gitea.Repo, 'name'>>(
  app: FlowApp,
  repos: readonly R[],
): R | undefined {
  const find = (n?: string) => (n ? repos.find((r) => lower(r.name) === lower(n)) : undefined);
  return find(app.repo) ?? find(app.name);
}

/**
 * Narrow to the active team's projects (Org → Team → Project → App). A lens,
 * never a boundary: when the team owns none of these projects nothing is hidden.
 */
export function teamApps(
  apps: readonly FlowApp[],
  team: { filtering: boolean; slugs: ReadonlySet<string> },
): FlowApp[] {
  if (!team.filtering || !team.slugs.size) return [...apps];
  const mine = apps.filter((a) => team.slugs.has(a.project));
  return mine.length ? mine : [...apps];
}

/** `<project>/<app>` → the app, tolerating a bare app name. */
export function findApp(apps: readonly FlowApp[], key: string | undefined): FlowApp | undefined {
  if (!key) return undefined;
  const k = lower(key);
  return apps.find((a) => a.key === k) ?? apps.find((a) => a.name === k);
}

/* ─────────── pipeline runs ─────────── */

export type RunState = 'succeeded' | 'failed' | 'cancelled' | 'running' | 'pending';
export type GateState =
  | 'none'
  | 'awaiting'
  | 'passed'
  | 'warned'
  | 'failed'
  | 'approved'
  | 'rejected';

export interface ScanCounts {
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  unknown?: number;
  fixable?: number;
}

export interface RunView {
  name: string;
  namespace: string;
  pipeline?: string;
  state: RunState;
  reason?: string;
  message?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationSec?: number;
  commit?: string;
  /** A pull request's head branch (`git-ref`), when the run built one. */
  gitRef?: string;
  trigger: 'push' | 'pull-request' | 'manual';
  image?: string;
  digest?: string;
  gate: GateState;
  summary?: ScanCounts;
  decision?: { value: 'approved' | 'rejected'; by?: string; at?: string; comment?: string };
  /** Tekton Chains signed the run's outputs. */
  chainsSigned?: boolean;
}

interface RawRun {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: { pipelineRef?: { name?: string }; params?: Array<{ name?: string; value?: unknown }> };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    startTime?: string;
    completionTime?: string;
    results?: Array<{ name?: string; value?: unknown }>;
    pipelineResults?: Array<{ name?: string; value?: unknown }>;
    childReferences?: Array<{ name?: string; pipelineTaskName?: string }>;
  };
}

function param(run: RawRun, ...names: string[]): string | undefined {
  for (const p of run.spec?.params ?? []) {
    if (p.name && names.includes(p.name) && typeof p.value === 'string' && p.value) return p.value;
  }
  return undefined;
}

const RUN_PREFIXES = ['app-ci-', 'app-pr-ci-', ''];

/**
 * Whether a PipelineRun built this app. The app-ci trigger labels its runs
 * `adhar.io/app=<repo>`; a run labelled for a DIFFERENT app is never ours,
 * even when it ran the same shared pipeline.
 */
export function runIsForApp(obj: unknown, names: readonly string[]): boolean {
  const run = obj as RawRun;
  const want = new Set(names.map(lower).filter(Boolean));
  if (!want.size) return false;
  const l = run.metadata?.labels ?? {};
  const label = lower(l['adhar.io/app'] ?? l['adhar.io/application'] ?? l['adhar.io/component']);
  if (label) return want.has(label);
  const bare = param(run, 'repo-name', 'repoName', 'app-name', 'app');
  if (bare) return want.has(lower(bare));
  const url = param(run, 'repo-url', 'git-url', 'url');
  if (url) return want.has(repoNameOf(url) ?? '');
  const rn = lower(run.metadata?.name);
  for (const n of want) {
    for (const prefix of RUN_PREFIXES) {
      if (!prefix) continue;
      if (rn === `${prefix}${n}` || rn.startsWith(`${prefix}${n}-`)) return true;
    }
  }
  return false;
}

const resultStr = (
  v: unknown,
) => (typeof v === 'string'
  ? v
  : Array.isArray(v)
  ? v.join(',')
  : v != null
  ? JSON.stringify(v)
  : '');
const COUNT_KEYS: Array<[keyof ScanCounts, RegExp]> = [
  ['critical', /^(vuln[-_])?critical([-_]count)?$/i],
  ['high', /^(vuln[-_])?high([-_]count)?$/i],
  ['medium', /^(vuln[-_])?medium([-_]count)?$/i],
  ['low', /^(vuln[-_])?low([-_]count)?$/i],
  ['unknown', /^(vuln[-_])?unknown([-_]count)?$/i],
  ['fixable', /^(vuln[-_])?fixable([-_]count)?$/i],
];
const GATE_TASK = /(^|[-_])scan[-_]?(approval|gate)($|[-_])/i;
const SHA = /^[0-9a-f]{7,40}$/i;

/** One PipelineRun → what the flow needs: state, timing, commit, image, scan gate. */
export function readRun(obj: unknown, now = Date.now()): RunView {
  const run = obj as RawRun;
  const conds = run.status?.conditions ?? [];
  const c = conds.find((x) => x.type === 'Succeeded');
  let state: RunState;
  if (!c) state = run.status?.startTime ? 'running' : 'pending';
  else if (c.status === 'True') state = 'succeeded';
  else if (c.status === 'False') state = /cancel/i.test(c.reason ?? '') ? 'cancelled' : 'failed';
  else state = 'running';
  const done = state === 'succeeded' || state === 'failed' || state === 'cancelled';

  const startedAt = run.status?.startTime;
  const completedAt = run.status?.completionTime;
  const s = startedAt ? Date.parse(startedAt) : NaN;
  const e = completedAt ? Date.parse(completedAt) : !done ? now : NaN;
  const durationSec = Number.isFinite(s) && Number.isFinite(e)
    ? Math.max(0, Math.round((e - s) / 1000))
    : undefined;

  const ann = run.metadata?.annotations ?? {};
  const labels = run.metadata?.labels ?? {};
  const results = [...(run.status?.results ?? []), ...(run.status?.pipelineResults ?? [])];

  let image: string | undefined;
  let digest: string | undefined;
  let gateResult: string | undefined;
  const summary: ScanCounts = {};
  let counted = false;
  for (const r of results) {
    const name = (r.name ?? '').trim();
    const raw = resultStr(r.value).trim();
    if (/^scan[-_]?summary$/i.test(name)) {
      try {
        const j = JSON.parse(raw) as Record<string, unknown>;
        for (const [k] of COUNT_KEYS) {
          const n = Number(j[k] ?? j[k.toUpperCase()] ?? j[`vuln_${k}`]);
          if (Number.isFinite(n)) {
            summary[k] = n;
            counted = true;
          }
        }
        if (typeof j.gate === 'string') gateResult = j.gate.toLowerCase();
      } catch { /* not JSON */ }
      continue;
    }
    if (/^scan[-_]?(gate|decision)$/i.test(name) || /^gate[-_]?result$/i.test(name)) {
      gateResult = raw.toLowerCase();
      continue;
    }
    if (/^image[-_]?digest$/i.test(name) && /^sha256:[a-f0-9]{64}$/.test(raw)) digest = raw;
    else if (/^(image[-_]?url|image)$/i.test(name) && raw) image = raw;
    for (const [k, re] of COUNT_KEYS) {
      if (re.test(name) && Number.isFinite(Number(raw)) && raw !== '') {
        summary[k] = Number(raw);
        counted = true;
      }
    }
  }
  if (!image) image = param(run, 'image', 'image-url', 'IMAGE');

  const decisionRaw = lower(ann['adhar.io/scan-approval']);
  const decision = decisionRaw === 'approved' || decisionRaw === 'rejected'
    ? {
      value: decisionRaw as 'approved' | 'rejected',
      by: ann['adhar.io/scan-approval-by'],
      at: ann['adhar.io/scan-approval-at'],
      comment: ann['adhar.io/scan-approval-comment'],
    }
    : undefined;
  const published = lower(ann['adhar.io/scan-gate'] ?? gateResult);
  const gateTaskRunning = !done &&
    (run.status?.childReferences ?? []).some((x) => GATE_TASK.test(x.pipelineTaskName ?? ''));
  let gate: GateState = 'none';
  if (decision) gate = decision.value;
  else if (/^(awaiting(-approval)?|pending(-approval)?)$/.test(published)) {
    gate = done ? 'none' : 'awaiting';
  } else if (gateTaskRunning) gate = 'awaiting';
  else if (/^(pass|passed|ok|waived)$/.test(published)) gate = 'passed';
  else if (/^(fail|failed|blocked)$/.test(published)) gate = 'failed';
  else if (/^(warn|warned|warning)$/.test(published)) gate = 'warned';

  const revParam = param(run, 'revision', 'git-revision', 'commit', 'sha');
  const commit = revisionOf(obj as never) ??
    (revParam && SHA.test(revParam) ? revParam : undefined);
  const gitRef = param(run, 'git-ref');
  const trig = labels['triggers.tekton.dev/trigger'] ?? '';
  const trigger: RunView['trigger'] =
    gitRef !== undefined || labels['adhar.io/preview'] === 'true' || /pr/.test(trig)
      ? 'pull-request'
      : trig || labels['triggers.tekton.dev/eventlistener'] ||
          /^app-ci-/.test(run.metadata?.name ?? '')
      ? 'push'
      : 'manual';

  return {
    name: run.metadata?.name ?? '',
    namespace: run.metadata?.namespace ?? '',
    pipeline: labels['tekton.dev/pipeline'] ?? run.spec?.pipelineRef?.name,
    state,
    ...(c?.reason ? { reason: c.reason } : {}),
    ...(c?.message ? { message: c.message } : {}),
    createdAt: run.metadata?.creationTimestamp,
    startedAt,
    completedAt,
    durationSec,
    ...(commit ? { commit: commit.toLowerCase() } : {}),
    ...(gitRef ? { gitRef: gitRef.replace(/^refs\/heads\//, '') } : {}),
    trigger,
    ...(image ? { image } : {}),
    ...(digest ? { digest } : {}),
    gate,
    ...(counted ? { summary } : {}),
    ...(decision ? { decision } : {}),
    ...(ann['chains.tekton.dev/signed'] === 'true' ? { chainsSigned: true } : {}),
  };
}

const runTime = (r: RunView) => Date.parse(r.startedAt ?? r.createdAt ?? '') || 0;
export const newestRunFirst = (a: RunView, b: RunView) => runTime(b) - runTime(a);

/* ─────────── image ─────────── */

/** `harbor.x/proj/path/name:tag@sha256:…` → `{ host, repo: 'proj/path/name', tag, digest }`. */
export function parseImageRef(
  ref: string | undefined,
): { host?: string; repo: string; tag?: string; digest?: string } | undefined {
  if (!ref) return undefined;
  let s = ref.trim().replace(/^[a-z]+:\/\//, '');
  let digest: string | undefined;
  const at = s.indexOf('@');
  if (at >= 0) {
    digest = s.slice(at + 1);
    s = s.slice(0, at);
  }
  let tag: string | undefined;
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon > slash) {
    tag = s.slice(colon + 1);
    s = s.slice(0, colon);
  }
  const parts = s.split('/').filter(Boolean);
  let host: string | undefined;
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) host = parts.shift();
  if (!parts.length) return undefined;
  return {
    ...(host ? { host } : {}),
    repo: parts.join('/'),
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

/** The Harbor repository (`<project>/<path>`) holding the app's images, from the most specific source. */
export function imageRepoFor(input: {
  warehouse?: Pick<kargo.Warehouse, 'subscriptions'> | null;
  runs?: readonly RunView[];
  freight?: readonly Pick<kargo.Freight, 'images'>[];
  argoApps?: readonly Pick<argocd.Application, 'status'>[];
}): string | undefined {
  const sub = input.warehouse?.subscriptions.find((s) => s.kind === 'image');
  const candidates = [
    sub?.repoURL,
    ...(input.runs ?? []).map((r) => r.image),
    ...(input.freight ?? []).flatMap((f) => f.images.map((i) => i.repoURL)),
    ...(input.argoApps ?? []).flatMap((a) => a.status.images),
  ];
  for (const c of candidates) {
    const p = parseImageRef(c);
    if (p?.repo.includes('/')) return p.repo;
  }
  return undefined;
}

export interface ArtifactSig {
  signed: boolean;
  attested: boolean;
  sbom: boolean;
}

/** Signature / attestation presence from Harbor's accessories (`undefined` = not asked). */
export function artifactSig(
  a: Pick<harbor.Artifact, 'accessories' | 'hasSbom'>,
): ArtifactSig | undefined {
  if (!a.accessories) return undefined;
  const types = a.accessories.map((x) => lower(x.type));
  return {
    signed: types.some((t) => t.includes('signature')),
    attested: types.some((t) => /attest|intoto|provenance/.test(t)),
    sbom: Boolean(a.hasSbom) || types.some((t) => t.includes('sbom')),
  };
}

/** The artifact a run (or commit) produced: by digest, else a tag that is the commit. */
export function artifactFor<A extends Pick<harbor.Artifact, 'digest' | 'tags'>>(
  artifacts: readonly A[],
  by: { digest?: string; commit?: string; tag?: string },
): A | undefined {
  if (by.digest) {
    const hit = artifacts.find((a) => a.digest === by.digest);
    if (hit) return hit;
  }
  if (by.tag) {
    const hit = artifacts.find((a) => (a.tags ?? []).some((t) => t.name === by.tag));
    if (hit) return hit;
  }
  if (by.commit) return artifacts.find((a) => (a.tags ?? []).some((t) => shaEq(t.name, by.commit)));
  return undefined;
}

/* ─────────── freight ─────────── */

/** Freight produced for this app: origin warehouse `<app>` in the app's project (or a per-app stage's warehouse). */
export function appFreight(
  freight: readonly kargo.Freight[],
  app: FlowApp,
  extraWarehouses: readonly string[] = [],
): kargo.Freight[] {
  const names = new Set([app.name, ...extraWarehouses].map(lower));
  return freight
    .filter((f) =>
      names.has(lower(f.warehouse)) &&
      (!app.project || !f.project || lower(f.project) === app.project)
    )
    .sort((a, b) => b.created.localeCompare(a.created));
}

/** Does this freight carry the image a run built / a commit? */
export function freightMatches(
  f: Pick<kargo.Freight, 'images' | 'commits'>,
  by: { digest?: string; commit?: string; tag?: string },
): boolean {
  if (by.digest && f.images.some((i) => i.digest === by.digest)) return true;
  if (by.tag && f.images.some((i) => i.tag === by.tag)) return true;
  if (by.commit) {
    if (
      f.images.some((i) => shaEq(i.tag, by.commit) || shaEq(i.tag?.split('-').pop(), by.commit))
    ) return true;
    if ((f.commits ?? []).some((c) => shaEq(c.id, by.commit))) return true;
  }
  return false;
}

/* ─────────── environments ─────────── */

export interface EnvView {
  name: string;
  namespace?: string;
  order: number;
  guardrails: string[];
  cell?: kargo.MatrixCell;
  argoApp?: argocd.Application;
  /** This app's freight in the env's stage. */
  freight?: kargo.Freight;
  rollout?: argoRollouts.Rollout;
  promotions: kargo.Promotion[];
}

export interface EnvInput {
  app: FlowApp;
  project?: kargo.ProjectLike | null;
  stages: readonly kargo.Stage[];
  freight: readonly kargo.Freight[];
  promotions: readonly kargo.Promotion[];
  argoApps: readonly argocd.Application[];
  rollouts?: readonly argoRollouts.Rollout[];
}

/**
 * The app's environments in promotion order, each with what the app runs
 * there — both Kargo shapes, both `authorized-stage` forms (via
 * `kargo.buildProjectMatrix`). Argo CD apps that fit no project environment
 * (a team's own, uncomposed app) are kept as environments of their own.
 */
export function appEnvironments(input: EnvInput): EnvView[] {
  const { app } = input;
  const freightById = new Map(input.freight.map((f) => [f.id, f]));
  const out: EnvView[] = [];
  if (app.project) {
    const matrix = kargo.buildProjectMatrix({
      project: app.project,
      envs: kargo.projectEnvironments(input.project ?? undefined),
      stages: input.stages,
      freight: input.freight,
      promotions: input.promotions,
      argoApps: input.argoApps,
      extraApps: [app.name],
    });
    const row = matrix.rows.find((r) => r.app === app.name);
    for (const e of matrix.envs) {
      const cell = row?.cells.find((c) => c.env === e.name);
      const argoApp = cell?.argoApp
        ? input.argoApps.find((a) => a.metadata.name === cell.argoApp)
        : undefined;
      out.push({
        name: e.name,
        namespace: cell?.namespace ?? e.namespace,
        order: e.order,
        guardrails: e.guardrails,
        ...(cell ? { cell } : {}),
        ...(argoApp ? { argoApp } : {}),
        ...(cell?.stage?.freight && freightById.get(cell.stage.freight)
          ? { freight: freightById.get(cell.stage.freight) }
          : {}),
        promotions: cell?.stage
          ? kargo.appPromotions(cell.stage, input.promotions, freightById)
          : [],
      });
    }
  }
  const used = new Set(out.map((e) => e.argoApp?.metadata.name).filter(Boolean));
  for (const a of app.argoApps) {
    if (used.has(a.metadata.name)) continue;
    const env = lower(a.metadata.labels?.[kargo.LABEL_ENVIRONMENT]) ||
      a.spec.destination.namespace || a.metadata.name;
    out.push({
      name: env,
      namespace: a.spec.destination.namespace,
      order: 100 + kargo.envOrder(env),
      guardrails: [],
      argoApp: a,
      promotions: [],
    });
  }
  for (const e of out) {
    const ns = e.argoApp?.spec.destination.namespace || e.namespace;
    e.rollout = (input.rollouts ?? []).find((r) =>
      r.metadata.namespace === ns &&
      (lower(r.metadata.name) === app.name || lower(r.metadata.name).startsWith(`${app.name}-`))
    );
    if (!e.rollout) delete e.rollout;
  }
  return out.sort((a, b) => a.order - b.order || kargo.envOrder(a.name) - kargo.envOrder(b.name));
}

/** When the app's freight entered an env (its successful promotion), or `undefined`. */
export function promotedAt(env: EnvView, freightId: string): string | undefined {
  const p = env.promotions.find((x) => x.freight === freightId && x.phase === 'Succeeded');
  if (p) return p.finished ?? p.created;
  const st = env.cell?.stage?.stage;
  if (st && st.lastPromotionFreight === freightId && st.lastPromoted) return st.lastPromoted;
  return undefined;
}

/* ─────────── stages ─────────── */

export type Tone =
  | 'done'
  | 'running'
  | 'failed'
  | 'blocked'
  | 'waiting'
  | 'none'
  | 'unavailable'
  | 'loading';

export interface Fact {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}

export interface StageItem {
  id: string;
  title: string;
  sub?: string;
  tone: Tone;
  label: string;
  at?: string;
  href?: string;
}

export interface FlowStage {
  id: string;
  group: 'source' | 'build' | 'release' | 'env';
  title: string;
  tone: Tone;
  /** Short status word. */
  label: string;
  /** One line of real detail. */
  detail: string;
  at?: string;
  durationSec?: number;
  /** Why the change stops here (or why there is nothing yet). */
  why: string[];
  facts: Fact[];
  items: StageItem[];
  links: Array<{ label: string; href: string }>;
}

export interface FlowInput {
  app: FlowApp;
  repo: Src<gitea.Repo | null>;
  commits: Src<gitea.Commit[]>;
  pulls: Src<gitea.PullRequest[]>;
  /** This app's runs, newest first. */
  runs: Src<RunView[]>;
  imageRepo?: string;
  artifacts: Src<harbor.Artifact[]>;
  warehouse: Src<kargo.Warehouse | null>;
  /** This app's freight, newest first. */
  freight: Src<kargo.Freight[]>;
  project: Src<kargo.ProjectLike | null>;
  stages: Src<kargo.Stage[]>;
  argo: Src<argocd.Application[]>;
  envs: EnvView[];
  now?: number;
}

export const links = {
  repo: (repo: string) => `/develop?section=repos&repo=${encodeURIComponent(repo)}`,
  commit: (repo: string, sha: string) =>
    `/develop?section=commits&repo=${encodeURIComponent(repo)}&sha=${
      encodeURIComponent(JSON.stringify(sha))
    }`,
  prs: (repo: string) => `/develop?section=prs&repo=${encodeURIComponent(repo)}`,
  pr: (repo: string, n: number) => `/develop?section=prs&pr=${encodeURIComponent(`${repo}/${n}`)}`,
  builds: () => '/develop?section=builds',
  run: (ns: string, name: string) =>
    `/develop?section=builds&run=${encodeURIComponent(`${ns}/${name}`)}`,
  review: () => '/deliver?section=scan-review',
  registry: () => '/deliver?section=registry',
  stages: () => '/deliver?section=stages',
  releases: () => '/deliver?section=releases',
  environments: (project?: string) =>
    `/deliver?section=environments${project ? `&project=${encodeURIComponent(project)}` : ''}`,
  argo: () => '/deliver?section=apps',
  rollouts: () => '/deliver?section=rollouts',
  catalog: (app: string) => `/catalog?entity=${encodeURIComponent(`component:${app}`)}`,
};

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');
const firstLine = (s?: string) => (s ?? '').split('\n')[0].trim();

function unavailable(
  id: string,
  group: FlowStage['group'],
  title: string,
  tool: string,
  s: Src<unknown>,
): FlowStage {
  if (s.status === 'loading') {
    return {
      id,
      group,
      title,
      tone: 'loading',
      label: 'Loading',
      detail: `Reading ${tool}…`,
      why: [],
      facts: [],
      items: [],
      links: [],
    };
  }
  const problem = sourceProblem(tool, s) ?? `${tool} did not answer.`;
  return {
    id,
    group,
    title,
    tone: 'unavailable',
    label: s.status === 'forbidden'
      ? 'Forbidden'
      : s.status === 'not-installed'
      ? 'Not installed'
      : 'Unreachable',
    detail: problem,
    why: [problem],
    facts: [],
    items: [],
    links: [],
  };
}

/** Conditions on the Application XR that are not True — the control plane's own "why". */
export function xrProblems(xr: AppXR | undefined): string[] {
  return (xr?.status?.conditions ?? [])
    .filter((c) =>
      (c.type === 'Synced' || c.type === 'Ready' || c.type === 'Healthy') && c.status !== 'True'
    )
    .map((c) =>
      `Application ${c.type}=${c.status ?? 'Unknown'}${c.reason ? ` (${c.reason})` : ''}${
        c.message ? `: ${c.message}` : ''
      }`
    );
}

function codeStage(i: FlowInput): FlowStage {
  const base = { id: 'code', group: 'source' as const, title: 'Code' };
  if (i.repo.status !== 'ok') return unavailable(base.id, base.group, base.title, 'Gitea', i.repo);
  const repo = i.repo.data;
  if (!repo) {
    return {
      ...base,
      tone: 'none',
      label: 'No repository',
      detail: 'No Gitea repository found for this app',
      why: [
        i.app.xr?.spec?.parameters?.source?.repoURL
          ? `The Application's source is ${i.app.xr.spec.parameters.source.repoURL}, and no repository named "${
            i.app.repo ?? i.app.name
          }" exists in the Gitea org.`
          : `No repository named "${i.app.name}" exists in the Gitea org.`,
      ],
      facts: [],
      items: [],
      links: [],
    };
  }
  const facts: Fact[] = [
    { label: 'Repository', value: repo.full_name, mono: true, href: links.repo(repo.name) },
    { label: 'Default branch', value: repo.default_branch, mono: true },
  ];
  if (i.commits.status !== 'ok') {
    const u = unavailable(base.id, base.group, base.title, 'Gitea', i.commits);
    return { ...u, facts };
  }
  const commits = i.commits.data ?? [];
  const latest = commits[0];
  if (!latest) {
    return {
      ...base,
      tone: 'none',
      label: 'No commits',
      detail: `${repo.default_branch} has no commits`,
      why: ['The repository is empty — push a first commit to start the flow.'],
      facts,
      items: [],
      links: [{ label: 'Open repository', href: links.repo(repo.name) }],
    };
  }
  return {
    ...base,
    tone: 'done',
    label: short(latest.sha),
    detail: firstLine(latest.message),
    at: latest.created,
    why: [],
    facts: [...facts, {
      label: 'Latest commit',
      value: `${short(latest.sha)} by ${latest.author?.login ?? 'unknown'}`,
      mono: false,
      href: links.commit(repo.name, latest.sha),
    }],
    items: commits.slice(0, 10).map((c) => ({
      id: c.sha,
      title: firstLine(c.message),
      sub: `${short(c.sha)} · ${c.author?.login ?? 'unknown'}`,
      tone: 'done' as Tone,
      label: short(c.sha),
      at: c.created,
      href: links.commit(repo.name, c.sha),
    })),
    links: [{ label: 'Open repository', href: links.repo(repo.name) }],
  };
}

function prStage(i: FlowInput): FlowStage {
  const base = { id: 'pr', group: 'source' as const, title: 'Pull request' };
  if (i.repo.status === 'ok' && !i.repo.data) {
    return {
      ...base,
      tone: 'none',
      label: 'No repository',
      detail: 'Nothing to review without a repository',
      why: [],
      facts: [],
      items: [],
      links: [],
    };
  }
  if (i.repo.status !== 'ok') return unavailable(base.id, base.group, base.title, 'Gitea', i.repo);
  if (i.pulls.status !== 'ok') {
    return unavailable(base.id, base.group, base.title, 'Gitea', i.pulls);
  }
  const repo = i.repo.data!;
  const pulls = [...(i.pulls.data ?? [])].sort((a, b) =>
    (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)
  );
  const open = pulls.filter((p) => p.state === 'open');
  const merged = pulls.filter((p) => p.merged);
  const lastMerged = merged.sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? ''))[0];
  const items: StageItem[] = pulls.slice(0, 10).map((p) => ({
    id: String(p.number),
    title: `#${p.number} ${p.title}`,
    sub: `${p.user.login}${p.head?.ref ? ` · ${p.head.ref}` : ''}`,
    tone: p.merged ? 'done' : p.state === 'open' ? (p.draft ? 'waiting' : 'running') : 'none',
    label: p.merged ? 'Merged' : p.state === 'open' ? (p.draft ? 'Draft' : 'Open') : 'Closed',
    at: p.merged_at ?? p.updated_at ?? p.created_at,
    href: links.pr(repo.name, p.number),
  }));
  const facts: Fact[] = [
    { label: 'Open', value: String(open.length) },
    { label: 'Merged', value: String(merged.length) },
  ];
  const link = [{ label: 'Pull requests in Develop', href: links.prs(repo.name) }];
  if (open.length) {
    return {
      ...base,
      tone: 'running',
      label: `${open.length} open`,
      detail: `#${open[0].number} ${open[0].title}`,
      at: open[0].updated_at ?? open[0].created_at,
      why: [],
      facts,
      items,
      links: link,
    };
  }
  if (lastMerged) {
    return {
      ...base,
      tone: 'done',
      label: 'Merged',
      detail: `#${lastMerged.number} ${lastMerged.title}`,
      at: lastMerged.merged_at ?? undefined,
      why: [],
      facts,
      items,
      links: link,
    };
  }
  return {
    ...base,
    tone: 'none',
    label: 'None',
    detail: 'Changes are pushed straight to the branch',
    why: [],
    facts,
    items,
    links: link,
  };
}

export const RUN_TONE: Record<RunState, Tone> = {
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'none',
  running: 'running',
  pending: 'waiting',
};
const RUN_LABEL: Record<RunState, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  running: 'Running',
  pending: 'Pending',
};

/** The run that represents "the latest change": newest push build, else newest of any. */
export function latestRun(runs: readonly RunView[]): RunView | undefined {
  return runs.find((r) => r.trigger === 'push') ?? runs[0];
}

function buildStage(i: FlowInput): FlowStage {
  const base = { id: 'build', group: 'build' as const, title: 'Build' };
  if (i.runs.status !== 'ok') return unavailable(base.id, base.group, base.title, 'Tekton', i.runs);
  const runs = i.runs.data ?? [];
  const run = latestRun(runs);
  const items: StageItem[] = runs.slice(0, 10).map((r) => ({
    id: `${r.namespace}/${r.name}`,
    title: r.name,
    sub: [
      r.trigger === 'pull-request' ? `PR ${r.gitRef ?? ''}`.trim() : r.trigger,
      r.commit ? short(r.commit) : '',
      r.durationSec != null ? fmtDuration(r.durationSec) : '',
    ].filter(Boolean).join(' · '),
    tone: RUN_TONE[r.state],
    label: RUN_LABEL[r.state],
    at: r.startedAt ?? r.createdAt,
    href: links.run(r.namespace, r.name),
  }));
  if (!run) {
    const why = i.repo.status === 'ok' && !i.repo.data
      ? ['There is no repository to build from.']
      : [
        `No app-ci PipelineRun labelled adhar.io/app=${
          i.app.repo ?? i.app.name
        } in ${CONTROL_PLANE_NS}. The supply chain starts a build on a push to the default branch.`,
      ];
    return {
      ...base,
      tone: 'none',
      label: 'No builds',
      detail: 'No pipeline run for this app yet',
      why,
      facts: [],
      items,
      links: [{ label: 'Builds in Develop', href: links.builds() }],
    };
  }
  const facts: Fact[] = [
    {
      label: 'Run',
      value: `${run.namespace}/${run.name}`,
      mono: true,
      href: links.run(run.namespace, run.name),
    },
    ...(run.pipeline ? [{ label: 'Pipeline', value: run.pipeline, mono: true }] : []),
    {
      label: 'Trigger',
      value: run.trigger === 'pull-request'
        ? `pull request${run.gitRef ? ` (${run.gitRef})` : ''}`
        : run.trigger,
    },
    ...(run.commit ? [{ label: 'Commit', value: short(run.commit), mono: true }] : []),
    ...(run.durationSec != null
      ? [{ label: 'Duration', value: fmtDuration(run.durationSec) }]
      : []),
    ...(run.reason ? [{ label: 'Reason', value: run.reason }] : []),
  ];
  const why = run.state === 'failed'
    ? [
      `${run.name} failed${run.reason ? ` (${run.reason})` : ''}${
        run.message ? `: ${run.message}` : '.'
      }`,
    ]
    : [];
  return {
    ...base,
    tone: RUN_TONE[run.state],
    label: RUN_LABEL[run.state],
    detail: `${run.commit ? `${short(run.commit)} · ` : ''}${run.name}`,
    at: run.completedAt ?? run.startedAt ?? run.createdAt,
    durationSec: run.durationSec,
    why,
    facts,
    items,
    links: [{ label: 'Open run in Develop', href: links.run(run.namespace, run.name) }],
  };
}

const GATE_LABEL: Record<GateState, string> = {
  none: 'No gate',
  awaiting: 'Awaiting approval',
  passed: 'Passed',
  warned: 'Passed with warnings',
  failed: 'Blocked',
  approved: 'Approved',
  rejected: 'Rejected',
};
const GATE_TONE: Record<GateState, Tone> = {
  none: 'none',
  awaiting: 'blocked',
  passed: 'done',
  warned: 'done',
  failed: 'failed',
  approved: 'done',
  rejected: 'failed',
};

export function countsText(c?: ScanCounts): string | undefined {
  if (!c) return undefined;
  const parts = (['critical', 'high', 'medium', 'low'] as const).filter((k) => c[k] != null).map((
    k,
  ) => `${c[k]} ${k}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function scanStage(i: FlowInput, artifact?: harbor.Artifact): FlowStage {
  const base = { id: 'scan', group: 'build' as const, title: 'Scan & sign' };
  if (i.runs.status !== 'ok') return unavailable(base.id, base.group, base.title, 'Tekton', i.runs);
  const run = latestRun(i.runs.data ?? []);
  if (!run) {
    return {
      ...base,
      tone: 'none',
      label: 'Not built',
      detail: 'Nothing has been scanned yet',
      why: ['No build has produced an image to scan.'],
      facts: [],
      items: [],
      links: [],
    };
  }
  const sig = artifact ? artifactSig(artifact) : undefined;
  const facts: Fact[] = [
    { label: 'Gate', value: GATE_LABEL[run.gate] },
    ...(countsText(run.summary) ? [{ label: 'Findings', value: countsText(run.summary)! }] : []),
    ...(run.decision
      ? [{
        label: 'Decision',
        value: `${run.decision.value}${run.decision.by ? ` by ${run.decision.by}` : ''}${
          run.decision.comment ? ` — ${run.decision.comment}` : ''
        }`,
      }]
      : []),
    ...(sig
      ? [{ label: 'Signature', value: sig.signed ? 'cosign signature present' : 'unsigned' }, {
        label: 'Attestation',
        value: sig.attested ? 'present' : 'none',
      }, { label: 'SBOM', value: sig.sbom ? 'present' : 'none' }]
      : run.chainsSigned
      ? [{ label: 'Signature', value: 'signed by Tekton Chains' }]
      : []),
  ];
  const why: string[] = [];
  let tone = GATE_TONE[run.gate];
  let label = GATE_LABEL[run.gate];
  const linksOut = [{ label: 'Vulnerability scans', href: '/deliver?section=scans' }];
  if (run.gate === 'awaiting') {
    why.push(
      `${run.name} is paused at the scan gate until a reviewer approves it in Security Review.`,
    );
    linksOut.unshift({ label: 'Open Security Review', href: links.review() });
  } else if (run.gate === 'failed' || run.gate === 'rejected') {
    why.push(
      `The scan gate ${run.gate === 'failed' ? 'blocked' : 'was rejected for'} ${run.name}${
        countsText(run.summary) ? ` (${countsText(run.summary)})` : ''
      }.`,
    );
  } else if (run.gate === 'none') {
    if (run.state === 'running' || run.state === 'pending') {
      tone = 'waiting';
      label = 'Pending';
    } else if (run.state === 'failed') {
      tone = 'none';
      label = 'Not reached';
      why.push('The build failed before the scan gate.');
    } else {
      label = 'No gate result';
      why.push('The run did not publish a scan-gate result (adhar.io/scan-gate or scan-summary).');
    }
  }
  if (sig && !sig.signed && (tone === 'done')) {
    tone = 'blocked';
    label = 'Unsigned';
    why.push('The image has no cosign signature, so the Kyverno admission policy will refuse it.');
  }
  return {
    ...base,
    tone,
    label,
    detail: countsText(run.summary) ?? (sig?.signed ? 'Signed image' : run.name),
    at: run.decision?.at ?? run.completedAt,
    why,
    facts,
    items: [],
    links: linksOut,
  };
}

function imageStage(i: FlowInput): { stage: FlowStage; artifact?: harbor.Artifact } {
  const base = { id: 'image', group: 'build' as const, title: 'Image' };
  const run = i.runs.status === 'ok'
    ? latestRun((i.runs.data ?? []).filter((r) => r.state === 'succeeded')) ??
      latestRun(i.runs.data ?? [])
    : undefined;
  if (!i.imageRepo) {
    return {
      stage: {
        ...base,
        tone: 'none',
        label: 'No image',
        detail: 'No image repository known for this app',
        why: [
          'Neither a Warehouse subscription, a build result (IMAGE_URL) nor a deployed workload names an image for this app.',
        ],
        facts: [],
        items: [],
        links: [{ label: 'Image registry', href: links.registry() }],
      },
    };
  }
  if (i.artifacts.status !== 'ok') {
    const u = unavailable(base.id, base.group, base.title, 'Harbor', i.artifacts);
    return { stage: { ...u, facts: [{ label: 'Repository', value: i.imageRepo, mono: true }] } };
  }
  const artifacts = i.artifacts.data ?? [];
  const parsed = parseImageRef(run?.image);
  const artifact = run
    ? artifactFor(artifacts, { digest: run.digest, commit: run.commit, tag: parsed?.tag })
    : undefined;
  const latest = artifacts[0];
  const shown = artifact ?? latest;
  const facts: Fact[] = [{
    label: 'Repository',
    value: i.imageRepo,
    mono: true,
    href: links.registry(),
  }];
  if (!shown) {
    return {
      stage: {
        ...base,
        tone: 'none',
        label: 'No artifacts',
        detail: `${i.imageRepo} is empty`,
        why: ['Nothing has been pushed to the image repository yet.'],
        facts,
        items: [],
        links: [{ label: 'Image registry', href: links.registry() }],
      },
    };
  }
  const tags = (shown.tags ?? []).map((t) => t.name);
  facts.push(
    { label: 'Digest', value: shown.digest.slice(0, 19), mono: true },
    ...(tags.length ? [{ label: 'Tags', value: tags.slice(0, 4).join(', '), mono: true }] : []),
    ...(shown.vulnerabilities
      ? [{
        label: 'Vulnerabilities',
        value: `${shown.vulnerabilities.critical} critical · ${shown.vulnerabilities.high} high`,
      }]
      : []),
  );
  const why: string[] = [];
  let tone: Tone = 'done';
  let label = tags[0]
    ? (SHA.test(tags[0]) ? tags[0].slice(0, 7) : tags[0])
    : shown.digest.slice(7, 19);
  if (run && !artifact && run.state === 'succeeded') {
    tone = 'waiting';
    label = 'Not found';
    why.push(
      `The latest build (${run.name}) reported ${
        run.digest ? `digest ${run.digest.slice(0, 19)}` : 'no digest'
      }, which is not in ${i.imageRepo}. Showing the newest artifact instead.`,
    );
  }
  return {
    artifact,
    stage: {
      ...base,
      tone,
      label,
      detail: `${i.imageRepo.split('/').pop()}@${shown.digest.slice(7, 19)}`,
      at: shown.push_time,
      why,
      facts,
      items: artifacts.slice(0, 8).map((a) => ({
        id: a.digest,
        title: (a.tags ?? []).map((t) => t.name).join(', ') || a.digest.slice(0, 19),
        sub: a.digest.slice(0, 19),
        tone: 'done' as Tone,
        label: artifactSig(a)?.signed ? 'Signed' : artifactSig(a) ? 'Unsigned' : 'Pushed',
        at: a.push_time,
      })),
      links: [{ label: 'Image registry', href: links.registry() }],
    },
  };
}

function freightStage(i: FlowInput): FlowStage {
  const base = { id: 'freight', group: 'release' as const, title: 'Freight' };
  if (i.freight.status !== 'ok') {
    return unavailable(base.id, base.group, base.title, 'Kargo', i.freight);
  }
  const list = i.freight.data ?? [];
  const wh = i.warehouse.status === 'ok' ? i.warehouse.data : undefined;
  const facts: Fact[] = [];
  if (wh) {
    facts.push({ label: 'Warehouse', value: `${wh.project}/${wh.name}`, mono: true });
    for (const s of wh.subscriptions) {
      facts.push({ label: `Watches (${s.kind})`, value: s.repoURL, mono: true });
    }
    if (wh.lastDiscovered) facts.push({ label: 'Last discovery', value: wh.lastDiscovered });
  }
  const latest = list[0];
  if (!latest) {
    const why: string[] = [];
    if (i.warehouse.status === 'ok' && !wh) {
      why.push(
        `No Kargo Warehouse "${i.app.name}" in project ${
          i.app.project || '(none)'
        } — nothing turns this app's images into freight.`,
      );
    } else if (wh?.issues?.length) why.push(...wh.issues.map((x) => `Warehouse: ${x}`));
    else why.push('The warehouse has not discovered an image for this app yet.');
    return {
      ...base,
      tone: 'none',
      label: 'No freight',
      detail: wh ? `Warehouse ${wh.name} has produced nothing` : 'No warehouse for this app',
      why,
      facts,
      items: [],
      links: [{ label: 'Kargo stages', href: links.stages() }],
    };
  }
  return {
    ...base,
    tone: wh?.issues?.length ? 'blocked' : 'done',
    label: kargo.freightDisplayName(latest).split(' ').pop() ?? 'Freight',
    detail: kargo.freightDisplayName(latest),
    at: latest.created,
    why: wh?.issues?.map((x) => `Warehouse: ${x}`) ?? [],
    facts: [
      ...facts,
      { label: 'Latest', value: `${latest.alias ?? latest.id.slice(0, 12)}`, mono: true },
      ...(latest.verifiedIn?.length
        ? [{ label: 'Verified in', value: latest.verifiedIn.join(', ') }]
        : []),
    ],
    items: list.slice(0, 8).map((f) => ({
      id: f.id,
      title: kargo.freightDisplayName(f),
      sub: f.alias ?? f.id.slice(0, 12),
      tone: 'done' as Tone,
      label: f.verifiedIn?.length ? `verified in ${f.verifiedIn.join(', ')}` : 'discovered',
      at: f.created,
    })),
    links: [{ label: 'Releases', href: links.releases() }, {
      label: 'Kargo stages',
      href: links.stages(),
    }],
  };
}

const HEALTH_TONE: Record<string, Tone> = {
  Healthy: 'done',
  Progressing: 'running',
  Degraded: 'failed',
  Missing: 'failed',
  Suspended: 'waiting',
  Unknown: 'none',
};

function envStage(
  i: FlowInput,
  e: EnvView,
  idx: number,
  envs: EnvView[],
  latestFreight?: kargo.Freight,
): FlowStage {
  const base = { id: `env:${e.name}`, group: 'env' as const, title: e.name };
  const facts: Fact[] = [];
  const why: string[] = [];
  const a = e.argoApp;
  const view = e.cell?.stage;
  if (e.namespace) facts.push({ label: 'Namespace', value: e.namespace, mono: true });
  if (a) {
    facts.push(
      { label: 'Argo CD app', value: a.metadata.name, mono: true, href: links.argo() },
      {
        label: 'Health',
        value: a.status.health.status +
          (a.status.health.message ? ` — ${a.status.health.message}` : ''),
      },
      { label: 'Sync', value: a.status.sync.status },
      ...(a.status.sync.revision
        ? [{ label: 'Revision', value: a.status.sync.revision.slice(0, 12), mono: true }]
        : []),
      ...(a.status.images[0] ? [{ label: 'Image', value: a.status.images[0], mono: true }] : []),
    );
  }
  if (view) {
    facts.push({
      label: 'Kargo stage',
      value: `${view.stage.project}/${view.stage.name} (${
        view.shape === 'shared' ? 'shared project stage' : 'per-app stage'
      })`,
      mono: true,
      href: links.stages(),
    });
  }
  if (e.freight) facts.push({ label: 'Freight', value: kargo.freightDisplayName(e.freight) });
  const lastP = e.cell?.lastPromotion;
  if (lastP) {
    facts.push({
      label: 'Last promotion',
      value: `${lastP.phase}${lastP.name ? ` (${lastP.name})` : ''}`,
    });
  }
  if (view?.stage.verification) {
    facts.push({
      label: 'Verification',
      value: view.stage.verification.phase +
        (view.stage.verification.message ? ` — ${view.stage.verification.message}` : ''),
    });
  }
  if (e.rollout) {
    facts.push({
      label: 'Rollout',
      value: `${e.rollout.metadata.name} · ${e.rollout.status.phase ?? 'Unknown'}${
        e.rollout.status.message ? ` — ${e.rollout.status.message}` : ''
      }`,
    });
  }
  if (e.guardrails.length) facts.push({ label: 'Guardrails', value: e.guardrails.join(', ') });

  const items: StageItem[] = e.promotions.slice(0, 8).map((p) => ({
    id: p.name,
    title: p.name,
    sub: [p.freight.slice(0, 12), p.actor].filter(Boolean).join(' · '),
    tone: p.phase === 'Succeeded'
      ? 'done'
      : p.phase === 'Running' || p.phase === 'Pending'
      ? 'running'
      : p.phase === 'Aborted'
      ? 'none'
      : 'failed',
    label: p.phase,
    at: p.finished ?? p.created,
  }));
  const envLinks = [{
    label: 'Environments',
    href: links.environments(i.app.project || undefined),
  }];

  if (e.cell?.authProblem) why.push(e.cell.authProblem);
  if (!a) {
    if (i.argo.status !== 'ok') {
      const u = unavailable(base.id, base.group, base.title, 'Argo CD', i.argo);
      return { ...u, facts, items, links: envLinks };
    }
    why.push(
      `No Argo CD app ${i.app.project}-${i.app.name}-${e.name} — the control plane has not composed this environment for the app.`,
    );
    why.push(...xrProblems(i.app.xr));
  }
  if (!view && i.app.project && i.stages.status === 'ok' && a) {
    why.push(
      `No Kargo stage promotes ${i.app.name} into ${e.name} (neither a shared "${e.name}" stage requesting Warehouse/${i.app.name} nor a "${i.app.name}-${e.name}" stage).`,
    );
  }
  if (view?.busyWithOther) {
    why.push(`The shared ${e.name} stage is promoting another application right now.`);
  }
  if (view?.stage.issues?.length) why.push(...view.stage.issues.map((x) => `Stage: ${x}`));

  const promoting = Boolean(view?.promotion) || lastP?.phase === 'Running' ||
    lastP?.phase === 'Pending';
  let tone: Tone;
  let label: string;
  if (!a && !view) {
    tone = 'none';
    label = 'Not set up';
  } else if (promoting) {
    tone = 'running';
    label = 'Promoting';
  } else if (lastP && (lastP.phase === 'Failed' || lastP.phase === 'Errored')) {
    tone = 'failed';
    label = 'Promotion failed';
    why.unshift(
      `The last promotion into ${e.name} ${lastP.phase.toLowerCase()}${
        lastP.message ? `: ${lastP.message}` : '.'
      }`,
    );
  } else if (a) {
    tone = HEALTH_TONE[a.status.health.status] ?? 'none';
    label = a.status.health.status;
    if (a.status.sync.status === 'OutOfSync' && tone === 'done') {
      tone = 'waiting';
      label = 'Out of sync';
    }
    if (tone === 'failed') {
      why.unshift(
        `${a.metadata.name} is ${a.status.health.status}${
          a.status.health.message ? `: ${a.status.health.message}` : '.'
        }`,
      );
    }
    for (const c of a.status.conditions) {
      if (/Error|Warning/.test(c.type)) why.push(`${c.type}: ${c.message ?? ''}`.trim());
    }
  } else {
    tone = e.freight ? 'done' : 'waiting';
    label = e.freight ? 'Promoted' : 'Waiting';
  }
  if (
    view?.stage.verification && /Failed|Error/.test(view.stage.verification.phase) &&
    tone === 'done'
  ) {
    tone = 'failed';
    label = 'Verification failed';
    why.unshift(
      `Verification in ${e.name} ${view.stage.verification.phase.toLowerCase()}${
        view.stage.verification.message ? `: ${view.stage.verification.message}` : '.'
      }`,
    );
  }
  if (e.rollout?.status.phase === 'Paused' && tone !== 'failed') {
    tone = 'blocked';
    label = 'Rollout paused';
    why.push(
      `Rollout ${e.rollout.metadata.name} is paused${
        e.rollout.status.message ? `: ${e.rollout.status.message}` : '.'
      }`,
    );
  }
  // Waiting for promotion: the env upstream has a newer freight than this one.
  const up = envs[idx - 1];
  const upId = up ? up.freight?.id : latestFreight?.id;
  if (view && upId && e.freight?.id !== upId && tone !== 'failed' && tone !== 'running') {
    why.push(
      up
        ? `${up.name} runs a newer build than ${e.name} — waiting for promotion.`
        : `Newer freight is available than what ${e.name} runs — waiting for promotion.`,
    );
    if (!e.freight) {
      tone = 'waiting';
      label = 'Waiting';
    }
  }
  const at = (e.freight && promotedAt(e, e.freight.id)) ?? a?.status.operationState?.finishedAt ??
    lastP?.at;
  const ver = e.freight
    ? kargo.freightDisplayName(e.freight)
    : a?.status.images[0]
    ? (kargo.imageTag(a.status.images[0]) ?? '')
    : a?.status.sync.revision?.slice(0, 7);
  return {
    ...base,
    tone,
    label,
    detail: ver ? `runs ${ver}` : a ? `${a.status.sync.status}` : 'nothing deployed',
    ...(at ? { at } : {}),
    why,
    facts,
    items,
    links: envLinks,
  };
}

/** When no environment exists at all, the one stage that says why. */
function noEnvStage(i: FlowInput): FlowStage {
  const base = { id: 'env:none', group: 'env' as const, title: 'Environments' };
  if (i.argo.status !== 'ok' && i.argo.status !== 'loading') {
    return unavailable(base.id, base.group, base.title, 'Argo CD', i.argo);
  }
  const why: string[] = [];
  if (!i.app.project) {
    why.push(
      'This repository is not an Application of any project, so nothing deploys it. Create the app from a template (or an Application resource) to give it environments.',
    );
  } else if (i.project.status === 'ok' && !i.project.data) {
    why.push(`There is no Project resource "${i.app.project}" — environments belong to a project.`);
  } else if (i.project.status === 'ok' && i.project.data) {
    const conds =
      ((i.project.data.status as { conditions?: XRCondition[] } | undefined)?.conditions ?? [])
        .filter((c) => c.status !== 'True');
    why.push(`Project ${i.app.project} declares no environments yet.`);
    for (const c of conds) {
      why.push(
        `Project ${c.type}=${c.status ?? 'Unknown'}${c.reason ? ` (${c.reason})` : ''}${
          c.message ? `: ${c.message}` : ''
        }`,
      );
    }
  } else if (i.project.status !== 'loading') {
    why.push(sourceProblem('Project resources', i.project) ?? 'The project could not be read.');
  }
  why.push(...xrProblems(i.app.xr));
  return {
    ...base,
    tone: i.argo.status === 'loading' ? 'loading' : 'none',
    label: 'No environments',
    detail: 'Nothing deploys this app yet',
    why,
    facts: [],
    items: [],
    links: [{ label: 'Environments', href: links.environments(i.app.project || undefined) }],
  };
}

/** Code → PR → Build → Scan & sign → Image → Freight → each environment. */
export function buildFlow(i: FlowInput): FlowStage[] {
  const img = imageStage(i);
  const latestFreight = i.freight.status === 'ok' ? i.freight.data?.[0] : undefined;
  const envs = i.envs.length
    ? i.envs.map((e, idx) => envStage(i, e, idx, i.envs, latestFreight))
    : [noEnvStage(i)];
  return [
    codeStage(i),
    prStage(i),
    buildStage(i),
    scanStage(i, img.artifact),
    img.stage,
    freightStage(i),
    ...envs,
  ];
}

/** The first stage a change is stuck at — failed, blocked, or nothing yet. */
export function stopsAt(stages: readonly FlowStage[]): FlowStage | undefined {
  return stages.find((s) => s.tone === 'failed' || s.tone === 'blocked') ??
    // A pull request is optional — a change pushed straight to the branch has not stopped.
    stages.find((s) =>
      s.id !== 'pr' && (s.tone === 'none' || s.tone === 'waiting' || s.tone === 'unavailable')
    );
}

/* ─────────── picker summary ─────────── */

export interface AppSummary {
  /** Furthest point reached: an environment name, `freight`, `build`, `code`, or `nothing`. */
  furthest: string;
  furthestLabel: string;
  health: 'healthy' | 'progressing' | 'degraded' | 'unknown';
  /** Building now / failing build. */
  build?: RunState;
}

const HEALTH_RANK = { degraded: 3, progressing: 2, healthy: 1, unknown: 0 } as const;

export function summarizeApp(
  app: FlowApp,
  ctx: {
    envs: EnvView[];
    runs: readonly RunView[];
    freight: readonly kargo.Freight[];
    hasRepo: boolean;
  },
): AppSummary {
  let health: AppSummary['health'] = 'unknown';
  for (const e of ctx.envs) {
    const h = e.argoApp?.status.health.status;
    const k: AppSummary['health'] = h === 'Healthy'
      ? 'healthy'
      : h === 'Progressing'
      ? 'progressing'
      : h === 'Degraded' || h === 'Missing'
      ? 'degraded'
      : 'unknown';
    if (HEALTH_RANK[k] > HEALTH_RANK[health]) health = k;
  }
  const run = latestRun(ctx.runs);
  const reached = [...ctx.envs].reverse().find((e) =>
    e.freight || (e.argoApp && e.argoApp.status.health.status !== 'Missing')
  );
  if (reached) {
    return {
      furthest: reached.name,
      furthestLabel: `in ${reached.name}`,
      health,
      ...(run ? { build: run.state } : {}),
    };
  }
  if (ctx.freight.length) {
    return {
      furthest: 'freight',
      furthestLabel: 'freight ready',
      health,
      ...(run ? { build: run.state } : {}),
    };
  }
  if (run) {
    return {
      furthest: 'build',
      furthestLabel: run.state === 'succeeded' ? 'built' : `build ${run.state}`,
      health,
      build: run.state,
    };
  }
  if (ctx.hasRepo) return { furthest: 'code', furthestLabel: 'code only', health };
  return { furthest: 'nothing', furthestLabel: app.xr ? 'declared' : 'not started', health };
}

/* ─────────── following one commit ─────────── */

export interface TraceStep {
  id: string;
  label: string;
  tone: Tone;
  /** When this step started (build only). */
  start?: string;
  /** When this step was reached / finished. */
  at?: string;
  detail?: string;
  href?: string;
}

export interface CommitTrace {
  sha: string;
  short: string;
  subject?: string;
  author?: string;
  committedAt?: string;
  steps: TraceStep[];
  /** Envs this change reached (now or in the past). */
  reached: string[];
  headline: string;
  run?: RunView;
  freight?: kargo.Freight;
}

export interface TraceInput {
  app: FlowApp;
  repo?: string;
  commits: readonly gitea.Commit[];
  pulls: readonly gitea.PullRequest[];
  runs: readonly RunView[];
  artifacts: readonly harbor.Artifact[];
  freight: readonly kargo.Freight[];
  envs: readonly EnvView[];
  now?: number;
}

export function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  return `${fmtDuration(ms / 1000, true)} ago`;
}

export function fmtDuration(sec: number, coarse = false): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d) return coarse || !h ? `${d}d` : `${d}d ${h}h`;
  if (h) return coarse || !m ? `${h}h` : `${h}h ${m}m`;
  if (m) return coarse || !r ? `${m}m` : `${m}m ${r}s`;
  return `${r}s`;
}

/**
 * Follow one commit through build → scan → image → freight → each environment.
 * Joined on real identifiers only: the run's `revision`, the image digest the
 * run published, the freight carrying that digest (or a tag that is the sha),
 * and the stage holding that freight / the promotion that moved it.
 */
export function traceCommit(sha: string, i: TraceInput): CommitTrace {
  const now = i.now ?? Date.now();
  const commit = i.commits.find((c) => shaEq(c.sha, sha));
  const full = commit?.sha ?? sha;
  const steps: TraceStep[] = [];
  steps.push(
    commit
      ? {
        id: 'commit',
        label: 'Committed',
        tone: 'done',
        at: commit.created,
        detail: `${commit.author?.login ?? ''} · ${firstLine(commit.message)}`.replace(/^ · /, ''),
        ...(i.repo ? { href: links.commit(i.repo, commit.sha) } : {}),
      }
      : {
        id: 'commit',
        label: 'Committed',
        tone: 'none',
        detail: 'not in the recent history of the default branch',
      },
  );

  const pr = i.pulls.find((p) => shaEq(p.head?.sha, full));
  if (pr) {
    steps.push({
      id: 'pr',
      label: 'Pull request',
      tone: pr.merged ? 'done' : pr.state === 'open' ? 'running' : 'none',
      at: pr.merged_at ?? pr.created_at,
      detail: `#${pr.number} ${pr.title}`,
      ...(i.repo ? { href: links.pr(i.repo, pr.number) } : {}),
    });
  }

  const runs = i.runs.filter((r) => shaEq(r.commit, full));
  const run = runs.find((r) => r.trigger === 'push' && r.state === 'succeeded') ??
    runs.find((r) => r.trigger === 'push') ?? runs[0];
  steps.push(
    run
      ? {
        id: 'build',
        label: 'Build',
        tone: RUN_TONE[run.state],
        start: run.startedAt ?? run.createdAt,
        at: run.completedAt,
        detail: `${run.name}${run.durationSec != null ? ` · ${fmtDuration(run.durationSec)}` : ''}`,
        href: links.run(run.namespace, run.name),
      }
      : {
        id: 'build',
        label: 'Build',
        tone: 'waiting',
        detail: 'no pipeline run references this commit',
      },
  );

  if (run) {
    const gTone = run.state === 'failed' && run.gate === 'none' ? 'none' : GATE_TONE[run.gate];
    steps.push({
      id: 'scan',
      label: 'Scan gate',
      tone: run.gate === 'none' && run.state === 'succeeded' ? 'done' : gTone,
      at: run.decision?.at ?? (run.gate !== 'none' ? run.completedAt : undefined),
      detail: [GATE_LABEL[run.gate], countsText(run.summary)].filter(Boolean).join(' · '),
      ...(run.gate === 'awaiting' ? { href: links.review() } : {}),
    });
  } else steps.push({ id: 'scan', label: 'Scan gate', tone: 'waiting' });

  const tag = parseImageRef(run?.image)?.tag;
  const artifact = artifactFor(i.artifacts, { digest: run?.digest, commit: full, tag });
  const digest = run?.digest ?? artifact?.digest;
  steps.push(
    artifact
      ? {
        id: 'image',
        label: 'Image',
        tone: 'done',
        at: artifact.push_time,
        detail: `${(artifact.tags ?? []).map((t) => t.name)[0] ?? ''} ${
          artifact.digest.slice(0, 19)
        }`.trim(),
      }
      : digest
      ? {
        id: 'image',
        label: 'Image',
        tone: 'done',
        at: run?.completedAt,
        detail: digest.slice(0, 19),
      }
      : {
        id: 'image',
        label: 'Image',
        tone: 'waiting',
        detail: run?.state === 'succeeded' ? 'the build published no image digest' : undefined,
      },
  );

  const freight = [...i.freight].sort((a, b) => a.created.localeCompare(b.created)).find((f) =>
    freightMatches(f, { digest, commit: full, tag })
  );
  steps.push(
    freight
      ? {
        id: 'freight',
        label: 'Freight',
        tone: 'done',
        at: freight.created,
        detail: kargo.freightDisplayName(freight),
      }
      : {
        id: 'freight',
        label: 'Freight',
        tone: 'waiting',
        detail: 'no warehouse has picked this build up',
      },
  );

  const reached: string[] = [];
  for (const e of i.envs) {
    let step: TraceStep;
    const holds = freight && e.freight?.id === freight.id;
    const at = freight ? promotedAt(e, freight.id) : undefined;
    const passed = freight &&
      e.promotions.some((p) => p.freight === freight.id && p.phase === 'Succeeded');
    const running = freight &&
      e.promotions.some((p) =>
        p.freight === freight.id && (p.phase === 'Running' || p.phase === 'Pending')
      );
    const failed = freight &&
      e.promotions.find((p) =>
        p.freight === freight.id && (p.phase === 'Failed' || p.phase === 'Errored')
      );
    const argoImgs = e.argoApp?.status.images ?? [];
    const viaArgo = !freight &&
      (digest
        ? argoImgs.some((x) => x.includes(digest))
        : argoImgs.some((x) => shaEq(parseImageRef(x)?.tag, full)));
    if (holds) {
      step = {
        id: `env:${e.name}`,
        label: e.name,
        tone: 'done',
        at,
        detail: 'running this change',
      };
    } else if (passed) {
      step = {
        id: `env:${e.name}`,
        label: e.name,
        tone: 'done',
        at,
        detail: 'since replaced by a newer change',
      };
    } else if (running) {
      step = {
        id: `env:${e.name}`,
        label: e.name,
        tone: 'running',
        detail: 'promotion in progress',
      };
    } else if (failed) {
      step = {
        id: `env:${e.name}`,
        label: e.name,
        tone: 'failed',
        at: failed.finished ?? failed.created,
        detail: `promotion ${failed.phase.toLowerCase()}${
          failed.message ? `: ${failed.message}` : ''
        }`,
      };
    } else if (viaArgo) {
      step = {
        id: `env:${e.name}`,
        label: e.name,
        tone: 'done',
        at: e.argoApp?.status.operationState?.finishedAt,
        detail: 'the deployed image is this build',
      };
    } else step = { id: `env:${e.name}`, label: e.name, tone: 'waiting' };
    if (step.tone === 'done') reached.push(e.name);
    steps.push(step);
  }

  return {
    sha: full,
    short: full.slice(0, 7),
    ...(commit
      ? {
        subject: firstLine(commit.message),
        author: commit.author?.login,
        committedAt: commit.created,
      }
      : {}),
    steps,
    reached,
    headline: headline(steps, i.envs, now),
    ...(run ? { run } : {}),
    ...(freight ? { freight } : {}),
  };
}

function headline(steps: TraceStep[], envs: readonly EnvView[], now: number): string {
  const by = (id: string) => steps.find((s) => s.id === id);
  const build = by('build')!;
  const scan = by('scan');
  if (build.tone === 'failed') return `Build failed${build.at ? ` ${relTime(build.at, now)}` : ''}`;
  if (build.tone === 'waiting') return 'Not built yet';
  if (scan?.tone === 'blocked') return 'Waiting for security review at the scan gate';
  if (scan?.tone === 'failed') return 'Blocked by the scan gate';
  if (build.tone === 'running') return `Building — started ${relTime(build.start, now)}`;
  const envSteps = steps.filter((s) => s.id.startsWith('env:'));
  const failed = envSteps.find((s) => s.tone === 'failed');
  if (failed) return `Promotion to ${failed.label} failed`;
  const promoting = envSteps.find((s) => s.tone === 'running');
  if (promoting) return `Promoting to ${promoting.label}`;
  let last = -1;
  envSteps.forEach((s, i) => {
    if (s.tone === 'done') last = i;
  });
  if (last === -1) {
    if (by('freight')?.tone !== 'done') {
      return 'Built — waiting for the warehouse to pick up the image';
    }
    return envs.length
      ? `Ready — waiting for promotion to ${envs[0].name}`
      : 'Ready — no environment to promote to';
  }
  const s = envSteps[last];
  const when = s.at ? ` ${relTime(s.at, now)}` : '';
  if (last === envSteps.length - 1) return `Live in ${s.label}${when}`;
  return `Reached ${s.label}${when}, waiting for ${envSteps[last + 1].label} promotion`;
}

/* ─────────── lead time ─────────── */

export interface Segment {
  id: string;
  label: string;
}

export interface ChangeLead {
  sha: string;
  short: string;
  subject?: string;
  /** Seconds per segment id; absent when either end has no real timestamp. */
  seconds: Record<string, number>;
  /** Commit → the last environment, when it got there and both timestamps are known. */
  totalSec?: number;
  reachedLast: boolean;
}

export interface LeadTimeBreakdown {
  segments: Segment[];
  changes: ChangeLead[];
  /** Median seconds per segment (only segments with samples). */
  median: Record<string, number>;
  samples: Record<string, number>;
  bottleneck?: Segment;
  /** Median commit → last environment, for changes that got there. */
  medianTotalSec?: number;
}

/** The segments of the stream, from the app's environments. */
export function leadSegments(envs: readonly string[]): Segment[] {
  const out: Segment[] = [
    { id: 'queue', label: 'Commit → build start' },
    { id: 'build', label: 'Build & scan' },
    { id: 'release', label: 'Image → freight' },
  ];
  envs.forEach((e, i) =>
    out.push({ id: `env:${e}`, label: i === 0 ? `Freight → ${e}` : `${envs[i - 1]} → ${e}` })
  );
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Durations between real timestamps on each change's trace. Never estimated. */
export function leadTimes(
  traces: readonly CommitTrace[],
  envs: readonly string[],
): LeadTimeBreakdown {
  const segments = leadSegments(envs);
  const t = (iso?: string) => (iso ? Date.parse(iso) : NaN);
  const changes: ChangeLead[] = [];
  for (const tr of traces) {
    const by = (id: string) => tr.steps.find((s) => s.id === id);
    const commitAt = t(tr.committedAt);
    const build = by('build');
    if (!build || build.tone === 'waiting') continue;
    const points: Array<[string, number, number]> = [
      ['queue', commitAt, t(build.start)],
      ['build', t(build.start), t(build.tone === 'done' ? build.at : undefined)],
      ['release', t(build.at), t(by('freight')?.tone === 'done' ? by('freight')!.at : undefined)],
    ];
    let prev = t(by('freight')?.at);
    for (const e of envs) {
      const s = by(`env:${e}`);
      const at = s?.tone === 'done' ? t(s.at) : NaN;
      points.push([`env:${e}`, prev, at]);
      prev = at;
    }
    const seconds: Record<string, number> = {};
    for (const [id, a, b] of points) {
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) seconds[id] = (b - a) / 1000;
    }
    const lastEnv = envs.length ? by(`env:${envs[envs.length - 1]}`) : undefined;
    const reachedLast = lastEnv?.tone === 'done';
    const lastAt = reachedLast ? t(lastEnv?.at) : NaN;
    changes.push({
      sha: tr.sha,
      short: tr.short,
      ...(tr.subject ? { subject: tr.subject } : {}),
      seconds,
      ...(Number.isFinite(commitAt) && Number.isFinite(lastAt) && lastAt >= commitAt
        ? { totalSec: (lastAt - commitAt) / 1000 }
        : {}),
      reachedLast: Boolean(reachedLast),
    });
  }
  const med: Record<string, number> = {};
  const samples: Record<string, number> = {};
  for (const s of segments) {
    const xs = changes.map((c) => c.seconds[s.id]).filter((v): v is number => v != null);
    samples[s.id] = xs.length;
    if (xs.length) med[s.id] = median(xs);
  }
  let bottleneck: Segment | undefined;
  for (const s of segments) {
    if (med[s.id] != null && (!bottleneck || med[s.id] > med[bottleneck.id])) bottleneck = s;
  }
  const totals = changes.filter((c) => c.totalSec != null).map((c) => c.totalSec!);
  return {
    segments,
    changes,
    median: med,
    samples,
    ...(bottleneck ? { bottleneck } : {}),
    ...(totals.length ? { medianTotalSec: median(totals) } : {}),
  };
}

/* ─────────── platform packages ─────────── */

export interface PackageRow {
  name: string;
  category: string;
  pkg?: string;
  source: string;
  targetRevision?: string;
  sync: string;
  health: string;
  revision?: string;
  lastSync?: string;
  lastSyncPhase?: string;
  message?: string;
}

/** Platform packages — GitOps only: release channel → Argo CD sync → health. */
export function platformPackages(apps: readonly argocd.Application[]): PackageRow[] {
  return apps
    .filter(isPlatformApp)
    .map((a) => ({
      name: a.metadata.name,
      category: appCategory(a),
      ...(packageName(a) ? { pkg: packageName(a) } : {}),
      source: a.spec.source.repoURL
        ? `${repoNameOf(a.spec.source.repoURL) ?? a.spec.source.repoURL}${
          a.spec.source.path
            ? `/${a.spec.source.path}`
            : a.spec.source.chart
            ? ` (${a.spec.source.chart})`
            : ''
        }`
        : '—',
      ...(a.spec.source.targetRevision ? { targetRevision: a.spec.source.targetRevision } : {}),
      sync: a.status.sync.status,
      health: a.status.health.status,
      ...(a.status.sync.revision ? { revision: a.status.sync.revision } : {}),
      ...(a.status.operationState?.finishedAt
        ? { lastSync: a.status.operationState.finishedAt }
        : {}),
      ...(a.status.operationState?.phase ? { lastSyncPhase: a.status.operationState.phase } : {}),
      ...(a.status.health.message || a.status.conditions[0]?.message
        ? { message: a.status.health.message ?? a.status.conditions[0]?.message }
        : {}),
    }))
    .sort((x, y) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name));
}

export { looksLikeSha };
