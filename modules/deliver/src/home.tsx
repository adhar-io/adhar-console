import { PageHeader } from '@adhar-console/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { ArgoApps } from './views/argo-apps.tsx'
import { Environments } from './views/environments.tsx'
import { KargoStages } from './views/kargo-stages.tsx'
import { Rollouts } from './views/rollouts.tsx'
import { Releases } from './views/releases.tsx'
import { Registry } from './views/registry.tsx'
import { Scans } from './views/scans.tsx'
import { Runtime } from './views/runtime.tsx'
import { Policy } from './views/policy.tsx'

type Section =
  | 'dashboard'
  | 'apps'
  | 'environments'
  | 'stages'
  | 'rollouts'
  | 'releases'
  | 'registry'
  | 'scans'
  | 'runtime'
  | 'policy'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Deliver Dashboard',
    description: 'Delivery pulse — sync state, rollouts in flight, vulnerabilities, runtime alerts.',
  },
  apps: {
    label: 'ArgoCD Applications',
    description: 'GitOps applications reconciled live against the cluster.',
  },
  environments: {
    label: 'Environments',
    description: 'dev / staging / prod environments aggregated from ArgoCD destinations + Kargo stages.',
  },
  stages: {
    label: 'Kargo Stages',
    description: 'Promotion pipeline — stages, freight, and upstream subscriptions.',
  },
  rollouts: {
    label: 'Rollouts',
    description: 'Canary and blue/green rollouts from Argo Rollouts — with promote / abort.',
  },
  releases: {
    label: 'Releases',
    description: 'Release history derived from sync revisions, freight promotions, and image tags.',
  },
  registry: {
    label: 'Image Registry',
    description: 'Harbor repositories, artifacts, tags, and per-image vulnerability counts.',
  },
  scans: {
    label: 'Vulnerability Scans',
    description: 'Trivy reports — image, config, secret, RBAC and compliance findings.',
  },
  runtime: {
    label: 'Runtime Security',
    description: 'Falco events + rule library — detect suspicious behaviour at the syscall level.',
  },
  policy: {
    label: 'Policy',
    description: 'Kyverno policy reports — pass / fail / warn aggregates.',
  },
}

export default function DeliverHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      <PageHeader title={def.label} description={def.description} />
      {active === 'dashboard' && <Dashboard />}
      {active === 'apps' && <ArgoApps />}
      {active === 'environments' && <Environments />}
      {active === 'stages' && <KargoStages />}
      {active === 'rollouts' && <Rollouts />}
      {active === 'releases' && <Releases />}
      {active === 'registry' && <Registry />}
      {active === 'scans' && <Scans />}
      {active === 'runtime' && <Runtime />}
      {active === 'policy' && <Policy />}
    </div>
  )
}
