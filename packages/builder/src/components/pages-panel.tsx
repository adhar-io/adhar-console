import { useState } from 'react';
import type { ProjectFile } from '../lib/builder-types.ts';
import { homePage, listPages, listSymbols, pageRoute, symbolName } from '../lib/studio.ts';

/**
 * Pages of the app (add / rename / route / reorder / set home / delete) and
 * its reusable components (open to edit the master).
 */
export function PagesPanel({
  files, activeFileId, onOpen, onAdd, onRename, onSetRoute, onDelete, onMove, onSetHome, onDeleteComponent,
}: {
  files: ProjectFile[];
  activeFileId: string | null;
  onOpen(id: string): void;
  onAdd(): void;
  onRename(id: string): void;
  onSetRoute(id: string, route: string): void;
  onDelete(id: string): void;
  onMove(id: string, dir: -1 | 1): void;
  onSetHome(id: string): void;
  onDeleteComponent(id: string): void;
}) {
  const pages = listPages(files);
  const symbols = listSymbols(files);
  const home = homePage(files);
  const [editingRoute, setEditingRoute] = useState<string | null>(null);

  return (
    <div className='flex flex-col gap-4 py-1'>
      <div>
        <div className='flex items-center justify-between px-1 pb-1.5'>
          <h3 className='text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'>Pages · {pages.length}</h3>
          <button type='button' onClick={onAdd} className='btn-icon-sm' title='Add page'>
            <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M12 5v14M5 12h14' /></svg>
          </button>
        </div>
        {pages.map((p, i) => {
          const active = p.id === activeFileId;
          const isHome = home?.id === p.id;
          const route = pageRoute(p, files);
          return (
            <div key={p.id} className={`group rounded-lg px-2 py-1.5 ${active ? 'bg-primary/10' : 'hover:bg-accent'}`}>
              <div className='flex items-center gap-1.5'>
                <button type='button' onClick={() => onOpen(p.id)} className={`flex-1 min-w-0 text-left text-xs truncate ${active ? 'font-semibold text-primary' : 'text-foreground'}`}>
                  {p.name.replace(/\.\w+$/, '')}
                </button>
                {isHome && <span className='rounded bg-primary/15 px-1 text-[9px] font-semibold text-primary' title='Home page'>HOME</span>}
                <div className='flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity'>
                  {!isHome && <IconBtn title='Set as home page' onClick={() => onSetHome(p.id)} d='M3 11l9-8 9 8M5 10v10h14V10' />}
                  <IconBtn title='Move up' onClick={() => onMove(p.id, -1)} disabled={i === 0} d='M18 15l-6-6-6 6' />
                  <IconBtn title='Move down' onClick={() => onMove(p.id, 1)} disabled={i === pages.length - 1} d='M6 9l6 6 6-6' />
                  <IconBtn title='Rename' onClick={() => onRename(p.id)} d='M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' />
                  <IconBtn title='Delete page' onClick={() => onDelete(p.id)} disabled={pages.length < 2} d='M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6' danger />
                </div>
              </div>
              {editingRoute === p.id ? (
                <input autoFocus defaultValue={route} className='input-sm mt-1 font-mono !h-6 !text-[10px]'
                  onBlur={(e) => { onSetRoute(p.id, e.currentTarget.value); setEditingRoute(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingRoute(null); }} />
              ) : (
                <button type='button' onClick={() => setEditingRoute(p.id)} title='Edit route' className='mt-0.5 block text-[10px] font-mono text-muted-foreground hover:text-foreground'>
                  {route}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <h3 className='px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'>Components · {symbols.length}</h3>
        {symbols.length === 0 ? (
          <p className='px-1 text-[11px] leading-relaxed text-muted-foreground'>
            Select anything on the canvas and choose <span className='font-medium text-foreground'>Create component</span> in the inspector to reuse it across pages. Edit it once, every instance updates.
          </p>
        ) : symbols.map((sym) => (
          <div key={sym.id} className={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 ${sym.id === activeFileId ? 'bg-violet-500/10' : 'hover:bg-accent'}`}>
            <span className='text-violet-500 text-xs'>◇</span>
            <button type='button' onClick={() => onOpen(sym.id)} className='flex-1 min-w-0 truncate text-left text-xs' title='Edit component'>{symbolName(sym)}</button>
            <div className='opacity-0 group-hover:opacity-100'>
              <IconBtn title='Delete component (instances show as missing)' onClick={() => onDeleteComponent(sym.id)} d='M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6' danger />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IconBtn({ d, title, onClick, disabled, danger }: { d: string; title: string; onClick(): void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type='button' title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className={`btn-icon-sm !h-5 !min-w-[20px] ${danger ? 'hover:!text-destructive' : ''}`}>
      <svg width={11} height={11} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2} strokeLinecap='round' strokeLinejoin='round'><path d={d} /></svg>
    </button>
  );
}
