// ─── Adhar UI Dialog / Modal ─────────────────────────────────────────────────
// Replaces native alert() and prompt() with styled overlays.

import React, { useEffect, useRef, useState } from 'react';

// ─── Dialog State Manager ────────────────────────────────────────────────────

interface DialogState {
  type: 'prompt' | 'alert' | 'confirm';
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: (value?: string) => void;
  onCancel?: () => void;
}

let _showDialog: (state: DialogState) => void = () => {};

export function registerDialogHandler(handler: (state: DialogState) => void) {
  _showDialog = handler;
}

// Public API — drop-in replacements for native dialogs
export function showPrompt(title: string, opts?: { placeholder?: string; defaultValue?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    _showDialog({
      type: 'prompt',
      title,
      placeholder: opts?.placeholder,
      defaultValue: opts?.defaultValue || '',
      confirmLabel: 'Create',
      onConfirm: (value) => resolve(value || null),
      onCancel: () => resolve(null),
    });
  });
}

export function showAlert(title: string, message?: string): Promise<void> {
  return new Promise((resolve) => {
    _showDialog({
      type: 'alert',
      title,
      message,
      confirmLabel: 'OK',
      onConfirm: () => resolve(),
    });
  });
}

export function showConfirm(title: string, message?: string, opts?: { destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    _showDialog({
      type: 'confirm',
      title,
      message,
      destructive: opts?.destructive,
      confirmLabel: opts?.destructive ? 'Delete' : 'Confirm',
      cancelLabel: 'Cancel',
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

// ─── Dialog Component ────────────────────────────────────────────────────────

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerDialogHandler((state) => {
      setDialog(state);
      setInputValue(state.defaultValue || '');
    });
  }, []);

  useEffect(() => {
    if (dialog?.type === 'prompt') {
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
    }
  }, [dialog]);

  function handleConfirm() {
    dialog?.onConfirm(dialog.type === 'prompt' ? inputValue : undefined);
    setDialog(null);
  }

  function handleCancel() {
    dialog?.onCancel?.();
    setDialog(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
    if (e.key === 'Escape') handleCancel();
  }

  return (
    <>
      {children}
      {dialog && (
        <div className='fixed inset-0 z-[200] flex items-center justify-center' onKeyDown={handleKeyDown}>
          {/* Backdrop */}
          <div className='absolute inset-0 bg-foreground/20 backdrop-blur-sm animate-fade-in' onClick={handleCancel} />

          {/* Dialog card */}
          <div className='relative w-full max-w-sm mx-4 rounded-xl border border-border bg-card shadow-2xl animate-scale-in' onClick={(e) => e.stopPropagation()}>
            <div className='p-5'>
              <h3 className='text-sm font-semibold text-foreground mb-1'>{dialog.title}</h3>
              {dialog.message && <p className='text-xs text-muted-foreground mb-3 leading-relaxed'>{dialog.message}</p>}

              {dialog.type === 'prompt' && (
                <input ref={inputRef} value={inputValue} onChange={(e) => setInputValue(e.target.value)}
                  placeholder={dialog.placeholder}
                  className='input-sm mt-2 !h-9 text-sm' autoFocus />
              )}
            </div>

            <div className='flex items-center justify-end gap-2 px-5 pb-4'>
              {dialog.type !== 'alert' && (
                <button type='button' onClick={handleCancel}
                  className='h-8 px-4 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors'>
                  {dialog.cancelLabel || 'Cancel'}
                </button>
              )}
              <button type='button' onClick={handleConfirm}
                className={`h-8 px-4 rounded-lg text-xs font-medium transition-colors ${
                  dialog.destructive
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}>
                {dialog.confirmLabel || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
