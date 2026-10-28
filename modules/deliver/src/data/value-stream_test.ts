import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { argocd, type gitea, type harbor, type kargo } from '@adhar/api-clients';
import {
  appEnvironments,
  appFreight,
  type AppXR,
  buildFlow,
  collectApps,
  type EnvView,
  type FlowApp,
  type FlowInput,
  imageRepoFor,
  leadTimes,
  ok,
  parseImageRef,
  platformPackages,
  readRun,
  runIsForApp,
  stopsAt,
  summarizeApp,
  teamApps,
  toSrc,
  traceCommit,
} from './value-stream.ts';

/* ─────────── fixtures ─────────── */

const SHA1 = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA2 = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const NOW = Date.parse('2026-10-21T12:00:00Z');

function argo(
  name: string,
  opts: {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    health?: string;
    sync?: string;
    images?: string[];
    ns?: string;
    project?: string;
  } = {},
): argocd.Application {
  return argocd.normalizeApplication({
    metadata: { name, namespace: 'argocd', labels: opts.labels, annotations: opts.annotations },
    spec: {
      project: opts.project ?? 'default',
      source: { repoURL: 'https://gitea.x/adhar/packages.git', path: 'x' },
      destination: { namespace: opts.ns ?? 'default' },
    },
    status: {
      sync: { status: (opts.sync ?? 'Synced') as 'Synced', revision: 'abcdef1234567' },
      health: { status: (opts.health ?? 'Healthy') as 'Healthy' },
      summary: { images: opts.images ?? [] },
      operationState: { phase: 'Succeeded', finishedAt: '2026-10-21T10:00:00Z' },
    },
  } as never);
}

const envApp = (
  project: string,
  app: string,
  env: string,
  extra: Parameters<typeof argo>[1] = {},
) =>
  argo(`${project}-${app}-${env}`, {
    ...extra,
    ns: `${project}-${env}`,
    labels: {
      'adhar.io/project': project,
      'adhar.io/application': app,
      'adhar.io/environment': env,
    },
    annotations: { 'kargo.akuity.io/authorized-stage': `${project}:${env}` },
  });

const platformPkg = (name: string, category = 'core') =>
  argo(name, { labels: { 'adhar.io/category': category, 'adhar.io/package-name': name } });

function xr(name: string, project?: string, conditions?: AppXR['status']): AppXR {
  return {
    metadata: { name, namespace: 'adhar-system' },
    spec: { parameters: { project, source: { repoURL: `https://gitea.x/adhar/${name}.git` } } },
    ...(conditions ? { status: conditions } : {}),
  };
}

const repo = (name: string, extra: Partial<gitea.Repo> = {}) =>
  ({
    id: 1,
    name,
    full_name: `adhar/${name}`,
    private: false,
    default_branch: 'main',
    updated_at: '',
    stars_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    html_url: `https://gitea.x/adhar/${name}`,
    ...extra,
  }) as gitea.Repo;

const projectXR = (name: string, envs: string[]): kargo.ProjectLike => ({
  metadata: { name },
  status: { environments: envs.map((e, i) => ({ name: e, namespace: `${name}-${e}`, order: i })) },
});

function sharedStage(
  project: string,
  env: string,
  freightByOrigin: Record<string, string>,
  extra: Partial<kargo.Stage> = {},
): kargo.Stage {
  return {
    name: env,
    project,
    labels: {
      'adhar.io/project': project,
      'adhar.io/environment': env,
      'adhar.io/stage-scope': 'project',
    },
    phase: 'Steady',
    origins: Object.keys(freightByOrigin).length ? Object.keys(freightByOrigin) : ['cart'],
    freightByOrigin,
    ...extra,
  } as kargo.Stage;
}

function perAppStage(
  project: string,
  app: string,
  env: string,
  current?: string,
  extra: Partial<kargo.Stage> = {},
): kargo.Stage {
  return {
    name: `${app}-${env}`,
    project,
    labels: {
      'adhar.io/project': project,
      'adhar.io/application': app,
      'adhar.io/environment': env,
    },
    phase: 'Steady',
    warehouse: app,
    origins: [app],
    currentFreight: current,
    ...extra,
  } as kargo.Stage;
}

const freight = (
  id: string,
  digest: string,
  tag: string,
  created: string,
  warehouse = 'cart',
  project = 'shop',
): kargo.Freight => ({
  id,
  project,
  warehouse,
  images: [{ repoURL: 'harbor.x/shop/cart', tag, digest }],
  created,
});

const promotion = (
  name: string,
  stage: string,
  f: string,
  finished: string,
  phase: kargo.Promotion['phase'] = 'Succeeded',
  origin = 'cart',
): kargo.Promotion => ({
  name,
  project: 'shop',
  stage,
  freight: f,
  phase,
  created: finished,
  finished,
  origin,
});

function run(
  name: string,
  sha: string,
  opts: {
    state?: 'True' | 'False' | 'Unknown';
    start: string;
    end?: string;
    digest?: string;
    gate?: string;
    app?: string;
    summary?: Record<string, number>;
  },
) {
  return {
    metadata: {
      name,
      namespace: 'adhar-system',
      creationTimestamp: opts.start,
      labels: {
        'adhar.io/app': opts.app ?? 'cart',
        'tekton.dev/pipeline': 'app-ci',
        'triggers.tekton.dev/eventlistener': 'app-ci',
      },
      annotations: opts.gate ? { 'adhar.io/scan-gate': opts.gate } : {},
    },
    spec: {
      params: [{ name: 'revision', value: sha }, { name: 'repo-name', value: opts.app ?? 'cart' }],
    },
    status: {
      startTime: opts.start,
      completionTime: opts.end,
      conditions: [{
        type: 'Succeeded',
        status: opts.state ?? 'True',
        reason: opts.state === 'False' ? 'Failed' : 'Succeeded',
      }],
      results: [
        ...(opts.digest
          ? [{ name: 'IMAGE_DIGEST', value: opts.digest }, {
            name: 'IMAGE_URL',
            value: `harbor.x/shop/cart:${sha.slice(0, 7)}`,
          }]
          : []),
        ...(opts.summary ? [{ name: 'scan-summary', value: JSON.stringify(opts.summary) }] : []),
      ],
    },
  };
}

const commit = (sha: string, created: string, msg = 'feat: thing'): gitea.Commit => ({
  sha,
  short_sha: sha.slice(0, 10),
  message: msg,
  author: { login: 'dev' },
  created,
});

const artifact = (digest: string, tag: string, push: string, signed = true): harbor.Artifact => ({
  digest,
  tags: [{ name: tag }],
  size: 1,
  push_time: push,
  accessories: signed ? [{ digest: 'sha256:sig', type: 'signature.cosign' }] : [],
});

/* ─────────── app grouping ─────────── */

Deno.test('collectApps: XRs, per-env Argo CD apps and repos fold into one app each; platform packages excluded', () => {
  const apps = collectApps({
    xrs: [xr('cart', 'shop'), xr('billing', 'default')],
    argoApps: [
      envApp('shop', 'cart', 'dev'),
      envApp('shop', 'cart', 'test'),
      envApp('shop', 'cart', 'prod'),
      platformPkg('keycloak'),
      platformPkg('harbor', 'security'),
    ],
    repos: [
      repo('cart'),
      repo('billing'),
      repo('packages'),
      repo('environments'),
      repo('upstream-mirror', { mirror: true }),
      repo('notes'),
    ],
  });
  assertEquals(apps.map((a) => a.key), ['/notes', 'adhar/billing', 'shop/cart']);
  const cart = apps.find((a) => a.key === 'shop/cart')!;
  assertEquals(cart.argoApps.length, 3);
  assertEquals(cart.from.sort(), ['argo', 'xr']);
  assertEquals(cart.repo, 'cart');
  // `default` project maps to `adhar`, as the control plane does.
  assert(apps.some((a) => a.key === 'adhar/billing'));
  // A repo with no XR and no Argo CD app is a fallback app without a project.
  assertEquals(apps.find((a) => a.name === 'notes')!.from, ['repo']);
});

/**
 * The two platform-made Argo CD apps that carry no `adhar.io/category`, with
 * the labels they have on a live cluster (Azure, 2026-10-28): the platform's
 * GitOps root, and the service adopter's per-repository bootstrap. Both were
 * listed as team apps — `adhar-platform-applicationset` and
 * `reactapp-bootstrap` beside the `reactapp` they adopt.
 */
Deno.test('collectApps: the platform GitOps root and service bootstrap apps are not team apps', () => {
  const root = argo('adhar-platform-applicationset', {
    labels: { 'app.kubernetes.io/part-of': 'adhar', 'adhar.io/component': 'platform-stack' },
  });
  const bootstrap = argo('reactapp-bootstrap', {
    labels: { 'adhar.io/service': 'reactapp', 'adhar.io/type': 'service-bootstrap' },
  });
  const apps = collectApps({
    xrs: [xr('reactapp')],
    argoApps: [root, bootstrap, envApp('adhar', 'reactapp', 'dev'), argo('team-own-app')],
    repos: [repo('reactapp')],
  });
  assertEquals(apps.map((a) => a.key), ['/team-own-app', 'adhar/reactapp']);
  assertEquals(apps.find((a) => a.name === 'reactapp')!.argoApps.map((a) => a.metadata.name), [
    'adhar-reactapp-dev',
  ]);
  // The root is a platform package: it belongs in the Platform packages panel.
  assertEquals(platformPackages([root]).map((r) => [r.name, r.category]), [[
    'adhar-platform-applicationset',
    'core',
  ]]);
  assertEquals(platformPackages([bootstrap]), []);
});

Deno.test('collectApps: an Application XR whose source is a platform GitOps repo does not claim that repo', () => {
  const apps = collectApps({
    xrs: [{
      metadata: { name: 'cart' },
      spec: {
        parameters: { project: 'shop', source: { repoURL: 'https://gitea.x/adhar/packages.git' } },
      },
    }],
    argoApps: [],
    repos: [repo('cart')],
  });
  assertEquals(apps.length, 1);
  assertEquals(apps[0].repo, undefined);
});

Deno.test('collectApps: unlabelled `<project>-<app>-<env>` names group under the project when it is known', () => {
  const apps = collectApps({
    xrs: [],
    argoApps: [argo('shop-web-dev'), argo('shop-web-prod'), argo('random')],
    repos: [],
    projects: ['shop'],
  });
  assertEquals(apps.map((a) => a.key), ['/random', 'shop/web']);
  assertEquals(apps.find((a) => a.key === 'shop/web')!.argoApps.length, 2);
});

Deno.test('teamApps: narrows to the team projects, but never to nothing', () => {
  const apps = collectApps({
    xrs: [xr('cart', 'shop'), xr('ledger', 'finance')],
    argoApps: [],
    repos: [],
  });
  assertEquals(teamApps(apps, { filtering: true, slugs: new Set(['shop']) }).map((a) => a.name), [
    'cart',
  ]);
  assertEquals(teamApps(apps, { filtering: true, slugs: new Set(['nope']) }).length, 2);
  assertEquals(teamApps(apps, { filtering: false, slugs: new Set(['shop']) }).length, 2);
});

/* ─────────── runs ─────────── */

Deno.test('runIsForApp: by app-ci label; a run labelled for another app is never ours', () => {
  assert(runIsForApp(run('app-ci-cart-x', SHA1, { start: 't' }), ['cart']));
  assert(!runIsForApp(run('app-ci-cart-x', SHA1, { start: 't', app: 'web' }), ['cart']));
  assert(runIsForApp({ metadata: { name: 'app-ci-cart-abc12' } }, ['cart']));
  assert(!runIsForApp({ metadata: { name: 'app-ci-cartography-1' } }, ['cart']));
});

Deno.test('readRun: commit, image, digest, gate and summary from the app-ci run', () => {
  const r = readRun(
    run('app-ci-cart-1', SHA1, {
      start: '2026-10-21T09:00:00Z',
      end: '2026-10-21T09:06:00Z',
      digest: D1,
      gate: 'passed',
      summary: { critical: 0, high: 2 },
    }),
  );
  assertEquals(r.state, 'succeeded');
  assertEquals(r.commit, SHA1);
  assertEquals(r.digest, D1);
  assertEquals(r.image, 'harbor.x/shop/cart:1111111');
  assertEquals(r.gate, 'passed');
  assertEquals(r.summary, { critical: 0, high: 2 });
  assertEquals(r.durationSec, 360);
  assertEquals(r.trigger, 'push');
});

Deno.test('readRun: awaiting approval only while the run is still going; a decision wins', () => {
  const going = run('r', SHA1, {
    state: 'Unknown',
    start: '2026-10-21T09:00:00Z',
    gate: 'awaiting-approval',
  });
  assertEquals(readRun(going).gate, 'awaiting');
  const ended = run('r', SHA1, {
    state: 'False',
    start: '2026-10-21T09:00:00Z',
    end: '2026-10-21T10:00:00Z',
    gate: 'awaiting-approval',
  });
  assertEquals(readRun(ended).gate, 'none');
  const decided = run('r', SHA1, {
    start: '2026-10-21T09:00:00Z',
    gate: 'awaiting-approval',
  }) as ReturnType<typeof run>;
  (decided.metadata.annotations as Record<string, string>)['adhar.io/scan-approval'] = 'approved';
  assertEquals(readRun(decided).gate, 'approved');
});

Deno.test('parseImageRef / imageRepoFor: Harbor repository from the warehouse first', () => {
  assertEquals(parseImageRef('harbor.x/shop/cart:abc@sha256:1'), {
    host: 'harbor.x',
    repo: 'shop/cart',
    tag: 'abc',
    digest: 'sha256:1',
  });
  assertEquals(parseImageRef('localhost:5000/a/b'), { host: 'localhost:5000', repo: 'a/b' });
  assertEquals(
    imageRepoFor({
      warehouse: { subscriptions: [{ kind: 'image', repoURL: 'harbor.x/shop/cart' }] },
    }),
    'shop/cart',
  );
  assertEquals(
    imageRepoFor({ runs: [readRun(run('r', SHA1, { start: 't', digest: D1 }))] }),
    'shop/cart',
  );
  assertEquals(imageRepoFor({}), undefined);
});

/* ─────────── a full happy path, shared Kargo shape ─────────── */

function happy() {
  const app: FlowApp = collectApps({
    xrs: [xr('cart', 'shop')],
    argoApps: [
      envApp('shop', 'cart', 'dev', { images: [`harbor.x/shop/cart:2222222@${D2}`] }),
      envApp('shop', 'cart', 'test', { images: [`harbor.x/shop/cart:2222222@${D2}`] }),
      envApp('shop', 'cart', 'prod', { images: [`harbor.x/shop/cart:1111111@${D1}`] }),
    ],
    repos: [repo('cart')],
  })[0];
  const fr = [
    freight('f2', D2, '2222222', '2026-10-21T09:10:00Z'),
    freight('f1', D1, '1111111', '2026-10-20T09:10:00Z'),
    freight('w1', D1, 'x', '2026-10-20T09:10:00Z', 'web'),
  ];
  const stages = [
    sharedStage('shop', 'dev', { cart: 'f2', web: 'w1' }),
    sharedStage('shop', 'test', { cart: 'f2', web: 'w1' }, { upstream: ['dev'] }),
    sharedStage('shop', 'prod', { cart: 'f1', web: 'w1' }, { upstream: ['test'] }),
  ];
  const promotions = [
    promotion('p-dev-2', 'dev', 'f2', '2026-10-21T09:20:00Z'),
    promotion('p-test-2', 'test', 'f2', '2026-10-21T10:00:00Z'),
    promotion('p-dev-1', 'dev', 'f1', '2026-10-20T09:20:00Z'),
    promotion('p-test-1', 'test', 'f1', '2026-10-20T10:00:00Z'),
    promotion('p-prod-1', 'prod', 'f1', '2026-10-20T15:00:00Z'),
    promotion('p-web', 'dev', 'w1', '2026-10-21T11:00:00Z', 'Failed', 'web'),
  ];
  const envs = appEnvironments({
    app,
    project: projectXR('shop', ['dev', 'test', 'prod']),
    stages,
    freight: fr,
    promotions,
    argoApps: app.argoApps,
  });
  const runs = [
    readRun(
      run('app-ci-cart-2', SHA2, {
        start: '2026-10-21T09:00:00Z',
        end: '2026-10-21T09:06:00Z',
        digest: D2,
        gate: 'passed',
        summary: { critical: 0, high: 1 },
      }),
      NOW,
    ),
    readRun(
      run('app-ci-cart-1', SHA1, {
        start: '2026-10-20T09:00:00Z',
        end: '2026-10-20T09:05:00Z',
        digest: D1,
        gate: 'passed',
      }),
      NOW,
    ),
  ];
  const commits = [commit(SHA2, '2026-10-21T08:58:00Z'), commit(SHA1, '2026-10-20T08:55:00Z')];
  const artifacts = [
    artifact(D2, '2222222', '2026-10-21T09:06:00Z'),
    artifact(D1, '1111111', '2026-10-20T09:05:00Z'),
  ];
  const appFr = appFreight(fr, app);
  const input: FlowInput = {
    app,
    repo: ok(repo('cart')),
    commits: ok(commits),
    pulls: ok([]),
    runs: ok(runs),
    imageRepo: 'shop/cart',
    artifacts: ok(artifacts),
    warehouse: ok({
      name: 'cart',
      project: 'shop',
      subscriptions: [{ kind: 'image', repoURL: 'harbor.x/shop/cart' }],
      created: '',
    }),
    freight: ok(appFr),
    project: ok(projectXR('shop', ['dev', 'test', 'prod'])),
    stages: ok(stages),
    argo: ok(app.argoApps),
    envs,
  };
  return { app, envs, runs, commits, artifacts, appFr, input, promotions };
}

Deno.test('appEnvironments (shared shape): each env holds THIS app’s freight, never another app’s promotions', () => {
  const { envs } = happy();
  assertEquals(envs.map((e) => e.name), ['dev', 'test', 'prod']);
  assertEquals(envs.map((e) => e.freight?.id), ['f2', 'f2', 'f1']);
  assertEquals(envs[0].cell?.stage?.shape, 'shared');
  // web's failed promotion into the shared dev stage is not cart's.
  assert(envs[0].promotions.every((p) => p.origin === 'cart'));
  assertEquals(envs[0].argoApp?.metadata.name, 'shop-cart-dev');
});

Deno.test('buildFlow: happy path — every stage done; prod waits for promotion', () => {
  const { input } = happy();
  const stages = buildFlow(input);
  assertEquals(stages.map((s) => s.id), [
    'code',
    'pr',
    'build',
    'scan',
    'image',
    'freight',
    'env:dev',
    'env:test',
    'env:prod',
  ]);
  const by = (id: string) => stages.find((s) => s.id === id)!;
  assertEquals(by('code').tone, 'done');
  assertEquals(by('pr').tone, 'none'); // pushed straight to the branch
  assertEquals(by('build').tone, 'done');
  assertEquals(by('build').durationSec, 360);
  assertEquals(by('scan').tone, 'done');
  assertEquals(by('image').tone, 'done');
  assertEquals(by('freight').tone, 'done');
  assertEquals(by('env:dev').tone, 'done');
  assert(by('env:prod').why.some((w) => /waiting for promotion/.test(w)));
  assertEquals(stopsAt(stages), undefined);
});

Deno.test('summarizeApp: furthest environment reached and health', () => {
  const { app, envs, runs, appFr } = happy();
  const s = summarizeApp(app, { envs, runs, freight: appFr, hasRepo: true });
  assertEquals(s.furthest, 'prod');
  assertEquals(s.health, 'healthy');
});

/* ─────────── per-app Kargo shape ─────────── */

Deno.test('appEnvironments (per-app shape): `<app>-<env>` stages and the old authorized-stage form', () => {
  const apps = [
    argo('shop-cart-dev', {
      ns: 'shop-dev',
      labels: {
        'adhar.io/project': 'shop',
        'adhar.io/application': 'cart',
        'adhar.io/environment': 'dev',
      },
      annotations: { 'kargo.akuity.io/authorized-stage': 'shop:cart-dev' },
    }),
    argo('shop-cart-prod', {
      ns: 'shop-prod',
      labels: {
        'adhar.io/project': 'shop',
        'adhar.io/application': 'cart',
        'adhar.io/environment': 'prod',
      },
      annotations: { 'kargo.akuity.io/authorized-stage': 'shop:cart-prod' },
    }),
  ];
  const app = collectApps({ xrs: [], argoApps: apps, repos: [] })[0];
  const fr = [freight('f1', D1, '1111111', '2026-10-20T09:10:00Z')];
  const envs = appEnvironments({
    app,
    project: null,
    stages: [
      perAppStage('shop', 'cart', 'dev', 'f1'),
      perAppStage('shop', 'cart', 'prod', undefined, { upstream: ['cart-dev'] }),
    ],
    freight: fr,
    promotions: [
      promotion(
        'p1',
        'cart-dev',
        'f1',
        '2026-10-20T09:20:00Z',
        'Succeeded',
        undefined as unknown as string,
      ),
    ],
    argoApps: apps,
  });
  assertEquals(envs.map((e) => e.name), ['dev', 'prod']);
  assertEquals(envs[0].cell?.stage?.shape, 'per-app');
  assertEquals(envs[0].freight?.id, 'f1');
  assertEquals(envs[0].promotions.map((p) => p.name), ['p1']);
  // The old `<project>:<app>-<env>` annotation still authorises the per-app stage.
  assertEquals(envs[0].cell?.authProblem, undefined);
  assertEquals(envs[1].freight, undefined);
});

/* ─────────── where it stops, and why ─────────── */

Deno.test('buildFlow: an XR with no Argo CD apps in a project without environments says why', () => {
  const app = collectApps({
    xrs: [
      xr('cart', 'shop', {
        conditions: [{
          type: 'Synced',
          status: 'False',
          reason: 'ReconcileError',
          message: 'cannot compose: project has no environments',
        }],
      }),
    ],
    argoApps: [],
    repos: [repo('cart')],
  })[0];
  const envs = appEnvironments({
    app,
    project: projectXR('shop', []),
    stages: [],
    freight: [],
    promotions: [],
    argoApps: [],
  });
  assertEquals(envs, []);
  const stages = buildFlow({
    app,
    repo: ok(repo('cart')),
    commits: ok([commit(SHA1, '2026-10-21T08:00:00Z')]),
    pulls: ok([]),
    runs: ok([]),
    artifacts: ok([]),
    warehouse: ok(null),
    freight: ok([]),
    project: ok(projectXR('shop', [])),
    stages: ok([]),
    argo: ok([]),
    envs,
  });
  const env = stages.find((s) => s.id === 'env:none')!;
  assertEquals(env.tone, 'none');
  assert(env.why.some((w) => /declares no environments/.test(w)));
  assert(env.why.some((w) => /Synced=False \(ReconcileError\): cannot compose/.test(w)));
  const build = stages.find((s) => s.id === 'build')!;
  assert(build.why[0].includes('adhar.io/app=cart'));
  assert(stages.find((s) => s.id === 'freight')!.why[0].includes('No Kargo Warehouse "cart"'));
});

Deno.test('buildFlow: a run paused at the scan gate blocks the flow and links to Security Review', () => {
  const { input } = happy();
  const paused = readRun(
    run('app-ci-cart-3', SHA2, {
      state: 'Unknown',
      start: '2026-10-21T11:50:00Z',
      gate: 'awaiting-approval',
      summary: { critical: 1, high: 3 },
    }),
    NOW,
  );
  const stages = buildFlow({ ...input, runs: ok([paused, ...(input.runs.data ?? [])]) });
  const scan = stages.find((s) => s.id === 'scan')!;
  assertEquals(scan.tone, 'blocked');
  assertEquals(scan.label, 'Awaiting approval');
  assert(scan.links.some((l) => l.href === '/deliver?section=scan-review'));
  assertEquals(stopsAt(stages)?.id, 'scan');
});

Deno.test('buildFlow: an unsigned image is blocked at Scan & sign', () => {
  const { input } = happy();
  const stages = buildFlow({
    ...input,
    artifacts: ok([artifact(D2, '2222222', '2026-10-21T09:06:00Z', false)]),
  });
  assertEquals(stages.find((s) => s.id === 'scan')!.label, 'Unsigned');
});

Deno.test('buildFlow: each unavailable source is reported at its own stage only', () => {
  const { input } = happy();
  const stages = buildFlow({
    ...input,
    runs: { status: 'forbidden' },
    artifacts: { status: 'unreachable', message: 'HTTP 502' },
  });
  assertEquals(stages.find((s) => s.id === 'build')!.label, 'Forbidden');
  assertEquals(stages.find((s) => s.id === 'image')!.tone, 'unavailable');
  assertEquals(stages.find((s) => s.id === 'code')!.tone, 'done');
  assertEquals(stages.find((s) => s.id === 'env:dev')!.tone, 'done');
});

Deno.test('toSrc: cached data survives a failed refetch; errors are classified', () => {
  assertEquals(toSrc({ data: [1], isError: true }).status, 'ok');
  assertEquals(
    toSrc({ isError: true, error: Object.assign(new Error('x'), { status: 403 }) }).status,
    'forbidden',
  );
  assertEquals(
    toSrc({ isError: true, error: Object.assign(new Error('x'), { status: 404 }) }).status,
    'not-installed',
  );
  assertEquals(toSrc({ isError: true, error: new Error('down') }).status, 'unreachable');
  assertEquals(toSrc({ isLoading: true }).status, 'loading');
});

/* ─────────── following a commit ─────────── */

Deno.test('traceCommit: reached test, waiting for prod', () => {
  const { app, envs, runs, commits, artifacts, appFr } = happy();
  const t = traceCommit(SHA2.slice(0, 7), {
    app,
    repo: 'cart',
    commits,
    pulls: [],
    runs,
    artifacts,
    freight: appFr,
    envs,
    now: NOW,
  });
  assertEquals(t.sha, SHA2);
  assertEquals(t.freight?.id, 'f2');
  assertEquals(t.reached, ['dev', 'test']);
  assertEquals(t.headline, 'Reached test 2h ago, waiting for prod promotion');
});

Deno.test('traceCommit: an older change that was promoted then replaced still counts as having reached dev/test', () => {
  const { app, envs, runs, commits, artifacts, appFr } = happy();
  const t = traceCommit(SHA1, {
    app,
    commits,
    pulls: [],
    runs,
    artifacts,
    freight: appFr,
    envs,
    now: NOW,
  });
  assertEquals(t.reached, ['dev', 'test', 'prod']);
  assertEquals(t.steps.find((s) => s.id === 'env:dev')!.detail, 'since replaced by a newer change');
  assert(t.headline.startsWith('Live in prod'));
});

Deno.test('traceCommit: an unknown SHA is honest — not built yet', () => {
  const { app, envs, runs, commits, artifacts, appFr } = happy();
  const t = traceCommit('deadbee', {
    app,
    commits,
    pulls: [],
    runs,
    artifacts,
    freight: appFr,
    envs,
    now: NOW,
  });
  assertEquals(t.steps[0].tone, 'none');
  assertEquals(t.headline, 'Not built yet');
  assertEquals(t.reached, []);
});

/* ─────────── lead time ─────────── */

Deno.test('leadTimes: per-step durations from real timestamps, medians and the bottleneck', () => {
  const { app, envs, runs, commits, artifacts, appFr } = happy();
  const traces = commits.map((c) =>
    traceCommit(c.sha, { app, commits, pulls: [], runs, artifacts, freight: appFr, envs, now: NOW })
  );
  const lt = leadTimes(traces, ['dev', 'test', 'prod']);
  const c2 = lt.changes.find((c) => c.sha === SHA2)!;
  assertEquals(c2.seconds.queue, 120); // 08:58 → 09:00
  assertEquals(c2.seconds.build, 360);
  assertEquals(c2.seconds.release, 240); // 09:06 → 09:10
  assertEquals(c2.seconds['env:dev'], 600);
  assertEquals(c2.seconds['env:test'], 2400);
  assertEquals(c2.seconds['env:prod'], undefined); // never got there
  assertEquals(c2.reachedLast, false);
  const c1 = lt.changes.find((c) => c.sha === SHA1)!;
  assertEquals(c1.seconds['env:prod'], 5 * 3600);
  assertEquals(
    c1.totalSec,
    Date.parse('2026-10-20T15:00:00Z') / 1000 - Date.parse('2026-10-20T08:55:00Z') / 1000,
  );
  assertEquals(lt.bottleneck?.id, 'env:prod');
  assertEquals(lt.samples['env:prod'], 1);
  assertEquals(lt.medianTotalSec, c1.totalSec);
});

Deno.test('leadTimes: a commit that was never built contributes nothing', () => {
  const t = traceCommit('deadbee', {
    app: { key: 'x/y', project: 'x', name: 'y', from: [], argoApps: [] },
    commits: [],
    pulls: [],
    runs: [],
    artifacts: [],
    freight: [],
    envs: [] as EnvView[],
  });
  const lt = leadTimes([t], []);
  assertEquals(lt.changes, []);
  assertEquals(lt.bottleneck, undefined);
});

Deno.test('traceCommit: a run paused at the scan gate reads as waiting for review, not as building', () => {
  const { app, envs, artifacts, appFr } = happy();
  const SHA3 = '3333333ccccccccccccccccccccccccccccccccc';
  const paused = readRun(
    run('app-ci-cart-3', SHA3, {
      state: 'Unknown',
      start: '2026-10-21T11:30:00Z',
      gate: 'awaiting-approval',
    }),
    NOW,
  );
  const t = traceCommit(SHA3, {
    app,
    commits: [commit(SHA3, '2026-10-21T11:28:00Z')],
    pulls: [],
    runs: [paused],
    artifacts,
    freight: appFr,
    envs,
    now: NOW,
  });
  assertEquals(t.headline, 'Waiting for security review at the scan gate');
  assertEquals(t.steps.find((s) => s.id === 'scan')!.tone, 'blocked');
});
