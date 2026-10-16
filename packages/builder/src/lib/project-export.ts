import { BUILDER_MANIFEST, type BuilderProject, type GeneratedFile } from '../types.ts'
import type { ProjectFile } from './builder-types.ts'
import { workflowToArgo } from './argo-export.ts'
import { generateReactApp } from './react-export.ts'

/**
 * Render a project to the files a repository should hold:
 *
 *   • the app itself — a runnable React + Tailwind project (see react-export.ts)
 *   • Mermaid diagrams (`.mmd`), Markdown notes, and workflows (`.workflow`)
 *     with an Argo `WorkflowTemplate` beside each
 *   • `.adhar/builder.json` — the project, so "Open from repo" restores it
 *     with every page, component and data source intact.
 */
export function projectToFiles(project: BuilderProject, basePath = ''): GeneratedFile[] {
  const base = basePath.replace(/^\/+|\/+$/g, '')
  const at = (p: string) => (base ? `${base}/${p}` : p)
  const out: GeneratedFile[] = generateReactApp(project).map((f) => ({ ...f, path: at(f.path) }))
  const taken = new Set(out.map((f) => f.path))

  const walk = (files: ProjectFile[], prefix: string) => {
    for (const f of files) {
      const path = prefix ? `${prefix}/${f.name}` : f.name
      if (f.type === 'folder') {
        walk(f.children ?? [], path)
        continue
      }
      if (f.nodes !== undefined || !f.content || !['mermaid', 'workflow', 'md'].includes(f.language ?? '')) continue
      if (!taken.has(at(path))) out.push({ path: at(path), content: f.content })
      if (f.language === 'workflow') {
        const yaml = workflowToArgo(f.content, f.name.replace(/\.workflow$/, ''))
        if (yaml) out.push({ path: at(path.replace(/\.workflow$/, '.argo.yaml')), content: yaml })
      }
    }
  }
  walk(project.files, '')

  out.push({ path: at(BUILDER_MANIFEST), content: JSON.stringify(project, null, 2) + '\n' })
  return out
}
