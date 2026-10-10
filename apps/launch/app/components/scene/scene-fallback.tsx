import { SUPPLY_CHAIN } from '~/data/launch-content.ts'

/**
 * Static stand-in for the supply-chain scene: the six stations on one
 * line, drawn as SVG. Used when WebGL is unavailable or the renderer fails.
 */
export function SupplyChainFallback() {
  const w = 1000
  const n = SUPPLY_CHAIN.length
  return (
    <svg viewBox={`0 0 ${w} 320`} className='h-full w-full' aria-hidden>
      <path
        d={`M 60 200 Q ${w / 2} 150 ${w - 60} 200`}
        fill='none'
        stroke='#3b82f6'
        strokeWidth='3'
        opacity='0.8'
      />
      <path
        d={`M ${w - 60} 200 Q ${w / 2} 60 60 200`}
        fill='none'
        stroke='#10b981'
        strokeWidth='2'
        strokeDasharray='8 6'
        opacity='0.6'
      />
      {SUPPLY_CHAIN.map((s, i) => {
        const x = 60 + (i / (n - 1)) * (w - 120)
        const y = 200 - Math.sin((i / (n - 1)) * Math.PI) * 25
        return (
          <g key={s.id}>
            <circle cx={x} cy={y} r={18} fill={s.color} />
            <text
              x={x}
              y={y + 48}
              textAnchor='middle'
              fontSize='16'
              fill='currentColor'
              fontFamily='var(--font-sans)'
            >
              {s.name}
            </text>
            <text
              x={x}
              y={y + 68}
              textAnchor='middle'
              fontSize='12'
              fill='currentColor'
              opacity='0.6'
              fontFamily='var(--font-sans)'
            >
              {s.tool}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function MaintenanceFallback() {
  return (
    <svg viewBox='0 0 400 320' className='h-full w-full' aria-hidden>
      <g transform='translate(200 160)'>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect
            key={i}
            x={-10}
            y={-96}
            width={20}
            height={28}
            rx={3}
            fill='#6366f1'
            transform={`rotate(${i * 45})`}
          />
        ))}
        <circle r={78} fill='#6366f1' />
        <circle r={30} fill='var(--color-surface-app)' />
      </g>
    </svg>
  )
}
