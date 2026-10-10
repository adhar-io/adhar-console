import {
  ArgoCDIcon,
  GiteaIcon,
  GrafanaIcon,
  HarborIcon,
  KargoIcon,
  TektonIcon,
} from '@adhar/shell-ui/brand-icons'
import type { StageKind } from '~/data/launch-content.ts'

/**
 * The official mark of the tool behind each supply-chain stage, from the
 * console's own brand-icon set (the same tiles the console uses in its
 * catalog), so the launch page and the product show identical logos.
 */
const LOGOS: Record<StageKind, (p: { size?: number; className?: string }) => React.ReactNode> = {
  source: GiteaIcon,
  build: TektonIcon,
  attest: HarborIcon,
  promote: KargoIcon,
  deploy: ArgoCDIcon,
  observe: GrafanaIcon,
}

export function ToolLogo(
  { stage, size = 20, className }: { stage: StageKind; size?: number; className?: string },
) {
  const Icon = LOGOS[stage]
  return <Icon size={size} className={className} />
}
