import type { k8s } from '@adhar/api-clients';
import type { ComponentType, Entity } from './catalog.ts';

/* ─────────── custom applications ─────────── */

export const APPLICATION_GVR = {
  group: 'platform.adhar.io',
  version: 'v1alpha1',
  resource: 'applications',
};
export const CONTROL_PLANE_NAMESPACE = 'adhar-system';

/** Names of every custom application: non-platform repositories and Application XRs. */
export function customAppNames(
  repoComponents: readonly Entity[],
  applications: readonly k8s.Generic[],
): Set<string> {
  const out = new Set<string>();
  for (const r of repoComponents) out.add(r.metadata.name.toLowerCase());
  for (const a of applications) if (a.metadata?.name) out.add(a.metadata.name.toLowerCase());
  return out;
}

/**
 * A workload is a custom application when it carries the control plane's
 * application label naming itself, or when its name is one. Composed
 * dependencies (`<app>-db`, `<app>-cache`, `<app>-events-…`) are neither.
 */
export function isCustomWorkload(
  obj: { metadata?: k8s.ObjectMeta },
  custom: ReadonlySet<string>,
): boolean {
  const name = (obj.metadata?.name ?? '').toLowerCase();
  const label = (obj.metadata?.labels?.['adhar.io/application'] ?? '').toLowerCase();
  if (label) return label === name;
  return custom.has(name);
}

/** One catalog entity per Application XR whose repository is not already a Gitea entity. */
export function applicationEntities(
  applications: readonly k8s.Generic[],
  repoComponents: readonly Entity[],
): Entity[] {
  const known = new Set(repoComponents.map((r) => r.metadata.name.toLowerCase()));
  const out: Entity[] = [];
  for (const a of applications) {
    const name = a.metadata?.name;
    if (!name || known.has(name.toLowerCase())) continue;
    const params =
      ((a as { spec?: { parameters?: Record<string, unknown> } }).spec?.parameters ?? {}) as Record<
        string,
        unknown
      >;
    const source = (params.source ?? {}) as Record<string, unknown>;
    const repo = typeof source.repoURL === 'string' ? source.repoURL.replace(/\.git$/, '') : '';
    const project = String(params.project ?? 'adhar');
    out.push({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name,
        namespace: 'default',
        title: typeof params.displayName === 'string' && params.displayName
          ? params.displayName
          : name,
        description: typeof params.description === 'string' && params.description
          ? params.description
          : `Application ${name} in project ${project}.`,
        tags: ['application'],
        links: /^https?:/.test(repo) && !/gitea-http\./.test(repo)
          ? [{ url: repo, title: 'Source', icon: 'repo' }]
          : undefined,
        createdAt: a.metadata?.creationTimestamp,
        updatedAt: a.metadata?.creationTimestamp,
      },
      spec: { type: String(params.type ?? 'service') as ComponentType },
      origin: 'live',
    } as Entity);
  }
  return out;
}
