// ─── API Data Editor & No-Code Response Mapper ──────────────────────────────
// Full-page editor for testing APIs and visually mapping responses to UI.

import { useState } from 'react';

interface APIEndpoint {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface FieldMapping {
  responsePath: string;
  componentType: string;
  propName: string;
  label: string;
}

interface APIEditorProps {
  content: string;
  onChange: (content: string) => void;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const METHOD_COLORS: Record<string, string> = { GET: '#10b981', POST: '#f59e0b', PUT: '#3b82f6', PATCH: '#8b5cf6', DELETE: '#ef4444' };

const UI_COMPONENTS = [
  { type: 'text', label: 'Text', icon: 'T' },
  { type: 'heading', label: 'Heading', icon: 'H' },
  { type: 'badge', label: 'Badge', icon: '●' },
  { type: 'image', label: 'Image', icon: '◇' },
  { type: 'list', label: 'List Item', icon: '•' },
  { type: 'card', label: 'Card', icon: '▣' },
  { type: 'table-cell', label: 'Table Cell', icon: '▦' },
  { type: 'input', label: 'Input (pre-fill)', icon: '▭' },
];

export function APIEditor({ content, onChange }: APIEditorProps) {
  const [data, setData] = useState(() => {
    try {
      return JSON.parse(content || '{}');
    } catch {
      return { endpoint: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/users', headers: {}, body: '' }, response: null, mappings: [] };
    }
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'mapping'>('request');
  const [headerKey, setHeaderKey] = useState('');
  const [headerVal, setHeaderVal] = useState('');

  function save(d: any) { setData(d); onChange(JSON.stringify(d, null, 2)); }

  async function testEndpoint() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(data.endpoint.url, {
        method: data.endpoint.method,
        headers: { 'Content-Type': 'application/json', ...data.endpoint.headers },
        ...(data.endpoint.method !== 'GET' && data.endpoint.body ? { body: data.endpoint.body } : {}),
      });
      const json = await res.json();
      save({ ...data, response: { status: res.status, data: json } });
      setActiveTab('response');
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }

  function extractPaths(obj: any, prefix = ''): string[] {
    if (obj === null || obj === undefined) return [];
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object') {
        return [`${prefix}[]`, ...extractPaths(obj[0], `${prefix}[0]`)];
      }
      return [`${prefix}[]`];
    }
    if (typeof obj === 'object') {
      return Object.entries(obj).flatMap(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null) return [path, ...extractPaths(v, path)];
        return [path];
      });
    }
    return [];
  }

  function addMapping(path: string) {
    const mappings = [...(data.mappings || []), { responsePath: path, componentType: 'text', propName: 'children', label: path.split('.').pop() || path }];
    save({ ...data, mappings });
  }

  function removeMapping(index: number) {
    const mappings = (data.mappings || []).filter((_: any, i: number) => i !== index);
    save({ ...data, mappings });
  }

  function updateMapping(index: number, field: string, value: string) {
    const mappings = (data.mappings || []).map((m: any, i: number) => i === index ? { ...m, [field]: value } : m);
    save({ ...data, mappings });
  }

  const responsePaths = data.response?.data ? extractPaths(data.response.data) : [];

  return (
    <div className='flex-1 flex flex-col overflow-hidden'>
      {/* ── Endpoint bar ── */}
      <div className='h-12 flex items-center gap-2 px-3 border-b border-border bg-card shrink-0'>
        <select value={data.endpoint.method}
          onChange={(e) => save({ ...data, endpoint: { ...data.endpoint, method: e.target.value } })}
          className='h-8 rounded-lg border-0 text-xs font-bold text-white px-2.5 appearance-none cursor-pointer'
          style={{ backgroundColor: METHOD_COLORS[data.endpoint.method] || '#666' }}>
          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input value={data.endpoint.url}
          onChange={(e) => save({ ...data, endpoint: { ...data.endpoint, url: e.target.value } })}
          placeholder='https://api.example.com/endpoint'
          className='flex-1 h-8 rounded-lg border border-border bg-background px-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/20' />
        <button type='button' onClick={testEndpoint} disabled={loading || !data.endpoint.url}
          className='h-8 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-30 hover:bg-primary/90 active:scale-[0.97] transition-all flex items-center gap-1.5'>
          {loading ? (
            <div className='flex gap-0.5'>{[0,100,200].map((d) => <div key={d} className='w-1 h-1 rounded-full bg-primary-foreground animate-bounce' style={{ animationDelay: `${d}ms` }} />)}</div>
          ) : (
            <><svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z' /></svg> Send</>
          )}
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className='h-9 flex items-center px-3 gap-1 border-b border-border bg-card shrink-0'>
        {(['request', 'response', 'mapping'] as const).map((tab) => (
          <button type='button' key={tab} onClick={() => setActiveTab(tab)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${activeTab === tab ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {tab === 'request' ? 'Request' : tab === 'response' ? `Response${data.response ? ` (${data.response.status})` : ''}` : `Mapping (${(data.mappings || []).length})`}
          </button>
        ))}
        {error && <span className='text-xs text-destructive ml-auto'>{error}</span>}
      </div>

      {/* ── Content ── */}
      <div className='flex-1 overflow-auto'>
        {/* Request tab */}
        {activeTab === 'request' && (
          <div className='p-4 max-w-2xl space-y-4'>
            <div>
              <h3 className='text-xs font-semibold text-foreground mb-2'>Headers</h3>
              <div className='space-y-1'>
                {Object.entries(data.endpoint.headers || {}).map(([k, v]) => (
                  <div key={k} className='flex items-center gap-2'>
                    <span className='text-xs font-mono text-primary/70 w-32 truncate'>{k}</span>
                    <span className='text-xs font-mono text-muted-foreground flex-1 truncate'>{v as string}</span>
                    <button type='button' onClick={() => { const h = { ...data.endpoint.headers }; delete h[k]; save({ ...data, endpoint: { ...data.endpoint, headers: h } }); }}
                      className='text-xs text-destructive/50 hover:text-destructive'>×</button>
                  </div>
                ))}
                <div className='flex gap-2 mt-1'>
                  <input value={headerKey} onChange={(e) => setHeaderKey(e.target.value)} placeholder='Key' className='input-sm !w-32 text-[10px] font-mono' />
                  <input value={headerVal} onChange={(e) => setHeaderVal(e.target.value)} placeholder='Value' className='input-sm flex-1 text-[10px] font-mono' />
                  <button type='button' onClick={() => { if (headerKey) { save({ ...data, endpoint: { ...data.endpoint, headers: { ...data.endpoint.headers, [headerKey]: headerVal } } }); setHeaderKey(''); setHeaderVal(''); } }}
                    className='h-7 px-2 rounded-md bg-primary text-primary-foreground text-[10px] disabled:opacity-30'>Add</button>
                </div>
              </div>
            </div>

            {data.endpoint.method !== 'GET' && (
              <div>
                <h3 className='text-xs font-semibold text-foreground mb-2'>Body</h3>
                <textarea value={data.endpoint.body || ''}
                  onChange={(e) => save({ ...data, endpoint: { ...data.endpoint, body: e.target.value } })}
                  placeholder='{ "key": "value" }'
                  className='w-full h-32 rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring/20' />
              </div>
            )}
          </div>
        )}

        {/* Response tab */}
        {activeTab === 'response' && (
          <div className='p-4'>
            {data.response ? (
              <div className='space-y-3'>
                <div className='flex items-center gap-2'>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${data.response.status < 300 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {data.response.status}
                  </span>
                  <span className='text-xs text-muted-foreground'>
                    {Array.isArray(data.response.data) ? `Array (${data.response.data.length} items)` : 'Object'}
                  </span>
                </div>
                <pre className='text-xs font-mono text-foreground bg-muted/30 rounded-lg p-4 overflow-auto max-h-[400px] border border-border/50'>
                  {JSON.stringify(data.response.data, null, 2)}
                </pre>

                {/* Quick field picker */}
                <div>
                  <h3 className='text-xs font-semibold text-foreground mb-2'>Available Fields</h3>
                  <div className='flex flex-wrap gap-1'>
                    {responsePaths.slice(0, 30).map((path) => (
                      <button type='button' key={path} onClick={() => { addMapping(path); setActiveTab('mapping'); }}
                        className='text-[10px] font-mono px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors'>
                        {path}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className='text-center py-16'>
                <span className='text-3xl'>📡</span>
                <p className='text-xs text-muted-foreground mt-3'>Send a request to see the response</p>
              </div>
            )}
          </div>
        )}

        {/* Mapping tab */}
        {activeTab === 'mapping' && (
          <div className='p-4 space-y-4'>
            <div className='flex items-center justify-between'>
              <h3 className='text-xs font-semibold text-foreground'>Response → UI Mappings</h3>
              <span className='text-[10px] text-muted-foreground/40'>{(data.mappings || []).length} mappings</span>
            </div>

            {(data.mappings || []).length === 0 && (
              <div className='text-center py-12 border-2 border-dashed border-border/30 rounded-xl'>
                <span className='text-3xl'>🔗</span>
                <p className='text-xs text-muted-foreground mt-3'>No mappings yet</p>
                <p className='text-[10px] text-muted-foreground/40 mt-1'>Go to Response tab, click a field to map it to UI</p>
              </div>
            )}

            {(data.mappings || []).map((mapping: FieldMapping, idx: number) => (
              <div key={idx} className='rounded-xl border border-border bg-card p-3'>
                <div className='flex items-center gap-3'>
                  {/* Source field */}
                  <div className='flex-1'>
                    <div className='text-[9px] text-muted-foreground/40 uppercase tracking-wider mb-0.5'>Response Field</div>
                    <div className='text-xs font-mono text-primary/80 bg-primary/5 px-2 py-1 rounded-md'>{mapping.responsePath}</div>
                  </div>

                  {/* Arrow */}
                  <svg width={20} height={20} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={1.5} className='text-muted-foreground/30 shrink-0'>
                    <path d='M5 12h14M12 5l7 7-7 7' /></svg>

                  {/* Target component */}
                  <div className='flex-1'>
                    <div className='text-[9px] text-muted-foreground/40 uppercase tracking-wider mb-0.5'>UI Component</div>
                    <select value={mapping.componentType} onChange={(e) => updateMapping(idx, 'componentType', e.target.value)}
                      className='input-sm text-xs'>
                      {UI_COMPONENTS.map((c) => <option key={c.type} value={c.type}>{c.icon} {c.label}</option>)}
                    </select>
                  </div>

                  {/* Delete */}
                  <button type='button' onClick={() => removeMapping(idx)}
                    className='btn-icon-sm !w-6 !h-6 !min-w-0 text-muted-foreground/30 hover:text-destructive'>
                    <svg width={12} height={12} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M18 6 6 18M6 6l12 12' /></svg>
                  </button>
                </div>

                {/* Label */}
                <div className='mt-2'>
                  <input value={mapping.label} onChange={(e) => updateMapping(idx, 'label', e.target.value)}
                    className='input-sm text-[10px]' placeholder='Display label' />
                </div>
              </div>
            ))}

            {/* Generated code preview */}
            {(data.mappings || []).length > 0 && (
              <div>
                <h4 className='text-xs font-semibold text-foreground mb-2'>Generated Code</h4>
                <pre className='text-[10px] font-mono text-muted-foreground bg-muted/30 rounded-lg p-3 overflow-auto border border-border/50'>
{`// Auto-generated from API mapping
const data = await fetch("${data.endpoint.url}").then(r => r.json());

${(data.mappings || []).map((m: FieldMapping) =>
  `// ${m.label}\n<${m.componentType === 'heading' ? 'h2' : m.componentType === 'badge' ? 'span' : m.componentType === 'image' ? 'img' : 'p'}>{data.${m.responsePath}}</${m.componentType === 'heading' ? 'h2' : m.componentType === 'badge' ? 'span' : 'p'}>`
).join('\n\n')}`}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
