import type { BuilderMode, BuilderProject, BuilderSettings } from '../types.ts'
import { defaultProject, getAllPageFiles, type ProjectFile } from './builder-types.ts'

export const DEFAULT_SETTINGS: BuilderSettings = {
  framework: 'react',
  theme: 'adhar',
  darkMode: false,
  customTokenOverrides: {},
}

/** A starter pipeline so Workflow mode opens on something real to edit. */
const STARTER_WORKFLOW = JSON.stringify(
  {
    steps: [
      { id: 'ws_trigger', type: 'trigger', name: 'Webhook', icon: '🌐', config: {}, x: 220, y: 60 },
      { id: 'ws_fetch', type: 'action', name: 'HTTP Request', icon: '🌐', config: { method: 'GET', url: 'https://example.com/health' }, x: 220, y: 200 },
      { id: 'ws_wait', type: 'delay', name: 'Delay', icon: '⏳', config: { delayValue: 10, delayUnit: 'seconds' }, x: 220, y: 340 },
      { id: 'ws_log', type: 'action', name: 'Log', icon: '📝', config: { message: 'pipeline finished' }, x: 220, y: 480 },
    ],
    connections: [
      { from: 'ws_trigger', to: 'ws_fetch' },
      { from: 'ws_fetch', to: 'ws_wait' },
      { from: 'ws_wait', to: 'ws_log' },
    ],
  },
  null,
  2,
)

/**
 * A new app in the Visual Designer: just the app's own structure — pages,
 * reusable components and data sources (see lib/studio.ts). No scaffolding
 * files: the runnable project is generated on export.
 */
export function studioFiles(): ProjectFile[] {
  return [
    {
      id: 'f_src', name: 'src', type: 'folder', expanded: true, children: [
        { id: 'f_pages', name: 'pages', type: 'folder', expanded: true, children: [
          { id: 'f_home', name: 'Home.tsx', type: 'file', language: 'tsx', nodes: [], home: true, route: '/' },
        ] },
        { id: 'f_symbols', name: 'components', type: 'folder', expanded: true, children: [] },
        { id: 'f_data', name: 'data', type: 'folder', expanded: true, children: [] },
      ],
    },
  ]
}

export function defaultProjectFor(mode: BuilderMode, name = 'Untitled'): BuilderProject {
  if (mode !== 'workflow') return { version: 1, name, files: studioFiles(), settings: { ...DEFAULT_SETTINGS } }
  const files = defaultProject()
  {
    files.push({
      id: 'f_workflows',
      name: 'workflows',
      type: 'folder',
      expanded: true,
      children: [{ id: 'f_wf_main', name: 'pipeline.workflow', type: 'file', language: 'workflow', content: STARTER_WORKFLOW }],
    })
  }
  return { version: 1, name, files, settings: { ...DEFAULT_SETTINGS } }
}

/** The file a mode opens on first. */
export function initialFileFor(mode: BuilderMode, files: ProjectFile[]): ProjectFile | undefined {
  if (mode === 'workflow') {
    const wf = findFirst(files, (f) => f.type === 'file' && f.language === 'workflow')
    if (wf) return wf
  }
  return getAllPageFiles(files)[0]
}

function findFirst(files: ProjectFile[], pred: (f: ProjectFile) => boolean): ProjectFile | undefined {
  for (const f of files) {
    if (pred(f)) return f
    if (f.children) {
      const hit = findFirst(f.children, pred)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * Accept anything that claims to be a project — a stored doc, a manifest read
 * from a repo, or the standalone builder's bare file array — and return a
 * well-formed one, or null when it is not a project at all.
 */
export function normalizeProject(raw: unknown, fallbackName = 'Untitled'): BuilderProject | null {
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw)) {
    return raw.length && (raw[0] as ProjectFile).type
      ? { version: 1, name: fallbackName, files: raw as ProjectFile[], settings: { ...DEFAULT_SETTINGS } }
      : null
  }
  const p = raw as Partial<BuilderProject>
  if (!Array.isArray(p.files)) return null
  return {
    version: 1,
    name: typeof p.name === 'string' && p.name ? p.name : fallbackName,
    files: p.files,
    settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
  }
}
