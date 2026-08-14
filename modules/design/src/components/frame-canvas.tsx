import type { WireframeBlock, WireframeBlockType } from '../data/types.ts'

/**
 * Read-only renderer for a single wireframe frame.
 *
 * Used in two places:
 *   1. Library cards on the Wireframes page — every card shows a thumbnail
 *      of its frame.
 *   2. Builder fallback — when the Visual Builder iframe isn't reachable,
 *      we still render the frame here so the team can at least see it.
 *
 * Editing happens in the embedded Visual Builder; this file is purely
 * presentational so it can stay tiny and dependency-free.
 */

export const VIEW_W = 720
export const VIEW_H = 440
export const TOPBAR_H = 26

export function FrameCanvas({ blocks }: { blocks: WireframeBlock[] }) {
  return (
    <div
      className="relative overflow-hidden rounded-md border border-edge-default bg-linear-to-br from-surface-sunken/50 to-surface-raised"
      style={{ paddingBottom: `${(VIEW_H / VIEW_W) * 100}%` }}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full"
      >
        <Viewport />
        {blocks.map((b, i) => (
          <BlockShape key={i} block={b} />
        ))}
      </svg>
    </div>
  )
}

export function Viewport() {
  return (
    <g>
      <rect x="6" y="6" width={VIEW_W - 12} height={VIEW_H - 12} rx="6" fill="var(--color-surface-raised)" stroke="var(--color-edge-subtle)" />
      <rect x="6" y="6" width={VIEW_W - 12} height={TOPBAR_H - 6} fill="var(--color-surface-sunken)" />
      <circle cx="14" cy="13" r="2" fill="#f43f5e" />
      <circle cx="22" cy="13" r="2" fill="#f59e0b" />
      <circle cx="30" cy="13" r="2" fill="#10b981" />
    </g>
  )
}

export function BlockShape({ block: b }: { block: WireframeBlock }) {
  const x = b.x
  const y = b.y + TOPBAR_H
  const stroke = 'var(--color-edge-subtle)'
  const radius = b.type === 'avatar' ? Math.min(b.w, b.h) / 2 : 6
  const fill = blockFill(b.type)
  const label = b.label ?? ''

  switch (b.type) {
    case 'logo':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill={fill} stroke={stroke} />
          <circle cx={x + 12} cy={y + b.h / 2} r={6} fill="var(--color-brand-500)" />
          <rect x={x + 24} y={y + b.h / 2 - 4} width={Math.max(0, b.w - 32)} height="8" rx="2" fill="var(--color-content-subtle)" opacity="0.5" />
        </g>
      )
    case 'h1':
      return (
        <g>
          <rect x={x} y={y} width={Math.min(b.w, 320)} height={Math.min(b.h, 28)} rx="3" fill="var(--color-content)" opacity="0.85" />
          {b.h > 30 ? <rect x={x} y={y + 32} width={b.w * 0.7} height="12" rx="2" fill="var(--color-content-subtle)" opacity="0.4" /> : null}
        </g>
      )
    case 'h2':
      return <rect x={x} y={y} width={b.w} height={b.h} rx="3" fill="var(--color-content)" opacity="0.7" />
    case 'text':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height="6" rx="2" fill="var(--color-content-subtle)" opacity="0.45" />
          <rect x={x} y={y + 10} width={b.w * 0.85} height="6" rx="2" fill="var(--color-content-subtle)" opacity="0.35" />
          {b.h > 20 ? <rect x={x} y={y + 20} width={b.w * 0.7} height="6" rx="2" fill="var(--color-content-subtle)" opacity="0.3" /> : null}
        </g>
      )
    case 'input':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-surface-raised)" stroke={stroke} />
          <text x={x + 10} y={y + b.h / 2 + 4} fontSize="11" fill="var(--color-content-subtle)">
            {label || 'Field…'}
          </text>
        </g>
      )
    case 'button':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-brand-500)" />
          <text x={x + b.w / 2} y={y + b.h / 2 + 4} fontSize="12" fontWeight="600" fill="white" textAnchor="middle">
            {label || 'Button'}
          </text>
        </g>
      )
    case 'card':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-surface-raised)" stroke={stroke} />
          {label ? (
            <text x={x + b.w / 2} y={y + b.h / 2 + 4} fontSize="12" fill="var(--color-content-subtle)" textAnchor="middle">
              {label}
            </text>
          ) : (
            <>
              <rect x={x + 12} y={y + 12} width={Math.max(0, b.w - 24)} height="10" rx="2" fill="var(--color-content-subtle)" opacity="0.4" />
              <rect x={x + 12} y={y + 28} width={Math.max(0, b.w * 0.7)} height="6" rx="2" fill="var(--color-content-subtle)" opacity="0.25" />
              <rect x={x + 12} y={y + 40} width={Math.max(0, b.w * 0.6)} height="6" rx="2" fill="var(--color-content-subtle)" opacity="0.25" />
            </>
          )}
        </g>
      )
    case 'image':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-surface-sunken)" stroke={stroke} />
          <line x1={x} y1={y + b.h} x2={x + b.w} y2={y} stroke="var(--color-edge-subtle)" />
          <line x1={x} y1={y} x2={x + b.w} y2={y + b.h} stroke="var(--color-edge-subtle)" />
        </g>
      )
    case 'avatar':
      return <circle cx={x + b.w / 2} cy={y + b.h / 2} r={Math.min(b.w, b.h) / 2} fill="var(--color-brand-100)" stroke={stroke} />
    case 'tag':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={b.h / 2} fill="var(--color-brand-50)" />
          <text x={x + b.w / 2} y={y + b.h / 2 + 3} fontSize="10" fill="var(--color-brand-700)" textAnchor="middle">
            {label || 'tag'}
          </text>
        </g>
      )
    case 'divider':
      return <line x1={x} y1={y + b.h / 2} x2={x + b.w} y2={y + b.h / 2} stroke="var(--color-edge-default)" strokeWidth="1.25" />
    case 'navbar': {
      const itemCount = 4
      const itemW = Math.max(40, (b.w - 120) / itemCount)
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx="6" fill="var(--color-surface-raised)" stroke={stroke} />
          <circle cx={x + 18} cy={y + b.h / 2} r="6" fill="var(--color-brand-500)" />
          <rect x={x + 32} y={y + b.h / 2 - 4} width="64" height="8" rx="2" fill="var(--color-content)" opacity="0.7" />
          {Array.from({ length: itemCount }).map((_, i) => (
            <rect key={i} x={x + 110 + i * itemW + 8} y={y + b.h / 2 - 5} width={Math.max(0, itemW - 16)} height="10" rx="2" fill="var(--color-content-subtle)" opacity="0.45" />
          ))}
        </g>
      )
    }
    case 'sidebar': {
      const itemCount = Math.max(3, Math.floor((b.h - 40) / 32))
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx="6" fill="var(--color-surface-sunken)" stroke={stroke} />
          <rect x={x + 12} y={y + 12} width={Math.max(0, b.w - 24)} height="10" rx="2" fill="var(--color-content)" opacity="0.7" />
          {Array.from({ length: itemCount }).map((_, i) => (
            <g key={i}>
              <rect x={x + 12} y={y + 32 + i * 28} width="14" height="14" rx="3" fill="var(--color-brand-100)" opacity={i === 0 ? 1 : 0.5} />
              <rect x={x + 32} y={y + 32 + i * 28 + 4} width={Math.max(0, b.w - 48)} height="6" rx="2" fill={i === 0 ? 'var(--color-brand-700)' : 'var(--color-content-subtle)'} opacity={i === 0 ? 0.85 : 0.5} />
            </g>
          ))}
        </g>
      )
    }
    case 'search':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={Math.min(radius, b.h / 2)} fill="var(--color-surface-raised)" stroke={stroke} />
          <circle cx={x + 14} cy={y + b.h / 2} r="4" fill="none" stroke="var(--color-content-subtle)" strokeWidth="1.5" />
          <line x1={x + 17} y1={y + b.h / 2 + 3} x2={x + 21} y2={y + b.h / 2 + 7} stroke="var(--color-content-subtle)" strokeWidth="1.5" strokeLinecap="round" />
          <text x={x + 30} y={y + b.h / 2 + 4} fontSize="11" fill="var(--color-content-subtle)">
            {label || 'Search…'}
          </text>
        </g>
      )
    case 'toggle': {
      const on = label?.toLowerCase() !== 'off'
      const knobX = on ? x + b.w - b.h + 2 : x + 2
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={b.h / 2} fill={on ? 'var(--color-brand-500)' : 'var(--color-edge-default)'} />
          <circle cx={knobX + (b.h - 4) / 2} cy={y + b.h / 2} r={(b.h - 4) / 2} fill="white" />
        </g>
      )
    }
    case 'checkbox': {
      const checked = label?.toLowerCase() !== 'unchecked'
      const size = Math.min(b.w, b.h, 18)
      return (
        <g>
          <rect x={x} y={y + (b.h - size) / 2} width={size} height={size} rx="3" fill={checked ? 'var(--color-brand-500)' : 'var(--color-surface-raised)'} stroke={checked ? 'var(--color-brand-500)' : stroke} />
          {checked ? (
            <path d={`M ${x + 4} ${y + (b.h - size) / 2 + size / 2} l ${size / 4} ${size / 4} l ${size / 2} -${size / 2}`} fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          {b.w > size + 6 ? (
            <text x={x + size + 6} y={y + b.h / 2 + 4} fontSize="11" fill="var(--color-content)">
              {label && label.toLowerCase() !== 'unchecked' ? label : 'Option'}
            </text>
          ) : null}
        </g>
      )
    }
    case 'radio': {
      const sel = label?.toLowerCase() !== 'off'
      const r = Math.min(b.w, b.h, 18) / 2
      return (
        <g>
          <circle cx={x + r} cy={y + b.h / 2} r={r} fill="var(--color-surface-raised)" stroke={sel ? 'var(--color-brand-500)' : stroke} />
          {sel ? <circle cx={x + r} cy={y + b.h / 2} r={r * 0.5} fill="var(--color-brand-500)" /> : null}
          {b.w > r * 2 + 6 ? (
            <text x={x + r * 2 + 6} y={y + b.h / 2 + 4} fontSize="11" fill="var(--color-content)">
              {label && label.toLowerCase() !== 'off' ? label : 'Option'}
            </text>
          ) : null}
        </g>
      )
    }
    case 'dropdown':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-surface-raised)" stroke={stroke} />
          <text x={x + 10} y={y + b.h / 2 + 4} fontSize="11" fill="var(--color-content)">
            {label || 'Select…'}
          </text>
          <path d={`M ${x + b.w - 14} ${y + b.h / 2 - 2} l 4 4 l 4 -4`} fill="none" stroke="var(--color-content-subtle)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    case 'link':
      return (
        <text x={x} y={y + b.h - 2} fontSize="12" fill="var(--color-brand-700)" textDecoration="underline">
          {label || 'link text'}
        </text>
      )
    case 'list': {
      const rows = Math.max(2, Math.floor(b.h / 24))
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx="4" fill="var(--color-surface-raised)" stroke={stroke} />
          {Array.from({ length: rows }).map((_, i) => (
            <g key={i}>
              <circle cx={x + 12} cy={y + 14 + i * 24} r="2" fill="var(--color-content-subtle)" />
              <rect x={x + 22} y={y + 11 + i * 24} width={Math.max(0, b.w - 36 - (i % 2) * 30)} height="6" rx="2" fill="var(--color-content)" opacity="0.55" />
            </g>
          ))}
        </g>
      )
    }
    case 'table': {
      const cols = 3
      const rows = Math.max(3, Math.floor((b.h - 28) / 22))
      const colW = b.w / cols
      const headerH = 22
      const rowH = (b.h - headerH) / rows
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx="4" fill="var(--color-surface-raised)" stroke={stroke} />
          <rect x={x} y={y} width={b.w} height={headerH} fill="var(--color-surface-sunken)" />
          {Array.from({ length: cols }).map((_, c) => (
            <rect key={`h-${c}`} x={x + c * colW + 8} y={y + headerH / 2 - 3} width={Math.max(0, colW - 16)} height="6" rx="2" fill="var(--color-content)" opacity="0.6" />
          ))}
          {Array.from({ length: rows }).map((_, r) =>
            Array.from({ length: cols }).map((_, c) => (
              <rect key={`r-${r}-${c}`} x={x + c * colW + 8} y={y + headerH + r * rowH + rowH / 2 - 3} width={Math.max(0, colW - 16)} height="6" rx="2" fill="var(--color-content-subtle)" opacity="0.4" />
            )),
          )}
          {Array.from({ length: cols - 1 }).map((_, c) => (
            <line key={`vl-${c}`} x1={x + (c + 1) * colW} x2={x + (c + 1) * colW} y1={y} y2={y + b.h} stroke="var(--color-edge-subtle)" />
          ))}
          <line x1={x} x2={x + b.w} y1={y + headerH} y2={y + headerH} stroke="var(--color-edge-default)" />
        </g>
      )
    }
    case 'tabs': {
      const tabs = (label || 'One,Two,Three').split(',').map((s) => s.trim())
      const tabW = b.w / tabs.length
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={b.h / 2} fill="var(--color-surface-sunken)" />
          <rect x={x + 2} y={y + 2} width={tabW - 4} height={b.h - 4} rx={(b.h - 4) / 2} fill="var(--color-surface-raised)" stroke="var(--color-edge-subtle)" />
          {tabs.map((t, i) => (
            <text
              key={i}
              x={x + tabW * (i + 0.5)}
              y={y + b.h / 2 + 4}
              fontSize="11"
              textAnchor="middle"
              fill={i === 0 ? 'var(--color-content)' : 'var(--color-content-subtle)'}
              fontWeight={i === 0 ? 600 : 400}
            >
              {t}
            </text>
          ))}
        </g>
      )
    }
    case 'stat': {
      const [num, lab] = (label || '128|Active users').split('|')
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-surface-raised)" stroke={stroke} />
          <text x={x + b.w / 2} y={y + b.h / 2 + 2} fontSize="22" fontWeight="700" textAnchor="middle" fill="var(--color-content)">
            {num}
          </text>
          <text x={x + b.w / 2} y={y + b.h - 10} fontSize="10" textAnchor="middle" fill="var(--color-content-subtle)" fontWeight="600">
            {(lab || '').toUpperCase()}
          </text>
        </g>
      )
    }
    case 'chart': {
      const bars = 6
      const bw = (b.w - 20) / bars
      const heights = [0.4, 0.7, 0.55, 0.85, 0.5, 0.95]
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-surface-raised)" stroke={stroke} />
          {heights.slice(0, bars).map((h, i) => {
            const barH = (b.h - 16) * h
            return (
              <rect
                key={i}
                x={x + 10 + i * bw + bw * 0.15}
                y={y + b.h - 8 - barH}
                width={bw * 0.7}
                height={barH}
                rx="2"
                fill={`var(--color-brand-${300 + (i % 3) * 100})`}
              />
            )
          })}
        </g>
      )
    }
    case 'icon':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-brand-50)" stroke={stroke} />
          <circle cx={x + b.w / 2} cy={y + b.h / 2} r={Math.min(b.w, b.h) / 4} fill="none" stroke="var(--color-brand-500)" strokeWidth="1.5" />
          <line
            x1={x + b.w / 2 - Math.min(b.w, b.h) / 8}
            y1={y + b.h / 2}
            x2={x + b.w / 2 + Math.min(b.w, b.h) / 8}
            y2={y + b.h / 2}
            stroke="var(--color-brand-500)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      )
    case 'footer':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} fill="var(--color-surface-sunken)" stroke={stroke} />
          <rect x={x + 16} y={y + b.h / 2 - 4} width={Math.max(0, b.w - 32)} height="8" rx="2" fill="var(--color-content-subtle)" opacity="0.4" />
        </g>
      )
    case 'badge':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={b.h / 2} fill="var(--color-emerald-500)" />
          <text x={x + b.w / 2} y={y + b.h / 2 + 3} fontSize="9" fontWeight="700" textAnchor="middle" fill="white">
            {label || 'NEW'}
          </text>
        </g>
      )
    case 'alert':
      return (
        <g>
          <rect x={x} y={y} width={b.w} height={b.h} rx={radius} fill="var(--color-amber-50)" stroke="var(--color-amber-300)" />
          <circle cx={x + 16} cy={y + b.h / 2} r="6" fill="var(--color-amber-500)" />
          <text x={x + 16} y={y + b.h / 2 + 3} fontSize="9" fontWeight="700" textAnchor="middle" fill="white">!</text>
          <rect x={x + 32} y={y + b.h / 2 - 4} width={Math.max(0, b.w - 48)} height="8" rx="2" fill="var(--color-amber-700)" opacity="0.6" />
        </g>
      )
    case 'breadcrumb': {
      const parts = (label || 'Home / Section / Page').split('/').map((s) => s.trim())
      let cursor = x
      return (
        <g>
          {parts.map((p, i) => {
            const w = p.length * 7 + 12
            const el = (
              <g key={i}>
                <text x={cursor} y={y + b.h / 2 + 4} fontSize="11" fill={i === parts.length - 1 ? 'var(--color-content)' : 'var(--color-content-subtle)'} fontWeight={i === parts.length - 1 ? 600 : 400}>
                  {p}
                </text>
                {i < parts.length - 1 ? (
                  <text x={cursor + w - 4} y={y + b.h / 2 + 4} fontSize="11" fill="var(--color-content-subtle)">›</text>
                ) : null}
              </g>
            )
            cursor += w + 8
            return el
          })}
        </g>
      )
    }
  }
}

function blockFill(t: WireframeBlockType): string {
  if (t === 'image') return 'var(--color-surface-sunken)'
  if (t === 'card' || t === 'input' || t === 'navbar' || t === 'list' || t === 'table' || t === 'stat' || t === 'icon' || t === 'chart' || t === 'dropdown' || t === 'search') return 'var(--color-surface-raised)'
  return 'var(--color-surface-sunken)'
}
