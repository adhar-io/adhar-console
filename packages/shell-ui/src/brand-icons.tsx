/**
 * Brand marks for backing OSS tools. Each icon is a simplified, recognisable
 * SVG approximation of the upstream project's logo — tuned for a 40px tile
 * on a neutral background. Colors match the canonical brand palette so the
 * icons stay identifiable even without the full official artwork.
 *
 * These are intentionally schematic, not pixel-perfect replicas. If a tile
 * needs the exact official logo, swap the body with a fetched SVG and keep
 * this component as the fallback.
 */

type BrandProps = { size?: number; className?: string }

const base = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: '0 0 40 40',
    xmlns: 'http://www.w3.org/2000/svg',
  }) as const

export function GiteaIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#609926" />
      <path
        d="M20.4 11.6 29 20.1c.8.8.8 2.1 0 2.9l-6.7 6.7c-.8.8-2 .8-2.8 0l-8.6-8.5c-.8-.8-.8-2.1 0-2.9l6.7-6.7c.8-.8 2-.8 2.8 0Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
      />
      <circle cx="28.2" cy="13.5" r="3.3" fill="#fff" />
      <circle cx="28.2" cy="13.5" r="1.4" fill="#609926" />
    </svg>
  )
}

export function ArgoIcon({ size = 40, className, tint = '#EF7B4D' }: BrandProps & { tint?: string }) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#111" />
      <path
        d="M20 8c-6 0-11 5-11 11 0 4 2 7 5 9 1 .5 2 0 2-1v-1c0-.7-.3-1-1-1.4-2-1.1-3-3-3-5.6 0-4.4 3.4-7.8 8-7.8s8 3.4 8 7.8c0 2.5-1 4.5-3 5.6-.7.4-1 .7-1 1.4V27c0 1 1 1.5 2 1 3-2 5-5 5-9 0-6-5-11-11-11Z"
        fill={tint}
      />
      <circle cx="20" cy="19" r="2.4" fill="#fff" />
    </svg>
  )
}

export function ArgoCDIcon(props: BrandProps) {
  return <ArgoIcon {...props} tint="#EF7B4D" />
}

export function ArgoWorkflowsIcon(props: BrandProps) {
  return <ArgoIcon {...props} tint="#8A2BE2" />
}

export function ArgoRolloutsIcon(props: BrandProps) {
  return <ArgoIcon {...props} tint="#06B6D4" />
}

export function KargoIcon({ size = 40, className }: BrandProps) {
  // Kargo = staged promotion of a shipping "cargo" box. Authentic blue.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#0B5CFF" />
      <path d="M20 9 30 14v12l-10 5-10-5V14L20 9Z" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M10 14l10 5 10-5M20 19v12" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" fill="none" />
    </svg>
  )
}

export function KyvernoIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#326CE5" />
      <path
        d="M20 9 10 13v6c0 6 4 10 10 12 6-2 10-6 10-12v-6l-10-4Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="m15 20 3.5 3.5L25 17" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

export function KeycloakIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#008AAA" />
      <circle cx="20" cy="18" r="6" fill="none" stroke="#fff" strokeWidth="2.4" />
      <path d="M20 24v6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M17 27h6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="20" cy="18" r="1.6" fill="#fff" />
    </svg>
  )
}

export function HarborIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#60B932" />
      <circle cx="20" cy="17" r="3.2" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M20 20v10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 26c0 4 4 5 9 5s9-1 9-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M14 24h12" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function CrossplaneIcon({ size = 40, className }: BrandProps) {
  // Crossplane's mark reads as interlocking rotated squares (a composition
  // lattice). Authentic deep-blue on white.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#1A0DAB" />
      <g transform="rotate(45 20 20)">
        <rect x="12" y="12" width="16" height="16" rx="3" fill="none" stroke="#fff" strokeWidth="2.4" />
        <rect x="16.5" y="16.5" width="7" height="7" rx="1.5" fill="#fff" />
      </g>
    </svg>
  )
}

export function PlaneIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#3B82F6" />
      <path d="m9 18 22-8-8 22-4-9-10-5Z" fill="#fff" />
      <path d="m19 23 4 9 4-13" fill="none" stroke="#3B82F6" strokeWidth="1.4" />
    </svg>
  )
}

export function GrafanaIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#F46800" />
      <path
        d="M20 9c-5 0-9 3-10 7l3 1c1-2 3-3 6-3 0-2 1-3 3-3l-2-2Z"
        fill="#fff"
      />
      <circle cx="20" cy="22" r="7" fill="none" stroke="#fff" strokeWidth="2.4" />
      <circle cx="20" cy="22" r="3" fill="#fff" />
    </svg>
  )
}

export function PrometheusIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#E6522C" />
      <path d="M20 8c-3 5 0 8 0 12 0 3-3 5-3 8 0 4 3 4 3 4s3 0 3-4c0-3-3-5-3-8 0-4 3-7 0-12Z" fill="#fff" />
      <path d="M13 27h14v2.5a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V27Z" fill="#fff" />
    </svg>
  )
}

export function LokiIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#111" />
      <path d="M10 26h3V14h4v12h3V11h4v15h3V18h4v8h3" stroke="#F46800" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function TempoIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#6E4AFF" />
      <rect x="8" y="14" width="14" height="3" rx="1.5" fill="#fff" />
      <rect x="12" y="19" width="18" height="3" rx="1.5" fill="#fff" />
      <rect x="10" y="24" width="12" height="3" rx="1.5" fill="#fff" />
    </svg>
  )
}

export function MinIOIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#C72C48" />
      <path
        d="M10 28V12l5 10 5-10 5 10 5-10v16"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function AirbyteIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#615EFF" />
      <path
        d="M10 20c0-5 4-9 9-9s7 3 7 7c0 3-2 5-5 5H14c-2 0-4 2-4 4s2 4 4 4h12"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function MetabaseIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#509EE3" />
      <circle cx="14" cy="14" r="2.4" fill="#fff" />
      <circle cx="26" cy="14" r="2.4" fill="#fff" />
      <circle cx="10" cy="20" r="2.4" fill="#fff" />
      <circle cx="30" cy="20" r="2.4" fill="#fff" />
      <circle cx="14" cy="26" r="2.4" fill="#fff" />
      <circle cx="26" cy="26" r="2.4" fill="#fff" />
      <circle cx="20" cy="20" r="2.4" fill="#fff" />
    </svg>
  )
}

export function IcebergIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#1F6FEB" />
      <path d="M20 8 12 22h5v8h6v-8h5L20 8Z" fill="#fff" />
      <path d="M10 30c3-2 6 0 10 0s7-2 10 0" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function KubernetesIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#326CE5" />
      <path
        d="M20 8 10 14v10l10 6 10-6V14L20 8Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="19" r="3.5" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path
        d="M20 8v6M10 14l5.5 3M30 14l-5.5 3M10 24l5.5-2M30 24l-5.5-2M20 30v-7"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function OTelIcon({ size = 40, className }: BrandProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#425CC7" />
      <circle cx="16" cy="24" r="4" fill="#F5A800" />
      <rect x="21" y="11" width="9" height="9" rx="2" fill="#fff" transform="rotate(45 25.5 15.5)" />
    </svg>
  )
}

export function VaultIcon({ size = 40, className }: BrandProps) {
  // HashiCorp Vault — the black wedge "V" with the keyhole dot, on Vault yellow.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#FFD814" />
      <path d="M8 10h24L20 32 8 10Z" fill="#111" />
      <circle cx="20" cy="16" r="2" fill="#FFD814" />
      <path d="M20 18v3.5" stroke="#FFD814" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function FalcoIcon({ size = 40, className }: BrandProps) {
  // Falco — the falcon-head profile mark, Sysdig teal.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#00AEC7" />
      <path
        d="M12 11c7-2 13 1 15 6 1.5 3.8.5 8-2.5 11L20 32l2-6c-6 1-10-2-11-7l6 1-5-9Z"
        fill="#fff"
      />
      <circle cx="21.5" cy="16.5" r="1.7" fill="#00AEC7" />
    </svg>
  )
}

export function TektonIcon({ size = 40, className }: BrandProps) {
  // Tekton — schematic pipeline: chained task nodes flowing left → right.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#FD495C" />
      <path d="M11 20h18" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="11" cy="20" r="3.4" fill="#fff" />
      <circle cx="20" cy="20" r="3.4" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="m27 16 5 4-5 4v-8Z" fill="#fff" />
    </svg>
  )
}

export function CoderIcon({ size = 40, className }: BrandProps) {
  // Coder — terminal prompt in a dev workspace. Near-black brand ground.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#090B0B" />
      <path
        d="m11 14 6 6-6 6"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M20 26h9" stroke="#3FE1B0" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

export function TrivyIcon({ size = 40, className }: BrandProps) {
  // Aqua Trivy — magnifier sweeping a shield (image scanning). Aqua navy/cyan.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#1D3C8F" />
      <path
        d="M17 9 9 12v5c0 5 3.2 8.5 8 10.5 4.8-2 8-5.5 8-10.5v-5l-8-3Z"
        fill="none"
        stroke="#08B1D5"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="22" cy="21" r="5" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="m25.7 24.7 4.5 4.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function PostHogIcon({ size = 40, className }: BrandProps) {
  // PostHog — ascending event bars in the tri-color brand palette on near-black.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#151515" />
      <path d="M9 30V22l6 6v2H9Z" fill="#F9BD2B" />
      <path d="M17 30V16l6 6v8h-6Z" fill="#F54E00" />
      <path d="M25 30V10l6 6v14h-6Z" fill="#1D4AFF" />
    </svg>
  )
}

export function OpenCostIcon({ size = 40, className }: BrandProps) {
  // OpenCost — cost gauge/coin over a spend trend. CNCF purple.
  return (
    <svg {...base(size)} className={className} aria-hidden>
      <rect width="40" height="40" rx="9" fill="#6E3ADE" />
      <circle cx="20" cy="17" r="7.5" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path
        d="M22.8 14.3c-.6-.9-1.6-1.4-2.8-1.4-1.9 0-3.2 1-3.2 2.3 0 3 6.4 1.4 6.4 4.4 0 1.3-1.3 2.3-3.2 2.3-1.3 0-2.4-.6-3-1.5M20 11v12"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M9 31c3-3 6-1.5 9-3s6-4 13-3" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.85" />
    </svg>
  )
}
