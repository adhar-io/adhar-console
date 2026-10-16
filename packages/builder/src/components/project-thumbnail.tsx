import { useEffect, useRef, useState } from 'react';
import type { BuilderProject } from '../types.ts';
import { homePage } from '../lib/studio.ts';
import { StaticNode, StudioFilesContext } from './static-node.tsx';
import { designThemeStyle } from '../lib/design-theme.ts';
import { ensureStyle } from '../lib/inject-style.ts';
import { BUILDER_CSS } from '../builder-styles.ts';
import { setExtraThemePresets, type ThemePreset } from '../lib/builder-api.ts';

/**
 * A live, scaled-down render of a project's home page — for library cards.
 *
 * Rendered with React from the node tree (tag, classes, text), never as
 * markup: project documents are shared across a tenant, so nothing from one is
 * ever injected as HTML. The design theme applies, so the card looks like the
 * page will.
 */

const ARTBOARD_W = 1280;

export function ProjectThumbnail({ project, themes, className }: { project: BuilderProject; themes?: ThemePreset[]; className?: string }) {
  ensureStyle('adhar-builder-css', BUILDER_CSS);
  // Host presets (e.g. the workspace theme) — the same registry the editor uses.
  if (themes) setExtraThemePresets(themes);
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / ARTBOARD_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = homePage(project.files)?.nodes ?? [];
  const s = project.settings;
  return (
    <div ref={ref} className={`adhar-builder relative overflow-hidden ${className ?? ''}`} aria-hidden>
      <div
        className={`absolute left-0 top-0 origin-top-left bg-background text-foreground ${s.darkMode ? 'dark' : ''}`}
        style={{ width: ARTBOARD_W, minHeight: '100%', transform: `scale(${scale})`, pointerEvents: 'none', ...designThemeStyle(s.theme, s.darkMode, s.customTokenOverrides) }}
      >
        {nodes.length ? (
          <StudioFilesContext.Provider value={project.files}>
            <div className='p-6'>{nodes.map((n) => <StaticNode key={n.id} node={n} />)}</div>
          </StudioFilesContext.Provider>
        ) : (
          <div className='flex h-[800px] items-center justify-center text-5xl text-muted-foreground'>Empty page</div>
        )}
      </div>
    </div>
  );
}

export default ProjectThumbnail;
