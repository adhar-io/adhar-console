import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Diagram Templates ──────────────────────────────────────────────────────

export const DIAGRAM_TEMPLATES: { id: string; label: string; icon: string; category: string; code: string }[] = [
  // Architecture
  { id: 'flowchart', label: 'Flowchart', icon: '⬡', category: 'Architecture', code: `flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process A]
    B -->|No| D[Process B]
    C --> E[End]
    D --> E` },
  { id: 'sequence', label: 'Sequence Diagram', icon: '↕', category: 'Architecture', code: `sequenceDiagram
    participant U as User
    participant F as Frontend
    participant A as API
    participant D as Database
    U->>F: Submit Form
    F->>A: POST /api/data
    A->>D: INSERT query
    D-->>A: Success
    A-->>F: 200 OK
    F-->>U: Show confirmation` },
  { id: 'class', label: 'Class Diagram', icon: '▣', category: 'Architecture', code: `classDiagram
    class User {
        +String id
        +String name
        +String email
        +login()
        +logout()
    }
    class Post {
        +String id
        +String title
        +String content
        +publish()
    }
    class Comment {
        +String id
        +String text
        +Date createdAt
    }
    User "1" --> "*" Post : creates
    Post "1" --> "*" Comment : has
    User "1" --> "*" Comment : writes` },
  { id: 'er', label: 'ER Diagram', icon: '⊞', category: 'Architecture', code: `erDiagram
    USER ||--o{ POST : creates
    USER ||--o{ COMMENT : writes
    POST ||--o{ COMMENT : has
    POST ||--o{ TAG : tagged
    USER {
        string id PK
        string name
        string email UK
        date createdAt
    }
    POST {
        string id PK
        string title
        text content
        date publishedAt
    }
    COMMENT {
        string id PK
        text body
        date createdAt
    }
    TAG {
        string id PK
        string name UK
    }` },
  { id: 'state', label: 'State Machine', icon: '◎', category: 'Architecture', code: `stateDiagram-v2
    [*] --> Idle
    Idle --> Loading : fetch()
    Loading --> Success : resolve
    Loading --> Error : reject
    Success --> Idle : reset
    Error --> Loading : retry
    Error --> Idle : dismiss` },

  // DevOps
  { id: 'c4-context', label: 'C4 Context', icon: '◉', category: 'DevOps', code: `C4Context
    title System Context Diagram
    Person(user, "User", "A customer")
    System(webapp, "Web App", "React SPA")
    System(api, "API Server", "Node.js REST")
    System_Ext(payment, "Payment Provider", "Stripe")
    System_Ext(email, "Email Service", "SendGrid")
    Rel(user, webapp, "Uses", "HTTPS")
    Rel(webapp, api, "Calls", "REST/JSON")
    Rel(api, payment, "Processes payments")
    Rel(api, email, "Sends emails")` },
  { id: 'git', label: 'Git Graph', icon: '⑂', category: 'DevOps', code: `gitGraph
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit
    branch hotfix
    checkout hotfix
    commit
    checkout main
    merge hotfix` },
  { id: 'gantt', label: 'Gantt Chart', icon: '▬', category: 'DevOps', code: `gantt
    title Project Timeline
    dateFormat YYYY-MM-DD
    section Design
        Wireframes          :a1, 2024-01-01, 7d
        UI Design           :a2, after a1, 10d
        Design Review       :a3, after a2, 3d
    section Development
        Frontend            :b1, after a3, 14d
        Backend API         :b2, after a3, 14d
        Integration         :b3, after b1, 7d
    section Testing
        QA Testing          :c1, after b3, 7d
        Bug Fixes           :c2, after c1, 5d
        Release             :milestone, after c2, 0d` },

  // User Flows
  { id: 'journey', label: 'User Journey', icon: '🗺', category: 'User Flows', code: `journey
    title User Onboarding
    section Sign Up
        Visit landing page: 5: User
        Click Get Started: 4: User
        Fill registration form: 3: User
        Verify email: 2: User
    section Setup
        Choose plan: 3: User
        Enter payment: 2: User
        Configure workspace: 4: User
    section First Use
        Create first project: 5: User
        Invite team members: 4: User
        Complete tutorial: 5: User` },
  { id: 'pie', label: 'Pie Chart', icon: '◔', category: 'User Flows', code: `pie title Technology Stack Distribution
    "React" : 35
    "Vue" : 25
    "Angular" : 20
    "Svelte" : 12
    "Solid" : 8` },
  { id: 'mindmap', label: 'Mind Map', icon: '🧠', category: 'User Flows', code: `mindmap
    root((Product))
        Frontend
            React
            Vue
            Svelte
        Backend
            API
                REST
                GraphQL
            Database
                PostgreSQL
                Redis
        Infrastructure
            Docker
            Kubernetes
            CI/CD` },
  { id: 'timeline', label: 'Timeline', icon: '⏱', category: 'User Flows', code: `timeline
    title Product Roadmap
    section Q1 2024
        MVP Launch : Core features
                   : User auth
                   : Dashboard
    section Q2 2024
        Growth : Team collaboration
               : API integrations
               : Mobile app
    section Q3 2024
        Scale : Enterprise features
              : Advanced analytics
              : SSO support` },

  // Data
  { id: 'quadrant', label: 'Quadrant Chart', icon: '⊟', category: 'Data', code: `quadrantChart
    title Feature Priority Matrix
    x-axis Low Effort --> High Effort
    y-axis Low Impact --> High Impact
    quadrant-1 Do First
    quadrant-2 Plan
    quadrant-3 Delegate
    quadrant-4 Eliminate
    Auth: [0.3, 0.9]
    Search: [0.6, 0.8]
    Dark Mode: [0.2, 0.4]
    Animations: [0.7, 0.3]
    Dashboard: [0.5, 0.7]
    Settings: [0.4, 0.5]` },
  { id: 'block', label: 'Block Diagram', icon: '▦', category: 'Data', code: `block-beta
    columns 3
    Frontend:3
    block:api
        columns 2
        Auth API
        Data API
    end
    block:data
        columns 2
        PostgreSQL
        Redis
    end` },
];

// ─── Diagram Editor Props ────────────────────────────────────────────────────

interface DiagramEditorProps {
  code: string;
  onChange: (code: string) => void;
  darkMode: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DiagramEditor({ code, onChange, darkMode }: DiagramEditorProps) {
  const [view, setView] = useState<'split' | 'code' | 'preview'>('split');
  const [error, setError] = useState<string | null>(null);
  const [svgContent, setSvgContent] = useState('');
  const [showTemplates, setShowTemplates] = useState(!code);
  const previewRef = useRef<HTMLDivElement>(null);
  const renderIdRef = useRef(0);

  // Render mermaid diagram
  const renderDiagram = useCallback(async (src: string) => {
    if (!src.trim()) { setSvgContent(''); setError(null); return; }
    const renderId = ++renderIdRef.current;
    try {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        theme: darkMode ? 'dark' : 'default',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 14,
        flowchart: { htmlLabels: true, curve: 'basis', padding: 12 },
        sequence: { mirrorActors: false, messageMargin: 40 },
        themeVariables: darkMode ? {
          primaryColor: '#6366f1', primaryTextColor: '#f1f5f9', primaryBorderColor: '#4f46e5',
          lineColor: '#475569', secondaryColor: '#1e293b', tertiaryColor: '#0f172a',
          background: '#0f172a', mainBkg: '#1e293b', nodeBorder: '#334155',
          clusterBkg: '#1e293b', titleColor: '#e2e8f0', edgeLabelBackground: '#1e293b',
        } : {
          primaryColor: '#6366f1', primaryTextColor: '#ffffff', primaryBorderColor: '#4f46e5',
          lineColor: '#94a3b8', secondaryColor: '#f1f5f9', tertiaryColor: '#e2e8f0',
          background: '#ffffff', mainBkg: '#f8fafc', nodeBorder: '#cbd5e1',
        },
      });
      const { svg } = await mermaid.render(`mermaid-${renderId}`, src);
      if (renderId === renderIdRef.current) {
        setSvgContent(svg);
        setError(null);
      }
    } catch (e: any) {
      if (renderId === renderIdRef.current) {
        setError(e.message || 'Invalid diagram syntax');
        setSvgContent('');
      }
    }
  }, [darkMode]);

  // Debounced render
  useEffect(() => {
    const timer = setTimeout(() => renderDiagram(code), 400);
    return () => clearTimeout(timer);
  }, [code, renderDiagram]);

  if (showTemplates) {
    return (
      <div className='flex-1 overflow-y-auto p-6' style={{ background: 'var(--b-canvas)' }}>
        <div className='max-w-3xl mx-auto'>
          <h2 className='text-lg font-semibold text-foreground mb-1'>Create a Diagram</h2>
          <p className='text-xs text-muted-foreground mb-6'>Choose a template to get started, or write Mermaid syntax from scratch.</p>

          <button type='button' onClick={() => { setShowTemplates(false); onChange('flowchart TD\n    A[Start] --> B[End]'); }}
            className='mb-6 px-4 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-card transition-all'>
            Start from blank
          </button>

          {['Architecture', 'DevOps', 'User Flows', 'Data'].map((cat) => (
            <div key={cat} className='mb-6'>
              <h3 className='text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2'>{cat}</h3>
              <div className='grid grid-cols-2 md:grid-cols-3 gap-2'>
                {DIAGRAM_TEMPLATES.filter((t) => t.category === cat).map((t) => (
                  <button type='button' key={t.id} onClick={() => { onChange(t.code); setShowTemplates(false); }}
                    className='group text-left p-3 rounded-xl border border-border bg-card hover:border-primary/30 hover:shadow-md transition-all'>
                    <div className='flex items-center gap-2 mb-1'>
                      <span className='text-base'>{t.icon}</span>
                      <span className='text-xs font-medium text-foreground group-hover:text-primary transition-colors'>{t.label}</span>
                    </div>
                    <p className='text-[10px] text-muted-foreground/60 line-clamp-2 font-mono'>{t.code.split('\n')[0]}</p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className='flex-1 flex flex-col overflow-hidden'>
      {/* Toolbar */}
      <div className='h-9 flex items-center px-3 border-b border-border bg-card shrink-0 gap-2'>
        <div className='toggle-group'>
          {[
            { id: 'split' as const, label: 'Split' },
            { id: 'code' as const, label: 'Code' },
            { id: 'preview' as const, label: 'Preview' },
          ].map((v) => (
            <button type='button' key={v.id} onClick={() => setView(v.id)} className={`!px-2 ${view === v.id ? 'active' : ''}`}>{v.label}</button>
          ))}
        </div>

        <div className='flex-1' />

        <button type='button' onClick={() => setShowTemplates(true)} className='btn-icon-sm' title='Templates'>
          <svg width={13} height={13} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><rect x='3' y='3' width='7' height='7' rx='1' /><rect x='14' y='3' width='7' height='7' rx='1' /><rect x='3' y='14' width='7' height='7' rx='1' /><rect x='14' y='14' width='7' height='7' rx='1' /></svg>
        </button>

        {svgContent && (
          <button type='button' onClick={() => {
            const blob = new Blob([svgContent], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'diagram.svg'; a.click();
          }} className='btn-icon-sm' title='Export SVG'>
            <svg width={13} height={13} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5}><path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3' /></svg>
          </button>
        )}

        {error && <span className='text-[10px] text-destructive truncate max-w-[200px]'>{error}</span>}
      </div>

      {/* Editor + Preview */}
      <div className='flex-1 flex overflow-hidden'>
        {/* Code editor */}
        {(view === 'split' || view === 'code') && (
          <div className={`${view === 'split' ? 'w-1/2 border-r border-border' : 'flex-1'} flex flex-col overflow-hidden`}>
            <textarea
              value={code}
              onChange={(e) => onChange(e.target.value)}
              className='flex-1 p-4 bg-card text-xs font-mono text-foreground resize-none outline-none leading-relaxed'
              placeholder='Enter Mermaid diagram syntax...'
              spellCheck={false}
              style={{ tabSize: 4 }}
            />
          </div>
        )}

        {/* Preview */}
        {(view === 'split' || view === 'preview') && (
          <div className={`${view === 'split' ? 'w-1/2' : 'flex-1'} overflow-auto flex items-center justify-center p-8`}
            style={{ background: 'var(--b-canvas)' }} ref={previewRef}>
            {svgContent ? (
              <div className='diagram-render rounded-xl bg-background border border-border p-6 shadow-sm max-w-full overflow-auto'
                dangerouslySetInnerHTML={{ __html: svgContent }} />
            ) : error ? (
              <div className='text-center max-w-sm'>
                <div className='text-2xl mb-2'>⚠</div>
                <p className='text-xs text-destructive font-medium mb-1'>Syntax Error</p>
                <p className='text-[10px] text-muted-foreground font-mono'>{error}</p>
              </div>
            ) : (
              <div className='text-center'>
                <div className='text-3xl mb-3 opacity-20'>◇</div>
                <p className='text-xs text-muted-foreground'>Write Mermaid syntax to see the diagram</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default DiagramEditor;
