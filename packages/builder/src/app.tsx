import React, { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { AdharSymbol, useToast } from '@adhar/shell-ui';
import * as Palette from './lib/builder-palette.ts';
import { Toolbar } from './components/toolbar.tsx';
import { CanvasView } from './components/canvas-view.tsx';
import { WorkflowEditor } from './components/workflow-editor.tsx';
import { APIEditor } from './components/api-editor.tsx';
import { PropertiesPanel } from './components/properties-panel.tsx';
import { ThemePanel } from './components/theme-panel.tsx';
import { AIPanel } from './components/ai-panel.tsx';
import { FileExplorer } from './components/file-explorer.tsx';
import { OutlinePanel } from './components/outline-panel.tsx';
import { DialogProvider, showPrompt, showAlert } from './components/dialog.tsx';
import { DesignHero } from './components/design-hero.tsx';
import { VariantStrip } from './components/variant-strip.tsx';
import { generateCode, nodeToHTML } from './lib/builder-codegen.ts';
import { getThemePreset, generateThemeCSS, exportDesignTokens, exportTokensAsCustomProperties, downloadFile } from './lib/builder-api.ts';
import { generateVariants, generateSingleVariant } from './lib/design-generator.ts';
import { parseRefinePrompt, applyRefine } from './lib/design-refine.ts';
import { designThemeStyle, designThemeVars } from './lib/design-theme.ts';
import { adharAiAvailable, askAdharAi, CODE_INSTRUCTIONS, PAGE_INSTRUCTIONS } from './lib/adhar-ai.ts';
import { extractFence, htmlToNodes } from './lib/html-to-nodes.ts';
import { initialFileFor } from './lib/project.ts';
import { findBlueprint, instantiate, BLUEPRINTS, searchBlueprints } from './lib/blueprints.ts';
import {
  collectRepeaters, countInstances, DATA_FOLDER, detachInstance, ensureFolder, instanceOf, listDataSources, listPages, listSymbols,
  makeSymbol, moveFile, newDataSource, newPage, PAGES_FOLDER, replaceNode, setHomePage, SYMBOLS_FOLDER, symbolName,
} from './lib/studio.ts';
import { SAMPLE_CUSTOMERS, SAMPLE_ORDERS } from './lib/sample-data.ts';
import { buildPrototypeDoc } from './lib/prototype.ts';
import { classCandidates } from './code/css-theme.ts';
import type { CanvasCss } from './builder-app.tsx';
import { PagesPanel } from './components/pages-panel.tsx';
import { DataPanel } from './components/data-panel.tsx';
import { StudioInspector } from './components/studio-inspector.tsx';
import { StudioFilesContext } from './components/static-node.tsx';
import type { StyleKey } from './lib/design-content.ts';
import type { BuilderMode, BuilderProject } from './types.ts';
import {
  genId,
  findFileInTree, getFilePath, isPageFile, getAllPageFiles,
  updateFileInTree, removeFileFromTree, addFileToFolder, langFromName,
  findNode, addChildToNode, removeNodeFromTree, updateNodeProp, reIdNodes,
  moveNodeInTree, wrapNodeInContainer, insertNodeAt, extractNode, isContainer,
  type AppState, type CanvasNode, type ProjectFile, type AIMessage,
} from './lib/builder-types.ts';

// Heavy surfaces load on first use: Monaco (code), Mermaid (diagrams), React Flow (freeform).
const MonacoEditor = lazy(() => import('./components/monaco-editor.tsx'));
const DiagramEditor = lazy(() => import('./components/diagram-editor.tsx'));
const FlowCanvas = lazy(() => import('./components/flow-canvas.tsx'));

function SurfaceLoading() {
  return <div className='flex-1 flex items-center justify-center text-xs text-muted-foreground'>Loading…</div>;
}

/** True when a tree holds preserved source code (imported from a repository). */
function containsCode(nodes: CanvasNode[]): boolean {
  return nodes.some((n) => n.type === 'code' || containsCode(n.children));
}

/** Monaco grammar for a page's generated code. */
function codeLanguage(framework: string): string {
  return framework === 'vue' || framework === 'svelte' ? 'html' : 'tsx';
}

/** Track the console's resolved light/dark mode (the `.dark` class on <html>). */
function useConsoleDark(): boolean {
  const read = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** Every stylesheet on the page, inlined — the preview iframe gets the console's compiled Tailwind with no CDN. */
function collectPageCSS(): string {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\n';
    } catch { /* cross-origin sheet — skip */ }
  }
  return css;
}

export interface WorkbenchProps {
  mode: BuilderMode;
  project: BuilderProject;
  onChange(project: BuilderProject): void;
  onSave(): void;
  initialFileId?: string;
  onActiveFileChange?(fileId: string | null): void;
  previewCode?(fileId: string, project: BuilderProject): string | null;
  canvasCss?: CanvasCss | null;
}

/** Every class string in a tree (incl. preview trees of code nodes) — Tailwind candidates. */
function collectClasses(nodes: CanvasNode[], into: string[]) {
  for (const n of nodes) {
    if (typeof n.props?.className === 'string') into.push(n.props.className);
    if (Array.isArray(n.props?.preview)) collectClasses(n.props.preview as CanvasNode[], into);
    collectClasses(n.children, into);
  }
}
function allClasses(files: ProjectFile[], into: string[] = []): string[] {
  for (const f of files) {
    if (f.nodes) collectClasses(f.nodes, into);
    if (f.children) allClasses(f.children, into);
  }
  return into;
}
// Palette classes are candidates too, so a dropped component renders at once.
const PALETTE_CLASSES = (() => {
  const out: string[] = [];
  const walk = (n: CanvasNode) => { if (typeof n.props?.className === 'string') out.push(n.props.className); n.children.forEach(walk); };
  for (const c of BLUEPRINTS) for (const it of c.items) {
    if (typeof it.defaultProps?.className === 'string') out.push(it.defaultProps.className);
    if (it.build) walk(it.build());
  }
  return out;
})();

// ─── Workbench ───────────────────────────────────────────────────────────────
export default function Workbench({ mode, project, onChange, onSave, initialFileId, onActiveFileChange, previewCode, canvasCss }: WorkbenchProps) {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const consoleDark = useConsoleDark();
  const [aiConnected, setAiConnected] = useState(false);
  useEffect(() => { void adharAiAvailable().then(setAiConnected); }, []);

  const [s, setS] = useState<AppState>(() => {
    const first = (initialFileId ? findFileInTree(project.files, initialFileId) : null) ?? initialFileFor(mode, project.files);
    return {
      files: project.files,
      activeFileId: first?.id || null,
      openFileIds: first ? [first.id] : [],
      selectedNodeIds: [],
      zoom: 100,
      viewMode: 'design',
      framework: project.settings.framework,
      theme: project.settings.theme,
      darkMode: project.settings.darkMode,
      showRuler: true,
      canvasMode: 'layout' as const,
      canvasBg: 'dots',
      aiPrompt: '',
      aiLoading: false,
      aiProvider: 'local',
      aiMessages: [],
      aiModifyMode: false,
      paletteSearch: '',
      leftPanel: mode === 'workflow' ? 'workflows' : 'components',
      rightPanel: mode === 'theme' ? 'theme' : 'properties',
      history: [],
      historyIndex: -1,
      clipboard: null,
      openMenu: null,
      renamingFileId: null,
      customTokenOverrides: project.settings.customTokenOverrides,
      devicePreview: 'desktop',
    };
  });

  // Use Adhar AI once the platform reports it configured; templates otherwise.
  useEffect(() => { if (aiConnected) setS((p) => ({ ...p, aiProvider: 'adhar' })); }, [aiConnected]);

  // ─── Derived state ─────────────────────────────────────────────
  const activeFile = s.activeFileId ? findFileInTree(s.files, s.activeFileId) : null;
  const isActive = activeFile ? isPageFile(activeFile) : false;
  const activeNodes = isActive && activeFile?.nodes ? activeFile.nodes : [];
  const selNode = s.selectedNodeIds.length === 1 ? findNode(activeNodes, s.selectedNodeIds[0]) : null;
  const activeFilePath = s.activeFileId ? getFilePath(s.files, s.activeFileId) : '';
  const pageName = activeFile ? activeFile.name.replace(/\.\w+$/, '').replace(/\s+/g, '') : 'Untitled';
  const pageFiles = getAllPageFiles(s.files);
  const currentTheme = getThemePreset(s.theme);
  const artboardStyle = designThemeStyle(s.theme, s.darkMode, s.customTokenOverrides);

  // ─── Report edits to the host (draft + dirty tracking + save) ──
  const firstRun = useRef(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    onChangeRef.current({
      version: 1,
      name: project.name,
      source: project.source,
      files: s.files,
      settings: { framework: s.framework, theme: s.theme, darkMode: s.darkMode, customTokenOverrides: s.customTokenOverrides },
    });
  }, [s.files, s.framework, s.theme, s.darkMode, s.customTokenOverrides, project.name]);

  // ─── Preview document ──────────────────────────────────────────
  // Self-contained: the console's compiled CSS (which includes every utility
  // the builder's palette and generators use) plus the design theme as
  // `--b-*` variables. No Tailwind CDN, no web fonts — works air-gapped.
  // ─── The repo's own CSS (compiled for the classes in use) ──────
  const [repoCss, setRepoCss] = useState('');
  const classKey = canvasCss ? classCandidates([...allClasses(s.files), ...PALETTE_CLASSES]).sort().join(' ') : '';
  useEffect(() => {
    if (!canvasCss) return;
    const t = setTimeout(() => {
      try { setRepoCss(canvasCss.build(classKey.split(' ').filter(Boolean))); } catch (e) { console.warn('[designer] CSS compile failed', e); }
    }, 120);
    return () => clearTimeout(t);
  }, [canvasCss, classKey]);
  useEffect(() => {
    if (!canvasCss || typeof document === 'undefined') return;
    let el = document.getElementById('adhar-repo-css') as HTMLStyleElement | null;
    if (!el) { el = document.createElement('style'); el.id = 'adhar-repo-css'; document.head.appendChild(el); }
    el.textContent = repoCss;
  }, [canvasCss, repoCss]);
  useEffect(() => () => { document.getElementById('adhar-repo-css')?.remove(); }, []);

  // Tell the host which page is open (deep links).
  const onActiveRef = useRef(onActiveFileChange);
  onActiveRef.current = onActiveFileChange;
  useEffect(() => { onActiveRef.current?.(s.activeFileId); }, [s.activeFileId]);

  function buildPreviewDoc(opts: { chrome?: boolean } = {}): string {
    return buildPrototypeDoc({
      files: s.files,
      css: collectPageCSS(),
      scoped: !!canvasCss,
      themeVars: designThemeVars(s.theme, s.darkMode, s.customTokenOverrides),
      dark: s.darkMode,
      startPageId: isActive && !activeFile?.symbol ? activeFile?.id : undefined,
      chrome: opts.chrome,
    });
  }

  // ─── Node operations ───────────────────────────────────────────
  function updateNodes(fn: (nodes: CanvasNode[]) => CanvasNode[]) {
    setS((p) => {
      if (!p.activeFileId) return p;
      const file = findFileInTree(p.files, p.activeFileId);
      if (!file || !isPageFile(file)) return p;
      const old = file.nodes || [];
      const next = fn(old);
      return { ...p, files: updateFileInTree(p.files, p.activeFileId, (f) => ({ ...f, nodes: next })), history: [...p.history.slice(0, p.historyIndex + 1), old], historyIndex: p.historyIndex + 1 };
    });
  }

  function addNode(type: string, parentId?: string, index?: number, x?: number, y?: number) {
    let node: CanvasNode;
    const symbolId = type.startsWith('symbol:') ? type.slice(7) : null;
    const bp = symbolId ? undefined : findBlueprint(type);
    if (symbolId) node = instanceOf(symbolId);
    else if (bp) node = instantiate(bp);
    else {
      const item = Palette.getFullPalette().flatMap((c) => c.items).find((i) => i.type === type);
      if (!item) { console.warn('[Builder] Unknown component type:', type); return; }
      node = { id: genId(), type: item.type, props: { ...item.defaultProps }, children: [], style: {} };
    }
    // Tables and lists arrive bound to data: the first data source, or a
    // starter "customers" source created on the spot.
    const repeaters = collectRepeaters(node);
    if (repeaters.length) {
      let source = listDataSources(s.files)[0];
      if (!source) {
        source = newDataSource('customers', SAMPLE_CUSTOMERS);
        const created = source;
        setS((p) => ({ ...p, files: addFileToFolder(ensureFolder(p.files, DATA_FOLDER), DATA_FOLDER, created) }));
      }
      for (const r of repeaters) { r.bind = { source: source.id }; delete r.props['data-repeater']; }
    }
    if (x !== undefined && y !== undefined) { node.x = x; node.y = y; }
    if (parentId && index !== undefined) {
      updateNodes((nodes) => insertNodeAt(nodes, node, parentId, index));
    } else if (parentId) {
      updateNodes((nodes) => addChildToNode(nodes, parentId, node));
    } else {
      updateNodes((nodes) => [...nodes, node]);
    }
    setS((p) => ({ ...p, selectedNodeIds: [node.id], rightPanel: 'properties' }));
  }

  // ─── App structure: pages, components, data ────────────────────
  async function addPage() {
    const n = await showPrompt('New page', { placeholder: 'Page name, e.g. Customers' });
    if (!n) return;
    const page = newPage(n, listPages(s.files).map((f) => f.name));
    setS((p) => ({
      ...p,
      files: addFileToFolder(ensureFolder(p.files, PAGES_FOLDER), PAGES_FOLDER, page),
      activeFileId: page.id, openFileIds: [...p.openFileIds, page.id], selectedNodeIds: [], history: [], historyIndex: -1,
    }));
  }
  async function renamePage(id: string) {
    const f = findFileInTree(s.files, id);
    if (!f) return;
    const n = await showPrompt('Rename', { placeholder: 'Name', defaultValue: f.name.replace(/\.\w+$/, '') });
    if (n) renameFile(id, `${n.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'Page'}.tsx`);
  }
  function setPageRoute(id: string, route: string) {
    const clean = ('/' + route.trim().replace(/^\/+/, '')).replace(/[^A-Za-z0-9/_:-]+/g, '-');
    setS((p) => ({ ...p, files: updateFileInTree(p.files, id, (f) => ({ ...f, route: clean })) }));
  }
  function deletePage(id: string) {
    if (listPages(s.files).length < 2) return;
    if (findFileInTree(s.files, id)?.repoPath) {
      toast.info('Pages in the repository are not deleted from here', { description: 'Remove the file (and its route) in code.' });
      return;
    }
    deleteFile(id);
  }
  function makeComponent(nodeId: string) {
    const node = findNode(activeNodes, nodeId);
    if (!node) return;
    void showPrompt('Create component', { placeholder: 'Component name, e.g. ProductCard', defaultValue: node.componentName || '' }).then((name) => {
      if (!name) return;
      const { symbol, instance } = makeSymbol(node, name, listSymbols(s.files).map((f) => f.name));
      updateNodes((nodes) => replaceNode(nodes, nodeId, instance));
      setS((p) => ({ ...p, files: addFileToFolder(ensureFolder(p.files, SYMBOLS_FOLDER), SYMBOLS_FOLDER, symbol), selectedNodeIds: [instance.id] }));
    });
  }
  function detach(nodeId: string) {
    const node = findNode(activeNodes, nodeId);
    const copy = node ? detachInstance(node, s.files) : null;
    if (copy) { updateNodes((nodes) => replaceNode(nodes, nodeId, copy)); setS((p) => ({ ...p, selectedNodeIds: [copy.id] })); }
  }
  async function addDataSource() {
    const n = await showPrompt('New data source', { placeholder: 'Name, e.g. customers' });
    if (!n) return;
    const src = newDataSource(n, /order/i.test(n) ? SAMPLE_ORDERS : /customer|user|people|contact/i.test(n) ? SAMPLE_CUSTOMERS : '[\n  { "id": 1, "title": "First item" }\n]', listDataSources(s.files).map((f) => f.name));
    setS((p) => ({ ...p, files: addFileToFolder(ensureFolder(p.files, DATA_FOLDER), DATA_FOLDER, src), leftPanel: 'data' }));
  }

  function deleteNode(nodeId: string) { updateNodes((nodes) => removeNodeFromTree(nodes, nodeId)); setS((p) => ({ ...p, selectedNodeIds: p.selectedNodeIds.filter((id) => id !== nodeId) })); }
  function updateProp(nodeId: string, key: string, value: any) {
    if (['interactions', 'hoverClassName', 'hidden', 'comments', 'componentName', 'locked', 'bind', 'x', 'y', 'width', 'height'].includes(key)) {
      // Direct node property, not inside props
      updateNodes((nodes) => {
        const update = (arr: CanvasNode[]): CanvasNode[] => arr.map((n) => {
          if (n.id === nodeId) return { ...n, [key]: value };
          return { ...n, children: update(n.children) };
        });
        return update(nodes);
      });
    } else {
      updateNodes((nodes) => updateNodeProp(nodes, nodeId, key, value));
    }
  }

  function undo() { setS((p) => { if (p.historyIndex < 0 || !p.activeFileId) return p; return { ...p, files: updateFileInTree(p.files, p.activeFileId, (f) => ({ ...f, nodes: p.history[p.historyIndex] })), historyIndex: p.historyIndex - 1, selectedNodeIds: [] }; }); }
  function redo() { setS((p) => { if (p.historyIndex >= p.history.length - 1 || !p.activeFileId) return p; return { ...p, files: updateFileInTree(p.files, p.activeFileId, (f) => ({ ...f, nodes: p.history[p.historyIndex + 2] || f.nodes || [] })), historyIndex: p.historyIndex + 1, selectedNodeIds: [] }; }); }

  function copyNode() {
    const n = s.selectedNodeIds.length === 1 ? findNode(activeNodes, s.selectedNodeIds[0]) : null;
    if (n) setS((p) => ({ ...p, clipboard: JSON.parse(JSON.stringify(n)) }));
  }
  function pasteNode() { if (!s.clipboard) return; updateNodes((nodes) => [...nodes, reIdNodes(s.clipboard!)]); }
  function duplicateNode() { const n = s.selectedNodeIds.length === 1 ? findNode(activeNodes, s.selectedNodeIds[0]) : null; if (n) updateNodes((nodes) => [...nodes, reIdNodes(JSON.parse(JSON.stringify(n)))]); }
  function clearCanvas() { updateNodes(() => []); setS((p) => ({ ...p, selectedNodeIds: [] })); }
  function moveUp(nodeId: string) { updateNodes((nodes) => moveNodeInTree(nodes, nodeId, 'up')); }
  function moveDown(nodeId: string) { updateNodes((nodes) => moveNodeInTree(nodes, nodeId, 'down')); }
  function wrapNode(nodeId: string) { updateNodes((nodes) => wrapNodeInContainer(nodes, nodeId)); }

  function handleSelect(nodeId: string, shiftKey: boolean) {
    setS((p) => {
      if (shiftKey) {
        const ids = p.selectedNodeIds.includes(nodeId) ? p.selectedNodeIds.filter((id) => id !== nodeId) : [...p.selectedNodeIds, nodeId];
        return { ...p, selectedNodeIds: ids, rightPanel: 'properties' };
      }
      return { ...p, selectedNodeIds: [nodeId], rightPanel: 'properties' };
    });
  }

  function handleDropReorder(sourceId: string, targetParentId: string | null, insertIndex: number) {
    updateNodes((nodes) => {
      const { remaining, extracted } = extractNode(JSON.parse(JSON.stringify(nodes)), sourceId);
      if (!extracted) return nodes;
      return insertNodeAt(remaining, extracted, targetParentId, insertIndex);
    });
  }

  // ─── File operations ───────────────────────────────────────────
  function openFile(fileId: string) {
    setS((p) => {
      const file = findFileInTree(p.files, fileId);
      if (!file || file.type === 'folder') return p;
      const openIds = p.openFileIds.includes(fileId) ? p.openFileIds : [...p.openFileIds, fileId];
      return { ...p, activeFileId: fileId, openFileIds: openIds, selectedNodeIds: [], history: [], historyIndex: -1 };
    });
  }
  function closeFile(fileId: string) {
    setS((p) => {
      const openIds = p.openFileIds.filter((fid) => fid !== fileId);
      let activeId = p.activeFileId;
      if (activeId === fileId) { const idx = p.openFileIds.indexOf(fileId); activeId = openIds[Math.min(idx, openIds.length - 1)] || null; }
      return { ...p, openFileIds: openIds, activeFileId: activeId, selectedNodeIds: [] };
    });
  }
  function toggleFolder(folderId: string) { setS((p) => ({ ...p, files: updateFileInTree(p.files, folderId, (f) => ({ ...f, expanded: !f.expanded })) })); }
  function createFile(parentFolderId: string, name: string, asPage: boolean) {
    const fid = `f_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    const lang = langFromName(name);
    const newFile: ProjectFile = asPage ? { id: fid, name, type: 'file', language: lang, nodes: [] } : { id: fid, name, type: 'file', language: lang, content: '' };
    setS((p) => {
      const updatedFiles = addFileToFolder(p.files, parentFolderId, newFile);
      const openIds = [...p.openFileIds, fid];
      return { ...p, files: updatedFiles, activeFileId: fid, openFileIds: openIds, selectedNodeIds: [], history: [], historyIndex: -1 };
    });
  }
  function createFolder(parentFolderId: string, name: string) {
    const fid = `f_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    setS((p) => ({ ...p, files: addFileToFolder(p.files, parentFolderId, { id: fid, name, type: 'folder', children: [], expanded: true }) }));
  }
  function deleteFile(fileId: string) { setS((p) => ({ ...p, files: removeFileFromTree(p.files, fileId), openFileIds: p.openFileIds.filter((fid) => fid !== fileId), activeFileId: p.activeFileId === fileId ? (p.openFileIds.filter((fid) => fid !== fileId)[0] || null) : p.activeFileId, selectedNodeIds: p.activeFileId === fileId ? [] : p.selectedNodeIds })); }
  function renameFile(fileId: string, newName: string) { if (!newName.trim()) return; setS((p) => ({ ...p, files: updateFileInTree(p.files, fileId, (f) => ({ ...f, name: newName.trim(), language: f.type === 'file' ? langFromName(newName.trim()) : f.language })), renamingFileId: null })); }
  function updateFileContent(fileId: string, content: string) { setS((p) => ({ ...p, files: updateFileInTree(p.files, fileId, (f) => ({ ...f, content })) })); }

  // ─── AI: variants + refinement engine ─────────────────────────────
  // Generates 3 styled variants from scratch and saves them to the active file
  function generateDesignVariants(prompt: string, styles?: StyleKey[]) {
    const variants = generateVariants(prompt, styles);
    const first = variants[0];
    setS((p) => {
      if (!p.activeFileId) return { ...p, aiLoading: false };
      return {
        ...p,
        aiLoading: false,
        files: updateFileInTree(p.files, p.activeFileId, (f) => ({
          ...f,
          nodes: first?.nodes || [],
          variants,
          activeVariantId: first?.id || null,
          lastPrompt: prompt,
        })),
        selectedNodeIds: [],
        history: [],
        historyIndex: -1,
        aiMessages: [...p.aiMessages, {
          id: genId(),
          role: 'assistant',
          content: `Generated ${variants.length} design variants: ${variants.map((v) => v.label).join(', ')}. Switch between them in the variant strip above the canvas, or refine the active one by chatting (e.g. "make it minimal", "add pricing section", "change headline to ...").`,
          timestamp: Date.now(),
        }],
      };
    });
  }

  // Switch to a different variant
  function activateVariant(variantId: string) {
    if (!s.activeFileId) return;
    setS((p) => {
      const file = findFileInTree(p.files, p.activeFileId!);
      if (!file?.variants) return p;
      const v = file.variants.find((vv) => vv.id === variantId);
      if (!v) return p;
      return {
        ...p,
        files: updateFileInTree(p.files, p.activeFileId!, (f) => ({ ...f, nodes: v.nodes, activeVariantId: v.id })),
        selectedNodeIds: [],
        history: [],
        historyIndex: -1,
      };
    });
  }

  function removeVariant(variantId: string) {
    if (!s.activeFileId) return;
    setS((p) => {
      const file = findFileInTree(p.files, p.activeFileId!);
      if (!file?.variants) return p;
      const remaining = file.variants.filter((v) => v.id !== variantId);
      const newActive = file.activeVariantId === variantId ? remaining[0]?.id || null : file.activeVariantId;
      const newNodes = newActive ? remaining.find((v) => v.id === newActive)?.nodes || [] : file.nodes;
      return {
        ...p,
        files: updateFileInTree(p.files, p.activeFileId!, (f) => ({
          ...f,
          variants: remaining,
          activeVariantId: newActive,
          nodes: newNodes,
        })),
      };
    });
  }

  // Add one extra variant (different style) to the existing set
  function addExtraVariant() {
    if (!s.activeFileId) return;
    const file = findFileInTree(s.files, s.activeFileId);
    if (!file) return;
    const prompt = file.lastPrompt || 'modern landing page';
    // Pick a style not yet in the set
    const used = new Set((file.variants || []).map((v) => v.style));
    const all: StyleKey[] = ['modern', 'minimal', 'playful', 'enterprise', 'bold', 'editorial'];
    const next = all.find((k) => !used.has(k)) || 'modern';
    const newVariant = generateSingleVariant(prompt, next);
    setS((p) => ({
      ...p,
      files: updateFileInTree(p.files, p.activeFileId!, (f) => ({
        ...f,
        variants: [...(f.variants || []), newVariant],
      })),
    }));
  }

  function pushAIMessage(role: AIMessage['role'], content: string) {
    setS((p) => ({ ...p, aiLoading: false, aiMessages: [...p.aiMessages, { id: genId(), role, content, timestamp: Date.now() }] }));
  }

  /**
   * Adhar AI: a page request returns an HTML fragment that becomes the page's
   * node tree (undoable); a source-file request returns the new file content.
   */
  async function generateWithAdharAI(prompt: string) {
    if (!activeFile || activeFile.type !== 'file') {
      pushAIMessage('system', 'Open a page or a source file first.');
      return;
    }
    const fileId = activeFile.id;
    if (isActive && containsCode(activeNodes)) {
      // The page holds code the designer preserves verbatim: AI adds to it,
      // it never rewrites (and so never drops) that code.
      const reply = await askAdharAi({
        prompt: `${PAGE_INSTRUCTIONS}\n\nGenerate ONE new section to add to an existing page. Request: ${prompt}`,
        context: [{ description: 'Builder page', value: `${activeFilePath} (${s.framework})` }],
      });
      const nodes = htmlToNodes(extractFence(reply, ['html']) ?? reply);
      if (!nodes.length) { pushAIMessage('system', 'Adhar AI did not return any markup the canvas can use. Try rephrasing the request.'); return; }
      const root = activeNodes.length === 1 && isContainer(activeNodes[0].type) ? activeNodes[0] : null;
      updateNodes((old) => (root ? old.map((n) => (n.id === root.id ? { ...n, children: [...n.children, ...nodes] } : n)) : [...old, ...nodes]));
      pushAIMessage('assistant', `Added ${nodes.length} section${nodes.length === 1 ? '' : 's'} to ${pageName}. This page contains code the designer keeps as written, so AI adds rather than rewrites. ⌘Z to undo.`);
      return;
    }
    if (isActive) {
      const current = activeNodes.length ? activeNodes.map(nodeToHTML).join('\n') : '';
      const reply = await askAdharAi({
        prompt: `${PAGE_INSTRUCTIONS}\n\nRequest: ${prompt}${current ? `\n\nThe page currently is (revise it rather than starting over unless asked):\n\`\`\`html\n${current}\n\`\`\`` : ''}`,
        context: [{ description: 'Builder page', value: `${activeFilePath} (${s.framework})` }],
      });
      const html = extractFence(reply, ['html']) ?? reply;
      const nodes = htmlToNodes(html);
      if (!nodes.length) {
        pushAIMessage('system', 'Adhar AI did not return any markup the canvas can use. Try rephrasing the request.');
        return;
      }
      setS((p) => {
        const file = findFileInTree(p.files, fileId);
        const old = file?.nodes || [];
        return {
          ...p,
          aiLoading: false,
          files: updateFileInTree(p.files, fileId, (f) => ({ ...f, nodes, variants: undefined, activeVariantId: undefined, lastPrompt: prompt })),
          history: [...p.history.slice(0, p.historyIndex + 1), old],
          historyIndex: p.historyIndex + 1,
          selectedNodeIds: [],
          aiMessages: [...p.aiMessages, { id: genId(), role: 'assistant', content: `Updated ${pageName} — ${nodes.length} top-level section${nodes.length === 1 ? '' : 's'}. ⌘Z to undo.`, timestamp: Date.now() }],
        };
      });
      return;
    }
    if (['workflow', 'api'].includes(activeFile.language || '')) {
      pushAIMessage('system', 'Adhar AI edits pages and source files. Open one of those to use it.');
      return;
    }
    const reply = await askAdharAi({
      prompt: `${CODE_INSTRUCTIONS}\n\nFile: ${activeFilePath}\nRequest: ${prompt}\n\nCurrent content:\n\`\`\`\n${activeFile.content || ''}\n\`\`\``,
    });
    const code = extractFence(reply);
    if (code === null) {
      pushAIMessage('assistant', reply.trim() || 'No change suggested.');
      return;
    }
    updateFileContent(fileId, code);
    const note = reply.replace(/\`\`\`[\s\S]*?\`\`\`/g, '').trim();
    pushAIMessage('assistant', note || `Updated ${activeFile.name}.`);
  }

  async function handleAIGenerate(override?: string) {
    const prompt = (override ?? s.aiPrompt).trim();
    if (!prompt || s.aiLoading) return;
    const userMsg: AIMessage = { id: genId(), role: 'user', content: prompt, timestamp: Date.now() };
    setS((p) => ({ ...p, aiLoading: true, aiMessages: [...p.aiMessages, userMsg], aiPrompt: '' }));

    if (s.aiProvider === 'adhar') {
      try {
        await generateWithAdharAI(prompt);
      } catch (e) {
        pushAIMessage('system', `Adhar AI: ${(e as Error).message}`);
      }
      return;
    }

    try {
      // Multi-page app generation — only when explicitly asking for multi-page scope
      const lower = prompt.toLowerCase();
      const isMultiPageRequest = /\b(app|application|multi-?page|whole app|full app|pages|flow)\b/.test(lower) &&
        (lower.includes('ecommerce') || lower.includes('e-commerce') || lower.includes('saas') || lower.includes('social') || lower.includes('blog') || lower.includes('dashboard app'));

      if (isMultiPageRequest) {
        const appPages = generateAppTemplate(prompt);
        const pagesFolder = findFileInTree(s.files, 'f_pages');
        const folderId = pagesFolder ? 'f_pages' : 'f_src';

        setS((p) => {
          let files = p.files;
          const createdIds: string[] = [];
          for (const page of appPages) {
            const fid = `f_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
            const newFile: ProjectFile = { id: fid, name: `${page.name}.tsx`, type: 'file', language: 'tsx', nodes: page.nodes };
            files = addFileToFolder(files, folderId, newFile);
            createdIds.push(fid);
          }
          const openIds = [...p.openFileIds, ...createdIds];
          const assistantMsg: AIMessage = { id: genId(), role: 'assistant', content: `Created ${appPages.length} pages: ${appPages.map((p) => p.name).join(', ')}`, timestamp: Date.now() };
          return { ...p, files, openFileIds: openIds, activeFileId: createdIds[0] || p.activeFileId, aiLoading: false, aiMessages: [...p.aiMessages, assistantMsg], selectedNodeIds: [], history: [], historyIndex: -1 };
        });
        return;
      }

      if (!isActive) {
        const errMsg: AIMessage = { id: genId(), role: 'system', content: 'Open a page file first to generate UI components.', timestamp: Date.now() };
        setS((p) => ({ ...p, aiLoading: false, aiMessages: [...p.aiMessages, errMsg] }));
        return;
      }

      // If canvas is empty → generate 3 fresh variants
      if (activeNodes.length === 0) {
        generateDesignVariants(prompt);
        return;
      }

      // Otherwise: treat as a refinement on the current active variant
      const op = parseRefinePrompt(prompt);
      if (containsCode(activeNodes) && op.kind !== 'append-section') {
        pushAIMessage('system', 'This page contains code the designer keeps as written, so templates can only add sections here (e.g. "add a pricing section"). Adhar AI can generate new sections too.');
        return;
      }
      const refined = applyRefine(activeNodes, op, (activeFile?.lastPrompt || '') + ' ' + prompt);

      setS((p) => {
        // Update both the file.nodes AND the active variant's nodes (so switching doesn't lose the edit)
        const files = updateFileInTree(p.files, p.activeFileId!, (f) => {
          const variants = (f.variants || []).map((v) => v.id === f.activeVariantId ? { ...v, nodes: refined } : v);
          return { ...f, nodes: refined, variants };
        });
        const opLabel = describeRefineOp(op);
        return {
          ...p,
          files,
          aiLoading: false,
          selectedNodeIds: [],
          history: [...p.history.slice(0, p.historyIndex + 1), activeNodes],
          historyIndex: p.historyIndex + 1,
          aiMessages: [...p.aiMessages, {
            id: genId(),
            role: 'assistant',
            content: opLabel,
            timestamp: Date.now(),
          }],
        };
      });
    } catch (e) {
      const errMsg: AIMessage = { id: genId(), role: 'system', content: `Error: ${(e as Error).message}`, timestamp: Date.now() };
      setS((p) => ({ ...p, aiLoading: false, aiMessages: [...p.aiMessages, errMsg] }));
    }
  }

  function describeRefineOp(op: ReturnType<typeof parseRefinePrompt>): string {
    switch (op.kind) {
      case 'append-section': return `Added ${op.cat} section to the design.`;
      case 'remove-section': return `Removed ${op.match} from the design.`;
      case 'restyle': return `Restyled the design as ${op.style}.`;
      case 'change-heading': return `Updated headline to "${op.text}".`;
      case 'change-brand': return `Updated brand name to "${op.text}".`;
      case 'replace-text': return `Replaced "${op.from}" with "${op.to}".`;
      case 'regenerate': return `Regenerated the full design.`;
      case 'unknown':
      default: return `Applied change to the design.`;
    }
  }

  // ─── Full App Template Generator ───────────────────────────────
  function generateAppTemplate(prompt: string): { name: string; nodes: CanvasNode[] }[] {
    const lower = prompt.toLowerCase();
    const id = genId;

    if (lower.includes('ecommerce') || lower.includes('e-commerce') || lower.includes('shop') || lower.includes('store')) {
      return [
        { name: 'Home', nodes: [
          { id: id(), type: 'nav', props: { className: 'flex items-center justify-between px-6 py-4 border-b border-border' }, children: [
            { id: id(), type: 'span', props: { className: 'text-xl font-bold', children: 'ShopApp' }, children: [], style: {} },
            { id: id(), type: 'flex', props: { className: 'flex items-center gap-4' }, children: [
              { id: id(), type: 'span', props: { className: 'text-sm text-muted-foreground', children: 'Products' }, children: [], style: {} },
              { id: id(), type: 'span', props: { className: 'text-sm text-muted-foreground', children: 'Categories' }, children: [], style: {} },
              { id: id(), type: 'button', props: { className: 'px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm', children: 'Cart (0)' }, children: [], style: {} },
            ], style: {} },
          ], style: {} },
          { id: id(), type: 'section', props: { className: 'py-16 px-6 text-center bg-muted/30' }, children: [
            { id: id(), type: 'h1', props: { className: 'text-4xl font-bold mb-4', children: 'Summer Collection 2024' }, children: [], style: {} },
            { id: id(), type: 'p', props: { className: 'text-lg text-muted-foreground mb-6', children: 'Discover our latest arrivals with up to 40% off.' }, children: [], style: {} },
            { id: id(), type: 'button', props: { className: 'px-8 py-3 bg-primary text-primary-foreground rounded-lg font-semibold', children: 'Shop Now' }, children: [], style: {} },
          ], style: {} },
          { id: id(), type: 'grid', props: { className: 'grid grid-cols-4 gap-6 px-6 py-8' }, children: [1,2,3,4].map((i) => (
            { id: id(), type: 'card', props: { className: 'rounded-xl border border-border overflow-hidden' }, children: [
              { id: id(), type: 'img-placeholder', props: { className: 'aspect-square w-full bg-muted flex items-center justify-center text-2xl text-muted-foreground/30', children: '🛍' }, children: [], style: {} },
              { id: id(), type: 'div', props: { className: 'p-4' }, children: [
                { id: id(), type: 'h3', props: { className: 'font-medium', children: `Product ${i}` }, children: [], style: {} },
                { id: id(), type: 'p', props: { className: 'text-sm text-muted-foreground', children: `$${29 + i * 10}.99` }, children: [], style: {} },
              ], style: {} },
            ], style: {} }
          )), style: {} },
        ] },
        { name: 'ProductDetail', nodes: [
          { id: id(), type: 'flex', props: { className: 'flex gap-8 px-6 py-8' }, children: [
            { id: id(), type: 'img-placeholder', props: { className: 'w-1/2 aspect-square rounded-xl bg-muted flex items-center justify-center text-4xl text-muted-foreground/20', children: '🖼' }, children: [], style: {} },
            { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-4 flex-1' }, children: [
              { id: id(), type: 'h1', props: { className: 'text-3xl font-bold', children: 'Premium Product' }, children: [], style: {} },
              { id: id(), type: 'h2', props: { className: 'text-2xl font-semibold text-primary', children: '$49.99' }, children: [], style: {} },
              { id: id(), type: 'p', props: { className: 'text-muted-foreground leading-relaxed', children: 'High-quality product with premium materials and craftsmanship. Perfect for everyday use.' }, children: [], style: {} },
              { id: id(), type: 'button', props: { className: 'w-full py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-lg', children: 'Add to Cart' }, children: [], style: {} },
            ], style: {} },
          ], style: {} },
        ] },
        { name: 'Cart', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-6 px-6 py-8 max-w-2xl mx-auto' }, children: [
            { id: id(), type: 'h1', props: { className: 'text-2xl font-bold', children: 'Shopping Cart' }, children: [], style: {} },
            ...[1,2].map((i) => ({ id: id(), type: 'flex', props: { className: 'flex items-center gap-4 p-4 border border-border rounded-lg' }, children: [
              { id: id(), type: 'div', props: { className: 'w-16 h-16 bg-muted rounded-lg' }, children: [], style: {} },
              { id: id(), type: 'flex-col', props: { className: 'flex flex-col flex-1' }, children: [
                { id: id(), type: 'span', props: { className: 'font-medium', children: `Item ${i}` }, children: [], style: {} },
                { id: id(), type: 'span', props: { className: 'text-sm text-muted-foreground', children: `$${29 + i * 10}.99` }, children: [], style: {} },
              ], style: {} },
              { id: id(), type: 'button', props: { className: 'px-3 py-1 border border-border rounded text-sm', children: 'Remove' }, children: [], style: {} },
            ], style: {} })),
            { id: id(), type: 'div', props: { className: 'border-t border-border pt-4 flex justify-between items-center' }, children: [
              { id: id(), type: 'span', props: { className: 'text-lg font-bold', children: 'Total: $89.98' }, children: [], style: {} },
              { id: id(), type: 'button', props: { className: 'px-6 py-3 bg-primary text-primary-foreground rounded-lg font-semibold', children: 'Checkout' }, children: [], style: {} },
            ], style: {} },
          ], style: {} },
        ] },
      ];
    }

    if (lower.includes('saas') || lower.includes('dashboard') || lower.includes('admin')) {
      return [
        { name: 'Dashboard', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-6' }, children: [
            { id: id(), type: 'flex', props: { className: 'flex items-center justify-between' }, children: [
              { id: id(), type: 'h1', props: { className: 'text-2xl font-bold', children: 'Dashboard' }, children: [], style: {} },
              { id: id(), type: 'button', props: { className: 'px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm', children: '+ New Project' }, children: [], style: {} },
            ], style: {} },
            { id: id(), type: 'grid', props: { className: 'grid grid-cols-4 gap-4' }, children: [
              { l: 'Total Revenue', v: '$45,231', c: '+20.1%' }, { l: 'Active Users', v: '2,350', c: '+15%' },
              { l: 'Conversion', v: '3.2%', c: '+0.4%' }, { l: 'Avg. Order', v: '$58', c: '+12%' },
            ].map((st: any) => (
              { id: id(), type: 'card', props: { className: 'p-5 rounded-xl border border-border' }, children: [
                { id: id(), type: 'p', props: { className: 'text-sm text-muted-foreground', children: st.l }, children: [], style: {} },
                { id: id(), type: 'h3', props: { className: 'text-2xl font-bold mt-1', children: st.v }, children: [], style: {} },
                { id: id(), type: 'span', props: { className: 'text-xs text-green-500', children: st.c }, children: [], style: {} },
              ], style: {} }
            )), style: {} },
          ], style: {} },
        ] },
        { name: 'Settings', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-6 max-w-2xl' }, children: [
            { id: id(), type: 'h1', props: { className: 'text-2xl font-bold', children: 'Settings' }, children: [], style: {} },
            ...[{ label: 'Profile', fields: ['Full Name', 'Email', 'Company'] }, { label: 'Notifications', fields: ['Email alerts', 'Push notifications', 'Weekly digest'] }].map((section) => (
              { id: id(), type: 'card', props: { className: 'p-6 rounded-xl border border-border' }, children: [
                { id: id(), type: 'h2', props: { className: 'text-lg font-semibold mb-4', children: section.label }, children: [], style: {} },
                ...section.fields.map((f) => ({ id: id(), type: 'flex', props: { className: 'flex items-center justify-between py-3 border-b border-border last:border-0' }, children: [
                  { id: id(), type: 'span', props: { className: 'text-sm', children: f }, children: [], style: {} },
                  { id: id(), type: 'input', props: { className: 'w-48 px-3 py-1.5 rounded-md border border-input text-sm', placeholder: f }, children: [], style: {} },
                ], style: {} })),
              ], style: {} }
            )),
            { id: id(), type: 'button', props: { className: 'w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-semibold', children: 'Save Changes' }, children: [], style: {} },
          ], style: {} },
        ] },
        { name: 'Users', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-4' }, children: [
            { id: id(), type: 'flex', props: { className: 'flex items-center justify-between' }, children: [
              { id: id(), type: 'h1', props: { className: 'text-2xl font-bold', children: 'Users' }, children: [], style: {} },
              { id: id(), type: 'input', props: { className: 'w-64 px-3 py-2 rounded-lg border border-input text-sm', placeholder: 'Search users...' }, children: [], style: {} },
            ], style: {} },
            { id: id(), type: 'card', props: { className: 'rounded-xl border border-border overflow-hidden' }, children: [
              ...[{ n: 'Alice Johnson', e: 'alice@example.com', r: 'Admin' }, { n: 'Bob Smith', e: 'bob@example.com', r: 'Editor' }, { n: 'Carol White', e: 'carol@example.com', r: 'Viewer' }].map((u) => (
                { id: id(), type: 'flex', props: { className: 'flex items-center gap-4 px-4 py-3 border-b border-border last:border-0' }, children: [
                  { id: id(), type: 'avatar', props: { className: 'w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold', children: u.n.charAt(0) }, children: [], style: {} },
                  { id: id(), type: 'flex-col', props: { className: 'flex flex-col flex-1' }, children: [
                    { id: id(), type: 'span', props: { className: 'text-sm font-medium', children: u.n }, children: [], style: {} },
                    { id: id(), type: 'span', props: { className: 'text-xs text-muted-foreground', children: u.e }, children: [], style: {} },
                  ], style: {} },
                  { id: id(), type: 'badge', props: { className: 'px-2 py-0.5 rounded-full bg-muted text-xs font-medium', children: u.r }, children: [], style: {} },
                ], style: {} }
              )),
            ], style: {} },
          ], style: {} },
        ] },
      ];
    }

    if (lower.includes('social') || lower.includes('feed') || lower.includes('community')) {
      return [
        { name: 'Feed', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-4 max-w-xl mx-auto' }, children: [
            { id: id(), type: 'h1', props: { className: 'text-xl font-bold', children: 'Feed' }, children: [], style: {} },
            ...[1,2,3].map((i) => (
              { id: id(), type: 'card', props: { className: 'p-4 rounded-xl border border-border' }, children: [
                { id: id(), type: 'flex', props: { className: 'flex items-center gap-3 mb-3' }, children: [
                  { id: id(), type: 'div', props: { className: 'w-8 h-8 rounded-full bg-primary/10' }, children: [], style: {} },
                  { id: id(), type: 'span', props: { className: 'text-sm font-medium', children: `User ${i}` }, children: [], style: {} },
                  { id: id(), type: 'span', props: { className: 'text-xs text-muted-foreground ml-auto', children: `${i}h ago` }, children: [], style: {} },
                ], style: {} },
                { id: id(), type: 'p', props: { className: 'text-sm mb-3', children: 'This is a sample post content. Lorem ipsum dolor sit amet.' }, children: [], style: {} },
                { id: id(), type: 'flex', props: { className: 'flex items-center gap-4 text-sm text-muted-foreground' }, children: [
                  { id: id(), type: 'span', props: { className: 'cursor-pointer hover:text-foreground', children: '❤ Like' }, children: [], style: {} },
                  { id: id(), type: 'span', props: { className: 'cursor-pointer hover:text-foreground', children: '💬 Comment' }, children: [], style: {} },
                  { id: id(), type: 'span', props: { className: 'cursor-pointer hover:text-foreground', children: '↗ Share' }, children: [], style: {} },
                ], style: {} },
              ], style: {} }
            )),
          ], style: {} },
        ] },
        { name: 'Profile', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col items-center gap-4 py-8' }, children: [
            { id: id(), type: 'div', props: { className: 'w-24 h-24 rounded-full bg-primary/10' }, children: [], style: {} },
            { id: id(), type: 'h1', props: { className: 'text-xl font-bold', children: 'John Doe' }, children: [], style: {} },
            { id: id(), type: 'p', props: { className: 'text-sm text-muted-foreground', children: 'Full-stack developer · San Francisco' }, children: [], style: {} },
            { id: id(), type: 'flex', props: { className: 'flex gap-8 text-center' }, children: [
              { id: id(), type: 'flex-col', props: { className: 'flex flex-col' }, children: [
                { id: id(), type: 'span', props: { className: 'text-lg font-bold', children: '128' }, children: [], style: {} },
                { id: id(), type: 'span', props: { className: 'text-xs text-muted-foreground', children: 'Posts' }, children: [], style: {} },
              ], style: {} },
              { id: id(), type: 'flex-col', props: { className: 'flex flex-col' }, children: [
                { id: id(), type: 'span', props: { className: 'text-lg font-bold', children: '1.2K' }, children: [], style: {} },
                { id: id(), type: 'span', props: { className: 'text-xs text-muted-foreground', children: 'Followers' }, children: [], style: {} },
              ], style: {} },
              { id: id(), type: 'flex-col', props: { className: 'flex flex-col' }, children: [
                { id: id(), type: 'span', props: { className: 'text-lg font-bold', children: '342' }, children: [], style: {} },
                { id: id(), type: 'span', props: { className: 'text-xs text-muted-foreground', children: 'Following' }, children: [], style: {} },
              ], style: {} },
            ], style: {} },
            { id: id(), type: 'button', props: { className: 'px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium', children: 'Edit Profile' }, children: [], style: {} },
          ], style: {} },
        ] },
      ];
    }

    if (lower.includes('blog') || lower.includes('content') || lower.includes('cms')) {
      return [
        { name: 'BlogHome', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-6' }, children: [
            { id: id(), type: 'h1', props: { className: 'text-3xl font-bold', children: 'Blog' }, children: [], style: {} },
            { id: id(), type: 'grid', props: { className: 'grid grid-cols-3 gap-6' }, children: [1,2,3].map((i) => (
              { id: id(), type: 'card', props: { className: 'rounded-xl border border-border overflow-hidden' }, children: [
                { id: id(), type: 'div', props: { className: 'aspect-video bg-muted' }, children: [], style: {} },
                { id: id(), type: 'div', props: { className: 'p-4' }, children: [
                  { id: id(), type: 'badge', props: { className: 'px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-2 inline-block', children: 'Tutorial' }, children: [], style: {} },
                  { id: id(), type: 'h3', props: { className: 'font-semibold mb-1', children: `Blog Post ${i}` }, children: [], style: {} },
                  { id: id(), type: 'p', props: { className: 'text-sm text-muted-foreground', children: 'A brief description of this blog post.' }, children: [], style: {} },
                ], style: {} },
              ], style: {} }
            )), style: {} },
          ], style: {} },
        ] },
        { name: 'BlogPost', nodes: [
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-4 max-w-3xl mx-auto py-8' }, children: [
            { id: id(), type: 'h1', props: { className: 'text-3xl font-bold', children: 'How to Build Modern Web Apps' }, children: [], style: {} },
            { id: id(), type: 'flex', props: { className: 'flex items-center gap-3 text-sm text-muted-foreground' }, children: [
              { id: id(), type: 'div', props: { className: 'w-6 h-6 rounded-full bg-primary/10' }, children: [], style: {} },
              { id: id(), type: 'span', props: { children: 'Author Name' }, children: [], style: {} },
              { id: id(), type: 'span', props: { children: '·' }, children: [], style: {} },
              { id: id(), type: 'span', props: { children: 'Dec 15, 2024' }, children: [], style: {} },
            ], style: {} },
            { id: id(), type: 'p', props: { className: 'text-muted-foreground leading-relaxed', children: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.' }, children: [], style: {} },
            { id: id(), type: 'p', props: { className: 'text-muted-foreground leading-relaxed', children: 'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.' }, children: [], style: {} },
          ], style: {} },
        ] },
      ];
    }

    // Default: landing page app
    return [
      { name: 'Landing', nodes: generateLocalTemplate('hero landing') },
      { name: 'Features', nodes: generateLocalTemplate('pricing cards') },
      { name: 'Contact', nodes: generateLocalTemplate('login form') },
    ];
  }

  function dismissAIMessage(messageId: string) { setS((p) => ({ ...p, aiMessages: p.aiMessages.filter((m) => m.id !== messageId) })); }

  function generateLocalTemplate(prompt: string): CanvasNode[] {
    const lower = prompt.toLowerCase();
    const id = genId;
    if (lower.includes('hero') || lower.includes('landing')) {
      return [{ id: id(), type: 'section', props: { className: 'flex flex-col items-center justify-center py-20 text-center gap-6' }, children: [
        { id: id(), type: 'h1', props: { className: 'text-5xl font-bold tracking-tight', children: 'Build something amazing' }, children: [], style: {} },
        { id: id(), type: 'p', props: { className: 'text-xl text-muted-foreground max-w-2xl', children: 'A modern solution for building beautiful user interfaces.' }, children: [], style: {} },
        { id: id(), type: 'flex', props: { className: 'flex gap-4' }, children: [
          { id: id(), type: 'button', props: { className: 'px-6 py-3 bg-primary text-primary-foreground rounded-lg font-semibold', children: 'Get Started' }, children: [], style: {} },
          { id: id(), type: 'button', props: { className: 'px-6 py-3 border border-border rounded-lg font-semibold', children: 'Learn More' }, children: [], style: {} },
        ], style: {} },
      ], style: {} }];
    }
    if (lower.includes('card') || lower.includes('pricing')) {
      return [{ id: id(), type: 'grid', props: { className: 'grid grid-cols-3 gap-6' }, children: [1, 2, 3].map((i) => (
        { id: id(), type: 'card', props: { className: 'p-6 rounded-xl border border-border bg-card flex flex-col gap-4' }, children: [
          { id: id(), type: 'h3', props: { className: 'text-lg font-semibold', children: ['Starter', 'Pro', 'Enterprise'][i - 1] }, children: [], style: {} },
          { id: id(), type: 'h2', props: { className: 'text-3xl font-bold', children: ['$9/mo', '$29/mo', '$99/mo'][i - 1] }, children: [], style: {} },
          { id: id(), type: 'button', props: { className: `w-full py-2 rounded-lg font-medium ${i === 2 ? 'bg-primary text-primary-foreground' : 'border border-border'}`, children: 'Choose Plan' }, children: [], style: {} },
        ], style: {} }
      )), style: {} }];
    }
    if (lower.includes('form') || lower.includes('login')) {
      return [{ id: id(), type: 'card', props: { className: 'max-w-md mx-auto p-8 rounded-xl border border-border bg-card flex flex-col gap-5' }, children: [
        { id: id(), type: 'h2', props: { className: 'text-2xl font-bold text-center', children: 'Sign In' }, children: [], style: {} },
        { id: id(), type: 'input', props: { className: 'w-full px-4 py-2.5 rounded-lg border border-input bg-background text-sm', placeholder: 'Email address' }, children: [], style: {} },
        { id: id(), type: 'input', props: { className: 'w-full px-4 py-2.5 rounded-lg border border-input bg-background text-sm', placeholder: 'Password' }, children: [], style: {} },
        { id: id(), type: 'button', props: { className: 'w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-semibold', children: 'Sign In' }, children: [], style: {} },
      ], style: {} }];
    }
    if (lower.includes('nav') || lower.includes('header')) {
      return [{ id: id(), type: 'nav', props: { className: 'flex items-center justify-between px-6 py-4 border-b border-border' }, children: [
        { id: id(), type: 'span', props: { className: 'text-xl font-bold', children: 'Acme Inc' }, children: [], style: {} },
        { id: id(), type: 'flex', props: { className: 'flex items-center gap-6' }, children: [
          { id: id(), type: 'span', props: { className: 'text-sm text-muted-foreground cursor-pointer', children: 'Products' }, children: [], style: {} },
          { id: id(), type: 'span', props: { className: 'text-sm text-muted-foreground cursor-pointer', children: 'Pricing' }, children: [], style: {} },
          { id: id(), type: 'button', props: { className: 'px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium', children: 'Sign In' }, children: [], style: {} },
        ], style: {} },
      ], style: {} }];
    }
    if (lower.includes('dashboard') || lower.includes('stats')) {
      return [{ id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-6' }, children: [
        { id: id(), type: 'h2', props: { className: 'text-2xl font-bold', children: 'Dashboard' }, children: [], style: {} },
        { id: id(), type: 'grid', props: { className: 'grid grid-cols-4 gap-4' }, children: [
          { l: 'Revenue', v: '$45,231', c: '+20.1%' }, { l: 'Users', v: '+2,350', c: '+180%' },
          { l: 'Sales', v: '+12,234', c: '+19%' }, { l: 'Active', v: '+573', c: '+201' },
        ].map((st: any) => (
          { id: id(), type: 'card', props: { className: 'p-6 rounded-xl border border-border bg-card' }, children: [
            { id: id(), type: 'p', props: { className: 'text-sm text-muted-foreground font-medium', children: st.l }, children: [], style: {} },
            { id: id(), type: 'h3', props: { className: 'text-2xl font-bold mt-1', children: st.v }, children: [], style: {} },
            { id: id(), type: 'p', props: { className: 'text-xs text-green-500 mt-1', children: `${st.c} from last month` }, children: [], style: {} },
          ], style: {} }
        )), style: {} },
      ], style: {} }];
    }
    if (lower.includes('footer')) {
      return [{ id: id(), type: 'footer', props: { className: 'border-t border-border px-6 py-12' }, children: [
        { id: id(), type: 'grid', props: { className: 'grid grid-cols-4 gap-8' }, children: ['Product', 'Company', 'Resources', 'Legal'].map((title) => (
          { id: id(), type: 'flex-col', props: { className: 'flex flex-col gap-3' }, children: [
            { id: id(), type: 'h4', props: { className: 'text-sm font-semibold', children: title }, children: [], style: {} },
            ...['Link 1', 'Link 2', 'Link 3'].map((link) => ({ id: id(), type: 'span', props: { className: 'text-sm text-muted-foreground cursor-pointer', children: link }, children: [], style: {} })),
          ], style: {} }
        )), style: {} },
      ], style: {} }];
    }
    return [{ id: id(), type: 'section', props: { className: 'p-8 rounded-xl border border-border bg-card' }, children: [
      { id: id(), type: 'h2', props: { className: 'text-xl font-semibold mb-2', children: 'New Section' }, children: [], style: {} },
      { id: id(), type: 'p', props: { className: 'text-muted-foreground', children: prompt }, children: [], style: {} },
    ], style: {} }];
  }

  // ─── Keyboard shortcuts ────────────────────────────────────────
  // Only while focus is inside the builder (or on the page body): the console
  // owns its own shortcuts — ⌘K is Adhar AI, ⌘W closes the browser tab — so the
  // builder neither claims those nor fires while someone types in the topbar.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const target = e.target as Node | null;
      const inside = !!target && (target === document.body || !!rootRef.current?.contains(target));
      if (!inside) return;
      const m = e.metaKey || e.ctrlKey;
      const el = e.target as HTMLElement | null;
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || !!el?.isContentEditable || !!el?.closest?.('.monaco-editor');
      if (m && e.key === 's') { e.preventDefault(); onSave(); return; }
      if (isInput) { if (e.key === 'Escape') setS((p) => ({ ...p, openMenu: null })); return; }
      if (m && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if (m && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      if (m && e.key === 'c') { e.preventDefault(); copyNode(); }
      if (m && e.key === 'v') { e.preventDefault(); pasteNode(); }
      if (m && e.key === 'd') { e.preventDefault(); duplicateNode(); }
      // ⌥↑ / ⌥↓ move the selection among its siblings.
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && s.selectedNodeIds.length === 1) { e.preventDefault(); if (e.key === 'ArrowUp') moveUp(s.selectedNodeIds[0]); else moveDown(s.selectedNodeIds[0]); }
      if (m && e.key === 'e') { e.preventDefault(); setS((p) => ({ ...p, leftPanel: p.leftPanel === 'pages' ? 'components' : 'pages' })); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedNodeIds.length > 0) { e.preventDefault(); s.selectedNodeIds.forEach(deleteNode); }
      if (e.key === 'Escape') setS((p) => ({ ...p, selectedNodeIds: [], openMenu: null, renamingFileId: null }));
    };
    globalThis.addEventListener('keydown', h);
    return () => globalThis.removeEventListener('keydown', h);
  });

  // ─── Code generation ───────────────────────────────────────────
  // Repo pages show the exact file they'd be saved as.
  const repoCode = isActive && previewCode && activeFile && s.viewMode === 'code'
    ? previewCode(activeFile.id, { version: 1, name: project.name, source: project.source, files: s.files, settings: { framework: s.framework, theme: s.theme, darkMode: s.darkMode, customTokenOverrides: s.customTokenOverrides } })
    : null;
  const fullCode = repoCode ?? (isActive ? generateCode(activeNodes, pageName, s.framework) : (activeFile?.content || ''));

  // ─── Menu definitions ──────────────────────────────────────────
  const menus = [
    { id: 'file', label: 'File', items: [
      { label: 'New Page...', shortcut: '⌘N', action: async () => { const n = await showPrompt('New Page', { placeholder: 'Page name' }); if (n) { const pf = findFileInTree(s.files, 'f_pages'); createFile(pf ? 'f_pages' : 'f_src', `${n.replace(/\s+/g, '')}.tsx`, true); } } },
      { label: 'New File...', action: async () => { const n = await showPrompt('New File', { placeholder: 'File name (e.g. utils.ts)' }); if (n) createFile('f_src', n, false); } },
      { label: 'New Folder...', action: async () => { const n = await showPrompt('New Folder', { placeholder: 'Folder name' }); if (n) createFolder('f_src', n); } },
      { label: 'New Diagram...', action: async () => { const n = await showPrompt('New Diagram', { placeholder: 'Diagram name (e.g. architecture)' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.mmd`, false); } },
      { label: 'separator' },
      { label: 'Clear Canvas', action: clearCanvas, disabled: !isActive },
      { label: 'separator' },
      { label: 'Save', shortcut: '⌘S', action: onSave },
      { label: 'separator' },
      ...(isActive ? [
        { label: 'Export prototype (HTML)', action: () => downloadFile(buildPreviewDoc(), `${(project.name || pageName).replace(/[^A-Za-z0-9_-]+/g, '-')}-prototype.html`, 'text/html') },
        { label: 'Export as JSON', action: () => downloadFile(JSON.stringify(activeNodes, null, 2), `${pageName}.json`, 'application/json') },
      ] : []),
      { label: 'separator' },
    ]},
    { id: 'edit', label: 'Edit', items: [
      { label: 'Undo', shortcut: '⌘Z', action: undo, disabled: s.historyIndex < 0 },
      { label: 'Redo', shortcut: '⌘⇧Z', action: redo, disabled: s.historyIndex >= s.history.length - 1 },
      { label: 'separator' },
      { label: 'Copy', shortcut: '⌘C', action: copyNode, disabled: s.selectedNodeIds.length === 0 },
      { label: 'Paste', shortcut: '⌘V', action: pasteNode, disabled: !s.clipboard },
      { label: 'Duplicate', shortcut: '⌘D', action: duplicateNode, disabled: s.selectedNodeIds.length === 0 },
      { label: 'separator' },
      { label: 'Delete', shortcut: '⌫', action: () => s.selectedNodeIds.forEach(deleteNode), disabled: s.selectedNodeIds.length === 0 },
    ]},
    { id: 'view', label: 'View', items: [
      { label: 'Design', shortcut: '⌘1', action: () => setS((p) => ({ ...p, viewMode: 'design' })), active: s.viewMode === 'design' },
      { label: 'Code', shortcut: '⌘2', action: () => setS((p) => ({ ...p, viewMode: 'code' })), active: s.viewMode === 'code' },
      { label: 'Preview', shortcut: '⌘3', action: () => setS((p) => ({ ...p, viewMode: 'preview' })), active: s.viewMode === 'preview' },
      { label: 'separator' },
      { label: 'Zoom In', shortcut: '⌘+', action: () => setS((p) => ({ ...p, zoom: Math.min(200, p.zoom + 10) })) },
      { label: 'Zoom Out', shortcut: '⌘−', action: () => setS((p) => ({ ...p, zoom: Math.max(25, p.zoom - 10) })) },
      { label: 'Reset Zoom', shortcut: '⌘0', action: () => setS((p) => ({ ...p, zoom: 100 })) },
      { label: 'separator' },
      { label: 'Canvas: White', action: () => setS((p) => ({ ...p, canvasBg: 'white' })), active: s.canvasBg === 'white' },
      { label: 'Canvas: Dots', action: () => setS((p) => ({ ...p, canvasBg: 'dots' })), active: s.canvasBg === 'dots' },
      { label: 'Canvas: Dark', action: () => setS((p) => ({ ...p, canvasBg: 'dark' })), active: s.canvasBg === 'dark' },
      { label: 'separator' },
      { label: s.showRuler ? '✓ Show Rulers' : '  Show Rulers', action: () => setS((p) => ({ ...p, showRuler: !p.showRuler })) },
      { label: s.canvasMode === 'layout' ? '✓ Structured Mode' : '  Structured Mode', action: () => setS((p) => ({ ...p, canvasMode: 'layout' })) },
      { label: s.canvasMode === 'freeform' ? '✓ Freeform Mode' : '  Freeform Mode', action: () => setS((p) => ({ ...p, canvasMode: 'freeform' })) },
    ]},
    { id: 'insert', label: 'Insert', items: [
      { label: 'Container', action: () => addNode('div'), disabled: !isActive },
      { label: 'Flex Row', action: () => addNode('flex'), disabled: !isActive },
      { label: 'Flex Column', action: () => addNode('flex-col'), disabled: !isActive },
      { label: 'Grid', action: () => addNode('grid'), disabled: !isActive },
      { label: 'separator' },
      { label: 'Heading', action: () => addNode('h2'), disabled: !isActive },
      { label: 'Paragraph', action: () => addNode('p'), disabled: !isActive },
      { label: 'Button', action: () => addNode('button'), disabled: !isActive },
      { label: 'Input', action: () => addNode('input'), disabled: !isActive },
      { label: 'separator' },
      { label: 'Form', action: () => addNode('form'), disabled: !isActive },
      { label: 'Table', action: () => addNode('data-table'), disabled: !isActive },
      { label: 'Modal', action: () => addNode('modal'), disabled: !isActive },
      { label: 'separator' },
      { label: 'New page…', action: () => void addPage() },
      { label: 'New data source…', action: () => void addDataSource() },
    ]},
    { id: 'go', label: 'Go', items: [
      ...pageFiles.map((pf) => ({ label: `${pf.id === s.activeFileId ? '● ' : '  '}${pf.name.replace(/\.\w+$/, '')}`, action: () => openFile(pf.id) })),
      { label: 'separator' },
      { label: 'Pages', action: () => setS((p) => ({ ...p, leftPanel: 'pages' })) },
      { label: 'Data', action: () => setS((p) => ({ ...p, leftPanel: 'data' })) },
    ]},
    { id: 'help', label: 'Help', items: [
      { label: 'Keyboard Shortcuts', action: () => { setS((p) => ({ ...p, rightPanel: 'settings' })); setRightCollapsed(false); } },
      { label: 'separator' },
      { label: 'About Visual Designer', action: () => showAlert('Adhar Visual Designer', 'Edit the pages of your React apps visually. Code the designer does not understand is kept exactly as written.\nChanges are saved back as a reviewed commit or pull request.') },
    ]},
  ];

  // ─── Palette ───────────────────────────────────────────────────
  // App building blocks; the freeform canvas adds its diagramming shapes.
  const freeformCats = s.canvasMode === 'freeform'
    ? Palette.searchPalette(Palette.getFullPalette().filter((c) => ['screens', 'architecture', 'shapes'].includes(c.id)), s.paletteSearch)
    : [];
  const palette = [...searchBlueprints(BLUEPRINTS, s.paletteSearch), ...freeformCats];
  const symbols = listSymbols(s.files).filter((f) => !s.paletteSearch.trim() || f.name.toLowerCase().includes(s.paletteSearch.trim().toLowerCase()));

  // ─── Layout state ──────────────────────────────────────────────
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const leftW = leftCollapsed ? 0 : s.leftPanel === 'files' ? 260 : 220;
  const rightW = rightCollapsed ? 0 : s.rightPanel === 'ai' ? 340 : 272;

  // Activity bar icons for left panel
  const activityItems: { id: typeof s.leftPanel; icon: React.ReactNode; label: string }[] = [
    { id: 'pages', label: 'Pages & components', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' /><path d='M14 3v6h6M8 13h8M8 17h5' /></svg> },
    { id: 'components', label: 'Components', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><rect x='3' y='3' width='7' height='7' rx='1' /><rect x='14' y='3' width='7' height='7' rx='1' /><rect x='3' y='14' width='7' height='7' rx='1' /><rect x='14' y='14' width='7' height='7' rx='1' /></svg> },
    { id: 'files', label: 'Explorer', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' /></svg> },
    // APIs: plug/connection icon
    { id: 'apis', label: 'APIs & Data', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M4 11a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM14 7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1zM14 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1zM10 13h4M10 13V9M14 9h-4' /></svg> },
    { id: 'data', label: 'Data sources', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><ellipse cx='12' cy='5' rx='8' ry='3' /><path d='M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' /></svg> },
    // Workflows: git-branch icon
    { id: 'workflows', label: 'Workflows', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><circle cx='18' cy='18' r='3' /><circle cx='6' cy='6' r='3' /><path d='M6 21V9a9 9 0 0 0 9 9' /></svg> },
  ];

  // Right panel icons
  const rightItems: { id: typeof s.rightPanel; icon: React.ReactNode; label: string; bottom?: boolean }[] = [
    { id: 'outline', label: 'Layers', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' /></svg> },
    // Properties: sliders icon
    { id: 'properties', label: 'Properties', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6' /></svg> },
    { id: 'theme', label: 'Theme', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z' /></svg> },
    // AI: sparkles icon
    { id: 'ai', label: 'AI Assistant', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .963L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4' /></svg> },
    // Settings: gear icon
    { id: 'settings', label: 'Settings', icon: <svg className='w-[18px] h-[18px]' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' /><circle cx='12' cy='12' r='3' /></svg> },
  ];

  // ─── Icon helper ───────────────────────────────────────────────
  const Ic = ({ d, s: sz = 18 }: { d: string; s?: number }) => (
    <svg width={sz} height={sz} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5} strokeLinecap='round' strokeLinejoin='round'><path d={d} /></svg>
  );

  // ─── Render ────────────────────────────────────────────────────
  return (
    <DialogProvider>
    <StudioFilesContext.Provider value={s.files}>
    <div ref={rootRef} className='h-full flex flex-col bg-background text-foreground overflow-hidden select-none'>
      {/* ═══ Top Menu Bar ═══ */}
      <Toolbar
        viewMode={s.viewMode} zoom={s.zoom} devicePreview={s.devicePreview}
        isActivePage={isActive} activeFilePath={activeFilePath}
        elementCount={activeNodes.length} fileLanguage={activeFile?.language}
        canUndo={s.historyIndex >= 0} canRedo={s.historyIndex < s.history.length - 1}
        hasSelection={s.selectedNodeIds.length > 0} hasClipboard={!!s.clipboard}
        openMenu={s.openMenu} menus={menus} canvasBg={s.canvasBg} canvasMode={s.canvasMode}
        onCanvasMode={(m) => setS((p) => ({ ...p, canvasMode: m }))}
        onUndo={undo} onRedo={redo}
        onCopy={copyNode} onPaste={pasteNode} onDuplicate={duplicateNode}
        onDelete={() => s.selectedNodeIds.forEach(deleteNode)} onClearCanvas={clearCanvas}
        onViewMode={(v) => setS((p) => ({ ...p, viewMode: v }))}
        onZoom={(z) => setS((p) => ({ ...p, zoom: z }))}
        onDevice={(d) => setS((p) => ({ ...p, devicePreview: d }))}
        onCanvasBg={(bg) => setS((p) => ({ ...p, canvasBg: bg }))}
        onAddNode={addNode}
        onSetMenu={(m) => setS((p) => ({ ...p, openMenu: m }))}
      />

      {/* ═══ Main body ═══ */}
      <div className='flex-1 flex overflow-hidden'>

      {/* ── Left Activity Bar ── */}
      <div className='w-12 bg-card border-r border-border flex flex-col items-center pt-3 pb-2 gap-1.5 shrink-0'>

        {/* Visual and theme modes are page design: no API / workflow panels. */}
        {activityItems.filter((it) => mode === 'workflow' ? it.id !== 'pages' && it.id !== 'data' : ['pages', 'components', 'data'].includes(it.id)).map((item) => (
          <button type='button' key={item.id} title={item.label}
            onClick={() => { if (s.leftPanel === item.id && !leftCollapsed) setLeftCollapsed(true); else { setS((p) => ({ ...p, leftPanel: item.id })); setLeftCollapsed(false); } }}
            className={`activity-item ${s.leftPanel === item.id && !leftCollapsed ? 'active' : ''}`}>
            {item.icon}
          </button>
        ))}
        <div className='flex-1' />
      </div>

      {/* ── Left Panel ── */}
      {!leftCollapsed && (
        <div className='border-r border-border bg-card flex flex-col shrink-0 overflow-hidden' style={{ width: leftW, transition: 'width 0.2s ease' }}>
          <div className='h-10 flex items-center px-3 border-b border-border shrink-0'>
            <span className='text-xs font-semibold text-foreground tracking-tight'>{{ pages: 'Pages', components: 'Components', data: 'Data', files: 'Explorer', apis: 'APIs & Data', workflows: 'Workflows' }[s.leftPanel]}</span>
            <div className='flex-1' />
            <button type='button' onClick={() => setLeftCollapsed(true)} className='btn-icon-sm !w-5 !h-5 !min-w-0' title='Collapse panel'>
              <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M15 18l-6-6 6-6' /></svg>
            </button>
          </div>
          {s.leftPanel === 'components' && (
            <div className='px-2.5 py-2 border-b border-border shrink-0'>
              <div className='relative'>
                <svg className='absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/35' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><circle cx='11' cy='11' r='8' /><path d='m21 21-4.3-4.3' /></svg>
                <input value={s.paletteSearch} onChange={(e) => setS((p) => ({ ...p, paletteSearch: e.target.value }))} placeholder='Search...' className='input-sm !pl-8' />
              </div>
            </div>
          )}
          <div className='flex-1 overflow-y-auto px-2 py-2'>
            {s.leftPanel === 'components' && symbols.length > 0 && (
              <div className='mb-4'>
                <div className='px-1 py-1 text-[10px] font-semibold text-violet-500 uppercase tracking-wider flex items-center gap-1.5'>
                  <span>◇</span><span>Your components</span><span className='ml-auto tabular-nums opacity-60'>{symbols.length}</span>
                </div>
                <div className='grid grid-cols-2 gap-0.5 mt-1'>
                  {symbols.map((sym) => (
                    <button type='button' key={sym.id} draggable onDragStart={(e) => { e.dataTransfer.setData('adhar/type', `symbol:${sym.id}`); }}
                      onClick={() => addNode(`symbol:${sym.id}`)} title={`Insert ${symbolName(sym)} (${countInstances(s.files, sym.id)} in use)`}
                      className='group text-left px-1.5 py-[6px] rounded-lg text-xs flex items-center gap-2 text-muted-foreground hover:text-foreground hover:bg-accent cursor-grab active:cursor-grabbing transition-all'>
                      <span className='w-6 h-6 rounded-md bg-violet-500/10 text-violet-500 flex items-center justify-center text-[11px] shrink-0'>◇</span>
                      <span className='truncate'>{symbolName(sym)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {s.leftPanel === 'components' && palette.map((cat) => (
              <div key={cat.id} className='mb-4'>
                <div className='px-1 py-1 text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider flex items-center gap-1.5'>
                  <span className='text-[11px]'>{cat.icon}</span><span>{cat.label}</span>
                  <span className='ml-auto text-muted-foreground/20 tabular-nums'>{cat.items.length}</span>
                </div>
                <div className='grid grid-cols-2 gap-0.5 mt-1'>
                  {cat.items.map((item) => (
                    <button type='button' key={item.type} draggable onDragStart={(e) => { e.dataTransfer.setData('adhar/type', item.type); }}
                      onClick={() => addNode(item.type)} title={`${item.label} — click to add, or drag onto the canvas`}
                      className='group text-left px-1.5 py-[6px] rounded-lg text-xs flex items-center gap-2 text-muted-foreground hover:text-foreground hover:bg-accent cursor-grab active:cursor-grabbing active:scale-[0.97] transition-all'>
                      <span className='w-6 h-6 rounded-md bg-muted/30 group-hover:bg-primary/10 flex items-center justify-center text-[11px] shrink-0 transition-colors'>{item.icon}</span>
                      <span className='truncate'>{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {s.leftPanel === 'pages' && (
              <PagesPanel files={s.files} activeFileId={s.activeFileId}
                onOpen={openFile} onAdd={() => void addPage()} onRename={(id) => void renamePage(id)}
                onSetRoute={setPageRoute} onDelete={deletePage}
                onMove={(id, dir) => setS((p) => ({ ...p, files: moveFile(p.files, id, dir) }))}
                onSetHome={(id) => setS((p) => ({ ...p, files: setHomePage(p.files, id) }))}
                onDeleteComponent={deleteFile} />
            )}
            {s.leftPanel === 'data' && (
              <DataPanel files={s.files} onAdd={() => void addDataSource()}
                onChange={(id, json) => updateFileContent(id, json)} onDelete={deleteFile} />
            )}
            {s.leftPanel === 'files' && (
              <div className='flex flex-col h-full'>
                {/* Quick actions bar */}
                <div className='flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0'>
                  <button type='button' onClick={async () => { const n = await showPrompt('New Page', { placeholder: 'Page name' }); if (n) { const pf = findFileInTree(s.files, 'f_pages'); createFile(pf ? 'f_pages' : 'f_src', `${n.replace(/\s+/g, '')}.tsx`, true); } }}
                    className='btn-icon-sm !h-6 !min-w-0 !px-1.5' title='New Page'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7' /><path d='M12 18v-6M9 15h6' /></svg>
                  </button>
                  <button type='button' onClick={async () => { const n = await showPrompt('New File', { placeholder: 'File name (e.g. utils.ts)' }); if (n) createFile('f_src', n, false); }}
                    className='btn-icon-sm !h-6 !min-w-0 !px-1.5' title='New File'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' /><path d='M14 2v6h6' /></svg>
                  </button>
                  <button type='button' onClick={async () => { const n = await showPrompt('New Folder', { placeholder: 'Folder name' }); if (n) createFolder('f_src', n); }}
                    className='btn-icon-sm !h-6 !min-w-0 !px-1.5' title='New Folder'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' /><path d='M12 11v6M9 14h6' /></svg>
                  </button>
                  <div className='w-px h-4 bg-border/40 mx-0.5' />
                  <button type='button' onClick={async () => { const n = await showPrompt('New Workflow', { placeholder: 'Workflow name' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.workflow`, false); }}
                    className='btn-icon-sm !h-6 !min-w-0 !px-1.5' title='New Workflow'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><circle cx='18' cy='18' r='3' /><circle cx='6' cy='6' r='3' /><path d='M6 21V9a9 9 0 0 0 9 9' /></svg>
                  </button>
                  <button type='button' onClick={async () => { const n = await showPrompt('New API', { placeholder: 'API name' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.api`, false); }}
                    className='btn-icon-sm !h-6 !min-w-0 !px-1.5' title='New API Integration'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M4 11a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM14 7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z' /></svg>
                  </button>
                  <button type='button' onClick={async () => { const n = await showPrompt('New Diagram', { placeholder: 'Diagram name' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.mmd`, false); }}
                    className='btn-icon-sm !h-6 !min-w-0 !px-1.5' title='New Diagram'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><rect x='3' y='3' width='7' height='7' rx='1' /><rect x='14' y='14' width='7' height='7' rx='1' /><path d='M10 7h4M7 10v4M14 17h-4M17 14v-4' /></svg>
                  </button>
                </div>

                {/* File tree */}
                <div className='flex-1 overflow-y-auto'>
                  <FileExplorer files={s.files} activeFileId={s.activeFileId} renamingFileId={s.renamingFileId}
                    onOpen={openFile} onToggle={toggleFolder} onDelete={deleteFile}
                    onRename={renameFile} onStartRename={(fid) => setS((p) => ({ ...p, renamingFileId: fid }))}
                    onNewFile={async (fid) => { const n = await showPrompt('New File', { placeholder: 'File name' }); if (n) createFile(fid, n, n.endsWith('.tsx')); }}
                    onNewFolder={async (fid) => { const n = await showPrompt('New Folder', { placeholder: 'Folder name' }); if (n) createFolder(fid, n); }}
                  />
                </div>

                {/* Footer stats */}
                <div className='px-3 py-2 border-t border-border text-[10px] text-muted-foreground/40 flex items-center gap-2'>
                  <span>{pageFiles.length} pages</span>
                  <span>·</span>
                  <span>{s.openFileIds.length} open</span>
                </div>
              </div>
            )}

            {/* ═══ APIs & Data Panel ═══ */}
            {s.leftPanel === 'apis' && (() => {
              const apiFiles: ProjectFile[] = [];
              const findAPI = (files: ProjectFile[]) => { files.forEach((f) => { if (f.type === 'file' && f.language === 'api') apiFiles.push(f); if (f.children) findAPI(f.children); }); };
              findAPI(s.files);

              return (
              <div className='p-3 space-y-4'>
                {/* API Integration files */}
                <div>
                  <div className='flex items-center justify-between mb-2'>
                    <h3 className='text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider'>Endpoints</h3>
                    <button type='button' onClick={async () => { const n = await showPrompt('New API Integration', { placeholder: 'e.g. users-api' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.api`, false); }}
                      className='btn-icon-sm !w-5 !h-5 !min-w-0' title='Add API integration'>
                      <svg width={11} height={11} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M12 5v14M5 12h14' /></svg>
                    </button>
                  </div>
                  {apiFiles.length === 0 ? (
                    <div className='text-center py-6'>
                      <svg className='w-10 h-10 mx-auto text-muted-foreground/15 mb-2' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1}><path d='M4 11a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM14 7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z' /></svg>
                      <p className='text-xs text-muted-foreground/40'>No API integrations</p>
                      <button type='button' onClick={async () => { const n = await showPrompt('New API', { placeholder: 'API name' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.api`, false); }}
                        className='mt-2 text-xs text-primary hover:underline'>Create your first API</button>
                    </div>
                  ) : (
                    apiFiles.map((af) => {
                      const isAct = af.id === s.activeFileId;
                      let method = 'GET'; let url = '';
                      try { const d = JSON.parse(af.content || '{}'); method = d.endpoint?.method || 'GET'; url = d.endpoint?.url || ''; } catch { /* not valid JSON yet */ }
                      const methodColors: Record<string, string> = { GET: '#10b981', POST: '#f59e0b', PUT: '#3b82f6', PATCH: '#8b5cf6', DELETE: '#ef4444' };
                      return (
                        <button type='button' key={af.id} onClick={() => openFile(af.id)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${isAct ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}>
                          <span className='text-[9px] font-bold px-1.5 py-0.5 rounded text-white shrink-0' style={{ backgroundColor: methodColors[method] || '#666' }}>{method}</span>
                          <div className='flex-1 min-w-0'>
                            <div className='text-xs font-medium truncate'>{af.name.replace('.api', '')}</div>
                            {url && <div className='text-[10px] text-muted-foreground/40 font-mono truncate'>{url}</div>}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

              </div>
              );
            })()}

            {/* ═══ Workflows Panel ═══ */}
            {s.leftPanel === 'workflows' && (() => {
              // Find all .workflow files in project
              const workflowFiles: ProjectFile[] = [];
              const findWF = (files: ProjectFile[]) => { files.forEach((f) => { if (f.type === 'file' && f.language === 'workflow') workflowFiles.push(f); if (f.children) findWF(f.children); }); };
              findWF(s.files);

              return (
              <div className='p-3 space-y-4'>
                {/* Workflow files */}
                <div>
                  <div className='flex items-center justify-between mb-2'>
                    <h3 className='text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider'>Workflows</h3>
                    <button type='button' onClick={async () => { const n = await showPrompt('New Workflow', { placeholder: 'Workflow name' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.workflow`, false); }}
                      className='btn-icon-sm !w-5 !h-5 !min-w-0' title='Create workflow'>
                      <svg width={11} height={11} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M12 5v14M5 12h14' /></svg>
                    </button>
                  </div>

                  {workflowFiles.length === 0 ? (
                    <div className='text-center py-6'>
                      <svg className='w-10 h-10 mx-auto text-muted-foreground/15 mb-2' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1}><circle cx='18' cy='18' r='3' /><circle cx='6' cy='6' r='3' /><path d='M6 21V9a9 9 0 0 0 9 9' /></svg>
                      <p className='text-xs text-muted-foreground/40'>No workflows yet</p>
                      <button type='button' onClick={async () => { const n = await showPrompt('New Workflow', { placeholder: 'Workflow name' }); if (n) createFile('f_src', `${n.replace(/\s+/g, '-')}.workflow`, false); }}
                        className='mt-2 text-xs text-primary hover:underline'>Create your first workflow</button>
                    </div>
                  ) : (
                    workflowFiles.map((wf) => {
                      const isActive = wf.id === s.activeFileId;
                      let stepCount = 0;
                      try { const d = JSON.parse(wf.content || '{}'); stepCount = d.steps?.length || 0; } catch { /* not valid JSON yet */ }
                      return (
                        <button type='button' key={wf.id} onClick={() => openFile(wf.id)}
                          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent'}`}>
                          <svg className='w-4 h-4 shrink-0' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><circle cx='18' cy='18' r='3' /><circle cx='6' cy='6' r='3' /><path d='M6 21V9a9 9 0 0 0 9 9' /></svg>
                          <div className='flex-1 min-w-0'>
                            <div className='text-xs font-medium truncate'>{wf.name.replace('.workflow', '')}</div>
                            <div className='text-[10px] text-muted-foreground/40'>{stepCount} steps</div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

              </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ═══ Center Workspace ═══ */}
      <div className='flex-1 flex flex-col overflow-hidden min-w-0 relative'>
        {/* ═══ Unified tab + frame bar ═══ */}
        {s.openFileIds.length > 0 && (
          <div className='h-9 bg-card border-b border-border flex items-center shrink-0 overflow-x-auto scrollbar-none'>
            {/* Open file tabs */}
            <div className='flex items-center h-full px-1'>
              {s.openFileIds.map((fid) => {
                const f = findFileInTree(s.files, fid);
                if (!f) return null;
                const isAct = fid === s.activeFileId;
                return (
                  <button type='button' key={fid} onClick={() => openFile(fid)}
                    className={`group flex items-center gap-1.5 h-full px-3 text-xs border-b-2 transition-colors shrink-0 ${isAct ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground/60 hover:text-foreground hover:bg-accent/30'}`}>
                    {f.nodes !== undefined
                      ? <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5} className={isAct ? 'text-primary' : ''}><rect x='3' y='3' width='18' height='18' rx='2' /></svg>
                      : <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7' /></svg>
                    }
                    <span className='truncate max-w-[100px]'>{f.name.replace(/\.\w+$/, '')}</span>
                    <span onClick={(e) => { e.stopPropagation(); closeFile(fid); }}
                      className='w-4 h-4 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:bg-accent ml-0.5 transition-all cursor-pointer'>
                      <svg className='w-2.5 h-2.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2.5}><path d='M18 6 6 18M6 6l12 12' /></svg>
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Add new page (quick action) */}
            <button type='button' onClick={async () => { const n = await showPrompt('New Page', { placeholder: 'Page name' }); if (n) { const pf = findFileInTree(s.files, 'f_pages'); createFile(pf ? 'f_pages' : 'f_src', `${n.replace(/\s+/g, '')}.tsx`, true); } }}
              className='flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground/30 hover:text-foreground hover:bg-accent transition-colors shrink-0 mx-1' title='New page'>
              <svg width={13} height={13} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M12 5v14M5 12h14' /></svg>
            </button>
          </div>
        )}

        {/* Welcome screen */}
        {!activeFile && (
          <div className='flex-1 flex flex-col items-center justify-center animate-fade-in' style={{ background: 'var(--b-canvas)' }}>
            <div className='w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/15 via-primary/8 to-transparent flex items-center justify-center mb-6'>
              <AdharSymbol size={40} />
            </div>
            <h2 className='text-xl font-semibold text-foreground mb-1.5 tracking-tight'>Open a file to start</h2>
            <p className='text-xs text-muted-foreground mb-8'>Pages, source, diagrams and workflows live in the Explorer.</p>
            <div className='flex gap-2.5'>
              {pageFiles.slice(0, 3).map((pf) => (
                <button type='button' key={pf.id} onClick={() => openFile(pf.id)}
                  className='flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-card hover:border-primary/20 hover:shadow-sm active:scale-[0.98] transition-all'>
                  <Ic d='M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7' s={15} />
                  {pf.name.replace(/\.\w+$/, '')}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Design view — Layout mode */}
        {activeFile && s.viewMode === 'design' && isActive && activeFile.readonlyReason && (
          <div className='flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center' style={{ background: 'var(--b-canvas)' }}>
            <span className='rounded bg-amber-500/15 px-2 py-0.5 font-mono text-xs text-amber-700 dark:text-amber-300'>{activeFile.repoPath}</span>
            <h3 className='text-sm font-semibold text-foreground'>This page can't be edited visually</h3>
            <p className='max-w-md text-xs text-muted-foreground'>{activeFile.readonlyReason} It stays exactly as written in the repository.</p>
          </div>
        )}
        {activeFile && s.viewMode === 'design' && isActive && !activeFile.readonlyReason && s.canvasMode === 'layout' && (
          activeNodes.length === 0 && (!activeFile.variants || activeFile.variants.length === 0) ? (
            <DesignHero
              pageName={pageName}
              loading={s.aiLoading}
              devicePreview={s.devicePreview}
              onDeviceChange={(d) => setS((p) => ({ ...p, devicePreview: d }))}
              framework={s.framework}
              onFrameworkChange={(id) => setS((p) => ({ ...p, framework: id }))}
              onGenerate={(prompt, styles) => {
                const userMsg: AIMessage = { id: genId(), role: 'user', content: prompt, timestamp: Date.now() };
                setS((p) => ({ ...p, aiLoading: true, aiMessages: [...p.aiMessages, userMsg] }));
                // Defer so loading state paints
                setTimeout(() => generateDesignVariants(prompt, styles), 50);
              }}
              onSwitchToBlank={() => {
                // Insert a single empty container so the hero dismisses
                setS((p) => ({
                  ...p,
                  files: updateFileInTree(p.files, p.activeFileId!, (f) => ({
                    ...f,
                    nodes: [{ id: genId(), type: 'section', props: { className: 'p-8 min-h-[400px]' }, children: [], style: {} }],
                  })),
                }));
              }}
            />
          ) : (
            <div className='flex-1 flex flex-col overflow-hidden'>
              {activeFile.symbol && (
                <div className='flex items-center gap-2 border-b border-border bg-violet-500/10 px-3 py-1.5 text-xs'>
                  <span className='text-violet-500'>◇</span>
                  <span className='font-medium text-foreground'>Editing component {symbolName(activeFile)}</span>
                  <span className='text-muted-foreground'>· used {countInstances(s.files, activeFile.id)}× — changes update every instance{activeNodes.length > 1 ? '. Only the first top-level element is the component.' : '.'}</span>
                  <div className='flex-1' />
                  {listPages(s.files)[0] && (
                    <button type='button' className='btn-icon-sm !px-2 !w-auto text-xs' onClick={() => openFile(listPages(s.files)[0].id)}>Done</button>
                  )}
                </div>
              )}
              {activeFile.variants && activeFile.variants.length > 0 && (
                <VariantStrip
                  variants={activeFile.variants}
                  activeVariantId={activeFile.activeVariantId || null}
                  prompt={activeFile.lastPrompt}
                  loading={s.aiLoading}
                  onSelect={activateVariant}
                  onRemove={removeVariant}
                  onRegenerate={addExtraVariant}
                />
              )}
              <CanvasView
                nodes={activeNodes} selectedNodeIds={s.selectedNodeIds}
                zoom={s.zoom} devicePreview={s.devicePreview} canvasBg={s.canvasBg} pageName={pageName}
                onSelect={handleSelect} onDeselect={() => setS((p) => ({ ...p, selectedNodeIds: [] }))}
                onUpdateText={(nid, txt) => updateProp(nid, 'children', txt)}
                onDropNew={(type, pid) => addNode(type, pid)}
                onDropReorder={handleDropReorder} onContextMenu={() => {}}
                onCopy={copyNode} onPaste={pasteNode} onDuplicate={duplicateNode}
                onMoveUp={(nid) => moveUp(nid)} onMoveDown={(nid) => moveDown(nid)}
                onWrap={(nid) => wrapNode(nid)} onDelete={deleteNode}
                onZoom={(z) => setS((p) => ({ ...p, zoom: z }))}
                artboardStyle={artboardStyle} artboardDark={s.darkMode} artboardClass={canvasCss ? 'adhar-repo-canvas' : undefined}
              />
            </div>
          )
        )}

        {/* Design view — Freeform mode (React Flow canvas) */}
        {activeFile && s.viewMode === 'design' && isActive && s.canvasMode === 'freeform' && (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <Suspense fallback={<SurfaceLoading />}>
          <FlowCanvas
            mode='freeform'
            nodes={activeNodes} selectedNodeIds={s.selectedNodeIds}
            canvasBg={s.canvasBg} pageName={pageName}
            onSelect={handleSelect} onDeselect={() => setS((p) => ({ ...p, selectedNodeIds: [] }))}
            onUpdateText={(nid, txt) => updateProp(nid, 'children', txt)}
            onDropNew={(type, pid, idx, x, y) => addNode(type, pid, idx, x, y)}
            onConnect={(sourceId, targetId) => {
              updateNodes((nodes) => {
                const update = (arr: CanvasNode[]): CanvasNode[] => arr.map((n) => {
                  if (n.id === sourceId) {
                    const existing = n.interactions || [];
                    return { ...n, interactions: [...existing, { trigger: 'click' as const, action: 'navigate' as const, targetNodeId: targetId, transition: 'fade' as const, duration: 200 }] };
                  }
                  return { ...n, children: update(n.children) };
                });
                return update(nodes);
              });
            }}
            onNodePositionChange={(nid, x, y) => { updateProp(nid, 'x', x); updateProp(nid, 'y', y); }}
            onNodeResize={(nid, w, h) => { updateProp(nid, 'width', w); updateProp(nid, 'height', h); }}
            onCopy={copyNode} onPaste={pasteNode} onDuplicate={duplicateNode}
            onMoveUp={(nid) => moveUp(nid)} onMoveDown={(nid) => moveDown(nid)}
            onWrap={(nid) => wrapNode(nid)} onDelete={deleteNode}
          />
          </Suspense>
          </div>
        )}

        {/* Diagram editor — full page, ignores view mode toggle */}
        {activeFile && !isActive && activeFile.language === 'mermaid' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <Suspense fallback={<SurfaceLoading />}>
              <DiagramEditor code={activeFile.content || ''} onChange={(val) => { if (s.activeFileId) updateFileContent(s.activeFileId, val); }} darkMode={consoleDark} />
            </Suspense>
          </div>
        )}

        {/* Workflow editor — full page, ignores view mode toggle */}
        {activeFile && !isActive && activeFile.language === 'workflow' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <WorkflowEditor content={activeFile.content || ''} onChange={(val) => { if (s.activeFileId) updateFileContent(s.activeFileId, val); }} />
          </div>
        )}

        {/* API editor — full page, ignores view mode toggle */}
        {activeFile && !isActive && activeFile.language === 'api' && (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <APIEditor content={activeFile.content || ''} onChange={(val) => { if (s.activeFileId) updateFileContent(s.activeFileId, val); }} />
          </div>
        )}

        {/* Design view — code files */}
        {activeFile && s.viewMode === 'design' && !isActive && !['mermaid', 'workflow', 'api'].includes(activeFile.language || '') && (
          <div className='flex-1 overflow-hidden'><Suspense fallback={<SurfaceLoading />}><MonacoEditor key={activeFile.id} value={activeFile.content || ''} language={activeFile.language || 'text'} readOnly={false} onChange={(val) => { if (s.activeFileId) updateFileContent(s.activeFileId, val); }} /></Suspense></div>
        )}

        {/* Code view (not for workflow/api — they have their own full-page editors) */}
        {activeFile && s.viewMode === 'code' && activeFile.language !== 'workflow' && activeFile.language !== 'api' && (
          <div className='flex-1 overflow-hidden'><Suspense fallback={<SurfaceLoading />}><MonacoEditor key={`${activeFile.id}:${isActive ? s.framework : 'src'}`} value={fullCode} language={isActive ? codeLanguage(s.framework) : activeFile.language || 'tsx'} readOnly={isActive} onChange={(val) => { if (s.activeFileId && !isActive) updateFileContent(s.activeFileId, val); }} /></Suspense></div>
        )}

        {/* Preview */}
        {activeFile && s.viewMode === 'preview' && isActive && (
          <div className='flex-1 flex justify-center p-6 overflow-auto' style={{ background: 'var(--b-canvas)' }}>
            <iframe
              srcDoc={buildPreviewDoc()}
              className='rounded-xl border border-border bg-background'
              style={{ boxShadow: '0 4px 24px color-mix(in oklab, var(--b-foreground) 6%, transparent)', width: s.devicePreview === 'mobile' ? 375 : s.devicePreview === 'tablet' ? 768 : '100%', maxWidth: '100%', height: '100%', minHeight: 500 }}
              sandbox='allow-scripts' title='Preview' />
          </div>
        )}
        {activeFile && s.viewMode === 'preview' && !isActive && activeFile.language !== 'workflow' && activeFile.language !== 'api' && (
          <div className='flex-1 flex items-center justify-center text-muted-foreground/30'><p className='text-xs'>Preview not available for .{activeFile?.language} files</p></div>
        )}

        {/* ═══ Floating Toolbox ═══ */}
        {activeFile && isActive && s.viewMode === 'design' && !(s.canvasMode === 'layout' && activeNodes.length === 0 && !activeFile.variants?.length) && (
          <div className='absolute bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-2xl px-2.5 py-2 animate-slide-up'
            style={{ background: 'color-mix(in oklab, var(--b-popover) 88%, transparent)', backdropFilter: 'blur(16px) saturate(1.4)', boxShadow: '0 12px 40px color-mix(in oklab, var(--b-foreground) 10%, transparent), 0 4px 12px color-mix(in oklab, var(--b-foreground) 6%, transparent), inset 0 0 0 1px color-mix(in oklab, var(--b-border) 50%, transparent)' }}>

            {/* Undo / Redo */}
            <button type='button' className='btn-icon-sm' onClick={undo} disabled={s.historyIndex < 0} title='Undo (⌘Z)'><Ic d='M3 10h10a5 5 0 0 1 5 5v2M3 10l4-4M3 10l4 4' s={14} /></button>
            <button type='button' className='btn-icon-sm' onClick={redo} disabled={s.historyIndex >= s.history.length - 1} title='Redo (⌘⇧Z)'><Ic d='M21 10H11a5 5 0 0 0-5 5v2M21 10l-4-4M21 10l-4 4' s={14} /></button>

            <div className='w-px h-5 bg-border/40 mx-1.5' />

            {/* Edit */}
            <button type='button' className='btn-icon-sm' onClick={copyNode} disabled={s.selectedNodeIds.length === 0} title='Copy (⌘C)'><Ic d='M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' s={13} /></button>
            <button type='button' className='btn-icon-sm' onClick={pasteNode} disabled={!s.clipboard} title='Paste (⌘V)'><Ic d='M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z' s={13} /></button>
            <button type='button' className='btn-icon-sm' onClick={duplicateNode} disabled={s.selectedNodeIds.length === 0} title='Duplicate (⌘D)'><Ic d='M8 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M10 20h8a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z' s={13} /></button>
            <button type='button' className='btn-icon-sm' onClick={() => s.selectedNodeIds.forEach(deleteNode)} disabled={s.selectedNodeIds.length === 0} title='Delete (⌫)' style={{ color: s.selectedNodeIds.length > 0 ? 'var(--b-destructive)' : undefined }}>
              <Ic d='M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' s={13} />
            </button>

            <div className='w-px h-5 bg-border/40 mx-1.5' />

            {/* Mode-specific quick insert */}
            {s.canvasMode === 'layout' ? (
              <>
                {[
                  { type: 'div', d: 'M3 3h18v18H3z', t: 'Container' },
                  { type: 'flex', d: 'M3 6h18M3 12h18M3 18h18', t: 'Flex' },
                  { type: 'h2', d: 'M4 7V4h16v3M9 20h6M12 4v16', t: 'Text' },
                  { type: 'button', d: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', t: 'Button' },
                  { type: 'input', d: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 12h4', t: 'Input' },
                  { type: 'img-placeholder', d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM21 15l-5-5L5 21', t: 'Image' },
                ].map((n) => (
                  <button type='button' key={n.type} className='btn-icon-sm' onClick={() => addNode(n.type)} title={n.t}><Ic d={n.d} s={13} /></button>
                ))}
              </>
            ) : (
              <>
                {[
                  { type: 'flow-step', t: 'Flow Step', icon: '⬡' },
                  { type: 'data-model', t: 'Data Model', icon: '🗄' },
                  { type: 'api-endpoint', t: 'API Endpoint', icon: '🌐' },
                  { type: 'note', t: 'Sticky Note', icon: '📌' },
                  { type: 'screen-mobile', t: 'Mobile Screen', icon: '📱' },
                  { type: 'screen-desktop', t: 'Desktop Screen', icon: '🖥' },
                ].map((n) => (
                  <button type='button' key={n.type} className='btn-icon-sm' onClick={() => addNode(n.type)} title={n.t}>
                    <span style={{ fontSize: 13 }}>{n.icon}</span>
                  </button>
                ))}
              </>
            )}

            <div className='w-px h-5 bg-border/40 mx-1.5' />

            {/* Zoom controls (common for both modes) */}
            <button type='button' className='btn-icon-sm' onClick={() => setS((p) => ({ ...p, zoom: Math.max(25, p.zoom - 10) }))} title='Zoom out'>
              <Ic d='M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM13 10H7' s={13} />
            </button>
            <span className='text-[10px] font-mono text-muted-foreground tabular-nums min-w-[32px] text-center select-none'>{s.zoom}%</span>
            <button type='button' className='btn-icon-sm' onClick={() => setS((p) => ({ ...p, zoom: Math.min(200, p.zoom + 10) }))} title='Zoom in'>
              <Ic d='M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM10 7v6M7 10h6' s={13} />
            </button>
            <button type='button' className='btn-icon-sm' onClick={() => setS((p) => ({ ...p, zoom: 100 }))} title='Reset zoom to 100%'>
              <Ic d='M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1' s={12} />
            </button>
          </div>
        )}
      </div>

      {/* ── Right Panel ── */}
      {!rightCollapsed && (
        <div className='border-l border-border bg-card flex flex-col shrink-0 overflow-hidden' style={{ width: rightW, transition: 'width 0.2s ease' }}>
          <div className='h-10 flex items-center px-3 border-b border-border shrink-0'>
            {s.rightPanel === 'ai' && (
              <svg className='w-4 h-4 text-primary mr-2 shrink-0' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}>
                <path d='M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .963L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4' />
              </svg>
            )}
            {s.rightPanel === 'settings' && (
              <svg className='w-4 h-4 text-muted-foreground mr-2 shrink-0' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}>
                <path d='M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' /><circle cx='12' cy='12' r='3' />
              </svg>
            )}
            <span className='text-xs font-semibold text-foreground tracking-tight'>
              {{ outline: 'Layers', properties: 'Properties', theme: 'Theme', ai: 'AI Assistant', settings: 'Settings' }[s.rightPanel]}
            </span>
            <div className='flex-1' />
            <button type='button' onClick={() => setRightCollapsed(true)} className='btn-icon-sm !w-5 !h-5 !min-w-0' title='Collapse panel'>
              <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M9 18l6-6-6-6' /></svg>
            </button>
          </div>
          <div className='flex-1 overflow-y-auto'>
            {s.rightPanel === 'outline' && <OutlinePanel nodes={activeNodes} selectedNodeIds={s.selectedNodeIds}
              onSelect={(nid) => handleSelect(nid, false)}
              onToggleVisibility={(nid) => updateProp(nid, 'hidden', !findNode(activeNodes, nid)?.hidden)}
              onMoveNode={(nid, dir) => { if (dir === 'up') moveUp(nid); else moveDown(nid); }}
              onToggleLock={(nid) => updateProp(nid, 'locked', !findNode(activeNodes, nid)?.locked)}
              onRename={(nid, name) => updateProp(nid, 'componentName', name || undefined)}
              onDropReorder={handleDropReorder}
            />}
            {s.rightPanel === 'properties' && selNode && isActive && (
              <StudioInspector node={selNode} files={s.files} pageNodes={activeNodes}
                onUpdate={updateProp} onMakeComponent={makeComponent} onDetach={detach} onEditComponent={openFile} />
            )}
            {s.rightPanel === 'properties' && <PropertiesPanel selectedNode={selNode} activeFile={activeFile} activeFilePath={activeFilePath} isActivePage={isActive} onUpdateProp={updateProp} onDelete={deleteNode} />}
            {s.rightPanel === 'theme' && <ThemePanel theme={s.theme} darkMode={s.darkMode} framework={s.framework} customTokenOverrides={s.customTokenOverrides}
              onSetTheme={(t) => setS((p) => ({ ...p, theme: t }))} onSetDarkMode={(d) => setS((p) => ({ ...p, darkMode: d }))} onSetFramework={(fw) => setS((p) => ({ ...p, framework: fw }))}
              onSetTokenOverride={(token, value) => setS((p) => ({ ...p, customTokenOverrides: { ...p.customTokenOverrides, [token]: value } }))}
              onExportDTCG={() => downloadFile(JSON.stringify(exportDesignTokens(s.theme), null, 2), `${s.theme}-tokens.json`, 'application/json')}
              onExportCSS={() => downloadFile(exportTokensAsCustomProperties(s.theme), `${s.theme}-theme.css`, 'text/css')}
              onApplyToGlobals={() => { const gf = findFileInTree(s.files, 'f_globals'); if (gf) { updateFileContent('f_globals', `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n${generateThemeCSS(currentTheme)}\n`); openFile('f_globals'); } }}
            />}
            {s.rightPanel === 'ai' && <AIPanel aiMessages={s.aiMessages} aiPrompt={s.aiPrompt} aiLoading={s.aiLoading} aiProvider={s.aiProvider} aiConnected={aiConnected}
              isActivePage={isActive} activeFileName={activeFile?.name} activeNodes={activeNodes}
              onSetPrompt={(p) => setS((prev) => ({ ...prev, aiPrompt: p }))} onSetProvider={(p) => setS((prev) => ({ ...prev, aiProvider: p }))}
              onGenerate={(text) => { void handleAIGenerate(text); }} onDismissMessage={dismissAIMessage}
            />}
            {s.rightPanel === 'settings' && (
              <div className='p-3 space-y-5'>
                {/* Project Settings */}
                <div>
                  <h3 className='text-xs font-semibold text-foreground mb-3 flex items-center gap-2'>
                    <svg className='w-3.5 h-3.5 text-muted-foreground' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7' /></svg>
                    Project
                  </h3>
                  <div className='space-y-3'>
                    <div>
                      <label className='text-[11px] text-muted-foreground block mb-1'>Framework</label>
                      <select value={s.framework} onChange={(e) => setS((p) => ({ ...p, framework: e.target.value }))}
                        className='input-sm'>
                        {['react', 'vue', 'svelte', 'angular', 'solid'].map((fw) => <option key={fw} value={fw}>{fw.charAt(0).toUpperCase() + fw.slice(1)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className='text-[11px] text-muted-foreground block mb-1'>Canvas Default</label>
                      <select value={s.canvasBg} onChange={(e) => setS((p) => ({ ...p, canvasBg: e.target.value as any }))}
                        className='input-sm'>
                        <option value='dots'>Dots Grid</option>
                        <option value='white'>White</option>
                        <option value='dark'>Dark</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className='h-px bg-border' />

                {/* Keyboard Shortcuts */}
                <div>
                  <h3 className='text-xs font-semibold text-foreground mb-3 flex items-center gap-2'>
                    <svg className='w-3.5 h-3.5 text-muted-foreground' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><rect x='2' y='4' width='20' height='16' rx='2' /><path d='M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8' /></svg>
                    Shortcuts
                  </h3>
                  <div className='space-y-1.5'>
                    {[
                      ['⌘S', 'Save'], ['⌘Z', 'Undo'], ['⌘⇧Z', 'Redo'],
                      ['⌘C', 'Copy'], ['⌘V', 'Paste'], ['⌘D', 'Duplicate'],
                      ['⌘E', 'Toggle explorer'], ['Del', 'Delete'],
                      ['Space+Drag', 'Pan canvas'], ['Ctrl+Scroll', 'Zoom'],
                    ].map(([key, desc]) => (
                      <div key={key} className='flex items-center justify-between'>
                        <span className='text-[11px] text-muted-foreground'>{desc}</span>
                        <kbd className='text-[10px] font-mono text-muted-foreground/40 bg-muted px-1.5 py-0.5 rounded'>{key}</kbd>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Right Activity Bar ── */}
      <div className='w-12 bg-card border-l border-border flex flex-col items-center pt-3 pb-2 gap-1 shrink-0'>
        {rightItems.map((item) => (
          <React.Fragment key={item.id}>
            {item.id === 'settings' && <div className='w-7 h-px bg-border/40 my-0.5' />}
            <button type='button' title={item.label}
              onClick={() => { if (s.rightPanel === item.id && !rightCollapsed) setRightCollapsed(true); else { setS((p) => ({ ...p, rightPanel: item.id })); setRightCollapsed(false); } }}
              className={`activity-item ${s.rightPanel === item.id && !rightCollapsed ? 'active' : ''}`}>
              {item.icon}
            </button>
          </React.Fragment>
        ))}
      </div>
      </div>{/* end main body */}
    </div>
    </StudioFilesContext.Provider>
    </DialogProvider>
  );
}
