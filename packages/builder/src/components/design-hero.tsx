import React, { useRef, useState, useEffect } from 'react';
import { DESIGN_SUGGESTIONS, STYLE_PRESETS, type StyleKey } from '../lib/design-content.ts';
import {
  FRAMEWORKS,
  ReactLogo,
  NextLogo,
  VueLogo,
  SvelteLogo,
  AngularLogo,
  SolidLogo,
  TailwindLogo,
} from '../lib/framework-logos.tsx';

interface Props {
  onGenerate: (prompt: string, styles?: StyleKey[]) => void;
  loading: boolean;
  pageName: string;
  devicePreview: 'desktop' | 'tablet' | 'mobile';
  onDeviceChange: (d: 'desktop' | 'tablet' | 'mobile') => void;
  onSwitchToBlank?: () => void;
  framework?: string;
  onFrameworkChange?: (id: string) => void;
}

const STYLE_KEYS: StyleKey[] = ['modern', 'minimal', 'playful', 'enterprise', 'bold', 'editorial'];

// Compact category icons for suggestion cards (Lucide-style stroke icons)
const CategoryIcon = ({ id, size = 18 }: { id: string; size?: number }) => {
  const paths: Record<string, React.ReactNode> = {
    'saas-landing': (
      <>
        <rect x='3' y='3' width='18' height='4' rx='1' />
        <rect x='3' y='11' width='18' height='10' rx='1' />
        <line x1='7' y1='15' x2='13' y2='15' />
        <line x1='7' y1='18' x2='17' y2='18' />
      </>
    ),
    'ecommerce': (
      <>
        <path d='M2 4h2l2.5 11.5a2 2 0 0 0 2 1.5h8.5a2 2 0 0 0 2-1.5L21 7H6' />
        <circle cx='9' cy='20' r='1.2' fill='currentColor' />
        <circle cx='18' cy='20' r='1.2' fill='currentColor' />
      </>
    ),
    'dashboard': (
      <>
        <rect x='3' y='3' width='8' height='9' rx='1' />
        <rect x='14' y='3' width='7' height='5' rx='1' />
        <rect x='14' y='12' width='7' height='9' rx='1' />
        <rect x='3' y='16' width='8' height='5' rx='1' />
      </>
    ),
    'portfolio': (
      <>
        <circle cx='12' cy='8' r='3.5' />
        <path d='M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7' />
      </>
    ),
    'blog': (
      <>
        <rect x='3' y='3' width='18' height='18' rx='2' />
        <line x1='7' y1='8' x2='17' y2='8' />
        <line x1='7' y1='12' x2='17' y2='12' />
        <line x1='7' y1='16' x2='13' y2='16' />
      </>
    ),
    'app-shell': (
      <>
        <rect x='3' y='3' width='18' height='18' rx='2' />
        <line x1='9' y1='3' x2='9' y2='21' />
        <line x1='3' y1='8' x2='9' y2='8' />
      </>
    ),
    'pricing': (
      <>
        <circle cx='12' cy='12' r='9' />
        <path d='M14 8.5c-.4-.6-1.2-1-2-1-1.2 0-2.5.8-2.5 2 0 2.5 5 1.5 5 4 0 1.2-1.3 2-2.5 2-.8 0-1.6-.4-2-1' />
        <line x1='12' y1='6.5' x2='12' y2='17.5' />
      </>
    ),
    'auth': (
      <>
        <rect x='4' y='11' width='16' height='10' rx='2' />
        <path d='M7 11V7a5 5 0 0 1 10 0v4' />
        <circle cx='12' cy='16' r='1' fill='currentColor' />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5} strokeLinecap='round' strokeLinejoin='round'>
      {paths[id]}
    </svg>
  );
};

// Mini icons for action bar
const Icon = ({ d, size = 14, fill, stroke = 'currentColor', strokeWidth = 1.7 }: { d: string; size?: number; fill?: string; stroke?: string; strokeWidth?: number }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill={fill || 'none'} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap='round' strokeLinejoin='round'>
    <path d={d} />
  </svg>
);

export function DesignHero({ onGenerate, loading, devicePreview, onDeviceChange, onSwitchToBlank, framework, onFrameworkChange }: Props) {
  const [prompt, setPrompt] = useState('');
  const [selectedStyles, setSelectedStyles] = useState<StyleKey[]>([]);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, []);

  function handleSubmit() {
    if (!prompt.trim() || loading) return;
    onGenerate(prompt.trim(), selectedStyles.length > 0 ? selectedStyles : undefined);
  }

  function toggleStyle(s: StyleKey) {
    setSelectedStyles((prev) => {
      if (prev.includes(s)) return prev.filter((x) => x !== s);
      if (prev.length >= 3) return [...prev.slice(1), s];
      return [...prev, s];
    });
  }

  function useSuggestion(p: string) {
    setPrompt(p);
    textareaRef.current?.focus();
  }

  function handlePaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find((it) => it.type.startsWith('image/'));
    if (item) {
      const file = item.getAsFile();
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => setAttachedImage(ev.target?.result as string);
        reader.readAsDataURL(file);
      }
    }
  }

  function readImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => setAttachedImage(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  return (
    <div className='flex-1 flex flex-col items-center justify-start overflow-y-auto relative'>
      {/* ─── Layered ambient background ───────────────────────────── */}
      <div
        className='absolute inset-0 pointer-events-none'
        style={{
          background: `
            radial-gradient(900px circle at 30% 0%, color-mix(in oklab, var(--b-primary) 10%, transparent), transparent 55%),
            radial-gradient(700px circle at 75% 35%, color-mix(in oklab, var(--b-primary) 6%, transparent), transparent 55%),
            var(--b-canvas)
          `,
        }}
      />
      {/* Subtle grid overlay */}
      <div
        className='absolute inset-0 pointer-events-none opacity-[0.4]'
        style={{
          backgroundImage: 'radial-gradient(color-mix(in oklab, var(--b-foreground) 7%, transparent) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage: 'radial-gradient(ellipse 70% 50% at 50% 30%, black 30%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 50% at 50% 30%, black 30%, transparent 80%)',
        }}
      />

      <div className='relative w-full max-w-3xl px-6 pt-12 pb-12 flex flex-col items-center gap-9'>
        {/* ─── Hero illustration: framework constellation ───────── */}
        <div className='flex flex-col items-center gap-5 animate-fade-in'>
          {/* Orbiting framework logos around central brand mark */}
          <div className='relative w-[340px] h-[140px] flex items-center justify-center'>
            {/* Soft glow */}
            <div
              className='absolute inset-0 pointer-events-none'
              style={{
                background: 'radial-gradient(closest-side, color-mix(in oklab, var(--b-primary) 18%, transparent), transparent 65%)',
              }}
            />
            {/* Connecting arcs */}
            <svg className='absolute inset-0 w-full h-full pointer-events-none' viewBox='0 0 340 140' fill='none'>
              <path d='M30 80 Q170 10 310 80' stroke='color-mix(in oklab, var(--b-primary) 18%, transparent)' strokeWidth='1' strokeDasharray='3 4' />
              <path d='M30 80 Q170 130 310 80' stroke='color-mix(in oklab, var(--b-primary) 18%, transparent)' strokeWidth='1' strokeDasharray='3 4' />
            </svg>

            {/* Left framework cluster */}
            <div className='absolute left-0 top-1/2 -translate-y-1/2 flex flex-col gap-3'>
              <div className='w-12 h-12 rounded-xl bg-card border border-border/80 shadow-sm flex items-center justify-center hover:scale-110 transition-transform' title='React'>
                <ReactLogo size={26} />
              </div>
              <div className='w-10 h-10 rounded-xl bg-card border border-border/80 shadow-sm flex items-center justify-center ml-7 hover:scale-110 transition-transform' title='Vue'>
                <VueLogo size={22} />
              </div>
            </div>

            {/* Right framework cluster */}
            <div className='absolute right-0 top-1/2 -translate-y-1/2 flex flex-col gap-3 items-end'>
              <div className='w-12 h-12 rounded-xl bg-card border border-border/80 shadow-sm flex items-center justify-center hover:scale-110 transition-transform' title='Next.js'>
                <NextLogo size={26} />
              </div>
              <div className='w-10 h-10 rounded-xl bg-card border border-border/80 shadow-sm flex items-center justify-center mr-7 hover:scale-110 transition-transform' title='Svelte'>
                <SvelteLogo size={22} />
              </div>
            </div>

            {/* Top accent logos */}
            <div className='absolute top-0 left-1/2 -translate-x-1/2 flex gap-2'>
              <div className='w-8 h-8 rounded-lg bg-card border border-border/80 shadow-sm flex items-center justify-center -translate-x-10 hover:scale-110 transition-transform' title='Angular'>
                <AngularLogo size={18} />
              </div>
              <div className='w-8 h-8 rounded-lg bg-card border border-border/80 shadow-sm flex items-center justify-center hover:scale-110 transition-transform' title='Solid'>
                <SolidLogo size={18} />
              </div>
              <div className='w-8 h-8 rounded-lg bg-card border border-border/80 shadow-sm flex items-center justify-center translate-x-10 hover:scale-110 transition-transform' title='Tailwind'>
                <TailwindLogo size={18} />
              </div>
            </div>

            {/* Center brand mark */}
            <div
              className='relative w-20 h-20 rounded-[22px] flex items-center justify-center z-10'
              style={{
                background: 'linear-gradient(135deg, var(--b-primary) 0%, color-mix(in oklab, var(--b-primary) 70%, transparent) 100%)',
                boxShadow: '0 16px 36px -10px color-mix(in oklab, var(--b-primary) 50%, transparent), inset 0 1px 0 color-mix(in oklab, var(--b-primary-foreground) 25%, transparent)',
              }}
            >
              <svg className='w-10 h-10 text-primary-foreground' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2.2} strokeLinejoin='round' strokeLinecap='round'>
                <path d='M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z' fill='currentColor' fillOpacity={0.2} />
                <path d='M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z' />
              </svg>
              <div className='absolute inset-0 rounded-[22px] pointer-events-none' style={{ background: 'linear-gradient(180deg, hsl(0 0% 100% / 0.2) 0%, transparent 50%)' }} />
            </div>
          </div>

          <div className='text-center'>
            <div className='inline-flex items-center gap-2 px-2.5 py-1 mb-3 rounded-full bg-primary/8 border border-primary/15'>
              <span className='w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse' />
              <span className='text-[10px] font-semibold tracking-wider uppercase text-primary'>AI design studio · Framework-agnostic</span>
            </div>
            <h1 className='text-3xl font-semibold tracking-tight mb-1.5'>
              What do you want to design today?
            </h1>
            <p className='text-sm text-muted-foreground max-w-md mx-auto leading-relaxed'>
              Describe a page or paste a screenshot. Get three production-ready variants — exportable to React, Vue, Svelte, and more.
            </p>
          </div>
        </div>

        {/* ─── Prompt card ──────────────────────────────────────── */}
        <div
          className='w-full rounded-2xl border border-border/80 bg-card overflow-hidden animate-slide-up relative'
          style={{
            boxShadow: '0 24px 48px -16px color-mix(in oklab, var(--b-foreground) 12%, transparent), 0 4px 16px -4px color-mix(in oklab, var(--b-foreground) 8%, transparent), inset 0 1px 0 var(--b-background)',
          }}
        >
          {/* attached image preview */}
          {attachedImage && (
            <div className='px-4 pt-4'>
              <div className='relative inline-block'>
                <img src={attachedImage} alt='Reference' className='h-20 rounded-lg border border-border/80' />
                <button type='button'
                  onClick={() => setAttachedImage(null)}
                  className='absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-foreground text-background flex items-center justify-center hover:bg-destructive text-xs shadow-md transition-colors'
                  title='Remove'
                >
                  ×
                </button>
              </div>
            </div>
          )}

          <div className='px-5 pt-4'>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={`A premium SaaS landing page for a developer tool, with hero, features, pricing, and testimonials...`}
              data-design-hero-input
              className='w-full bg-transparent resize-none outline-none text-[15px] leading-relaxed placeholder:text-muted-foreground/45'
              style={{ minHeight: 78, fontFamily: 'inherit' }}
              rows={3}
            />
          </div>

          {/* style chips */}
          <div className='px-5 pb-3 pt-1'>
            <div className='flex items-center gap-2 mb-2'>
              <span className='text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60'>Style</span>
              <span className='text-[10px] text-muted-foreground/40 font-mono'>
                {selectedStyles.length === 0 ? 'auto · 3 curated' : `${selectedStyles.length}/3 picked`}
              </span>
              {selectedStyles.length > 0 && (
                <button type='button'
                  onClick={() => setSelectedStyles([])}
                  className='text-[10px] text-muted-foreground/50 hover:text-foreground ml-auto transition-colors'
                >
                  Reset
                </button>
              )}
            </div>
            <div className='flex flex-wrap gap-1.5'>
              {STYLE_KEYS.map((sk) => {
                const preset = STYLE_PRESETS[sk];
                const active = selectedStyles.includes(sk);
                return (
                  <button type='button'
                    key={sk}
                    onClick={() => toggleStyle(sk)}
                    title={preset.description}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent hover:border-border'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* action bar */}
          <div className='px-3.5 py-2.5 border-t border-border/60 flex items-center gap-1.5 bg-muted/15'>
            <label className='w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-all' title='Attach reference image'>
              <Icon d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v15' />
              <input
                type='file'
                accept='image/*'
                className='hidden'
                onChange={(e) => { const f = e.target.files?.[0]; if (f) readImageFile(f); }}
              />
            </label>

            {/* Device target */}
            <div className='flex items-center bg-background/80 rounded-lg border border-border/60 p-0.5 gap-0.5'>
              {[
                { id: 'desktop' as const, label: 'Desktop', d: 'M2 4h20v12H2zM8 20h8M12 16v4' },
                { id: 'tablet' as const, label: 'Tablet', d: 'M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 18h.01' },
                { id: 'mobile' as const, label: 'Mobile', d: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 18h.01' },
              ].map((d) => (
                <button type='button'
                  key={d.id}
                  onClick={() => onDeviceChange(d.id)}
                  className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${
                    devicePreview === d.id ? 'bg-accent text-foreground' : 'text-muted-foreground/60 hover:text-foreground'
                  }`}
                  title={`${d.label} target`}
                >
                  <Icon d={d.d} size={11} />
                </button>
              ))}
            </div>

            {/* Framework picker (compact) */}
            {onFrameworkChange && (
              <div className='hidden md:flex items-center bg-background/80 rounded-lg border border-border/60 p-0.5 gap-0.5'>
                {FRAMEWORKS.slice(0, 5).map((fw) => (
                  <button type='button'
                    key={fw.id}
                    onClick={() => onFrameworkChange(fw.id)}
                    className={`w-7 h-7 rounded-md flex items-center justify-center transition-all ${
                      framework === fw.id ? 'bg-accent ring-1 ring-border/60' : 'opacity-55 hover:opacity-100 grayscale-[0.4] hover:grayscale-0'
                    }`}
                    title={fw.name}
                  >
                    <fw.Logo size={16} />
                  </button>
                ))}
              </div>
            )}

            <div className='flex-1' />

            <span className='text-[10px] text-muted-foreground/45 font-mono hidden sm:inline mr-1'>⌘ ↵</span>
            <button type='button'
              onClick={handleSubmit}
              disabled={!prompt.trim() || loading}
              className='h-8 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-md hover:shadow-primary/25 transition-all flex items-center gap-1.5 active:scale-[0.97]'
              style={{ background: 'linear-gradient(180deg, var(--b-primary) 0%, color-mix(in oklab, var(--b-primary) 85%, transparent) 100%)' }}
            >
              {loading ? (
                <>
                  <svg className='w-3 h-3 animate-spin' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={3}>
                    <path d='M21 12a9 9 0 1 1-6.2-8.55' />
                  </svg>
                  Generating...
                </>
              ) : (
                <>
                  <svg width={12} height={12} viewBox='0 0 24 24' fill='currentColor'>
                    <path d='M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z' />
                  </svg>
                  Generate
                </>
              )}
            </button>
          </div>
        </div>

        {/* ─── Suggestion grid ─────────────────────────────────── */}
        <div className='w-full'>
          <div className='flex items-center justify-between mb-3'>
            <div className='flex items-center gap-2'>
              <h3 className='text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-wider'>
                Start from a template
              </h3>
              <span className='text-[10px] text-muted-foreground/30'>· 8 patterns</span>
            </div>
            {onSwitchToBlank && (
              <button type='button'
                onClick={onSwitchToBlank}
                className='text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1'
              >
                Start blank
                <svg width={11} height={11} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}>
                  <path d='M5 12h14M13 6l6 6-6 6' />
                </svg>
              </button>
            )}
          </div>
          <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
            {DESIGN_SUGGESTIONS.map((sug, i) => (
              <button type='button'
                key={sug.id}
                onClick={() => useSuggestion(sug.prompt)}
                disabled={loading}
                className='group text-left p-3 rounded-xl border border-border/70 bg-card hover:border-primary/40 hover:bg-accent/20 hover:shadow-sm transition-all disabled:opacity-40 active:scale-[0.98]'
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <div className='w-8 h-8 rounded-lg bg-muted/40 group-hover:bg-primary/10 flex items-center justify-center text-muted-foreground group-hover:text-primary mb-2 transition-colors'>
                  <CategoryIcon id={sug.id} />
                </div>
                <div className='text-xs font-medium text-foreground'>{sug.label}</div>
                <div className='text-[10px] text-muted-foreground/55 line-clamp-2 mt-0.5 leading-snug'>
                  {sug.prompt.slice(0, 58)}…
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ─── Framework strip ─────────────────────────────────── */}
        <div className='w-full flex flex-col items-center gap-4 pt-2'>
          <div className='flex items-center gap-2'>
            <div className='h-px flex-1 w-12 bg-border/60' />
            <span className='text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider'>
              Export to any framework
            </span>
            <div className='h-px flex-1 w-12 bg-border/60' />
          </div>
          <div className='flex items-center gap-1.5 flex-wrap justify-center'>
            {FRAMEWORKS.map((fw) => (
              <button type='button'
                key={fw.id}
                onClick={() => onFrameworkChange?.(fw.id)}
                className={`group h-9 px-3 rounded-xl flex items-center gap-2 transition-all border disabled:cursor-default disabled:hover:bg-card/40 disabled:hover:border-border/50 ${
                  framework === fw.id
                    ? 'bg-accent border-border/80 shadow-sm'
                    : 'border-border/50 bg-card/40 hover:bg-card hover:border-border'
                }`}
                title={`Generate ${fw.name} code`}
                disabled={!onFrameworkChange}
              >
                <fw.Logo size={18} />
                <span className={`text-xs font-medium transition-colors ${framework === fw.id ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'}`}>
                  {fw.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ─── Tips ────────────────────────────────────────────── */}
        <div className='flex items-center gap-5 text-[10px] text-muted-foreground/40 pt-2 border-t border-border/40 w-full justify-center'>
          <span className='flex items-center gap-1.5 pt-3'>
            <kbd className='px-1.5 py-0.5 rounded bg-muted/60 font-mono text-[9px] border border-border/60'>⌘ ↵</kbd>
            Generate
          </span>
          <span className='flex items-center gap-1.5 pt-3'>
            <kbd className='px-1.5 py-0.5 rounded bg-muted/60 font-mono text-[9px] border border-border/60'>⌘ K</kbd>
            AI chat
          </span>
          <span className='flex items-center gap-1.5 pt-3'>
            <kbd className='px-1.5 py-0.5 rounded bg-muted/60 font-mono text-[9px] border border-border/60'>⌘ V</kbd>
            Paste image
          </span>
        </div>
      </div>
    </div>
  );
}
