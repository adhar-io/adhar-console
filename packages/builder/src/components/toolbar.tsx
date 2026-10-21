import { useState, useRef, useEffect } from 'react';
import { useBuilderFullscreen } from '../fullscreen.tsx';

interface ToolbarProps {
  viewMode: 'design' | 'code' | 'preview';
  zoom: number;
  devicePreview: 'desktop' | 'tablet' | 'mobile';
  isActivePage: boolean;
  activeFilePath: string;
  elementCount: number;
  fileLanguage: string | undefined;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  hasClipboard: boolean;
  openMenu: string | null;
  menus: Array<{ id: string; label: string; items: any[] }>;
  canvasBg: 'white' | 'dots' | 'dark';
  canvasMode: 'layout' | 'freeform';
  onCanvasMode: (mode: 'layout' | 'freeform') => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClearCanvas: () => void;
  onViewMode: (mode: 'design' | 'code' | 'preview') => void;
  onZoom: (zoom: number) => void;
  onDevice: (device: 'desktop' | 'tablet' | 'mobile') => void;
  onCanvasBg: (bg: 'white' | 'dots' | 'dark') => void;
  onAddNode: (type: string) => void;
  onSetMenu: (menuId: string | null) => void;
}

const I = ({ d, s = 14 }: { d: string; s?: number }) => (
  <svg width={s} height={s} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5} strokeLinecap='round' strokeLinejoin='round'><path d={d} /></svg>
);

export function Toolbar(props: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const fs = useBuilderFullscreen();

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { props.onSetMenu(null); setZoomOpen(false); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [props.onSetMenu]);

  return (
    <div ref={ref} className='flex items-center h-10 px-2 gap-1 bg-card border-b border-border select-none shrink-0'>

      {/* ── Menus ── */}
      {props.menus.map((menu) => (
        <div key={menu.id} className='relative'>
          <button type='button'
            onClick={() => props.onSetMenu(props.openMenu === menu.id ? null : menu.id)}
            onMouseEnter={() => props.openMenu && props.onSetMenu(menu.id)}
            className={`px-2 py-1 text-xs rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${props.openMenu === menu.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}>
            {menu.label}
          </button>
          {props.openMenu === menu.id && (
            <div className='dropdown left-0 top-full mt-1'>
              {menu.items.map((item: any, i: number) =>
                item.label === 'separator' ? <div key={i} className='dropdown-separator' /> :
                <button type='button' key={i} onClick={() => { if (!item.disabled) { item.action?.(); props.onSetMenu(null); } }} disabled={item.disabled}
                  className={`dropdown-item ${item.active ? 'text-primary font-medium' : ''}`}>
                  <span>{item.label}</span>
                  {item.shortcut && <kbd className='text-[10px] text-muted-foreground/40 font-mono'>{item.shortcut}</kbd>}
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Separator */}
      <div className='w-px h-4 bg-border/50 mx-1 shrink-0' />

      {/* ── View Mode (centered) ── */}
      <div className='flex-1 flex justify-center'>
        <div className='flex items-center rounded-lg p-[3px]' style={{ background: 'color-mix(in oklab, var(--b-muted) 40%, transparent)', border: '1px solid color-mix(in oklab, var(--b-border) 50%, transparent)' }}>
          {[
            { id: 'design' as const, label: 'Design', d: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' },
            { id: 'code' as const, label: 'Code', d: 'M16 18l6-6-6-6M8 6l-6 6 6 6' },
            { id: 'preview' as const, label: 'Preview', d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
          ].map((v) => {
            const active = props.viewMode === v.id;
            return (
              <button type='button' key={v.id} onClick={() => props.onViewMode(v.id)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                style={active ? { background: 'var(--b-background)', boxShadow: '0 1px 2px color-mix(in oklab, var(--b-foreground) 6%, transparent), 0 0 0 1px color-mix(in oklab, var(--b-border) 30%, transparent)' } : undefined}>
                <I d={v.d} s={12} />
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right controls ── */}
      <div className='flex items-center gap-1 shrink-0'>

        {/* Layout / Freeform mode toggle (design mode only) */}
        {props.isActivePage && props.viewMode === 'design' && (
          <>
            <div className='flex items-center rounded-lg p-[3px]' style={{ background: 'color-mix(in oklab, var(--b-muted) 40%, transparent)', border: '1px solid color-mix(in oklab, var(--b-border) 50%, transparent)' }}>
              {[
                { id: 'layout' as const, label: 'Structured', d: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h18v7H3z' },
                { id: 'freeform' as const, label: 'Freeform', d: 'M21 3H3v18h18V3zM15 9h-6v6h6V9z' },
              ].map((m) => {
                const active = props.canvasMode === m.id;
                return (
                  <button type='button' key={m.id} onClick={() => props.onCanvasMode(m.id)} title={m.id === 'layout' ? 'Structured — nested component layout' : 'Freeform — drag-and-drop diagramming'}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    style={active ? { background: 'var(--b-background)', boxShadow: '0 1px 2px color-mix(in oklab, var(--b-foreground) 6%, transparent), 0 0 0 1px color-mix(in oklab, var(--b-border) 30%, transparent)' } : undefined}>
                    <I d={m.d} s={12} />{m.label}
                  </button>
                );
              })}
            </div>
            <div className='w-px h-4 bg-border/40 mx-0.5' />
          </>
        )}

        {/* Canvas bg (design only) */}
        {props.isActivePage && props.viewMode === 'design' && (
          <>
            <div className='toggle-group'>
              {([
                { k: 'white' as const, label: 'Light' },
                { k: 'dots' as const, label: 'Grid' },
                { k: 'dark' as const, label: 'Dark' },
              ]).map((b) => (
                <button type='button' key={b.k} onClick={() => props.onCanvasBg(b.k)} title={b.label} className={`!px-1 ${props.canvasBg === b.k ? 'active' : ''}`}>
                  <div style={{ width: 12, height: 12, borderRadius: 3,
                    background: b.k === 'white' ? '#fff' : b.k === 'dots' ? '#f0f0f3' : '#1a1a2e',
                    border: b.k === 'white' ? '1px solid #e2e2e2' : b.k === 'dark' ? '1px solid #333' : '1px solid #ccc',
                    backgroundImage: b.k === 'dots' ? 'radial-gradient(#bbb 0.5px, transparent 0.5px)' : undefined,
                    backgroundSize: b.k === 'dots' ? '4px 4px' : undefined,
                  }} />
                </button>
              ))}
            </div>
            <div className='w-px h-4 bg-border/40 mx-0.5' />
          </>
        )}

        {/* Device */}
        <div className='toggle-group'>
          {[
            { id: 'desktop' as const, d: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6zM8 21h8M12 17v4', label: 'Desktop' },
            { id: 'tablet' as const, d: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01', label: 'Tablet' },
            { id: 'mobile' as const, d: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01', label: 'Mobile' },
          ].map((d) => (
            <button type='button' key={d.id} onClick={() => props.onDevice(d.id)} title={d.label} className={`!px-1 ${props.devicePreview === d.id ? 'active' : ''}`}>
              <I d={d.d} s={13} />
            </button>
          ))}
        </div>

        {/* Zoom */}
        <div className='toggle-group relative'>
          <button type='button' onClick={() => props.onZoom(Math.max(25, props.zoom - 10))} className='!px-0.5' title='Zoom out'><I d='M5 12h14' s={11} /></button>
          <button type='button' onClick={() => setZoomOpen(!zoomOpen)} className='!px-1 !min-w-[38px] text-[11px] tabular-nums font-mono'>{props.zoom}%</button>
          <button type='button' onClick={() => props.onZoom(Math.min(200, props.zoom + 10))} className='!px-0.5' title='Zoom in'><I d='M12 5v14M5 12h14' s={11} /></button>
          {zoomOpen && (
            <div className='dropdown right-0 top-full mt-1 min-w-[68px]'>
              {[25, 50, 75, 100, 125, 150, 200].map((z) => (
                <button type='button' key={z} onClick={() => { props.onZoom(z); setZoomOpen(false); }}
                  className={`dropdown-item tabular-nums ${props.zoom === z ? 'text-primary font-medium' : ''}`}>{z}%</button>
              ))}
            </div>
          )}
        </div>

        {/* Full screen — after zoom */}
        <button
          type='button'
          onClick={fs.toggle}
          aria-pressed={fs.full}
          title={fs.full ? 'Exit full screen (Esc · ⌃⌘F)' : 'Full screen (⌃⌘F)'}
          aria-label={fs.full ? 'Exit full screen' : 'Full screen'}
          className={`btn-icon-sm ${fs.full ? 'text-primary' : ''}`}
        >
          {fs.full
            ? <I d='M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' s={13} />
            : <I d='M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' s={13} />}
        </button>
      </div>
    </div>
  );
}
