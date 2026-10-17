import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { bindingItemsSafe, displayText, findMaster, renderLeaf, RepeatItemContext, StaticNode, StudioFilesContext } from './static-node.tsx';
import { findFileInTree } from '../lib/builder-types.ts';
import type { CanvasNode, ProjectFile } from '../lib/builder-types.ts';
import { isContainer } from '../lib/builder-types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CanvasViewProps {
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  zoom: number;
  devicePreview: 'desktop' | 'tablet' | 'mobile';
  canvasBg: 'white' | 'dots' | 'dark';
  pageName: string;
  onSelect: (nodeId: string, shiftKey: boolean) => void;
  onDeselect: () => void;
  onUpdateText: (nodeId: string, text: string) => void;
  onDropNew: (type: string, parentId?: string) => void;
  onDropReorder: (sourceId: string, targetParentId: string | null, insertIndex: number) => void;
  onContextMenu: (nodeId: string, x: number, y: number) => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onMoveUp: (nodeId: string) => void;
  onMoveDown: (nodeId: string) => void;
  onWrap: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onZoom?: (zoom: number) => void;
  /** Design-theme `--b-*` overrides for the artboard (see lib/design-theme.ts). */
  artboardStyle?: React.CSSProperties;
  /** Render the artboard in the design theme's dark variant. */
  artboardDark?: boolean;
  /** Extra class on the artboard (the repo CSS scope). */
  artboardClass?: string;
}

const DEVICE_W = { desktop: 1280, tablet: 768, mobile: 375 } as const;

// ─── Canvas View ────────────────────────────────────────────────────────────

export function CanvasView({
  nodes, selectedNodeIds, zoom, devicePreview, canvasBg, pageName,
  onSelect, onDeselect, onUpdateText, onDropNew, onDropReorder,
  onCopy, onPaste, onDuplicate, onMoveUp, onMoveDown, onWrap, onDelete, onZoom,
  artboardStyle, artboardDark, artboardClass,
}: CanvasViewProps) {
  const [ctx, setCtx] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, px: 0, py: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const deviceWidth = DEVICE_W[devicePreview];
  const scale = zoom / 100;
  const [spaceHeld, setSpaceHeld] = useState(false);

  // ── Space key for pan mode (like Figma) ──
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
    globalThis.addEventListener('keydown', down);
    globalThis.addEventListener('keyup', up);
    return () => { globalThis.removeEventListener('keydown', down); globalThis.removeEventListener('keyup', up); };
  }, []);

  // ── Pan: Space+drag, Middle mouse, Alt+drag ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
    }
  }, [pan, spaceHeld]);

  useEffect(() => {
    if (!isPanning) return;
    const move = (e: MouseEvent) => setPan({ x: panStart.px + e.clientX - panStart.x, y: panStart.py + e.clientY - panStart.y });
    const up = () => setIsPanning(false);
    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mouseup', up);
    return () => { globalThis.removeEventListener('mousemove', move); globalThis.removeEventListener('mouseup', up); };
  }, [isPanning, panStart]);

  // ── Scroll: regular scroll = pan, Ctrl/Cmd+scroll = zoom ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom or Ctrl+scroll = zoom
      e.preventDefault();
      if (onZoom) {
        const delta = e.deltaY > 0 ? -5 : 5;
        onZoom(Math.max(25, Math.min(200, zoom + delta)));
      }
    } else {
      // Regular scroll = pan canvas
      e.preventDefault();
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  }, [zoom, onZoom]);

  // Canvas background — uses CSS variables from globals.css
  const bgStyle: React.CSSProperties = canvasBg === 'dark'
    ? { background: 'var(--b-canvas-dark)' }
    : canvasBg === 'dots'
      ? { background: 'var(--b-canvas)', backgroundImage: 'radial-gradient(circle, var(--b-canvas-dot) 0.8px, transparent 0.8px)', backgroundSize: `${20 * scale}px ${20 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }
      : { background: 'var(--b-canvas)' };

  function handleCanvasClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset?.canvas) {
      onDeselect();
      setCtx(null);
    }
  }

  function handleCanvasDrop(e: React.DragEvent) {
    const type = e.dataTransfer.getData('adhar/type');
    const moveId = e.dataTransfer.getData('adhar/move-id');
    if (type) { e.preventDefault(); onDropNew(type); }
    else if (moveId) { e.preventDefault(); onDropReorder(moveId, null, nodes.length); }
  }

  function doCtx(action: string) {
    if (!ctx) return;
    const { nodeId } = ctx;
    setCtx(null);
    switch (action) {
      case 'copy': onCopy(); break;
      case 'paste': onPaste(); break;
      case 'duplicate': onDuplicate(); break;
      case 'up': onMoveUp(nodeId); break;
      case 'down': onMoveDown(nodeId); break;
      case 'wrap': onWrap(nodeId); break;
      case 'delete': onDelete(nodeId); break;
    }
  }


  return (
    <div className='flex-1 overflow-hidden relative' style={bgStyle}
      onMouseDown={handleMouseDown} onWheel={handleWheel}
      onClick={() => setCtx(null)} ref={canvasRef}>

      {/* ── Horizontal Ruler (top) ── */}
      <div className='absolute top-0 left-5 right-0 h-5 z-20 pointer-events-none overflow-hidden' style={{ background: 'color-mix(in oklab, var(--b-card) 85%, transparent)', backdropFilter: 'blur(4px)', borderBottom: '1px solid color-mix(in oklab, var(--b-border) 30%, transparent)' }}>
        <svg className='absolute top-0 left-0 w-full h-full' style={{ transform: `translateX(${pan.x % (100 * scale)}px)` }}>
          {Array.from({ length: 60 }, (_, i) => {
            const major = i * 100 * scale;
            const label = Math.round(i * 100 - pan.x / scale);
            return (
              <g key={i}>
                <line x1={major} y1={14} x2={major} y2={20} stroke='var(--b-muted-foreground)' strokeWidth={0.5} opacity={0.3} />
                <text x={major + 3} y={12} fill='var(--b-muted-foreground)' fontSize={8} opacity={0.35} fontFamily='ui-monospace, monospace'>{label}</text>
                {/* Minor ticks */}
                {[1,2,3,4].map((t) => (
                  <line key={t} x1={major + t * 20 * scale} y1={16} x2={major + t * 20 * scale} y2={20} stroke='var(--b-muted-foreground)' strokeWidth={0.5} opacity={0.15} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      {/* ── Vertical Ruler (left) ── */}
      <div className='absolute top-5 left-0 bottom-0 w-5 z-20 pointer-events-none overflow-hidden' style={{ background: 'color-mix(in oklab, var(--b-card) 85%, transparent)', backdropFilter: 'blur(4px)', borderRight: '1px solid color-mix(in oklab, var(--b-border) 30%, transparent)' }}>
        <svg className='absolute top-0 left-0 w-full h-full' style={{ transform: `translateY(${pan.y % (100 * scale)}px)` }}>
          {Array.from({ length: 60 }, (_, i) => {
            const major = i * 100 * scale;
            const label = Math.round(i * 100 - pan.y / scale);
            return (
              <g key={i}>
                <line x1={14} y1={major} x2={20} y2={major} stroke='var(--b-muted-foreground)' strokeWidth={0.5} opacity={0.3} />
                <text x={2} y={major + 10} fill='var(--b-muted-foreground)' fontSize={7} opacity={0.35} fontFamily='ui-monospace, monospace' style={{ writingMode: 'vertical-lr' } as any}>{label}</text>
                {[1,2,3,4].map((t) => (
                  <line key={t} x1={16} y1={major + t * 20 * scale} x2={20} y2={major + t * 20 * scale} stroke='var(--b-muted-foreground)' strokeWidth={0.5} opacity={0.15} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      {/* ── Ruler corner ── */}
      <div className='absolute top-0 left-0 w-5 h-5 z-20 pointer-events-none' style={{ background: 'color-mix(in oklab, var(--b-card) 85%, transparent)', borderBottom: '1px solid color-mix(in oklab, var(--b-border) 30%, transparent)', borderRight: '1px solid color-mix(in oklab, var(--b-border) 30%, transparent)' }} />

      {/* ── Artboard area ── */}
      <div className='absolute inset-0 pt-5 pl-5' style={{ cursor: isPanning ? 'grabbing' : spaceHeld ? 'grab' : 'default' }}
        onClick={handleCanvasClick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleCanvasDrop}>

        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, willChange: 'transform' }}>
          {/* Artboard */}
          <div className='relative' style={{ padding: '60px 80px' }}>
            {/* Artboard label */}
            <div className='absolute left-[80px] top-8 flex items-center gap-2' style={{ transform: `scale(${Math.max(0.7, 1 / scale)})`, transformOrigin: 'left center' }}>
              <span className='text-[11px] font-medium text-muted-foreground/50'>{pageName}</span>
              <span className='text-[10px] text-muted-foreground/30'>{deviceWidth}px</span>
            </div>

            {/* The actual artboard */}
            <div
              className={`relative rounded-lg bg-background text-foreground ${artboardDark ? 'dark' : ''} ${artboardClass ?? ''}`}
              style={{
                ...artboardStyle,
                width: deviceWidth,
                minHeight: 600,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                boxShadow: '0 0 0 1px color-mix(in oklab, var(--b-border) 50%, transparent), 0 4px 24px color-mix(in oklab, var(--b-foreground) 6%, transparent), 0 16px 56px color-mix(in oklab, var(--b-foreground) 3%, transparent)',
              }}
              data-canvas='true'
              onClick={handleCanvasClick}>

              {/* Artboard content */}
              <div className='p-6 min-h-[600px]'>
                {nodes.length === 0 ? (
                  <div className='flex flex-col items-center justify-center h-[550px] rounded-xl'
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleCanvasDrop}>
                    <div className='w-full h-full flex flex-col items-center justify-center border-2 border-dashed border-border/30 text-muted-foreground/20 rounded-xl transition-colors'>
                      <svg className='w-10 h-10 mb-3 opacity-40' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1}>
                        <rect x='3' y='3' width='18' height='18' rx='3' />
                        <path d='M12 8v8M8 12h8' />
                      </svg>
                      <p className='text-xs font-medium'>Drop components here</p>
                      <p className='text-xs mt-1 opacity-50'>Drag from the sidebar or use Insert menu</p>
                    </div>
                  </div>
                ) : (
                  nodes.map((node, i) => (
                    <NodeView key={node.id} node={node} selectedNodeIds={selectedNodeIds} hoveredId={hoveredId}
                      parentId={null} siblingIndex={i}
                      onSelect={onSelect} onUpdateText={onUpdateText}
                      onDropNew={onDropNew} onDropReorder={onDropReorder}
                      onHover={setHoveredId}
                      onContextMenu={(nodeId, x, y) => setCtx({ nodeId, x, y })} />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Context Menu ── */}
      {ctx && (
        <>
          <div className='fixed inset-0 z-40' onClick={() => setCtx(null)} />
          <div className='dropdown fixed w-48' style={{ left: ctx.x, top: ctx.y }}>
            <CtxItem label='Copy' shortcut='⌘C' onClick={() => doCtx('copy')} />
            <CtxItem label='Paste' shortcut='⌘V' onClick={() => doCtx('paste')} />
            <CtxItem label='Duplicate' shortcut='⌘D' onClick={() => doCtx('duplicate')} />
            <div className='dropdown-separator' />
            <CtxItem label='Move Up' onClick={() => doCtx('up')} />
            <CtxItem label='Move Down' onClick={() => doCtx('down')} />
            <CtxItem label='Wrap in Container' onClick={() => doCtx('wrap')} />
            <div className='dropdown-separator' />
            <CtxItem label='Delete' shortcut='⌫' onClick={() => doCtx('delete')} destructive />
          </div>
        </>
      )}

    </div>
  );
}

// ─── Context Menu Item ──────────────────────────────────────────────────────
function CtxItem({ label, shortcut, onClick, destructive }: { label: string; shortcut?: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button type='button' onClick={onClick} className={`dropdown-item ${destructive ? 'text-destructive' : ''}`}>
      <span>{label}</span>
      {shortcut && <kbd className='text-[10px] text-muted-foreground/40 font-mono'>{shortcut}</kbd>}
    </button>
  );
}

// ─── Node View ──────────────────────────────────────────────────────────────

/*
 * A modal is `fixed inset-0` in the prototype and the export. On the canvas
 * that would cover the artboard, so it is drawn inline as a framed backdrop
 * the designer can edit in place.
 */
const CANVAS_MODAL = 'relative mt-8 flex justify-center rounded-xl border-2 border-dashed border-violet-500/40 bg-foreground/10 p-8';

type DropPos = 'before' | 'after' | 'inside' | null;

function NodeView({ node, selectedNodeIds, hoveredId, parentId, siblingIndex, onSelect, onUpdateText, onDropNew, onDropReorder, onHover, onContextMenu }: {
  node: CanvasNode; selectedNodeIds: string[]; hoveredId: string | null;
  parentId: string | null; siblingIndex: number;
  onSelect: (nodeId: string, shiftKey: boolean) => void;
  onUpdateText: (nodeId: string, text: string) => void;
  onDropNew: (type: string, parentId?: string) => void;
  onDropReorder: (sourceId: string, targetParentId: string | null, insertIndex: number) => void;
  onHover: (nodeId: string | null) => void;
  onContextMenu: (nodeId: string, x: number, y: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [dropPos, setDropPos] = useState<DropPos>(null);
  const files = useContext(StudioFilesContext);
  const item = useContext(RepeatItemContext);
  if (node.hidden) return null;

  const isSel = selectedNodeIds.includes(node.id);
  const isHov = hoveredId === node.id && !isSel;
  const isCont = isContainer(node.type);
  const hasText = typeof node.props.children === 'string';

  function handleDragStart(e: React.DragEvent) {
    e.stopPropagation();
    e.dataTransfer.setData('adhar/move-id', node.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const hasMoveId = e.dataTransfer.types.includes('adhar/move-id');
    const hasType = e.dataTransfer.types.includes('adhar/type');
    if (!hasMoveId && !hasType) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;

    if (isCont) {
      // For containers: top 8px = before, bottom 8px = after, middle = inside
      const edge = Math.min(8, h * 0.15);
      if (y < edge) setDropPos('before');
      else if (y > h - edge) setDropPos('after');
      else setDropPos('inside');
    } else {
      // For leaf nodes: top half = before, bottom half = after
      setDropPos(y < h / 2 ? 'before' : 'after');
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const type = e.dataTransfer.getData('adhar/type');
    const moveId = e.dataTransfer.getData('adhar/move-id');
    const pos = dropPos;
    setDropPos(null);

    if (pos === 'inside' && isCont) {
      // Drop inside this container (append to end of children)
      if (type) onDropNew(type, node.id);
      else if (moveId && moveId !== node.id) onDropReorder(moveId, node.id, node.children.length);
    } else if (pos === 'before') {
      // Drop before this node within its parent
      if (type) onDropNew(type, parentId || undefined);
      else if (moveId && moveId !== node.id) onDropReorder(moveId, parentId, siblingIndex);
    } else if (pos === 'after') {
      // Drop after this node within its parent
      if (type) onDropNew(type, parentId || undefined);
      else if (moveId && moveId !== node.id) onDropReorder(moveId, parentId, siblingIndex + 1);
    }
  }

  // Selection ring color/style
  const ringCls = isSel
    ? 'ring-2 ring-primary ring-offset-1'
    : isHov
      ? 'ring-1 ring-primary/30'
      : '';

  const inline = isInlineNode(node);
  return (
    <div draggable={!node.locked}
      onClick={(e) => { if (node.locked) return; e.stopPropagation(); onSelect(node.id, e.shiftKey); }}
      onContextMenu={(e) => { if (node.locked) return; e.preventDefault(); e.stopPropagation(); onContextMenu(node.id, e.clientX, e.clientY); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (hasText && !node.locked) setEditing(true); }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={() => setDropPos(null)}
      onDrop={handleDrop}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      className={`relative transition-shadow ${inline ? 'inline' : ''} ${ringCls} ${dropPos === 'inside' ? 'ring-2 ring-primary/40 bg-primary/[0.03]' : ''}`}>

      {/* Drop indicators — precise lines with dots at edges */}
      {dropPos === 'before' && (
        <div className='absolute -top-[1px] left-0 right-0 z-10 pointer-events-none flex items-center'>
          <div className='w-1.5 h-1.5 rounded-full bg-primary shrink-0 -ml-[3px]' />
          <div className='flex-1 h-[2px] bg-primary' />
          <div className='w-1.5 h-1.5 rounded-full bg-primary shrink-0 -mr-[3px]' />
        </div>
      )}
      {dropPos === 'after' && (
        <div className='absolute -bottom-[1px] left-0 right-0 z-10 pointer-events-none flex items-center'>
          <div className='w-1.5 h-1.5 rounded-full bg-primary shrink-0 -ml-[3px]' />
          <div className='flex-1 h-[2px] bg-primary' />
          <div className='w-1.5 h-1.5 rounded-full bg-primary shrink-0 -mr-[3px]' />
        </div>
      )}

      {/* Selection label */}
      {isSel && (
        <div className='absolute -top-5 left-0 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary text-primary-foreground text-[10px] font-semibold whitespace-nowrap shadow-sm'>
          {node.type === 'symbol' ? `◇ ${symbolLabel(files, node)}` : node.componentName || node.type}
          {node.bind && <span className='opacity-70'>· repeats</span>}
          {node.children.length > 0 && <span className='opacity-60'>({node.children.length})</span>}
        </div>
      )}

      {/* Hover label (subtle) */}
      {isHov && !isSel && (
        <div className='absolute -top-4 left-0 z-10 px-1 py-px rounded-md bg-muted text-muted-foreground text-[10px] font-medium whitespace-nowrap pointer-events-none'>
          {node.type}
        </div>
      )}

      {/* Node content */}
      {node.type === 'symbol' ? (
        <div className='relative rounded-sm outline outline-1 outline-dashed outline-violet-500/40'>
          {(() => {
            const master = findMaster(files, String(node.props?.symbolId ?? ''));
            return master
              ? <div className='pointer-events-none'><StaticNode node={master} /></div>
              : <div className='p-3 text-xs text-destructive'>Missing component</div>;
          })()}
        </div>
      ) : node.type === 'code' ? (
        <CodeChip node={node} />
      ) : renderLeaf(node, item) ?? (
      <div className={node.type === 'modal' ? CANVAS_MODAL : withInline(node.props.className || '', inline)}>
        {node.type === 'modal' && (
          <span className='absolute -top-2.5 left-3 rounded bg-violet-500 px-1.5 text-[10px] font-semibold text-white'>Modal · opens on click</span>
        )}
        {/* ── Device chrome for screen types ── */}
        {node.type === 'screen-mobile' && (
          <>
            <div className='h-7 flex items-center justify-center'>
              <div className='w-20 h-[5px] rounded-full bg-zinc-800' />
            </div>
            <div className='flex items-center justify-between px-5 py-1.5 text-[11px]'>
              <span className='font-medium'>9:41</span>
              <div className='flex items-center gap-1'>
                <div className='w-4 h-2 border border-current rounded-sm'><div className='w-2/3 h-full bg-current rounded-sm' /></div>
              </div>
            </div>
          </>
        )}
        {node.type === 'screen-desktop' && (
          <div className='h-8 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 flex items-center px-3 gap-1.5 rounded-t-lg'>
            <div className='w-3 h-3 rounded-full bg-red-400/80' />
            <div className='w-3 h-3 rounded-full bg-yellow-400/80' />
            <div className='w-3 h-3 rounded-full bg-green-400/80' />
            <div className='flex-1 mx-8'>
              <div className='h-5 rounded-md bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 flex items-center px-2'>
                <span className='text-[9px] text-muted-foreground/40 font-mono'>localhost:3000</span>
              </div>
            </div>
          </div>
        )}
        {node.type === 'screen-tablet' && (
          <div className='h-5 flex items-center justify-center'>
            <div className='w-2 h-2 rounded-full bg-zinc-700' />
          </div>
        )}

        {/* ── Standard content rendering ── */}
        {(
          <>
            {hasText && !isCont && (
              editing ? (
                <span contentEditable suppressContentEditableWarning
                  onBlur={(e) => { setEditing(false); onUpdateText(node.id, e.currentTarget.textContent || ''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
                  className='outline-none ring-1 ring-primary/30 rounded-md px-0.5 min-w-[20px] inline-block'
                  ref={(el: HTMLSpanElement | null) => el?.focus()}>
                  {node.props.children}
                </span>
              ) : <span>{displayText(node.props.children, item)}</span>
            )}
            {/* Screen content area */}
            {node.type.startsWith('screen-') && (
              <div className='p-4 min-h-[200px]'>
                {node.children.length === 0 && (
                  <div className='flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground/20'>
                    <span className='text-2xl mb-2'>{node.type === 'screen-mobile' ? '📱' : node.type === 'screen-tablet' ? '📲' : '🖥'}</span>
                    <span className='text-xs'>Drop components here</span>
                  </div>
                )}
                {node.children.map((c, ci) => (
                  <NodeView key={c.id} node={c} selectedNodeIds={selectedNodeIds} hoveredId={hoveredId}
                    parentId={node.id} siblingIndex={ci}
                    onSelect={onSelect} onUpdateText={onUpdateText} onDropNew={onDropNew} onDropReorder={onDropReorder}
                    onHover={onHover} onContextMenu={onContextMenu} />
                ))}
              </div>
            )}
            {/* Regular children rendering (non-screen) */}
            {!node.type.startsWith('screen-') && (() => {
              const editable = node.children.map((c, ci) => (
                <NodeView key={c.id} node={c} selectedNodeIds={selectedNodeIds} hoveredId={hoveredId}
                  parentId={node.id} siblingIndex={ci}
                  onSelect={onSelect} onUpdateText={onUpdateText} onDropNew={onDropNew} onDropReorder={onDropReorder}
                  onHover={onHover} onContextMenu={onContextMenu} />
              ));
              if (!node.bind) return editable;
              // Repeater: the first item is the editable template; the rest
              // preview the data read-only.
              const items = bindingItemsSafe(files, node, 8);
              return (
                <>
                  <RepeatItemContext.Provider value={items[0] ?? {}}>{editable}</RepeatItemContext.Provider>
                  {items.slice(1).map((it, i) => (
                    <RepeatItemContext.Provider key={i} value={it}>
                      <div className='contents pointer-events-none'>
                        {node.children.map((c) => <StaticNode key={c.id} node={c} />)}
                      </div>
                    </RepeatItemContext.Provider>
                  ))}
                </>
              );
            })()}
            {isCont && !node.type.startsWith('screen-') && node.children.length === 0 && (
              <div className={`min-h-[48px] flex items-center justify-center text-[10px] border-2 border-dashed rounded-lg transition-colors ${dropPos === 'inside' ? 'border-primary/40 text-primary/40 bg-primary/[0.02]' : 'border-border/20 text-muted-foreground/15'}`}>
                <svg className='w-3.5 h-3.5 mr-1 opacity-40' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M12 5v14M5 12h14' /></svg>
                Drop here
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}

const INLINE_TYPES = new Set(['text', 'span', 'link', 'strong', 'em', 'small', 'badge', 'label-el']);
const DISPLAY_RE = /(^|\s)(block|inline|inline-block|flex|inline-flex|grid|inline-grid|hidden|contents|table)(\s|$)/;

/** Text-level nodes flow inline on the canvas, as they do in the app. */
function isInlineNode(n: CanvasNode): boolean {
  if (INLINE_TYPES.has(n.type)) return true;
  return n.type === 'code' && !String(n.props?.code ?? '').trimStart().startsWith('<') && !Array.isArray(n.props?.preview);
}

function withInline(className: string, inline: boolean): string {
  return inline && !DISPLAY_RE.test(className) ? `inline ${className}` : className;
}

/**
 * Code the designer preserves but doesn't edit: a preview of the JSX inside
 * it when there is any, else a chip with the expression.
 */
function CodeChip({ node }: { node: CanvasNode }) {
  const label = String(node.props?.label ?? 'code');
  if (label === 'comment') return null;
  const preview = Array.isArray(node.props?.preview) ? (node.props.preview as CanvasNode[]) : null;
  if (preview?.length) {
    return (
      <div className='relative rounded-sm outline outline-1 outline-dashed outline-amber-500/50' title={String(node.props?.code ?? '')}>
        <div className='pointer-events-none'>{preview.map((p) => <StaticNode key={p.id} node={p} />)}</div>
        <span className='absolute -top-2 right-1 rounded bg-amber-500 px-1 font-mono text-[9px] font-semibold text-white'>{label}</span>
      </div>
    );
  }
  return (
    <span className='inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[11px] text-amber-700 dark:text-amber-300' title={String(node.props?.code ?? '')}>
      {label}
    </span>
  );
}

function symbolLabel(files: ProjectFile[], node: CanvasNode): string {
  const f = findFileInTree(files, String(node.props?.symbolId ?? ''));
  return f ? f.name.replace(/\.\w+$/, '') : 'Component';
}
