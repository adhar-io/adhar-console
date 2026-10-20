import { useMemo } from 'react'
import { useProjects } from './plane.ts'
import { useCyclesFor, useModulesFor, useProjectsData } from './insights-data.ts'
import type { KrLink, LinkResolver, Objective } from './okrs-model.ts'

/** Resolve KR links against live Plane data (modules, cycles, issues). */
export function useLinkResolver(objectives: Objective[]): LinkResolver {
  const links = objectives.flatMap((o) => o.key_results.flatMap((k) => k.links ?? []));
  const projectIds = [...new Set(links.map((l) => l.project))].slice(0, 6);
  const projectsQ = useProjects();
  const modules = useModulesFor(
    projectIds.filter((p) => links.some((l) => l.project === p && l.kind === 'module')),
  );
  const cycles = useCyclesFor(
    projectIds.filter((p) => links.some((l) => l.project === p && l.kind === 'cycle')),
  );
  const issueProjects = (projectsQ.data ?? []).filter((p) =>
    links.some((l) => l.project === p.id && l.kind === 'issue')
  );
  const issues = useProjectsData(issueProjects, { snapshot: false });
  const stamp = [...modules, ...cycles].map((q) => q.dataUpdatedAt).join(',') + issues.updatedAt;
  return useMemo(() => {
    const mods = new Map(modules.flatMap((q) => q.data ?? []).map((m) => [m.id, m]));
    const cyc = new Map(cycles.flatMap((q) => q.data ?? []).map((c) => [c.id, c]));
    const its = new Map(issues.items.map((i) => [i.id, i]));
    const counts = (
      x?: { total_issues?: number; completed_issues?: number; cancelled_issues?: number },
    ) =>
      x
        ? {
          done: x.completed_issues ?? 0,
          total: Math.max(0, (x.total_issues ?? 0) - (x.cancelled_issues ?? 0)),
        }
        : undefined;
    return (l: KrLink) => {
      if (l.kind === 'module') return counts(mods.get(l.id));
      if (l.kind === 'cycle') return counts(cyc.get(l.id));
      const i = its.get(l.id);
      if (!i || i.group === 'cancelled') return undefined;
      return { done: i.group === 'completed' ? 1 : 0, total: 1 };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
}

