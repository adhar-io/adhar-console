// ─── Workflow Visual Editor ───────────────────────────────────────────────────
// Full-page canvas for composing workflows with triggers, actions, conditions.

import { useState } from 'react';

interface WorkflowStep {
  id: string;
  type: 'trigger' | 'action' | 'condition' | 'delay';
  name: string;
  icon: string;
  config: Record<string, any>;
  x: number;
  y: number;
}

interface WorkflowConnection {
  from: string;
  to: string;
  label?: string;
}

interface WorkflowData {
  steps: WorkflowStep[];
  connections: WorkflowConnection[];
}

interface WorkflowEditorProps {
  content: string;
  onChange: (content: string) => void;
}

const TRIGGER_TYPES = [
  { type: 'event', name: 'On Event', icon: '⚡', desc: 'User action or system event' },
  { type: 'schedule', name: 'Schedule', icon: '⏱', desc: 'Cron or interval' },
  { type: 'webhook', name: 'Webhook', icon: '🌐', desc: 'HTTP request' },
  { type: 'email', name: 'Email', icon: '📧', desc: 'Incoming email' },
];

const ACTION_TYPES = [
  { type: 'send-email', name: 'Send Email', icon: '📨', desc: 'Send transactional email' },
  { type: 'db-query', name: 'Database', icon: '🗄', desc: 'Read or write to DB' },
  { type: 'http', name: 'HTTP Request', icon: '🌐', desc: 'Call external API' },
  { type: 'delay', name: 'Delay', icon: '⏳', desc: 'Wait before next step' },
  { type: 'condition', name: 'Condition', icon: '🔀', desc: 'Branch on condition' },
  { type: 'transform', name: 'Transform', icon: '🔄', desc: 'Map or filter data' },
  { type: 'notify', name: 'Notification', icon: '📢', desc: 'Push notification' },
  { type: 'log', name: 'Log', icon: '📝', desc: 'Write to audit log' },
];

function genId() { return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`; }

export function WorkflowEditor({ content, onChange }: WorkflowEditorProps) {
  const [data, setData] = useState<WorkflowData>(() => {
    try { return JSON.parse(content || '{}'); } catch { return { steps: [], connections: [] }; }
  });
  const [selectedStep, setSelectedStep] = useState<string | null>(null);

  function save(d: WorkflowData) { setData(d); onChange(JSON.stringify(d, null, 2)); }

  function addStep(_kind: string, name: string, icon: string, stepType: WorkflowStep['type']) {
    const step: WorkflowStep = { id: genId(), type: stepType, name, icon, config: {}, x: 200 + data.steps.length * 60, y: 100 + data.steps.length * 100 };
    const newData = { ...data, steps: [...data.steps, step] };
    // Auto-connect to last step
    if (data.steps.length > 0) {
      newData.connections = [...data.connections, { from: data.steps[data.steps.length - 1].id, to: step.id }];
    }
    save(newData);
  }

  function deleteStep(id: string) {
    save({ steps: data.steps.filter((s) => s.id !== id), connections: data.connections.filter((c) => c.from !== id && c.to !== id) });
    if (selectedStep === id) setSelectedStep(null);
  }

  function moveStep(id: string, x: number, y: number) {
    save({ ...data, steps: data.steps.map((s) => s.id === id ? { ...s, x, y } : s) });
  }

  const selStep = data.steps.find((s) => s.id === selectedStep);

  return (
    <div className='flex-1 flex overflow-hidden'>
      {/* ── Left: Step palette ── */}
      <div className='w-56 border-r border-border bg-card flex flex-col shrink-0 overflow-y-auto'>
        <div className='h-9 flex items-center px-3 border-b border-border shrink-0'>
          <span className='text-xs font-semibold text-foreground'>Workflow Steps</span>
        </div>

        <div className='p-2 space-y-3'>
          <div>
            <h4 className='text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider px-1 mb-1'>Triggers</h4>
            {TRIGGER_TYPES.map((t) => (
              <button type='button' key={t.type} onClick={() => addStep(t.type, t.name, t.icon, 'trigger')}
                className='w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-accent transition-colors'>
                <span className='text-sm shrink-0'>{t.icon}</span>
                <div className='min-w-0'>
                  <div className='text-xs font-medium text-foreground'>{t.name}</div>
                  <div className='text-[10px] text-muted-foreground/40 truncate'>{t.desc}</div>
                </div>
              </button>
            ))}
          </div>

          <div className='h-px bg-border' />

          <div>
            <h4 className='text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider px-1 mb-1'>Actions</h4>
            {ACTION_TYPES.map((a) => (
              <button type='button' key={a.type} onClick={() => addStep(a.type, a.name, a.icon, a.type === 'condition' ? 'condition' : a.type === 'delay' ? 'delay' : 'action')}
                className='w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-accent transition-colors'>
                <span className='text-sm shrink-0'>{a.icon}</span>
                <div className='min-w-0'>
                  <div className='text-xs font-medium text-foreground'>{a.name}</div>
                  <div className='text-[10px] text-muted-foreground/40 truncate'>{a.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Center: Workflow canvas ── */}
      <div className='flex-1 relative overflow-auto' style={{ background: 'var(--b-canvas)', backgroundImage: 'radial-gradient(circle, var(--b-canvas-dot) 0.8px, transparent 0.8px)', backgroundSize: '20px 20px' }}>

        {/* Render connections as SVG */}
        <svg className='absolute inset-0 w-full h-full pointer-events-none' style={{ minWidth: 1200, minHeight: 800 }}>
          {data.connections.map((conn) => {
            const from = data.steps.find((s) => s.id === conn.from);
            const to = data.steps.find((s) => s.id === conn.to);
            if (!from || !to) return null;
            const x1 = from.x + 80; const y1 = from.y + 40;
            const x2 = to.x + 80; const y2 = to.y;
            const midY = (y1 + y2) / 2;
            return (
              <g key={`${conn.from}-${conn.to}`}>
                <path d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                  fill='none' stroke='var(--b-primary)' strokeWidth={2} opacity={0.4} />
                <circle cx={x2} cy={y2} r={3} fill='var(--b-primary)' opacity={0.6} />
              </g>
            );
          })}
        </svg>

        {/* Render steps */}
        {data.steps.map((step) => (
          <div key={step.id}
            className={`absolute cursor-grab active:cursor-grabbing select-none ${selectedStep === step.id ? 'z-10' : ''}`}
            style={{ left: step.x, top: step.y, width: 160 }}
            onClick={() => setSelectedStep(step.id)}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              const startX = e.clientX - step.x;
              const startY = e.clientY - step.y;
              const onMove = (ev: MouseEvent) => {
                moveStep(step.id, ev.clientX - startX, ev.clientY - startY);
              };
              const onUp = () => { globalThis.removeEventListener('mousemove', onMove); globalThis.removeEventListener('mouseup', onUp); };
              globalThis.addEventListener('mousemove', onMove);
              globalThis.addEventListener('mouseup', onUp);
            }}>
            <div className={`rounded-xl border-2 bg-card shadow-md transition-all ${
              selectedStep === step.id ? 'border-primary shadow-lg ring-2 ring-primary/20' :
              step.type === 'trigger' ? 'border-emerald-400/50' :
              step.type === 'condition' ? 'border-amber-400/50' :
              'border-border'
            }`}>
              <div className={`px-3 py-2 rounded-t-[10px] ${
                step.type === 'trigger' ? 'bg-emerald-50 dark:bg-emerald-950/30' :
                step.type === 'condition' ? 'bg-amber-50 dark:bg-amber-950/30' :
                'bg-muted/30'
              }`}>
                <div className='flex items-center gap-2'>
                  <span className='text-lg'>{step.icon}</span>
                  <div className='flex-1 min-w-0'>
                    <div className='text-xs font-semibold text-foreground truncate'>{step.name}</div>
                    <div className='text-[9px] text-muted-foreground/50'>{step.type}</div>
                  </div>
                  <button type='button' onClick={(e) => { e.stopPropagation(); deleteStep(step.id); }}
                    className='w-4 h-4 rounded flex items-center justify-center text-muted-foreground/30 hover:text-destructive transition-colors'>
                    <svg width={10} height={10} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M18 6 6 18M6 6l12 12' /></svg>
                  </button>
                </div>
              </div>
              <div className='px-3 py-2 text-[10px] text-muted-foreground/50'>
                Click to configure
              </div>
            </div>
          </div>
        ))}

        {/* Empty state */}
        {data.steps.length === 0 && (
          <div className='absolute inset-0 flex items-center justify-center'>
            <div className='text-center'>
              <span className='text-4xl'>⚡</span>
              <h3 className='text-sm font-semibold text-foreground mt-3'>Build your workflow</h3>
              <p className='text-xs text-muted-foreground/50 mt-1 max-w-xs'>Add triggers and actions from the left panel to compose your automation flow.</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: Step config ── */}
      {selStep && (
        <div className='w-64 border-l border-border bg-card flex flex-col shrink-0'>
          <div className='h-9 flex items-center px-3 border-b border-border'>
            <span className='text-xs font-semibold text-foreground'>{selStep.name}</span>
            <div className='flex-1' />
            <button type='button' onClick={() => setSelectedStep(null)} className='btn-icon-sm !w-5 !h-5 !min-w-0'>
              <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth={2}><path d='M18 6 6 18M6 6l12 12' /></svg>
            </button>
          </div>
          <div className='p-3 space-y-3 overflow-y-auto flex-1'>
            <div>
              <label className='text-[10px] text-muted-foreground block mb-1'>Step Name</label>
              <input value={selStep.name} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, name: e.target.value } : s) })}
                className='input-sm' />
            </div>
            <div>
              <label className='text-[10px] text-muted-foreground block mb-1'>Type</label>
              <div className='text-xs text-foreground bg-muted px-2 py-1 rounded-md capitalize'>{selStep.type}</div>
            </div>
            <div className='h-px bg-border' />

            {/* Type-specific config */}
            {(selStep.type === 'trigger' && selStep.config.triggerType === undefined) && (
              <div>
                <label className='text-[10px] text-muted-foreground block mb-1'>Trigger Event</label>
                <select value={selStep.config.event || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, event: e.target.value } } : s) })}
                  className='input-sm'>
                  <option value=''>Select event...</option>
                  <option value='user.signup'>User Signup</option>
                  <option value='user.login'>User Login</option>
                  <option value='order.created'>Order Created</option>
                  <option value='payment.received'>Payment Received</option>
                  <option value='form.submitted'>Form Submitted</option>
                  <option value='custom'>Custom Event</option>
                </select>
              </div>
            )}

            {selStep.name === 'Schedule' && (
              <div>
                <label className='text-[10px] text-muted-foreground block mb-1'>Schedule</label>
                <select value={selStep.config.schedule || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, schedule: e.target.value } } : s) })}
                  className='input-sm'>
                  <option value=''>Select interval...</option>
                  <option value='* * * * *'>Every minute</option>
                  <option value='*/5 * * * *'>Every 5 minutes</option>
                  <option value='0 * * * *'>Every hour</option>
                  <option value='0 0 * * *'>Daily at midnight</option>
                  <option value='0 9 * * 1-5'>Weekdays at 9am</option>
                </select>
              </div>
            )}

            {selStep.name === 'Webhook' && (
              <div>
                <label className='text-[10px] text-muted-foreground block mb-1'>Webhook URL</label>
                <input value={selStep.config.webhookUrl || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, webhookUrl: e.target.value } } : s) })}
                  className='input-sm text-[10px] font-mono' placeholder='https://...' />
              </div>
            )}

            {selStep.name === 'Send Email' && (
              <>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>To</label>
                  <input value={selStep.config.to || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, to: e.target.value } } : s) })}
                    className='input-sm text-[10px]' placeholder='{{user.email}}' />
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Subject</label>
                  <input value={selStep.config.subject || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, subject: e.target.value } } : s) })}
                    className='input-sm text-[10px]' placeholder='Welcome to our platform' />
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Template</label>
                  <select value={selStep.config.template || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, template: e.target.value } } : s) })}
                    className='input-sm'>
                    <option value=''>Select template...</option>
                    <option value='welcome'>Welcome Email</option>
                    <option value='verification'>Email Verification</option>
                    <option value='reset-password'>Password Reset</option>
                    <option value='notification'>Notification</option>
                  </select>
                </div>
              </>
            )}

            {selStep.name === 'HTTP Request' && (
              <>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Method</label>
                  <select value={selStep.config.method || 'GET'} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, method: e.target.value } } : s) })}
                    className='input-sm'>
                    <option value='GET'>GET</option><option value='POST'>POST</option><option value='PUT'>PUT</option><option value='DELETE'>DELETE</option>
                  </select>
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>URL</label>
                  <input value={selStep.config.url || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, url: e.target.value } } : s) })}
                    className='input-sm text-[10px] font-mono' placeholder='https://api.example.com/endpoint' />
                </div>
              </>
            )}

            {selStep.name === 'Database' && (
              <>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Operation</label>
                  <select value={selStep.config.op || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, op: e.target.value } } : s) })}
                    className='input-sm'>
                    <option value=''>Select operation...</option>
                    <option value='select'>SELECT (read)</option><option value='insert'>INSERT (create)</option>
                    <option value='update'>UPDATE</option><option value='delete'>DELETE</option>
                  </select>
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Table</label>
                  <input value={selStep.config.table || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, table: e.target.value } } : s) })}
                    className='input-sm text-[10px] font-mono' placeholder='users' />
                </div>
              </>
            )}

            {selStep.name === 'Delay' && (
              <div>
                <label className='text-[10px] text-muted-foreground block mb-1'>Duration</label>
                <div className='flex gap-1.5'>
                  <input type='number' value={selStep.config.delayValue || 5} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, delayValue: parseInt(e.target.value) } } : s) })}
                    className='input-sm text-[10px] !w-16 tabular-nums' min={1} />
                  <select value={selStep.config.delayUnit || 'seconds'} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, delayUnit: e.target.value } } : s) })}
                    className='input-sm flex-1'>
                    <option value='seconds'>Seconds</option><option value='minutes'>Minutes</option><option value='hours'>Hours</option><option value='days'>Days</option>
                  </select>
                </div>
              </div>
            )}

            {selStep.name === 'Condition' && (
              <>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Field</label>
                  <input value={selStep.config.field || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, field: e.target.value } } : s) })}
                    className='input-sm text-[10px] font-mono' placeholder='{{user.plan}}' />
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Operator</label>
                  <select value={selStep.config.operator || 'equals'} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, operator: e.target.value } } : s) })}
                    className='input-sm'>
                    <option value='equals'>Equals</option><option value='not-equals'>Not Equals</option>
                    <option value='contains'>Contains</option><option value='gt'>Greater Than</option><option value='lt'>Less Than</option>
                  </select>
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Value</label>
                  <input value={selStep.config.condValue || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, condValue: e.target.value } } : s) })}
                    className='input-sm text-[10px]' placeholder='pro' />
                </div>
              </>
            )}

            {selStep.name === 'Notification' && (
              <>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Channel</label>
                  <select value={selStep.config.channel || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, channel: e.target.value } } : s) })}
                    className='input-sm'>
                    <option value=''>Select channel...</option>
                    <option value='push'>Push Notification</option><option value='in-app'>In-App</option>
                    <option value='slack'>Slack</option><option value='sms'>SMS</option>
                  </select>
                </div>
                <div>
                  <label className='text-[10px] text-muted-foreground block mb-1'>Message</label>
                  <textarea value={selStep.config.message || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, message: e.target.value } } : s) })}
                    className='w-full h-16 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] resize-none outline-none focus:ring-1 focus:ring-ring'
                    placeholder='Your order has been shipped!' />
                </div>
              </>
            )}

            <div className='h-px bg-border' />

            {/* Description/notes */}
            <div>
              <label className='text-[10px] text-muted-foreground block mb-1'>Notes</label>
              <textarea value={selStep.config.notes || ''} onChange={(e) => save({ ...data, steps: data.steps.map((s) => s.id === selStep.id ? { ...s, config: { ...s.config, notes: e.target.value } } : s) })}
                className='w-full h-14 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] resize-none outline-none focus:ring-1 focus:ring-ring'
                placeholder='Add notes about this step...' />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
