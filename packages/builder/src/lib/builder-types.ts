// ─── Shared Types & Utilities for the Builder ───────────────────────────────

export interface NodeInteraction {
  trigger: 'click' | 'hover' | 'focus';
  action: 'navigate' | 'toggle-visibility' | 'open-url' | 'scroll-to' | 'show-overlay';
  targetPageId?: string;   // for navigate
  targetNodeId?: string;   // for toggle-visibility, scroll-to
  url?: string;            // for open-url
  transition?: 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'scale';
  duration?: number;       // ms
}

export interface NodeComment {
  id: string;
  author: string;
  text: string;
  resolved: boolean;
  timestamp: number;
}

export interface CanvasNode {
  id: string;
  type: string;
  props: Record<string, any>;
  children: CanvasNode[];
  style: Record<string, string>;
  interactions?: NodeInteraction[];
  hoverClassName?: string;
  hidden?: boolean;
  comments?: NodeComment[];
  componentName?: string;
  /** Layers panel: locked nodes cannot be selected or dragged on the canvas. */
  locked?: boolean;
  /**
   * Repeater binding: render this container's children once per item of a
   * project data source (a JSON file under `data/`). Text inside may use
   * `{{field}}` / `{{nested.field}}` templates against the current item.
   */
  bind?: { source: string; path?: string };
  // Freeform positioning (used in freeform canvas mode)
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DesignVariant {
  id: string;
  label: string;
  style: 'modern' | 'minimal' | 'playful' | 'enterprise' | 'bold' | 'editorial';
  nodes: CanvasNode[];
  prompt: string;
  timestamp: number;
}

export interface ProjectFile {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: ProjectFile[];
  nodes?: CanvasNode[];
  content?: string;
  language?: string;
  expanded?: boolean;
  variants?: DesignVariant[];
  activeVariantId?: string | null;
  lastPrompt?: string;
  /** App page: URL route in the prototype and the exported app (e.g. `/customers`). */
  route?: string;
  /** App page: the page served at `/`. */
  home?: boolean;
  /** A reusable component (symbol): `nodes[0]` is the master; instances reference this file id. */
  symbol?: boolean;
}

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  nodes?: CanvasNode[];
  timestamp: number;
}

export interface AppState {
  files: ProjectFile[];
  activeFileId: string | null;
  openFileIds: string[];
  selectedNodeIds: string[];
  zoom: number;
  viewMode: 'design' | 'code' | 'preview';
  framework: string;
  theme: string;
  darkMode: boolean;
  showRuler: boolean;
  canvasMode: 'layout' | 'freeform';
  canvasBg: 'white' | 'dots' | 'dark';
  aiPrompt: string;
  aiLoading: boolean;
  aiProvider: 'local' | 'adhar';
  aiMessages: AIMessage[];
  aiModifyMode: boolean;
  paletteSearch: string;
  leftPanel: 'pages' | 'components' | 'data' | 'files' | 'apis' | 'workflows';
  rightPanel: 'outline' | 'properties' | 'theme' | 'ai' | 'settings';
  history: CanvasNode[][];
  historyIndex: number;
  clipboard: CanvasNode | null;
  openMenu: string | null;
  renamingFileId: string | null;
  customTokenOverrides: Record<string, string>;
  devicePreview: 'desktop' | 'tablet' | 'mobile';
}

// ─── ID generator ────────────────────────────────────────────────────────────
export const genId = () => `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// ─── Container types ─────────────────────────────────────────────────────────
export const CONTAINER_TYPES = [
  'div', 'flex', 'flex-col', 'grid', 'grid-3', 'section', 'card', 'nav', 'footer', 'sidebar',
  'hero-section', 'feature-card', 'pricing-card', 'cta-section', 'login-form', 'stat-card',
  'screen-mobile', 'screen-tablet', 'screen-desktop', 'frame', 'modal', 'form',
];

export function isContainer(type: string): boolean {
  return CONTAINER_TYPES.includes(type);
}

// ─── File tree utilities ─────────────────────────────────────────────────────
export function findFileInTree(files: ProjectFile[], fileId: string): ProjectFile | null {
  for (const f of files) {
    if (f.id === fileId) return f;
    if (f.children) {
      const found = findFileInTree(f.children, fileId);
      if (found) return found;
    }
  }
  return null;
}

export function getFilePath(files: ProjectFile[], fileId: string, prefix = ''): string {
  for (const f of files) {
    const p = prefix ? `${prefix}/${f.name}` : f.name;
    if (f.id === fileId) return p;
    if (f.children) {
      const found = getFilePath(f.children, fileId, p);
      if (found) return found;
    }
  }
  return '';
}

export function isPageFile(file: ProjectFile): boolean {
  return file.type === 'file' && file.language === 'tsx' && file.nodes !== undefined;
}

export function getAllPageFiles(files: ProjectFile[]): ProjectFile[] {
  const result: ProjectFile[] = [];
  for (const f of files) {
    // Symbols (reusable components) hold nodes too, but they are not pages.
    if (f.type === 'file' && f.nodes !== undefined && !f.symbol) result.push(f);
    if (f.children) result.push(...getAllPageFiles(f.children));
  }
  return result;
}

export function updateFileInTree(files: ProjectFile[], fileId: string, updater: (f: ProjectFile) => ProjectFile): ProjectFile[] {
  return files.map((f) => {
    if (f.id === fileId) return updater(f);
    if (f.children) return { ...f, children: updateFileInTree(f.children, fileId, updater) };
    return f;
  });
}

export function removeFileFromTree(files: ProjectFile[], fileId: string): ProjectFile[] {
  return files.filter((f) => f.id !== fileId).map((f) => f.children ? { ...f, children: removeFileFromTree(f.children, fileId) } : f);
}

export function addFileToFolder(files: ProjectFile[], folderId: string, newFile: ProjectFile): ProjectFile[] {
  return files.map((f) => {
    if (f.id === folderId && f.type === 'folder') return { ...f, children: [...(f.children || []), newFile], expanded: true };
    if (f.children) return { ...f, children: addFileToFolder(f.children, folderId, newFile) };
    return f;
  });
}

export function findParentFolder(files: ProjectFile[], fileId: string): ProjectFile | null {
  for (const f of files) {
    if (f.children) {
      if (f.children.some((c) => c.id === fileId)) return f;
      const found = findParentFolder(f.children, fileId);
      if (found) return found;
    }
  }
  return null;
}

export function langFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = { tsx: 'tsx', ts: 'ts', jsx: 'jsx', js: 'js', css: 'css', json: 'json', html: 'html', md: 'md', txt: 'text', yaml: 'yaml', yml: 'yaml', svg: 'html', mmd: 'mermaid', mermaid: 'mermaid', workflow: 'workflow', api: 'api' };
  return map[ext] || 'text';
}

// ─── Canvas node utilities ───────────────────────────────────────────────────
export function findNode(nodes: CanvasNode[], nodeId: string | null): CanvasNode | null {
  if (!nodeId) return null;
  for (const n of nodes) {
    if (n.id === nodeId) return n;
    const f = findNode(n.children, nodeId);
    if (f) return f;
  }
  return null;
}

export function findNodeParent(nodes: CanvasNode[], nodeId: string): { parent: CanvasNode[] | null; index: number } {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === nodeId) return { parent: nodes, index: i };
    const found = findNodeParent(nodes[i].children, nodeId);
    if (found.parent) return found;
  }
  return { parent: null, index: -1 };
}

export function moveNodeInTree(nodes: CanvasNode[], nodeId: string, direction: 'up' | 'down'): CanvasNode[] {
  const clone = JSON.parse(JSON.stringify(nodes));
  const { parent, index } = findNodeParent(clone, nodeId);
  if (!parent) return nodes;
  const targetIdx = direction === 'up' ? index - 1 : index + 1;
  if (targetIdx < 0 || targetIdx >= parent.length) return nodes;
  [parent[index], parent[targetIdx]] = [parent[targetIdx], parent[index]];
  return clone;
}

export function wrapNodeInContainer(nodes: CanvasNode[], nodeId: string): CanvasNode[] {
  const clone: CanvasNode[] = JSON.parse(JSON.stringify(nodes));
  const { parent, index } = findNodeParent(clone, nodeId);
  if (!parent) return nodes;
  const node = parent[index];
  const wrapper: CanvasNode = { id: genId(), type: 'div', props: { className: 'p-4' }, children: [node], style: {} };
  parent[index] = wrapper;
  return clone;
}

// Insert a node at a specific index within a parent's children, or at root level
export function insertNodeAt(nodes: CanvasNode[], node: CanvasNode, parentId: string | null, index: number): CanvasNode[] {
  if (!parentId) {
    // Insert at root level
    const clone = [...nodes];
    const idx = Math.max(0, Math.min(index, clone.length));
    clone.splice(idx, 0, node);
    return clone;
  }
  // Insert inside a specific parent
  return nodes.map((n) => {
    if (n.id === parentId) {
      const children = [...n.children];
      const idx = Math.max(0, Math.min(index, children.length));
      children.splice(idx, 0, node);
      return { ...n, children };
    }
    if (n.children.length > 0) return { ...n, children: insertNodeAt(n.children, node, parentId, index) };
    return n;
  });
}

// Remove a node from anywhere in the tree and return it + the remaining tree
export function extractNode(nodes: CanvasNode[], nodeId: string): { remaining: CanvasNode[]; extracted: CanvasNode | null } {
  let extracted: CanvasNode | null = null;
  const remaining = nodes.filter((n) => {
    if (n.id === nodeId) { extracted = n; return false; }
    return true;
  }).map((n) => {
    if (n.children.length > 0) {
      const result = extractNode(n.children, nodeId);
      if (result.extracted) extracted = result.extracted;
      return { ...n, children: result.remaining };
    }
    return n;
  });
  return { remaining, extracted };
}

export function addChildToNode(nodes: CanvasNode[], parentId: string, child: CanvasNode): CanvasNode[] {
  return nodes.map((n) => n.id === parentId ? { ...n, children: [...n.children, child] } : { ...n, children: addChildToNode(n.children, parentId, child) });
}

export function removeNodeFromTree(nodes: CanvasNode[], nodeId: string): CanvasNode[] {
  return nodes.filter((n) => n.id !== nodeId).map((n) => ({ ...n, children: removeNodeFromTree(n.children, nodeId) }));
}

export function updateNodeProp(nodes: CanvasNode[], nodeId: string, key: string, value: any): CanvasNode[] {
  return nodes.map((n) => n.id === nodeId ? { ...n, props: { ...n.props, [key]: value } } : { ...n, children: updateNodeProp(n.children, nodeId, key, value) });
}

export function reIdNodes(node: CanvasNode): CanvasNode {
  return { ...node, id: genId(), children: node.children.map(reIdNodes) };
}

// ─── File icon helpers ───────────────────────────────────────────────────────
export function fileIcon(f: ProjectFile): string {
  if (f.type === 'folder') return f.expanded ? '▾' : '▸';
  const ext = f.name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = { tsx: '⚛', ts: 'TS', jsx: '⚛', js: 'JS', css: '#', json: '{}', html: '<>', svg: '◇', md: '¶', ico: '◆', mmd: '◆', mermaid: '◆', workflow: '⑂', api: '🔌' };
  return icons[ext] || '□';
}

export function fileColor(f: ProjectFile): string {
  if (f.type === 'folder') return 'text-muted-foreground';
  const ext = f.name.split('.').pop()?.toLowerCase() || '';
  const colors: Record<string, string> = { tsx: 'text-blue-400', ts: 'text-blue-500', jsx: 'text-yellow-400', js: 'text-yellow-500', css: 'text-purple-400', json: 'text-green-400', html: 'text-orange-400' };
  return colors[ext] || 'text-muted-foreground';
}

// ─── Default project scaffold ────────────────────────────────────────────────
export function defaultProject(): ProjectFile[] {
  return [
    { id: 'f_src', name: 'src', type: 'folder', expanded: true, children: [
      { id: 'f_pages', name: 'pages', type: 'folder', expanded: true, children: [
        { id: 'f_home', name: 'Home.tsx', type: 'file', language: 'tsx', nodes: [] },
        { id: 'f_about', name: 'About.tsx', type: 'file', language: 'tsx', nodes: [] },
      ]},
      { id: 'f_components', name: 'components', type: 'folder', expanded: false, children: [
        { id: 'f_ui', name: 'ui', type: 'folder', expanded: false, children: [] },
      ]},
      { id: 'f_diagrams', name: 'diagrams', type: 'folder', expanded: false, children: [
        { id: 'f_arch', name: 'architecture.mmd', type: 'file', language: 'mermaid', content: 'flowchart TD\n    Client[Browser] --> LB[Load Balancer]\n    LB --> API[API Server]\n    API --> DB[(Database)]\n    API --> Cache[(Redis Cache)]\n    API --> Queue[Message Queue]\n    Queue --> Worker[Worker Service]\n    Worker --> DB\n' },
      ]},
      { id: 'f_lib', name: 'lib', type: 'folder', expanded: false, children: [
        { id: 'f_utils', name: 'utils.ts', type: 'file', language: 'ts', content: 'import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}\n' },
      ]},
      { id: 'f_globals', name: 'globals.css', type: 'file', language: 'css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n@layer base {\n  :root {\n    --background: 0 0% 100%;\n    --foreground: 240 10% 3.9%;\n    --primary: 240 5.9% 10%;\n    --primary-foreground: 0 0% 98%;\n    --secondary: 240 4.8% 95.9%;\n    --muted: 240 4.8% 95.9%;\n    --muted-foreground: 240 3.8% 46.1%;\n    --border: 240 5.9% 90%;\n    --radius: 0.5rem;\n  }\n}\n' },
      { id: 'f_layout', name: 'layout.tsx', type: 'file', language: 'tsx', content: 'import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n' },
    ]},
    { id: 'f_public', name: 'public', type: 'folder', expanded: false, children: [
      { id: 'f_favicon', name: 'favicon.ico', type: 'file', language: 'text' },
    ]},
    { id: 'f_pkgjson', name: 'package.json', type: 'file', language: 'json', content: '{\n  "name": "my-app",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "dev": "next dev",\n    "build": "next build"\n  },\n  "dependencies": {\n    "react": "^19.0.0",\n    "next": "^15.0.0",\n    "tailwindcss": "^4.0.0"\n  }\n}\n' },
    { id: 'f_tsconfig', name: 'tsconfig.json', type: 'file', language: 'json', content: '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "jsx": "react-jsx",\n    "strict": true,\n    "paths": { "@/*": ["./src/*"] }\n  }\n}\n' },
    { id: 'f_adharui', name: 'adhar-ui.json', type: 'file', language: 'json', content: '{\n  "framework": "react",\n  "typescript": true,\n  "tailwind": { "css": "src/globals.css", "baseColor": "zinc" },\n  "aliases": { "components": "@/components", "ui": "@/components/ui", "utils": "@/lib/utils" }\n}\n' },
  ];
}

export function migratePages(saved: any): ProjectFile[] | null {
  if (!saved || !Array.isArray(saved)) return null;
  if (saved.length > 0 && saved[0].name && saved[0].nodes && !saved[0].type) {
    const proj = defaultProject();
    const pagesFolder = findFileInTree(proj, 'f_pages');
    if (pagesFolder && pagesFolder.children) {
      pagesFolder.children = saved.map((pg: any, i: number) => ({
        id: pg.id || `f_page_${i}`,
        name: `${pg.name.replace(/\s+/g, '')}.tsx`,
        type: 'file' as const,
        language: 'tsx',
        nodes: pg.nodes || [],
      }));
    }
    return proj;
  }
  return null;
}
