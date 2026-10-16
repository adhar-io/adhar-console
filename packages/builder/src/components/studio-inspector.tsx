import { useState, type ReactNode } from 'react';
import type { CanvasNode, NodeInteraction, ProjectFile } from '../lib/builder-types.ts';
import { isContainer } from '../lib/builder-types.ts';
import { bindingItems, dataSourceName, listDataSources, listPages, pageRoute, symbolName } from '../lib/studio.ts';
import { findFileInTree } from '../lib/builder-types.ts';

/**
 * App-builder sections of the inspector, above the style properties:
 * layer (name / lock / hide), interaction (navigate / toggle / open URL),
 * component (create / edit / detach), data (repeat over a data source) and
 * form field (type, required, options).
 */

const FIELD_TYPES = new Set(['input', 'textarea', 'select', 'date-input', 'checkbox', 'radio', 'switch']);

export function StudioInspector({
  node, files, pageNodes, onUpdate, onMakeComponent, onDetach, onEditComponent,
}: {
  node: CanvasNode;
  files: ProjectFile[];
  /** The open page's nodes — candidates for "toggle element". */
  pageNodes: CanvasNode[];
  onUpdate(nodeId: string, key: string, value: unknown): void;
  onMakeComponent(nodeId: string): void;
  onDetach(nodeId: string): void;
  onEditComponent(symbolId: string): void;
}) {
  const isSymbol = node.type === 'symbol';
  const symbolFile = isSymbol ? findFileInTree(files, String(node.props?.symbolId ?? '')) : null;

  return (
    <div className='border-b border-border'>
      <Section title='Layer'>
        <div className='flex items-center gap-1.5'>
          <input
            key={node.id}
            className='input-sm flex-1'
            placeholder={isSymbol && symbolFile ? symbolName(symbolFile) : node.type}
            defaultValue={node.componentName ?? ''}
            onBlur={(e) => onUpdate(node.id, 'componentName', e.currentTarget.value.trim() || undefined)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            aria-label='Layer name'
          />
          <Toggle on={!!node.locked} onClick={() => onUpdate(node.id, 'locked', !node.locked)} title={node.locked ? 'Unlock' : 'Lock'}
            d={node.locked ? 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4' : 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2'} />
          <Toggle on={!!node.hidden} onClick={() => onUpdate(node.id, 'hidden', !node.hidden)} title={node.hidden ? 'Show' : 'Hide'}
            d={node.hidden ? 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.3 2 12 2 12s3 8 10 8a9 9 0 0 0 5.4-1.8' : 'M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'} />
        </div>
      </Section>

      <InteractionSection node={node} files={files} pageNodes={pageNodes} onUpdate={onUpdate} />

      <Section title='Component'>
        {isSymbol ? (
          <div className='flex flex-col gap-2'>
            <p className='text-[11px] text-muted-foreground'>
              Instance of <span className='font-medium text-violet-500'>◇ {symbolFile ? symbolName(symbolFile) : 'missing component'}</span>. Edits to the component update every instance.
            </p>
            <div className='flex gap-1.5'>
              {symbolFile && <SmallButton onClick={() => onEditComponent(symbolFile.id)}>Edit component</SmallButton>}
              <SmallButton onClick={() => onDetach(node.id)}>Detach</SmallButton>
            </div>
          </div>
        ) : (
          <SmallButton onClick={() => onMakeComponent(node.id)}>◇ Create component</SmallButton>
        )}
      </Section>

      {isContainer(node.type) && !isSymbol && <DataSection node={node} files={files} onUpdate={onUpdate} />}
      {FIELD_TYPES.has(node.type) && <FieldSection node={node} onUpdate={onUpdate} />}
    </div>
  );
}

function InteractionSection({ node, files, pageNodes, onUpdate }: {
  node: CanvasNode; files: ProjectFile[]; pageNodes: CanvasNode[];
  onUpdate(nodeId: string, key: string, value: unknown): void;
}) {
  const it = node.interactions?.find((i) => i.trigger === 'click');
  const set = (next: NodeInteraction | null) => onUpdate(node.id, 'interactions', next ? [next, ...(node.interactions ?? []).filter((i) => i !== it)] : (node.interactions ?? []).filter((i) => i !== it));
  const targets = toggleTargets(pageNodes).filter((t) => t.id !== node.id);
  return (
    <Section title='On click'>
      <select className='input-sm' value={it?.action ?? ''} onChange={(e) => {
        const action = e.target.value as NodeInteraction['action'] | '';
        set(action ? { trigger: 'click', action } : null);
      }}>
        <option value=''>Do nothing</option>
        <option value='navigate'>Go to page</option>
        <option value='toggle-visibility'>Show / hide element</option>
        <option value='open-url'>Open URL</option>
      </select>
      {it?.action === 'navigate' && (
        <select className='input-sm mt-1.5' value={it.targetPageId ?? ''} onChange={(e) => set({ ...it, targetPageId: e.target.value || undefined })}>
          <option value=''>Choose a page…</option>
          {listPages(files).map((p) => <option key={p.id} value={p.id}>{p.name.replace(/\.\w+$/, '')} — {pageRoute(p, files)}</option>)}
        </select>
      )}
      {it?.action === 'toggle-visibility' && (
        <select className='input-sm mt-1.5' value={it.targetNodeId ?? ''} onChange={(e) => set({ ...it, targetNodeId: e.target.value || undefined })}>
          <option value=''>Choose an element…</option>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      )}
      {it?.action === 'open-url' && (
        <input className='input-sm mt-1.5' placeholder='https://…' defaultValue={it.url ?? ''} key={node.id}
          onBlur={(e) => set({ ...it, url: e.currentTarget.value.trim() || undefined })} />
      )}
      {it && <p className='mt-1.5 text-[10px] text-muted-foreground'>Try it in Preview.</p>}
    </Section>
  );
}

/** Modals, named layers and hidden elements on the page — what "toggle" can target. */
export function toggleTargets(nodes: CanvasNode[]): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const walk = (ns: CanvasNode[]) => {
    for (const n of ns) {
      if (n.type === 'modal' || n.componentName || n.hidden) {
        out.push({ id: n.id, label: n.componentName || (n.type === 'modal' ? 'Modal' : `${n.type} (hidden)`) });
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function DataSection({ node, files, onUpdate }: { node: CanvasNode; files: ProjectFile[]; onUpdate(nodeId: string, key: string, value: unknown): void }) {
  const sources = listDataSources(files);
  const items = node.bind ? bindingItems(files, node.bind) : [];
  const first = items[0];
  const fields = first && typeof first === 'object' ? Object.keys(first as object) : [];
  return (
    <Section title='Repeat for data' defaultOpen={!!node.bind || !!node.props?.['data-repeater']}>
      {sources.length === 0 ? (
        <p className='text-[11px] text-muted-foreground'>Add a data source in the Data panel to repeat this container per item.</p>
      ) : (
        <>
          <select className='input-sm' value={node.bind?.source ?? ''} onChange={(e) => onUpdate(node.id, 'bind', e.target.value ? { source: e.target.value, path: node.bind?.path } : undefined)}>
            <option value=''>Not repeated</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{dataSourceName(s)}</option>)}
          </select>
          {node.bind && (
            <>
              <input key={node.id} className='input-sm mt-1.5 font-mono' placeholder='path to the list (optional), e.g. results'
                defaultValue={node.bind.path ?? ''} onBlur={(e) => onUpdate(node.id, 'bind', { ...node.bind, path: e.currentTarget.value.trim() || undefined })} />
              <p className='mt-1.5 text-[10px] text-muted-foreground'>{items.length} item{items.length === 1 ? '' : 's'} · children repeat per item.</p>
              {fields.length > 0 && (
                <div className='mt-1 flex flex-wrap gap-1'>
                  {fields.map((f) => (
                    <button type='button' key={f} title='Copy template' onClick={() => void navigator.clipboard?.writeText(`{{${f}}}`)}
                      className='rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground'>{`{{${f}}}`}</button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </Section>
  );
}

function FieldSection({ node, onUpdate }: { node: CanvasNode; onUpdate(nodeId: string, key: string, value: unknown): void }) {
  const p = node.props ?? {};
  return (
    <Section title='Form field'>
      <div className='flex flex-col gap-1.5'>
        {node.type === 'input' && (
          <select className='input-sm' value={String(p.inputType ?? 'text')} onChange={(e) => onUpdate(node.id, 'inputType', e.target.value)}>
            {['text', 'email', 'number', 'password', 'tel', 'url', 'search'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {['input', 'textarea', 'select', 'date-input'].includes(node.type) && (
          <label className='flex items-center gap-2 text-[11px] text-muted-foreground'>
            <input type='checkbox' checked={!!p.required} onChange={(e) => onUpdate(node.id, 'required', e.target.checked)} style={{ accentColor: 'var(--b-primary)' }} />
            Required (validated in Preview and the exported app)
          </label>
        )}
        {node.type === 'radio' && (
          <input key={node.id} className='input-sm' placeholder='Group name' defaultValue={String(p.name ?? '')} onBlur={(e) => onUpdate(node.id, 'name', e.currentTarget.value)} />
        )}
        {node.type === 'select' && (
          <textarea key={node.id} className='input-sm !h-20 py-1' placeholder='One option per line'
            defaultValue={(Array.isArray(p.options) ? p.options : []).join('\n')}
            onBlur={(e) => onUpdate(node.id, 'options', e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean))} />
        )}
      </div>
    </Section>
  );
}

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className='border-b border-border/50 last:border-b-0'>
      <button type='button' className='panel-section w-full' onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span>
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M9 18l6-6-6-6' /></svg>
      </button>
      {open && <div className='px-3 pb-3'>{children}</div>}
    </div>
  );
}

function SmallButton({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return (
    <button type='button' onClick={onClick} className='h-7 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent'>
      {children}
    </button>
  );
}

function Toggle({ on, onClick, title, d }: { on: boolean; onClick(): void; title: string; d: string }) {
  return (
    <button type='button' onClick={onClick} title={title} aria-label={title} aria-pressed={on} className={`btn-icon-sm ${on ? 'active' : ''}`}>
      <svg width={13} height={13} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.75} strokeLinecap='round' strokeLinejoin='round'><path d={d} /></svg>
    </button>
  );
}
