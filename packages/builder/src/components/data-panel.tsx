import { useState } from 'react';
import type { ProjectFile } from '../lib/builder-types.ts';
import { dataSourceName, listDataSources, parseData } from '../lib/studio.ts';

/**
 * Data sources: JSON files the design binds to (tables, lists, cards). They
 * ship with the exported app as `src/data/<name>.json`.
 */
export function DataPanel({ files, onAdd, onChange, onDelete }: {
  files: ProjectFile[];
  onAdd(): void;
  onChange(id: string, json: string): void;
  onDelete(id: string): void;
}) {
  const sources = listDataSources(files);
  const [openId, setOpenId] = useState<string | null>(sources[0]?.id ?? null);
  const open = sources.find((s) => s.id === openId) ?? null;
  const parsed = parseData(open?.content);
  const count = Array.isArray(parsed.value) ? parsed.value.length : parsed.value === null ? 0 : 1;
  const fields = Array.isArray(parsed.value) && parsed.value[0] && typeof parsed.value[0] === 'object'
    ? Object.keys(parsed.value[0] as object) : [];

  return (
    <div className='flex h-full flex-col gap-3 py-1'>
      <div className='flex items-center justify-between px-1'>
        <h3 className='text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'>Data sources · {sources.length}</h3>
        <button type='button' onClick={onAdd} className='btn-icon-sm' title='Add data source'>
          <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M12 5v14M5 12h14' /></svg>
        </button>
      </div>
      {sources.length === 0 ? (
        <p className='px-1 text-[11px] leading-relaxed text-muted-foreground'>
          Add a JSON data source, then bind a table or list to it in the inspector — rows repeat per item and <span className='font-mono'>{'{{field}}'}</span> fills in values.
        </p>
      ) : (
        <div className='flex flex-col gap-0.5'>
          {sources.map((s) => (
            <div key={s.id} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 ${s.id === openId ? 'bg-primary/10' : 'hover:bg-accent'}`}>
              <span className='text-[10px] font-mono text-muted-foreground'>{'{}'}</span>
              <button type='button' onClick={() => setOpenId(s.id)} className='flex-1 min-w-0 truncate text-left text-xs'>{dataSourceName(s)}</button>
              <button type='button' onClick={() => onDelete(s.id)} title='Delete data source' className='btn-icon-sm !h-5 opacity-0 group-hover:opacity-100 hover:!text-destructive'>
                <svg width={11} height={11} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6' /></svg>
              </button>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className='flex min-h-0 flex-1 flex-col gap-1.5 px-1'>
          <div className='flex items-center justify-between text-[10px]'>
            <span className='font-mono text-muted-foreground'>data/{open.name}</span>
            {parsed.error ? <span className='text-destructive'>Invalid JSON</span> : <span className='text-muted-foreground'>{count} item{count === 1 ? '' : 's'}</span>}
          </div>
          <textarea
            key={open.id}
            defaultValue={open.content ?? ''}
            spellCheck={false}
            onChange={(e) => onChange(open.id, e.target.value)}
            className={`min-h-[220px] flex-1 resize-none rounded-md border bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground outline-none ${parsed.error ? 'border-destructive' : 'border-input focus:border-ring'}`}
          />
          {parsed.error && <p className='text-[10px] text-destructive'>{parsed.error}</p>}
          {fields.length > 0 && (
            <div className='flex flex-wrap gap-1'>
              {fields.map((f) => <span key={f} className='rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>{`{{${f}}}`}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
