/**
 * Monaco editor for the builder's code view and plain project files.
 *
 * Bundled Monaco (see lib/monaco-loader.ts), themed to follow the console's
 * light/dark mode live. Kept deliberately small: the builder owns the
 * surrounding chrome, this only hosts the editor and keeps it in sync.
 */
import { useEffect, useRef, useState } from 'react';
import { loadMonaco, type MonacoApi, type MonacoEditorInstance } from '../lib/monaco-loader.ts';

interface MonacoEditorProps {
  value: string;
  language: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

// Builder file languages → Monaco Monarch grammar ids (worker-free build).
const LANG: Record<string, string> = {
  tsx: 'typescript', ts: 'typescript', jsx: 'javascript', js: 'javascript',
  json: 'javascript', html: 'html', css: 'css', scss: 'scss', md: 'markdown',
  markdown: 'markdown', yaml: 'yaml', yml: 'yaml', vue: 'html', svelte: 'html',
  mermaid: 'plaintext', text: 'plaintext', sh: 'shell', go: 'go', py: 'python',
};

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

export function MonacoEditor({ value, language, readOnly = false, onChange }: MonacoEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Create once.
  useEffect(() => {
    let disposed = false;
    loadMonaco()
      .then((monaco) => {
        if (disposed || !hostRef.current) return;
        monacoRef.current = monaco;
        const ed = monaco.editor.create(hostRef.current, {
          value,
          language: LANG[language] ?? language,
          readOnly,
          theme: isDark() ? 'vs-dark' : 'vs',
          automaticLayout: true,
          minimap: { enabled: true, scale: 1 },
          fontSize: 13,
          fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          smoothScrolling: true,
          bracketPairColorization: { enabled: true },
          tabSize: 2,
          wordWrap: 'on',
          renderWhitespace: 'selection',
        });
        ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()));
        editorRef.current = ed;
        setReady(true);
      })
      .catch((e) => !disposed && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      editorRef.current?.getModel()?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // Mount-only: value/language/readOnly are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (switching files, regenerated code).
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && ed.getValue() !== value) ed.setValue(value);
  }, [value, ready]);

  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (monaco && model) monaco.editor.setModelLanguage(model, LANG[language] ?? language);
  }, [language, ready]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, ready]);

  // Follow the console's light/dark switch.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => monacoRef.current?.editor.setTheme(isDark() ? 'vs-dark' : 'vs'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  if (failed) {
    // Never hide the content: fall back to a plain text area.
    return (
      <textarea
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        spellCheck={false}
        className='w-full h-full p-4 bg-background text-foreground font-mono text-xs resize-none outline-none'
      />
    );
  }

  return (
    <div className='relative w-full h-full'>
      <div ref={hostRef} className='absolute inset-0' />
      {!ready && (
        <div className='absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground'>
          Loading editor…
        </div>
      )}
    </div>
  );
}

export default MonacoEditor;
