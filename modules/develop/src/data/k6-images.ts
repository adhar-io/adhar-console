/**
 * Pinned images for every pod a k6 TestRun creates.
 *
 * A TestRun that names no image gets the operator's built-in defaults —
 * `grafana/k6:latest` for the initializer and runners and
 * `ghcr.io/grafana/k6-operator:latest-starter` for the starter and stopper —
 * and the platform's `disallow-latest-tag` Kyverno policy refuses `:latest`.
 * The operator's very first Job (the initializer) was denied at admission and
 * never retried, so every Performance Center run sat in `initialization`
 * forever with "Creation of initializer pod takes too long" (2026-10-21).
 *
 * The initializer inherits the runner's settings when it has none of its own
 * (operator pkg/resources/jobs/initializer.go), so `runner` and `starter` cover
 * all four pod roles. The starter tracks the operator release the platform
 * installs (packages/application/k6, controller-v1.6.0); the runner tracks the
 * k6 the resilience runner uses.
 */
export const K6_RUNNER_IMAGE = 'grafana/k6:1.3.0';
export const K6_STARTER_IMAGE = 'ghcr.io/grafana/k6-operator:starter-v1.6.0';

/**
 * True when an image reference moves: no tag, a `latest` tag, or a `latest-*`
 * one like the operator's own `latest-starter` default. A digest or any other
 * tag is pinned.
 */
export function isUnpinned(ref: unknown): boolean {
  if (typeof ref !== 'string' || ref.trim() === '') return true;
  const [name, digest] = ref.split('@', 2);
  if (digest) return false;
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  const tag = colon > slash ? name.slice(colon + 1) : '';
  return tag === '' || tag === 'latest' || tag.startsWith('latest-');
}

type Pod = Record<string, unknown> & { image?: unknown };

/**
 * The spec with a pinned image for the runner (and so the initializer) and
 * the starter. An explicitly pinned image is kept; a missing or `:latest` one
 * is replaced, which also repairs a rerun of a run created before this.
 */
export function withPinnedImages<S extends Record<string, unknown>>(
  spec: S,
): S & { runner: Pod; starter: Pod } {
  const runner = (spec.runner ?? {}) as Pod;
  const starter = (spec.starter ?? {}) as Pod;
  const initializer = spec.initializer as Pod | undefined;
  return {
    ...spec,
    runner: { ...runner, image: isUnpinned(runner.image) ? K6_RUNNER_IMAGE : runner.image },
    starter: { ...starter, image: isUnpinned(starter.image) ? K6_STARTER_IMAGE : starter.image },
    // Only touched when a run states its own initializer, which then no
    // longer inherits the runner's image.
    ...(initializer
      ? {
        initializer: {
          ...initializer,
          image: isUnpinned(initializer.image) ? K6_RUNNER_IMAGE : initializer.image,
        },
      }
      : {}),
  };
}
