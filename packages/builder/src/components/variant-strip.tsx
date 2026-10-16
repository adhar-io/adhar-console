import type { DesignVariant } from '../lib/builder-types.ts';
import { STYLE_PRESETS } from '../lib/design-content.ts';

interface Props {
  variants: DesignVariant[];
  activeVariantId: string | null;
  onSelect: (variantId: string) => void;
  onRemove: (variantId: string) => void;
  onRegenerate: () => void;
  loading?: boolean;
  prompt?: string;
}

// Renders a small visual preview of the variant as stacked rectangles
// (mini-wireframe). Avoids having to actually render the full tree.
function VariantThumbnail({ variant }: { variant: DesignVariant }) {
  const count = Math.min(variant.nodes.length, 5);

  // Derive tint based on style
  const tints: Record<string, string> = {
    modern: 'from-blue-500/20 to-cyan-500/20',
    minimal: 'from-stone-300/30 to-stone-500/20',
    playful: 'from-amber-400/25 to-pink-400/25',
    enterprise: 'from-slate-500/20 to-slate-700/20',
    bold: 'from-foreground/30 to-foreground/10',
    editorial: 'from-amber-200/20 to-rose-200/20',
  };

  return (
    <div className={`w-full h-full rounded-lg bg-gradient-to-br ${tints[variant.style] || 'from-muted to-muted/50'} p-2.5 flex flex-col gap-1 overflow-hidden`}>
      {/* Fake nav line */}
      <div className='flex items-center gap-1 mb-0.5'>
        <div className='w-4 h-1.5 rounded-sm bg-foreground/40' />
        <div className='flex-1' />
        <div className='w-1 h-1 rounded-full bg-foreground/30' />
        <div className='w-1 h-1 rounded-full bg-foreground/30' />
        <div className='w-1 h-1 rounded-full bg-foreground/30' />
      </div>
      {/* Hero block */}
      <div className='h-6 rounded bg-foreground/15 flex items-end p-1'>
        <div className='h-1 w-3/5 rounded-sm bg-foreground/40' />
      </div>
      {/* Content rows */}
      {Array.from({ length: Math.max(2, count - 1) }).map((_, i) => (
        <div key={i} className='flex gap-1'>
          <div className='h-3 flex-1 rounded bg-foreground/10' />
          <div className='h-3 flex-1 rounded bg-foreground/10' />
          <div className='h-3 flex-1 rounded bg-foreground/10' />
        </div>
      ))}
    </div>
  );
}

export function VariantStrip({ variants, activeVariantId, onSelect, onRemove, onRegenerate, loading, prompt }: Props) {
  if (variants.length === 0) return null;

  return (
    <div
      className='flex items-center gap-2 px-4 py-2.5 border-b border-border bg-card/60 shrink-0 overflow-x-auto'
      style={{ backdropFilter: 'blur(8px)' }}
    >
      <div className='flex items-center gap-1.5 shrink-0 pr-2'>
        <svg className='w-3.5 h-3.5 text-muted-foreground/60' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.8}>
          <rect x='3' y='3' width='7' height='7' rx='1' />
          <rect x='14' y='3' width='7' height='7' rx='1' />
          <rect x='3' y='14' width='7' height='7' rx='1' />
          <rect x='14' y='14' width='7' height='7' rx='1' />
        </svg>
        <span className='text-[11px] font-semibold text-muted-foreground tracking-tight'>Variants</span>
        {prompt && (
          <span className='text-[10px] text-muted-foreground/50 italic truncate max-w-[200px] hidden md:inline' title={prompt}>
            · {prompt}
          </span>
        )}
      </div>

      <div className='flex items-center gap-2 flex-1 overflow-x-auto scrollbar-none'>
        {variants.map((v) => {
          const active = v.id === activeVariantId;
          const preset = STYLE_PRESETS[v.style];
          return (
            <div
              key={v.id}
              className={`group relative shrink-0 cursor-pointer transition-all ${
                active ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : 'opacity-70 hover:opacity-100'
              }`}
              style={{ width: 112 }}
            >
              <button type='button'
                onClick={() => onSelect(v.id)}
                className='w-full rounded-lg overflow-hidden border border-border bg-card'
                style={{ aspectRatio: '16/10' }}
                title={`${preset.label} variant — click to activate`}
              >
                <VariantThumbnail variant={v} />
              </button>
              <div className='flex items-center justify-between mt-1.5 px-0.5'>
                <span className={`text-[10px] font-medium tracking-tight ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                  {v.label}
                </span>
                {variants.length > 1 && (
                  <button type='button'
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(v.id);
                    }}
                    className='opacity-0 group-hover:opacity-100 w-4 h-4 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all'
                    title='Remove variant'
                  >
                    <svg width={9} height={9} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2.5}>
                      <path d='M18 6L6 18M6 6l12 12' />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <button type='button'
          onClick={onRegenerate}
          disabled={loading}
          className='shrink-0 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border hover:border-primary hover:bg-primary/5 transition-all disabled:opacity-50'
          style={{ width: 112, aspectRatio: '16/10' }}
          title='Generate more variants'
        >
          {loading ? (
            <svg className='w-4 h-4 animate-spin text-muted-foreground' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2.5}>
              <path d='M21 12a9 9 0 1 1-6.2-8.55' />
            </svg>
          ) : (
            <>
              <svg width={16} height={16} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2} className='text-muted-foreground'>
                <path d='M12 5v14M5 12h14' />
              </svg>
              <span className='text-[9px] font-medium text-muted-foreground'>More</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
