import React, { useEffect, useRef } from 'react';
import type { AIMessage, CanvasNode } from '../lib/builder-types.ts';

/**
 * AI assistant panel.
 *
 * Two engines: **Adhar AI** — the platform's own model endpoint, used when the
 * cluster has it configured — and **Templates**, the offline generator that
 * builds styled variants and applies refinements locally. There is no API-key
 * field: model credentials belong to the platform, never to the browser.
 */

interface AIPanelProps {
  aiMessages: AIMessage[];
  aiPrompt: string;
  aiLoading: boolean;
  aiProvider: 'local' | 'adhar';
  /** Adhar AI is configured on this cluster. */
  aiConnected: boolean;
  isActivePage: boolean;
  activeFileName?: string;
  activeNodes: CanvasNode[];
  onSetPrompt: (prompt: string) => void;
  onSetProvider: (provider: 'local' | 'adhar') => void;
  onGenerate: (prompt?: string) => void;
  onDismissMessage: (messageId: string) => void;
}

const EMPTY_SUGGESTIONS = ['SaaS landing page', 'Analytics dashboard', 'Pricing page', 'Login form', 'Blog home'];
const PAGE_SUGGESTIONS = ['Make it minimal', 'Make it bold', 'Add pricing section', 'Add testimonials', 'Add FAQ', 'Add footer'];
const CODE_SUGGESTIONS = ['Add JSDoc comments', 'Add input validation', 'Refactor for readability', 'Add error handling'];

export function AIPanel({
  aiMessages,
  aiPrompt,
  aiLoading,
  aiProvider,
  aiConnected,
  isActivePage,
  activeFileName,
  activeNodes,
  onSetPrompt,
  onSetProvider,
  onGenerate,
  onDismissMessage,
}: AIPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [aiMessages, aiLoading]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [aiPrompt]);

  const adhar = aiProvider === 'adhar';
  // Templates only work on pages; Adhar AI also edits source files.
  const canPrompt = isActivePage || (adhar && !!activeFileName);
  const suggestions = !isActivePage
    ? (adhar ? CODE_SUGGESTIONS : [])
    : activeNodes.length > 0 ? PAGE_SUGGESTIONS : EMPTY_SUGGESTIONS;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      if (aiPrompt.trim() && !aiLoading) onGenerate();
    }
  }

  return (
    <div className='flex flex-col h-full'>
      {/* Engine */}
      <div className='px-3 py-2 border-b border-border'>
        <div className='toggle-group'>
          <button type='button' className={`flex-1 ${adhar ? 'active' : ''}`} disabled={!aiConnected} onClick={() => onSetProvider('adhar')}
            title={aiConnected ? 'Generate with the platform model' : 'Adhar AI is not configured on this cluster'}>
            Adhar AI
          </button>
          <button type='button' className={`flex-1 ${!adhar ? 'active' : ''}`} onClick={() => onSetProvider('local')} title='Offline generator — styled variants and quick refinements'>
            Templates
          </button>
        </div>
        {!aiConnected && (
          <p className='mt-1.5 text-[10px] text-muted-foreground'>Adhar AI is not configured on this cluster — using the offline generator.</p>
        )}
      </div>

      {/* Conversation */}
      <div className='flex-1 overflow-y-auto px-2 py-2 space-y-2 min-h-0'>
        {aiMessages.length === 0 && (
          <div className='flex items-center justify-center h-full'>
            <p className='text-xs text-muted-foreground text-center px-4'>
              {isActivePage
                ? 'Describe a page or a change to the current one.'
                : adhar && activeFileName
                  ? `Describe a change to ${activeFileName}.`
                  : 'Open a page to generate UI.'}
            </p>
          </div>
        )}

        {aiMessages.map((msg) => {
          if (msg.role === 'system') {
            return (
              <div key={msg.id} className='group flex items-start gap-1 rounded-lg bg-muted px-2.5 py-1.5'>
                <span className='flex-1 text-[11px] text-muted-foreground'>{msg.content}</span>
                <button type='button' onClick={() => onDismissMessage(msg.id)} className='opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground text-[11px]' aria-label='Dismiss'>×</button>
              </div>
            );
          }
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className='flex justify-end'>
                <div className='max-w-[85%] rounded-xl rounded-br-sm bg-primary/10 px-3 py-2'>
                  <p className='text-xs text-foreground whitespace-pre-wrap'>{msg.content}</p>
                </div>
              </div>
            );
          }
          return (
            <div key={msg.id} className='flex justify-start'>
              <div className='max-w-[85%] rounded-xl rounded-bl-sm bg-muted px-3 py-2'>
                <p className='text-xs text-foreground whitespace-pre-wrap'>{msg.content}</p>
              </div>
            </div>
          );
        })}

        {aiLoading && (
          <div className='flex justify-start'>
            <div className='rounded-xl rounded-bl-sm bg-muted px-3 py-2'>
              <div className='flex gap-1'>
                {[0, 150, 300].map((d) => (
                  <span key={d} className='w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce' style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Suggestions */}
      {canPrompt && !aiLoading && suggestions.length > 0 && (
        <div className='px-2 pb-1.5 flex flex-wrap gap-1'>
          {suggestions.map((text) => (
            <button type='button' key={text} onClick={() => onGenerate(text)}
              className='text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'>
              {text}
            </button>
          ))}
        </div>
      )}

      {/* Prompt */}
      <div className='px-2 pb-2'>
        <div className='rounded-xl border border-border bg-background overflow-hidden focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20'>
          <textarea
            ref={inputRef}
            data-ai-input
            value={aiPrompt}
            onChange={(e) => onSetPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={canPrompt ? (isActivePage ? 'Describe what to build…' : 'Describe the change…') : 'Open a page first'}
            disabled={!canPrompt || aiLoading}
            rows={2}
            className='w-full text-xs px-3 pt-2.5 pb-1 bg-transparent text-foreground placeholder:text-muted-foreground/60 resize-none outline-none disabled:opacity-50 disabled:cursor-not-allowed'
          />
          <div className='flex items-center gap-1 px-2 pb-2'>
            <span className='text-[10px] text-muted-foreground'>{adhar ? 'Adhar AI' : 'Templates'} · ↵ to send</span>
            <div className='flex-1' />
            <button type='button'
              onClick={() => onGenerate()}
              disabled={!aiPrompt.trim() || aiLoading || !canPrompt}
              className='h-7 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 disabled:opacity-30 hover:opacity-90 active:scale-[0.97] transition-all'
            >
              Generate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
