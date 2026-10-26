import { assertEquals } from 'jsr:@std/assert@^1.0.0';
import { isUnpinned, K6_RUNNER_IMAGE, K6_STARTER_IMAGE, withPinnedImages } from './k6-images.ts';
import { testRunTemplate } from './perf-runner.ts';

// The operator's defaults are :latest, which the platform's Kyverno policy
// refuses — every Performance Center run stuck in `initialization` (2026-10-21).
Deno.test('pinned images are never latest or untagged', () => {
  assertEquals(isUnpinned(K6_RUNNER_IMAGE), false);
  assertEquals(isUnpinned(K6_STARTER_IMAGE), false);
  for (
    const ref of [
      undefined,
      '',
      'grafana/k6',
      'grafana/k6:latest',
      'ghcr.io/grafana/k6-operator:latest',
      'ghcr.io/grafana/k6-operator:latest-starter',
      'registry:5000/k6',
    ]
  ) {
    assertEquals(isUnpinned(ref), true, String(ref));
  }
  assertEquals(isUnpinned('registry:5000/team/k6:1.2.3'), false);
  assertEquals(isUnpinned('grafana/k6@sha256:abc'), false);
});

Deno.test('a spec with no images gets the runner and starter pinned, keeping the rest', () => {
  const s = withPinnedImages({
    parallelism: 2,
    runner: { env: [{ name: 'BASE_URL', value: 'http://x' }] },
  });
  assertEquals(s.runner.image, K6_RUNNER_IMAGE);
  assertEquals(s.runner.env, [{ name: 'BASE_URL', value: 'http://x' }]);
  assertEquals(s.starter.image, K6_STARTER_IMAGE);
  assertEquals(s.parallelism, 2);
  assertEquals('initializer' in s, false);
});

Deno.test('an explicitly pinned image is kept; :latest is replaced', () => {
  const s = withPinnedImages({
    runner: { image: 'harbor/team/k6-xk6:2.0.1' },
    starter: { image: 'ghcr.io/grafana/k6-operator:latest-starter' },
    initializer: { image: 'grafana/k6:latest' },
  });
  assertEquals(s.runner.image, 'harbor/team/k6-xk6:2.0.1');
  assertEquals(s.starter.image, K6_STARTER_IMAGE);
  assertEquals((s as { initializer: { image: string } }).initializer.image, K6_RUNNER_IMAGE);
});

// Schedules and CI apply the template stored in the artefact ConfigMap, so the
// pin has to be in the template, not only in the console's own create call.
Deno.test('the runner template that schedules and CI apply carries pinned images', () => {
  const t = testRunTemplate({
    test: 'my-service-load',
    config: { namespace: 'test', parallelism: 1, env: { BASE_URL: 'http://my-service' } } as never,
  }) as unknown as {
    spec: { runner: { image: string; env: unknown[] }; starter: { image: string } };
  };
  assertEquals(t.spec.runner.image, K6_RUNNER_IMAGE);
  // BASE_URL, plus K6_SUMMARY_TREND_STATS (k6-trend-stats.ts).
  assertEquals(t.spec.runner.env.length, 2);
  assertEquals(t.spec.starter.image, K6_STARTER_IMAGE);
});

// Every place that builds a TestRun goes through the helper.
Deno.test('no TestRun is built without pinned images', async () => {
  for (const f of ['k6.ts', 'perf-runner.ts', 'perf-suite.ts']) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    const runs = src.split("kind: 'TestRun'").length - 1;
    const pinned = src.split('spec: withTrendStats(withPinnedImages(').length - 1;
    // …and asks k6 for p(99) (k6-trend-stats.ts) on the way.
    assertEquals(
      pinned,
      runs,
      `${f}: ${runs} TestRun(s) built, ${pinned} through withTrendStats(withPinnedImages(…))`,
    );
  }
});
