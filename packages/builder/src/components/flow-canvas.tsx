// ─── Freeform Canvas — Diagramming & Architecture Tool ──────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Panel,
  useReactFlow, applyNodeChanges, applyEdgeChanges, addEdge, BackgroundVariant,
  Handle, Position, MarkerType, ConnectionMode,
  type Node as RFNode, type Edge as RFEdge, type OnNodesChange, type OnEdgesChange, type OnConnect,
} from '@xyflow/react';
import flowCss from '@xyflow/react/dist/style.css?inline';
import { ensureStyle } from '../lib/inject-style.ts';
import type { CanvasNode } from '../lib/builder-types.ts';

// ─── Architecture Node Types ─────────────────────────────────────────────────

const SHAPE_STYLES: Record<string, { bg: string; border: string; icon: string; radius: number }> = {
  'flow-step':     { bg: '#eff6ff', border: '#3b82f6', icon: '⬡', radius: 8 },
  'data-model':    { bg: '#f0fdf4', border: '#22c55e', icon: '🗄', radius: 4 },
  'api-endpoint':  { bg: '#faf5ff', border: '#a855f7', icon: '🌐', radius: 8 },
  'note':          { bg: '#fefce8', border: '#eab308', icon: '📌', radius: 4 },
  'screen-mobile': { bg: '#fff', border: '#334155', icon: '📱', radius: 16 },
  'screen-desktop':{ bg: '#fff', border: '#334155', icon: '🖥', radius: 8 },
  'screen-tablet': { bg: '#fff', border: '#334155', icon: '📲', radius: 12 },
  'div':           { bg: '#f8fafc', border: '#94a3b8', icon: '▦', radius: 8 },
  'card':          { bg: '#fff', border: '#e2e8f0', icon: '▣', radius: 12 },
  'button':        { bg: '#eef2ff', border: '#6366f1', icon: '⬡', radius: 8 },
  'input':         { bg: '#fff', border: '#cbd5e1', icon: '▭', radius: 6 },
  'shape-rect':    { bg: '#f1f5f9', border: '#94a3b8', icon: '⬜', radius: 0 },
  'shape-circle':  { bg: '#f1f5f9', border: '#94a3b8', icon: '⭕', radius: 999 },
  'section':       { bg: '#fafafa', border: '#e5e7eb', icon: '§', radius: 8 },
};

function getShape(type: string) {
  return SHAPE_STYLES[type] || { bg: '#f8fafc', border: '#94a3b8', icon: '•', radius: 8 };
}

// ─── Diagram Node Component ──────────────────────────────────────────────────

function DiagramNode({ data, selected }: any) {
  const node: CanvasNode = data;
  const text = typeof node.props?.children === 'string' ? node.props.children : '';
  const shape = getShape(node.type);
  const w = node.width || 180;
  const h = node.height || 70;

  return (
    <div style={{
      width: w, minHeight: h, borderRadius: shape.radius,
      border: `2px solid ${selected ? '#6366f1' : shape.border}`,
      background: shape.bg,
      boxShadow: selected ? '0 0 0 3px rgba(99,102,241,0.15), 0 2px 8px rgba(0,0,0,0.08)' : '0 1px 4px rgba(0,0,0,0.06)',
      fontFamily: 'Inter, system-ui, sans-serif',
      transition: 'box-shadow 0.15s, border-color 0.15s',
      position: 'relative',
    }}>
      {/* Connection handles */}
      <Handle type='target' position={Position.Top} style={{ width: 8, height: 8, background: '#6366f1', border: '2px solid white' }} />
      <Handle type='source' position={Position.Bottom} style={{ width: 8, height: 8, background: '#6366f1', border: '2px solid white' }} />
      <Handle type='target' position={Position.Left} style={{ width: 8, height: 8, background: '#6366f1', border: '2px solid white' }} />
      <Handle type='source' position={Position.Right} style={{ width: 8, height: 8, background: '#6366f1', border: '2px solid white' }} />

      {/* Header */}
      <div style={{ padding: '6px 10px', borderBottom: `1px solid ${shape.border}33`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>{shape.icon}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: shape.border, textTransform: 'capitalize' }}>{node.componentName || node.type.replace(/-/g, ' ')}</span>
      </div>

      {/* Content */}
      <div style={{ padding: '8px 10px' }}>
        {text ? (
          <div style={{ fontSize: 12, color: '#1e293b', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
        ) : node.type === 'data-model' ? (
          <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
            {'id: string\nname: string\ncreatedAt: Date'}
          </div>
        ) : node.type === 'api-endpoint' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: '#22c55e', color: 'white' }}>GET</span>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#64748b' }}>/api/resource</span>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
            {node.type === 'note' ? 'Click to edit note...' : 'Double-click to edit'}
          </div>
        )}
      </div>

      {/* Badges */}
      {node.comments && node.comments.filter((c: any) => !c.resolved).length > 0 && (
        <div style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: '#f59e0b', color: '#78350f', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {node.comments.filter((c: any) => !c.resolved).length}
        </div>
      )}
    </div>
  );
}

// ─── Sticky Note Node ────────────────────────────────────────────────────────

function StickyNode({ data, selected }: any) {
  const node: CanvasNode = data;
  const text = typeof node.props?.children === 'string' ? node.props.children : '';
  return (
    <div style={{
      width: node.width || 200, minHeight: node.height || 150, padding: 12,
      background: '#fef9c3', border: selected ? '2px solid #6366f1' : '1px solid #fbbf24',
      borderRadius: 4, boxShadow: '2px 2px 6px rgba(0,0,0,0.08)',
      fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, color: '#713f12',
      lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }}>
      <Handle type='target' position={Position.Top} style={{ width: 6, height: 6, background: '#eab308', border: '2px solid #fef9c3' }} />
      <Handle type='source' position={Position.Bottom} style={{ width: 6, height: 6, background: '#eab308', border: '2px solid #fef9c3' }} />
      {text || 'Click to add notes...'}
    </div>
  );
}

const nodeTypes = { diagram: DiagramNode, sticky: StickyNode };

// ─── Props ───────────────────────────────────────────────────────────────────

interface FlowCanvasProps {
  mode: 'layout' | 'freeform';
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  canvasBg: 'white' | 'dots' | 'dark';
  pageName: string;
  onSelect: (nodeId: string, shiftKey: boolean) => void;
  onDeselect: () => void;
  onUpdateText: (nodeId: string, text: string) => void;
  onDropNew: (type: string, parentId?: string, index?: number, x?: number, y?: number) => void;
  onNodePositionChange: (nodeId: string, x: number, y: number) => void;
  onNodeResize: (nodeId: string, width: number, height: number) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onMoveUp: (nodeId: string) => void;
  onMoveDown: (nodeId: string) => void;
  onWrap: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
}

// ─── Convert CanvasNode[] → React Flow ───────────────────────────────────────

function toRFNodes(nodes: CanvasNode[]): RFNode[] {
  return nodes.map((node, i) => ({
    id: node.id,
    type: node.type === 'note' ? 'sticky' : 'diagram',
    position: { x: node.x ?? 60 + (i % 5) * 220, y: node.y ?? 60 + Math.floor(i / 5) * 130 },
    data: node as unknown as Record<string, unknown>,
    draggable: true,
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
  }));
}

function toRFEdges(nodes: CanvasNode[]): RFEdge[] {
  const edges: RFEdge[] = [];
  nodes.forEach((node) => {
    node.interactions?.forEach((int) => {
      if (int.targetNodeId) {
        edges.push({
          id: `e-${node.id}-${int.targetNodeId}`,
          source: node.id,
          target: int.targetNodeId,
          label: int.action === 'navigate' ? '' : int.action,
          animated: int.action === 'navigate',
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#6366f1' },
          style: { stroke: '#6366f1', strokeWidth: 2 },
          labelStyle: { fontSize: 10, fill: '#64748b' },
        });
      }
    });
  });
  return edges;
}

// ─── Inner Component ─────────────────────────────────────────────────────────

function FlowInner(props: FlowCanvasProps) {
  const { nodes, canvasBg, pageName } = props;
  const reactFlow = useReactFlow();
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([]);

  useEffect(() => {
    setRfNodes(toRFNodes(nodes));
    setRfEdges(toRFEdges(nodes));
  }, [nodes]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
    for (const c of changes) {
      if (c.type === 'position' && c.position && !c.dragging) {
        props.onNodePositionChange(c.id, c.position.x, c.position.y);
      }
    }
  }, [props.onNodePositionChange]);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setRfEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const onConnect: OnConnect = useCallback((connection) => {
    if (!connection.source || !connection.target) return;
    setRfEdges((eds) => addEdge({ ...connection, type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#6366f1' }, style: { stroke: '#6366f1', strokeWidth: 2 } }, eds));
    props.onConnect(connection.source, connection.target);
  }, [props.onConnect]);

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('adhar/type');
    if (!type) return;
    try {
      const pos = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      props.onDropNew(type, undefined, undefined, pos.x, pos.y);
    } catch { props.onDropNew(type); }
  }, [reactFlow, props.onDropNew]);

  const onNodeClick = useCallback((_: any, node: RFNode) => { props.onSelect(node.id, false); }, [props.onSelect]);

  const bgColor = canvasBg === 'dark' ? 'var(--b-canvas-dark)' : canvasBg === 'white' ? 'var(--b-background)' : 'var(--b-canvas)';
  const dotColor = 'var(--b-canvas-dot)';
  const bgVariant = canvasBg === 'white' ? BackgroundVariant.Lines : BackgroundVariant.Dots;

  return (
    <div style={{ width: '100%', height: '100%' }} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={props.onDeselect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        fitView={rfNodes.length > 0}
        minZoom={0.1}
        maxZoom={4}
        panOnScroll
        zoomOnScroll
        snapToGrid
        snapGrid={[10, 10]}
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        style={{ background: bgColor }}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#6366f1' },
          style: { stroke: '#6366f1', strokeWidth: 2 },
        }}
      >
        <Background variant={bgVariant} gap={20} size={1} color={dotColor} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const shape = getShape(String((n.data as unknown as CanvasNode | undefined)?.type || ''));
            return shape.border;
          }}
          maskColor='rgba(0,0,0,0.05)'
        />
        <Panel position='top-left'>
          <div style={{ padding: '6px 12px', borderRadius: 10, fontSize: 11, background: 'var(--b-popover)', color: 'var(--b-muted-foreground)', border: '1px solid var(--b-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, color: 'var(--b-foreground)' }}>{pageName}</span>
            <span>·</span>
            <span>{nodes.length} nodes</span>
            <span>·</span>
            <span>{rfEdges.length} connections</span>
          </div>
        </Panel>
        <Panel position='top-right'>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4, borderRadius: 10, background: 'var(--b-popover)', border: '1px solid var(--b-border)' }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--b-muted-foreground)', padding: '2px 8px', textTransform: 'uppercase', letterSpacing: 1 }}>Quick Add</span>
            {[
              { type: 'flow-step', label: 'Step', icon: '⬡' },
              { type: 'data-model', label: 'Model', icon: '🗄' },
              { type: 'api-endpoint', label: 'API', icon: '🌐' },
              { type: 'note', label: 'Note', icon: '📌' },
            ].map((item) => (
              <button type='button' key={item.type}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('adhar/type', item.type); e.dataTransfer.effectAllowed = 'move'; }}
                onClick={() => {
                  const center = reactFlow.getViewport();
                  props.onDropNew(item.type, undefined, undefined, -center.x / center.zoom + 400, -center.y / center.zoom + 300);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, border: 'none', background: 'transparent', cursor: 'grab', fontSize: 11, color: 'var(--b-foreground)', textAlign: 'left' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--b-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                <span style={{ fontSize: 14 }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function FlowCanvas(props: FlowCanvasProps) {
  ensureStyle('adhar-xyflow-css', flowCss);
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}

export default FlowCanvas;
