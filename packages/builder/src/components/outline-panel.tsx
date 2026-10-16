// ─── Outline / Layers Panel ───────────────────────────────────────────────────
import { useState } from 'react';
import type { CanvasNode } from '../lib/builder-types.ts';
import { isContainer } from '../lib/builder-types.ts';

interface OutlinePanelProps {
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  onSelect: (nodeId: string) => void;
  onToggleVisibility?: (nodeId: string) => void;
  onMoveNode?: (nodeId: string, direction: 'up' | 'down') => void;
  onToggleLock?: (nodeId: string) => void;
  onRename?: (nodeId: string, name: string) => void;
  /** Drag a layer onto another to move it before that layer (same parent). */
  onDropReorder?: (sourceId: string, targetParentId: string | null, index: number) => void;
}

type RowExtras = Pick<OutlinePanelProps, 'onToggleLock' | 'onRename' | 'onDropReorder'>;

export function OutlinePanel({ nodes, selectedNodeIds, onSelect, onToggleVisibility, onMoveNode, onToggleLock, onRename, onDropReorder }: OutlinePanelProps) {
  const extras: RowExtras = { onToggleLock, onRename, onDropReorder };
  if (nodes.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <svg className='w-8 h-8 text-muted-foreground/20 mb-2' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1}><path d='M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' /></svg>
        <p className='text-xs text-muted-foreground/40'>No elements on canvas</p>
      </div>
    );
  }
  return (
    <div className='py-1'>
      {nodes.map((node, i) => (
        <OutlineNode key={node.id} node={node} depth={0} index={i} totalSiblings={nodes.length} parentId={null} extras={extras}
          selectedNodeIds={selectedNodeIds} onSelect={onSelect}
          onToggleVisibility={onToggleVisibility} onMoveNode={onMoveNode} />
      ))}
    </div>
  );
}

function OutlineNode({ node, depth, index, totalSiblings, parentId, extras, selectedNodeIds, onSelect, onToggleVisibility, onMoveNode }: {
  node: CanvasNode; depth: number; index: number; totalSiblings: number; parentId: string | null; extras: RowExtras;
  selectedNodeIds: string[]; onSelect: (nodeId: string) => void;
  onToggleVisibility?: (nodeId: string) => void;
  onMoveNode?: (nodeId: string, direction: 'up' | 'down') => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const isSel = selectedNodeIds.includes(node.id);
  const isCont = isContainer(node.type);
  const hasChildren = node.children.length > 0;
  const text = typeof node.props.children === 'string' ? node.props.children.slice(0, 18) : '';
  const isHidden = node.hidden;

  const icon = isCont ? '▦' : node.type === 'button' || node.type.startsWith('btn-') ? '⬡' : node.type === 'input' || node.type === 'textarea' ? '▭' : node.type.startsWith('h') && node.type.length === 2 ? 'H' : node.type === 'p' || node.type === 'span' ? 'T' : node.type.startsWith('screen-') ? '📱' : node.type === 'flow-step' ? '⬡' : node.type.startsWith('shape-') ? '⬜' : '•';

  return (
    <>
      <div onClick={() => onSelect(node.id)}
        onDoubleClick={() => extras.onRename && setRenaming(true)}
        draggable={!!extras.onDropReorder}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('adhar/layer-id', node.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('adhar/layer-id')) { e.preventDefault(); setDropOver(true); } }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(e) => { e.preventDefault(); setDropOver(false); const id = e.dataTransfer.getData('adhar/layer-id'); if (id && id !== node.id) extras.onDropReorder?.(id, parentId, index); }}
        className={`group flex items-center gap-1 py-[4px] pr-1.5 cursor-pointer transition-colors ${isSel ? 'bg-primary/10' : 'hover:bg-accent/50'} ${isHidden ? 'opacity-35' : ''} ${dropOver ? 'shadow-[inset_0_2px_0_var(--b-primary)]' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}>

        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button type='button' onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
            className='w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-foreground shrink-0 transition-colors'>
            <svg className={`w-3 h-3 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2.5}><path d='M9 18l6-6-6-6' /></svg>
          </button>
        ) : <span className='w-4 shrink-0' />}

        {/* Type icon */}
        <span className={`text-[10px] w-4 text-center shrink-0 ${isSel ? 'text-primary' : 'text-muted-foreground/35'}`}>{icon}</span>

        {/* Name + text */}
        {renaming ? (
          <input autoFocus defaultValue={node.componentName ?? ''} placeholder={node.type} className='input-sm !h-5 flex-1 !text-[11px]'
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { extras.onRename?.(node.id, e.currentTarget.value.trim()); setRenaming(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }} />
        ) : (
          <span className={`flex-1 text-xs truncate ${isSel ? 'text-primary font-medium' : 'text-foreground'}`} title='Double-click to rename · drag to reorder'>
            {node.type === 'symbol' && <span className='text-violet-500 mr-1'>◇</span>}
            {node.componentName || node.type}
            {node.bind && <span className='ml-1 text-[9px] text-primary/70'>↻</span>}
            {text && <span className='text-muted-foreground/30 ml-1 font-normal'>: {text}</span>}
          </span>
        )}

        {/* Lock (always shown when locked) */}
        {extras.onToggleLock && (
          <button type='button' onClick={(e) => { e.stopPropagation(); extras.onToggleLock?.(node.id); }}
            className={`w-4 h-4 flex items-center justify-center shrink-0 transition-opacity ${node.locked ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
            title={node.locked ? 'Unlock' : 'Lock'}>
            <svg className='w-3 h-3 text-muted-foreground' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.75}><rect x='5' y='11' width='14' height='10' rx='2' /><path d={node.locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} /></svg>
          </button>
        )}

        {/* Indicators */}
        {node.comments?.some((c) => !c.resolved) && <span className='w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0' />}
        {(node.interactions?.length || 0) > 0 && <span className='text-[8px] text-primary/40 shrink-0'>⚡</span>}
        {hasChildren && <span className='text-[9px] text-muted-foreground/20 tabular-nums shrink-0'>{node.children.length}</span>}

        {/* Visibility eye (appears on hover) */}
        {onToggleVisibility && (
          <button type='button' onClick={(e) => { e.stopPropagation(); onToggleVisibility(node.id); }}
            className={`w-4 h-4 flex items-center justify-center shrink-0 transition-opacity ${isHidden ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
            title={isHidden ? 'Show' : 'Hide'}>
            {isHidden
              ? <svg className='w-3 h-3 text-muted-foreground' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22' /></svg>
              : <svg className='w-3 h-3 text-muted-foreground/40' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' /><circle cx='12' cy='12' r='3' /></svg>
            }
          </button>
        )}

        {/* Reorder arrows (appear on hover) */}
        {onMoveNode && (
          <div className='flex flex-col opacity-0 group-hover:opacity-60 transition-opacity shrink-0'>
            <button type='button' onClick={(e) => { e.stopPropagation(); onMoveNode(node.id, 'up'); }}
              disabled={index === 0} className='w-3 h-2 flex items-center justify-center text-muted-foreground hover:text-foreground disabled:invisible'>
              <svg className='w-2 h-2' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={3}><path d='M18 15l-6-6-6 6' /></svg>
            </button>
            <button type='button' onClick={(e) => { e.stopPropagation(); onMoveNode(node.id, 'down'); }}
              disabled={index === totalSiblings - 1} className='w-3 h-2 flex items-center justify-center text-muted-foreground hover:text-foreground disabled:invisible'>
              <svg className='w-2 h-2' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={3}><path d='M6 9l6 6 6-6' /></svg>
            </button>
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && !collapsed && node.children.map((child, ci) => (
        <OutlineNode key={child.id} node={child} depth={depth + 1} index={ci} totalSiblings={node.children.length} parentId={node.id} extras={extras}
          selectedNodeIds={selectedNodeIds} onSelect={onSelect}
          onToggleVisibility={onToggleVisibility} onMoveNode={onMoveNode} />
      ))}
    </>
  );
}
