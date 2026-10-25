import { PageHeader } from '@adhar/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { DeliveryFlow } from './views/flow.tsx'
import { ArgoApps } from './views/argo-apps.tsx'
import { Environments } from './views/environments.tsx'
import { KargoStages } from './views/kargo-stages.tsx'
import { Rollouts } from './views/rollouts.tsx'
import { Releases } from './views/releases.tsx'
import { Registry } from './views/registry.tsx'
import { Scans } from './views/scans.tsx'
import { Runtime } from './views/runtime.tsx'
import { Policy } from './views/policy.tsx'
import { Functions } from './views/functions.tsx'

type Section =
  | 'dashboard'
  | 'flow'
  | 'apps'
  | 'environments'
  | 'stages'
  | 'rollouts'
  | 'releases'
  | 'registry'
  | 'scans'
  | 'runtime'
  | 'policy'
  | 'functions'
  | 'scan-review'
  | 'waivers'
  | 'licenses'
  | 'scan-policy'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Deliver Dashboard',
    description: 'Delivery pulse — sync state, rollouts in flight, vulnerabilities, runtime alerts.',
  },
  flow: {
    label: 'Delivery Flow',
    description:
      'End-to-end value stream for your applications — code, PR, build, scan & sign, image, freight and each environment (dev → test → prod), with commit tracing, lead time and where a change is stuck.',
  },
  apps: {
    label: 'ArgoCD Applications',
    description: 'GitOps applications reconciled live against the cluster.',
  },
  environments: {
    label: 'Environments',
    description: "Each project's dev → test → prod, shared by every application in it — versions, health and promotions per app.",
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
    // Label kept in step with the sidebar entry (`deliver.registry` in nav-tree).
    label: 'Image Registry',
    description:
      'Harbor container images and Nexus packages — tags, versions, provenance, signatures, scan results and the admission policies that gate them.',
  },
  scans: {
    label: 'Vulnerability Scans',
    description:
      'Findings in running workloads, CI and the registry; OSS licenses; waivers with review, expiry and audit; scan policy and the manual scan gate.',
  },
  // Direct entries into the Scans page's tabs (deep-linkable sidebar rows).
  'scan-review': {
    label: 'Vulnerability Scans',
    description: 'Waiver requests and pipeline runs paused at the scan gate, waiting for a reviewer.',
  },
  waivers: {
    label: 'Vulnerability Scans',
    description: 'Every accepted, pending, expired and revoked scan waiver — with its audit trail.',
  },
  licenses: {
    label: 'Vulnerability Scans',
    description: 'License inventory from the running images\' SBOMs, judged against the license policy.',
  },
  'scan-policy': {
    label: 'Vulnerability Scans',
    description: 'Severity gate, scanners, enforce / warn, manual approval, license lists and waiver limits — global and per project.',
  },
  runtime: {
    label: 'Runtime Security',
    description: 'Tetragon and Falco — what processes actually did inside running workloads.',
  },
  policy: {
    label: 'Policy',
    description: 'Kyverno policy reports — pass / fail / warn aggregates.',
  },
  functions: {
    label: 'Functions',
    description: 'Function lifecycle operations with runtime health and quick access to performance and chaos workflows.',
  },
}

export default function DeliverHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  return (
    <div className="space-y-6">
      <PageHeader title={def.label} />
      {active === 'dashboard' && <Dashboard />}
      {active === 'flow' && <DeliveryFlow />}
      {active === 'apps' && <ArgoApps />}
      {active === 'environments' && <Environments />}
      {active === 'stages' && <KargoStages />}
      {active === 'rollouts' && <Rollouts />}
      {active === 'releases' && <Releases />}
      {active === 'registry' && <Registry />}
      {active === 'scans' && <Scans />}
      {active === 'scan-review' && <Scans defaultTab="review" />}
      {active === 'waivers' && <Scans defaultTab="waivers" />}
      {active === 'licenses' && <Scans defaultTab="licenses" />}
      {active === 'scan-policy' && <Scans defaultTab="policy" />}
      {active === 'runtime' && <Runtime />}
      {active === 'policy' && <Policy />}
      {active === 'functions' && <Functions />}
    </div>
  )
}
